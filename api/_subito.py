"""
_subito.py — shared core for parsing a Subito.it listing into a screenshot config.

Used by:
  - server.py            (local / persistent cloud server, e.g. Render)
  - api/parse.py         (Vercel serverless function)
  - from_url.py          (CLI + batch PNG)

Fetching goes through a rotating proxy with Chrome-TLS impersonation (curl_cffi),
which is required because Subito is behind Akamai (blocks datacenter IPs and
non-browser TLS fingerprints). The proxy also gives an Italian exit IP.

Proxy is read from the SUBITO_PROXY env var, else from a `proxy.txt` file next to
the project. Accepts either `http://user:pass@host:port` or `host:port:user:pass`.
"""
import os, re, json, base64, io, subprocess, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
RETRIES = 6


# ---------------------------------------------------------------- proxy ------
def _read_proxy_file():
    for p in (os.path.join(ROOT, "proxy.txt"), os.path.join(os.path.dirname(__file__), "proxy.txt")):
        try:
            with open(p, "r", encoding="utf-8") as f:
                v = f.read().strip()
                if v:
                    return v
        except OSError:
            pass
    return ""


def proxy_url():
    raw = (os.environ.get("SUBITO_PROXY") or _read_proxy_file() or "").strip()
    if not raw:
        return None
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    parts = raw.split(":")
    if len(parts) >= 4:               # host:port:user:pass
        host, port, user = parts[0], parts[1], parts[2]
        pw = ":".join(parts[3:])
        return "http://%s:%s@%s:%s" % (user, pw, host, port)
    if len(parts) == 2:               # host:port
        return "http://%s:%s" % (parts[0], parts[1])
    return raw


# ---------------------------------------------------------------- fetch ------
def _fetch_curlcffi(url, binary=False):
    try:
        from curl_cffi import requests as creq
    except ImportError:
        return None
    px = proxy_url()
    proxies = {"http": px, "https": px} if px else None
    last = None
    for _ in range(RETRIES):
        try:
            r = creq.get(url, proxies=proxies, impersonate="chrome", timeout=45)
            if r.status_code == 200:
                if binary:
                    return r.content
                if "application/ld+json" in r.text or "og:title" in r.text:
                    return r.text
            last = r.status_code
        except Exception as e:          # noqa: BLE001  (rotate & retry)
            last = e
    raise RuntimeError("curl_cffi fetch failed after %d tries (last=%s)" % (RETRIES, last))


def _fetch_syscurl(url, binary=False):
    """Fallback for local machines that have the curl binary but not curl_cffi."""
    exe = shutil.which("curl") or shutil.which("curl.exe")
    if not exe:
        return None
    px = proxy_url()
    base = [exe, "-sSL", "-A", UA, "-H", "Accept-Language: it-IT,it;q=0.9"]
    if px:
        base += ["-x", px]
    last = None
    for _ in range(RETRIES):
        out = subprocess.run(base + [url], capture_output=True)
        if out.returncode == 0 and out.stdout and (binary or b"403" not in out.stdout[:200]):
            if binary:
                return out.stdout
            txt = out.stdout.decode("utf-8", "replace")
            if "application/ld+json" in txt or "og:title" in txt:
                return txt
        last = out.returncode
    raise RuntimeError("curl fetch failed (last rc=%s)" % last)


def fetch(url, binary=False):
    r = _fetch_curlcffi(url, binary)
    if r is not None:
        return r
    r = _fetch_syscurl(url, binary)
    if r is not None:
        return r
    raise RuntimeError("no fetch backend available (install curl_cffi)")


# ---------------------------------------------------------------- parse ------
def extract_ldjson(html):
    for m in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
        try:
            d = json.loads(m)
        except Exception:
            continue
        for c in (d if isinstance(d, list) else [d]):
            if isinstance(c, dict) and c.get("@type") == "Product":
                return c
        if isinstance(d, dict) and "@graph" in d:
            for c in d["@graph"]:
                if isinstance(c, dict) and c.get("@type") == "Product":
                    return c
    return None


def meta(html, prop):
    m = re.search(r'<meta property="%s" content="([^"]*)"' % re.escape(prop), html)
    return m.group(1) if m else None


def eur(x):
    s = "%0.2f" % round(float(x), 2)
    intp, dec = s.split(".")
    intp = re.sub(r"\B(?=(\d{3})+(?!\d))", ".", intp)
    return "%s,%s €" % (intp, dec)


def parse_price_num(s):
    s = str(s).replace("€", "").strip().replace(".", "").replace(",", ".")
    return float(re.sub(r"[^0-9.]", "", s) or 0)


