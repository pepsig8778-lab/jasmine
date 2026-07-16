#!/usr/bin/env python3
"""
server.py — one process that serves the UI AND the /api/parse endpoint.

Local:  python server.py            -> http://localhost:8000  (127.0.0.1)
Cloud:  runs on 0.0.0.0:$PORT when the PORT env var is set (Render/Railway/Fly).

Parsing goes through the proxy (see api/_subito.py + SUBITO_PROXY / proxy.txt).
"""
import sys, os, json, urllib.parse, functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "api"))
import _subito  # noqa: E402


def opts_from_query(q):
    def g(k, d=None):
        v = q.get(k, [])
        return v[0] if v else d
    o = {}
    for k in ("qr", "caption", "ship_pickup", "ship_home"):
        if g(k) is not None:
            o[k] = g(k)
    for k in ("prot_fixed", "prot_rate1", "prot_rate2", "prot_cap"):
        if g(k) is not None:
            try: o[k] = float(g(k))
            except ValueError: pass
    return o


class Handler(SimpleHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/parse":
            q = urllib.parse.parse_qs(parsed.query)
            url = (q.get("url", [""])[0] or "").strip()
            if "subito.it" not in url:
                return self._json({"ok": False, "error": "ссылка должна быть subito.it"})
            try:
                return self._json({"ok": True, "data": _subito.fetch_data(url, opts_from_query(q))})
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": str(e)})
        return super().do_GET()

    def log_message(self, fmt, *args):
        if "/api/parse" in (self.path or ""):
            sys.stderr.write("[parse] " + self.path.split("url=")[-1][:80] + "\n")


def main():
    env_port = os.environ.get("PORT")
    if env_port:                       # cloud
        host, port = "0.0.0.0", int(env_port)
    else:                              # local
        host, port = "127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(Handler, directory=HERE)
    httpd = ThreadingHTTPServer((host, port), handler)
    print("Конструктор:  http://%s:%d/index.html" % (host, port))
    print("API парсера:  /api/parse?url=<subito-url>")
    print("Прокси:       %s" % ("настроен" if _subito.proxy_url() else "НЕ настроен"))
    print("(Ctrl+C чтобы остановить)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
