"""
_render.py — render a template + listing data to PNG bytes, server-side.

Builds a self-contained page that loads the SAME engine the UI uses
(config.js + builder.js + qr.js + apply.js), applies the listing data to the
user's template, regenerates the QR, then screenshots it with headless Chromium.

Backends, in order:
  1. Playwright chromium  (works on hosts: `playwright install chromium`)
  2. A system Chrome/Edge (local dev)
"""
import os, io, sys, time, json, queue, shutil, threading, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def _asset(name):
    with open(os.path.join(ASSETS, name), "r", encoding="utf-8") as f:
        return f.read()


def build_page(template, data):
    """Self-contained HTML that renders the final screen and sets title=READY."""
    return (
        '<!doctype html><html><head><meta charset="utf-8"></head>'
        '<body style="margin:0;background:#fff"><div class="screen" id="screen"></div>'
        '<script>' + _asset("config.js") + '</script>'
        '<script>' + _asset("builder.js") + '</script>'
        '<script>' + _asset("qr.js") + '</script>'
        '<script>' + _asset("apply.js") + '</script>'
        '<script>'
        'var st=document.createElement("style");st.textContent=window.SCREEN_CSS;'
        'document.head.appendChild(st);'
        'var tpl=window.mergeConfig(window.DEFAULT_CONFIG,' + json.dumps(template or {}, ensure_ascii=False) + ');'
        'var data=' + json.dumps(data, ensure_ascii=False) + ';'
        'var cfg=data?window.SubitoApply.applyListingData(tpl,data):tpl;'
        'window.SubitoApply.renderQR(cfg.qr).then(function(){'
        '  window.renderScreen(document.getElementById("screen"),cfg);'
        '  requestAnimationFrame(function(){document.title="READY";});'
        '});'
        '</script></body></html>'
    )


def canvas_size(template):
    c = (template or {}).get("canvas") or {}
    try:
        w = int(c.get("width", 418))
    except (TypeError, ValueError):
        w = 418
    try:
        h = int(c.get("height", 826))
    except (TypeError, ValueError):
        h = 826
    # A corrupted/hand-edited template (width<=0 etc.) would otherwise make Chrome
    # fall back to its own default window size and silently return a wrong-size PNG.
    w = w if 100 <= w <= 2000 else 418
    h = h if 100 <= h <= 3000 else 826
    return w, h


_PW_INSTALL_TRIED = False
_PW_LOCK = threading.Lock()          # serialise install + launch (free tier = 1 chromium)