def slug_from_url(url):
    base = url.rstrip("/").split("/")[-1]
    base = re.sub(r"\.html?$", "", base)
    return re.sub(r"[^a-z0-9\-]+", "-", base.lower())[:60] or "annuncio"


def protezione(price, o):
    if price <= 300:
        return round(o["prot_fixed"] + o["prot_rate1"] * price, 2)
    return round(min(o["prot_rate2"] * price, o["prot_cap"]), 2)


def image_datauri(url, box=160):
    try:
        raw = fetch(url, binary=True)
    except Exception:
        return ""
    mime = "image/jpeg"
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        w, h = im.size
        sc = box / float(max(w, h))
        if sc < 1:
            im = im.resize((max(1, int(w * sc)), max(1, int(h * sc))), Image.LANCZOS)
        buf = io.BytesIO(); im.save(buf, "JPEG", quality=86); raw = buf.getvalue()
    except Exception:
        pass
    return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode())


def qr_datauri(text):
    """Bake QR server-side if `qrcode` is available; else '' (frontend fills)."""
    try:
        import qrcode
    except ImportError:
        return ""
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=6, border=4)
    qr.add_data(text); qr.make(fit=True)
    buf = io.BytesIO(); qr.make_image().save(buf, "PNG")
    return "data:image/png;base64,%s" % base64.b64encode(buf.getvalue()).decode()


DEFAULTS = {"qr": "corner", "caption": "Inquadra per aprire l'annuncio",
            "ship_pickup": "2,39", "ship_home": "5,99",
            "prot_fixed": 1.20, "prot_rate1": 0.05, "prot_rate2": 0.045, "prot_cap": 51.0}


def fetch_data(url, opts=None):
    """Return ONLY the listing data (no template): title, price, image, protezione.
    The web parser injects this into the user's constructor template."""
    o = dict(DEFAULTS)
    if opts:
        o.update({k: v for k, v in opts.items() if v is not None})

    html = fetch(url)
    prod = extract_ldjson(html) or {}
    name = prod.get("name") or meta(html, "og:title") or "Annuncio"
    name = re.sub(r"\s*\|\s*Subito\s*$", "", name).strip()

    price = prod.get("offers", {}).get("price") if isinstance(prod.get("offers"), dict) else None
    if price is None:
        m = re.search(r'"price"\s*:\s*"?([0-9.,]+)', html)
        price = parse_price_num(m.group(1)) if m else 0
    price = float(price)

    img = prod.get("image")
    img_url = (img[0] if isinstance(img, list) else img) or meta(html, "og:image")

    prot = protezione(price, o)
    return {
        "url": url, "title": name, "price": price, "protezione": prot,
        "image": image_datauri(img_url) if img_url else "",
        "ship_pickup": parse_price_num(o["ship_pickup"]),
    }


def build_config(url, opts=None):
    """Full standalone config from the DEFAULT template (used by the CLI)."""
    o = dict(DEFAULTS)
    if opts:
        o.update({k: v for k, v in opts.items() if v is not None})

    d = fetch_data(url, opts)
    name, price, prot = d["title"], d["price"], d["protezione"]
    ship_pickup = parse_price_num(o["ship_pickup"])
    total = price + ship_pickup + prot

    cfg = {
        "summary": {
            "product": {"image": d["image"], "title": name},
            "rows": [
                {"label": "Oggetto", "value": eur(price), "info": False, "muted": False},
                {"label": "Spedizione", "value": "a partire da " + eur(ship_pickup), "info": True, "muted": True},
                {"label": "Protezione acquisti", "value": eur(prot), "info": False, "muted": False},
            ],
            "total": {"label": "Totale", "value": eur(total)},
        },
        "shipping": {
            "options": [
                {"kind": "pickup", "selected": True, "badge": "", "title": "Punto di ritiro",
                 "price": "da " + eur(ship_pickup), "button": "Cerca punto di ritiro", "carrier": "", "carrierLogo": ""},
                {"kind": "home", "selected": False, "badge": "SCELTA PIÙ COMODA",
                 "title": "Consegna a domicilio", "price": eur(parse_price_num(o["ship_home"])),
                 "button": "", "carrier": "Poste Italiane", "carrierLogo": ""},
            ]
        },
        "_meta": {"price": price, "protezione": prot, "total": total, "title": name, "url": url},
    }

    if o["qr"] != "none":
        cfg["qr"] = {"show": True, "image": qr_datauri(url), "data": url, "ecl": "M",
                     "position": o["qr"], "size": 88 if o["qr"] != "product" else 56,
                     "caption": o["caption"], "top": 64, "right": 26,
                     "x": 280, "y": 96, "bare": False, "dark": "#000000", "light": "#ffffff"}
        if o["qr"] == "block":
            cfg["canvas"] = {"height": 960}
    return cfg
