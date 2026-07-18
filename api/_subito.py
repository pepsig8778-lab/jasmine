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
import os, re, json, base64, io, time, threading, subprocess, shutil, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
RETRIES = 8


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
# A proxy attempt that's going to work responds in a few seconds; one that's
# dead/blocked rarely benefits from waiting the full 22s before the next
# retry gets a fresh exit IP. RETRIES stays high (Akamai soft-blocks need a
# handful of different exit IPs to get past) — only the per-try budget shrinks.
TIMEOUT = 10


def _cffi():
    try:
        from curl_cffi import requests as creq
        return creq
    except ImportError:
        return None


# Profiled on live listings: a FRESH proxied request costs 3.5-4.6s, of which
# ~3s is connect + TLS to the proxy + tunnel TLS to Subito; the SAME session
# reused answers in 1.0-1.3s. So keep a small pool of warm sessions. A reused
# session keeps its (sticky) exit IP — exactly what we want while it works;
# when a request fails or gets an Akamai soft-block we DISCARD that session,
# so the retry builds a fresh one and lands on a new exit IP (the old
# rotate-on-retry behaviour, now paying the handshake only when needed).
_POOL, _POOL_LOCK, _POOL_MAX = [], threading.Lock(), 4


def _borrow_session():
    with _POOL_LOCK:
        if _POOL:
            return _POOL.pop()
    creq = _cffi()
    return creq.Session(impersonate="chrome") if creq else None


def _return_session(s):
    with _POOL_LOCK:
        if len(_POOL) < _POOL_MAX:
            _POOL.append(s)
            return
    try:
        s.close()
    except Exception:                   # noqa: BLE001
        pass


def _discard_session(s):
    try:
        s.close()
    except Exception:                   # noqa: BLE001
        pass


def _syscurl_html(url):
    """Local fallback (no curl_cffi): system curl through the proxy."""
    exe = shutil.which("curl") or shutil.which("curl.exe")
    if not exe:
        return None
    px = proxy_url()
    cmd = [exe, "-sSL", "--max-time", str(TIMEOUT), "-A", UA,
           "-H", "Accept-Language: it-IT,it;q=0.9"]
    if px:
        cmd += ["-x", px]
    out = subprocess.run(cmd + [url], capture_output=True)
    return out.stdout.decode("utf-8", "replace") if out.returncode == 0 and out.stdout else None


def normalize_url(url):
    """People paste links without a scheme ("www.subito.it/...") — urlparse
    then sees no hostname and validation wrongly rejects a perfectly good
    listing. Add https:// when missing; also trim whitespace."""
    url = (url or "").strip()
    if url and not re.match(r"^https?://", url, re.I):
        url = "https://" + url.lstrip("/")
    return url


def is_subito_url(url):
    """True only if the URL's actual HOST is subito.it (or a subdomain).
    A naive substring check like `"subito.it" in url` can be spoofed by
    e.g. https://evil.example.com/x-1.htm?ref=subito.it — which would let
    anyone tunnel arbitrary sites through our paid proxy."""
    try:
        host = (urllib.parse.urlparse(normalize_url(url)).hostname or "").lower()
    except ValueError:
        return False
    return host == "subito.it" or host.endswith(".subito.it")


def _listing_id(url):
    m = re.search(r"-(\d+)\.html?(?:[?#]|$)", url)
    return m.group(1) if m else None


def _is_right_page(html, lid):
    """A valid listing page must have a Product card AND reference this exact ad id
    (guards against redirects to home/search or a wrong cached page)."""
    if not extract_ldjson(html):
        return False
    return (lid is None) or (lid in html)


def fetch_html(url):
    """Get the LISTING page and RETRY until it really contains THIS product's card.
    Datacenter IPs (e.g. on a host) sometimes get a 200 'soft block' from Akamai
    with no product data — we must retry (new proxy IP), never accept garbage."""
    creq = _cffi()
    px = proxy_url()
    proxies = {"http": px, "https": px} if px else None
    lid = _listing_id(url)
    last = "нет данных"
    for attempt in range(RETRIES):
        if attempt:
            # Brief pause before a retry: lets the rotating proxy hand out a
            # fresh exit IP and lets a transient Akamai soft-block clear, instead
            # of hammering the same blocked state back-to-back.
            time.sleep(min(0.4 * attempt, 1.5))
        if creq:
            s = _borrow_session()
            try:
                r = s.get(url, proxies=proxies, timeout=TIMEOUT)
                if r.status_code == 200 and _is_right_page(r.text, lid):
                    _return_session(s)          # warm session -> next parse ~1s
                    return r.text
                last = "HTTP %s" % r.status_code if r.status_code != 200 else "не то объявление/блок"
            except Exception as e:      # noqa: BLE001  (rotate & retry)
                last = type(e).__name__
            _discard_session(s)                 # bad exit IP -> retry gets a fresh one
        else:
            try:
                txt = _syscurl_html(url)
                if txt and _is_right_page(txt, lid):
                    return txt
                last = "не то объявление/блок"
            except Exception as e:      # noqa: BLE001
                last = type(e).__name__
    raise RuntimeError("Subito не отдал объявление (%s). Нажмите «Собрать» ещё раз." % last)


