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
import _subito   # noqa: E402
import _store    # noqa: E402
import _render    # noqa: E402


def _err_code(e):
    """Map an exception from the fetch/parse pipeline to an HTTP status:
    bad input (400), upstream/Subito failure (502), unexpected (500)."""
    if isinstance(e, ValueError):
        return 400
    if isinstance(e, RuntimeError):
        return 502
    return 500


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

    def _png(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _is_local(self):
        return self.client_address and self.client_address[0] in ("127.0.0.1", "::1", "localhost")

    def end_headers(self):
        # Static files must revalidate on every load: without this, browsers
        # keep serving a cached app.js after a deploy and users keep hitting
        # bugs that are already fixed. (API responses set their own headers.)
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/parse":
            url = (q.get("url", [""])[0] or "").strip()
            if not _subito.is_subito_url(url):
                return self._json({"ok": False, "error": "ссылка должна быть subito.it"}, 400)
            try:
                return self._json({"ok": True, "data": _subito.fetch_data(url, opts_from_query(q))})
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": str(e)}, _err_code(e))

        # --- API: listing URL -> ready PNG -------------------------------
        if parsed.path in ("/api/image", "/api/render"):
            if not _store.check_key(q.get("key", [""])[0]):
                return self._json({"ok": False, "error": "неверный или отсутствующий API-ключ (?key=...)"}, 401)
            url = (q.get("url", [""])[0] or "").strip()
            if not _subito.is_subito_url(url):
                return self._json({"ok": False, "error": "нужен параметр url= со ссылкой subito.it"}, 400)
            try:
                scale = int(q.get("scale", ["2"])[0])
            except ValueError:
                scale = 2
            try:
                data = _subito.fetch_data(url, opts_from_query(q))
                tpl, _src = _store.load_template()
                return self._png(_render.render_png(tpl, data, scale))
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": str(e)}, _err_code(e))

        # --- API: status (template source / render backend) ---------------
        if parsed.path == "/api/status":
            if not _store.check_key(q.get("key", [""])[0]):
                return self._json({"ok": False, "error": "неверный API-ключ"}, 401)
            tpl, src = _store.load_template()
            try:
                import playwright  # noqa: F401
                backend = "playwright"
            except ImportError:
                backend = "chrome" if _render._find_chrome() else "none"
            return self._json({"ok": True, "templateSource": src,
                               "hasTemplate": bool(tpl), "renderer": backend})

        # --- API key: only readable from localhost (never over the net) ---
        if parsed.path == "/api/key":
            if not self._is_local():
                return self._json({"ok": False, "error":
                                   "Ключ виден только на localhost. На хостинге задайте переменную API_KEY."}, 403)
            k, src = _store.get_api_key()
            return self._json({"ok": True, "key": k, "source": src})

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/template":
            if not _store.check_key(q.get("key", [""])[0]):
                return self._json({"ok": False, "error": "неверный API-ключ"}, 401)
            try:
                n = int(self.headers.get("Content-Length") or 0)
                cfg = json.loads(self.rfile.read(n).decode("utf-8"))
                _store.save_template(cfg)
                return self._json({"ok": True, "saved": True})
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": str(e)}, 400)
        self.send_error(404)

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
