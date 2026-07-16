"""
Vercel serverless function:  GET /api/parse?url=<subito-url>&qr=corner&...
Returns { ok, config } or { ok:false, error }.
"""
import sys, os, json, urllib.parse
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
import _subito  # noqa: E402


def opts_from_query(q):
    def g(k, d=None):
        v = q.get(k, [])
        return v[0] if v else d
    o = {}
    if g("qr") is not None: o["qr"] = g("qr")
    if g("caption") is not None: o["caption"] = g("caption")
    if g("ship_pickup") is not None: o["ship_pickup"] = g("ship_pickup")
    if g("ship_home") is not None: o["ship_home"] = g("ship_home")
    for k in ("prot_fixed", "prot_rate1", "prot_rate2", "prot_cap"):
        if g(k) is not None:
            try: o[k] = float(g(k))
            except ValueError: pass
    return o


class handler(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = (q.get("url", [""])[0] or "").strip()
        if "subito.it" not in url:
            return self._send({"ok": False, "error": "ссылка должна быть subito.it"})
        try:
            return self._send({"ok": True, "data": _subito.fetch_data(url, opts_from_query(q))})
        except Exception as e:  # noqa: BLE001
            return self._send({"ok": False, "error": str(e)})

    def log_message(self, *a):
        pass