def fetch_image_bytes(url):
    """Product image is on a CDN (not geo-blocked): try DIRECT first (fast),
    fall back to the proxy only if needed."""
    creq = _cffi()
    if creq:
        for use_proxy in (False, True):
            px = proxy_url() if use_proxy else None
            proxies = {"http": px, "https": px} if px else None
            try:
                r = creq.get(url, proxies=proxies, impersonate="chrome", timeout=9)
                if r.status_code == 200 and r.content:
                    return r.content
            except Exception:           # noqa: BLE001
                pass
    exe = shutil.which("curl") or shutil.which("curl.exe")
    if exe:
        out = subprocess.run([exe, "-sSL", "--max-time", "9", "-A", UA, url], capture_output=True)
        if out.returncode == 0 and out.stdout:
            return out.stdout
    return None


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


def to_price(v):
    """Robustly turn a JSON-LD price (int/float/str, IT or EN format) into a float."""
    if isinstance(v, (int, float)):
        return float(v)
    if v is None:
        return None
    s = str(v).strip()
    try:
        return float(s)                       # "1100" or "1100.00"
    except ValueError:
        p = parse_price_num(s)                 # "1.100,00 €"
        return p if p else None


def price_of(prod):
    off = prod.get("offers")
    if isinstance(off, list):
        off = off[0] if off else {}
    if isinstance(off, dict):
        return to_price(off.get("price"))
    return None


def image_datauri(url, box=160):
    raw = fetch_image_bytes(url)
    if not raw:
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


_DATA_CACHE, _DATA_CACHE_LOCK, _DATA_TTL = {}, threading.Lock(), 300

DEFAULTS = {"qr": "corner", "caption": "Inquadra per aprire l'annuncio",
            "ship_pickup": "2,39", "ship_home": "5,99",
            "prot_fixed": 1.20, "prot_rate1": 0.05, "prot_rate2": 0.045, "prot_cap": 51.0}


def fetch_data(url, opts=None):
    """Return ONLY the listing data (no template): title, price, image, protezione.
    The web parser injects this into the user's constructor template."""
    o = dict(DEFAULTS)
    if opts:
        o.update({k: v for k, v in opts.items() if v is not None})

    url = normalize_url(url)
    # Fail fast: without an ad id this can never be a listing, so don't burn
    # ~30s of proxy retries before telling the user.
    lid = _listing_id(url)
    if not lid:
        raise ValueError("Это ссылка на subito.it, но не на объявление. Откройте "
                         "сам товар и скопируйте адрес — он оканчивается на "
                         "-1234567890.htm")

    # Short TTL cache of the listing FACTS only (title/price/image) — a repeat
    # of the same link (re-pressing «Собрать», API retries, url+qrUrl variants)
    # answers instantly instead of re-fetching through the proxy. Protezione
    # and shipping are derived below per-request because opts can differ.
    with _DATA_CACHE_LOCK:
        hit = _DATA_CACHE.get(lid)
        raw = dict(hit[1]) if hit and time.time() - hit[0] < _DATA_TTL else None

    if raw is None:
        html = fetch_html(url)                 # guaranteed to contain a Product card
        prod = extract_ldjson(html) or {}
        name = (prod.get("name") or meta(html, "og:title") or "Annuncio")
        name = re.sub(r"\s*\|\s*Subito\s*$", "", name).strip()

        price = price_of(prod)                  # ONLY from the product's own offer
        if price is None:
            price = 0.0                         # free/"Regalo" listing — not a random number

        img = prod.get("image")
        img_url = (img[0] if isinstance(img, list) else img) or meta(html, "og:image")
        raw = {"url": url, "title": name, "price": price,
               "image": image_datauri(img_url) if img_url else ""}
        with _DATA_CACHE_LOCK:
            _DATA_CACHE[lid] = (time.time(), dict(raw))
            if len(_DATA_CACHE) > 200:          # bound memory on long-lived hosts
                oldest = min(_DATA_CACHE, key=lambda k: _DATA_CACHE[k][0])
                del _DATA_CACHE[oldest]

    raw["protezione"] = protezione(raw["price"], o)
    raw["ship_pickup"] = parse_price_num(o["ship_pickup"])
    return raw


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