def _playwright_browser_ready():
    """True only if the chromium BINARY is actually on disk — importing the
    playwright package is not enough (the common Render mistake: pip installed
    the package but the build never ran `playwright install chromium`)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    try:
        with sync_playwright() as p:
            return bool(p.chromium.executable_path) and os.path.exists(p.chromium.executable_path)
    except Exception:                          # noqa: BLE001
        return False


def _ensure_playwright_browser():
    """Safety net: if the browser is missing (misconfigured build), download it
    once per process. Slow the first time, then cached for this container."""
    global _PW_INSTALL_TRIED
    if _PW_INSTALL_TRIED or _playwright_browser_ready():
        return
    _PW_INSTALL_TRIED = True
    try:
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"],
                       timeout=240, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:                          # noqa: BLE001
        pass


# --- persistent browser, driven by ONE worker thread -----------------------
# Launching a fresh Chromium per request costs ~1-3s. Instead a single worker
# thread owns Playwright and keeps ONE browser alive, rendering each request in
# a throwaway page — so only the first request pays the launch cost. The sync
# API is thread-affine, hence the dedicated thread + job queue.
_JOB_Q = queue.Queue()
_WORKER = None


def _launch_browser(p):
    """Launch chromium, retrying the transient ETXTBSY that hits a just-installed
    binary (its write handle isn't released yet)."""
    last = None
    for _ in range(5):
        try:
            return p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        except Exception as e:                 # noqa: BLE001
            last = e
            if "ETXTBSY" in str(e) or "Text file busy" in str(e):
                time.sleep(1.5)
                continue
            raise
    raise last


def _worker_loop():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = None
        try:
            browser = _launch_browser(p)       # eager: warm before the 1st job
        except Exception:                      # noqa: BLE001
            browser = None                     # will launch lazily on first job
        while True:
            html, w, h, scale, reply = _JOB_Q.get()
            try:
                if browser is None or not browser.is_connected():
                    browser = _launch_browser(p)
                pg = browser.new_page(viewport={"width": w, "height": h + 80},
                                      device_scale_factor=scale)
                try:
                    pg.set_content(html, wait_until="load")
                    try:
                        pg.wait_for_function("document.title==='READY'", timeout=15000)
                    except Exception:
                        pass
                    png = pg.screenshot(clip={"x": 0, "y": 0, "width": w, "height": h})
                finally:
                    pg.close()
                reply.put(("ok", png))
            except Exception as e:             # noqa: BLE001
                try:
                    if browser:
                        browser.close()
                except Exception:              # noqa: BLE001
                    pass
                browser = None                 # relaunch on the next job
                reply.put(("err", e))


def _ensure_worker():
    global _WORKER
    with _PW_LOCK:
        if _WORKER is not None and _WORKER.is_alive():
            return
        _ensure_playwright_browser()           # install the binary if missing
        _WORKER = threading.Thread(target=_worker_loop, daemon=True)
        _WORKER.start()


def warmup():
    """Start the render worker (and launch the browser) ahead of the first
    request, so once the service is awake the first render is fast too. Safe to
    call at server startup; a no-op without Playwright (local dev)."""
    try:
        import playwright  # noqa: F401
    except ImportError:
        return
    threading.Thread(target=_ensure_worker, daemon=True).start()


def _render_playwright(html, w, h, scale):
    try:
        import playwright  # noqa: F401
    except ImportError:
        return None
    _ensure_worker()
    reply = queue.Queue()
    _JOB_Q.put((html, w, h, scale, reply))
    try:
        status, payload = reply.get(timeout=90)
    except queue.Empty:
        raise RuntimeError("playwright render timed out")
    if status == "ok":
        return payload
    raise RuntimeError("playwright render failed: %s" % payload)


def _find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.isfile(p):
            return p
    return shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chrome")


def _render_syschrome(html, w, h, scale):
    exe = _find_chrome()
    if not exe:
        return None
    tmp = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8")
    tmp.write(html); tmp.close()
    out = os.path.join(tempfile.gettempdir(), "sub_%d.png" % os.getpid())
    prof = tempfile.mkdtemp(prefix="cr-")
    try:
        subprocess.run([exe, "--headless=new", "--no-sandbox", "--disable-gpu",
                        "--hide-scrollbars", "--force-device-scale-factor=%d" % scale,
                        "--user-data-dir=" + prof, "--virtual-time-budget=6000",
                        "--window-size=%d,%d" % (w, h + 80),
                        "--screenshot=" + out,
                        "file:///" + tmp.name.replace("\\", "/")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    finally:
        try: os.unlink(tmp.name)
        except OSError: pass
    if not os.path.isfile(out):
        return None
    try:
        from PIL import Image
        im = Image.open(out)
        im = im.crop((0, 0, w * scale, h * scale))
        buf = io.BytesIO(); im.save(buf, "PNG"); png = buf.getvalue()
    except Exception:
        with open(out, "rb") as f:
            png = f.read()
    try: os.unlink(out)
    except OSError: pass
    try: shutil.rmtree(prof, ignore_errors=True)
    except Exception: pass
    return png


def render_png(template, data, scale=2):
    """template: user's config; data: fetch_data() result (or None). -> PNG bytes"""
    scale = max(1, min(3, int(scale or 2)))
    w, h = canvas_size(template)
    html = build_page(template, data)
    png = _render_playwright(html, w, h, scale)
    if png:
        return png
    png = _render_syschrome(html, w, h, scale)
    if png:
        return png
    raise RuntimeError(
        "Нет движка рендера: установите Playwright "
        "(pip install playwright && playwright install chromium) или Chrome.")
