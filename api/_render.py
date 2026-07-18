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
    """Self-contained HTML that renders the final screen and sets title=READY.
    Used only by the system-Chrome fallback (local dev). The Playwright path
    uses a persistent page + _HARNESS instead (see _worker_loop)."""
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


_HARNESS = None


def _harness_html():
    """A page loaded ONCE per Playwright page: the engine JS is parsed a single
    time, then window.__render(template,data) renders any request into #screen
    and resolves when the paint (incl. QR) is done. Rendering thus skips the
    ~200KB re-parse that set_content paid on every request."""
    global _HARNESS
    if _HARNESS is None:
        _HARNESS = (
            '<!doctype html><html><head><meta charset="utf-8"></head>'
            '<body style="margin:0;background:#fff"><div class="screen" id="screen"></div>'
            '<script>' + _asset("config.js") + '</script>'
            '<script>' + _asset("builder.js") + '</script>'
            '<script>' + _asset("qr.js") + '</script>'
            '<script>' + _asset("apply.js") + '</script>'
            '<script>'
            'var st=document.createElement("style");st.textContent=window.SCREEN_CSS;'
            'document.head.appendChild(st);'
            # __render MUST always settle: there is ONE worker thread and
            # page.evaluate has no timeout, so a promise that stays pending
            # would wedge the worker forever. Hence: a single linear chain
            # ending in .catch(fail), plus an in-page watchdog.
            'window.__render=function(template,data){'
            '  return new Promise(function(resolve,reject){'
            '    var settled=false,wd=null;'
            '    function done(v){if(settled)return;settled=true;if(wd)clearTimeout(wd);resolve(v);}'
            '    function fail(e){if(settled)return;settled=true;if(wd)clearTimeout(wd);reject(String(e&&e.message||e));}'
            '    wd=setTimeout(function(){fail("render timeout");},10000);'
            '    try{'
            '      var tpl=window.mergeConfig(window.DEFAULT_CONFIG,template||{});'
            '      var cfg=data?window.SubitoApply.applyListingData(tpl,data):tpl;'
            '      var el=document.getElementById("screen");'
            '      Promise.resolve(window.SubitoApply.renderQR(cfg.qr)).then(function(){'
            '        window.renderScreen(el,cfg);'
            # renderScreen only sets innerHTML — the <img> elements (product
            # photo, QR data-URI, carrier logo) decode ASYNCHRONOUSLY. Capturing
            # before they paint yields a blank/previous-frame image. Wait for
            # decode, but BOUND it (3s) so a slow remote custom image can't stall.
            '        var imgs=[].slice.call(el.querySelectorAll("img"));'
            '        var dec=Promise.all(imgs.map(function(i){'
            '          if(i.complete&&i.naturalWidth>0)return 0;'
            '          return (i.decode?i.decode():Promise.resolve()).catch(function(){});'
            '        }));'
            '        return Promise.race([dec,new Promise(function(r){setTimeout(r,3000);})]);'
            '      }).then(function(){'
            '        requestAnimationFrame(function(){requestAnimationFrame(function(){'
            '          done({w:(cfg.canvas&&cfg.canvas.width)||418,h:(cfg.canvas&&cfg.canvas.height)||826});'
            '        });});'
            '      }).catch(fail);'
            '    }catch(e){fail(e);}'
            '  });'
            '};'
            '</script></body></html>'
        )
    return _HARNESS


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


_PAGE_RECYCLE = 300                            # rebuild a page after N renders (bound memory)


def _worker_loop():
    _ensure_playwright_browser()               # install here — off the request path
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = None
        pages = {}                             # scale -> [page, render_count]
        try:
            browser = _launch_browser(p)       # eager: warm before the 1st job
        except Exception:                      # noqa: BLE001
            browser = None                     # will launch lazily on first job

        def new_page(scale):
            pg = browser.new_page(viewport={"width": 480, "height": 900},
                                  device_scale_factor=scale)
            pg.set_content(_harness_html(), wait_until="load")
            pg.wait_for_function("typeof window.__render==='function'", timeout=15000)
            return pg

        def get_page(scale):
            slot = pages.get(scale)
            pg = slot[0] if slot else None
            try:
                dead = pg is None or pg.is_closed() or slot[1] >= _PAGE_RECYCLE
            except Exception:                  # noqa: BLE001
                dead = True
            if dead:
                try:
                    if pg is not None:
                        pg.close()             # recycle: free the churned DOM/data-URLs
                except Exception:              # noqa: BLE001
                    pass
                pg = new_page(scale)
                pages[scale] = [pg, 0]
            return pages[scale]

        while True:
            template, data, w, h, scale, reply = _JOB_Q.get()
            try:
                if browser is None or not browser.is_connected():
                    browser = _launch_browser(p)
                    pages = {}                 # stale pages belonged to the dead browser
                slot = get_page(scale)
                pg = slot[0]
                pg.set_viewport_size({"width": max(int(w), 100), "height": max(int(h) + 40, 100)})
                # __render always settles (linear chain + in-page watchdog), so
                # this evaluate can never wedge the sole worker.
                pg.evaluate("(a) => window.__render(a.t, a.d)", {"t": template, "d": data})
                png = pg.locator("#screen").screenshot(type="png")
                slot[1] += 1
                reply.put(("ok", png))
            except Exception as e:             # noqa: BLE001
                # a crashed page/browser: drop everything so the next job relaunches
                try:
                    if browser:
                        browser.close()
                except Exception:              # noqa: BLE001
                    pass
                browser = None
                pages = {}
                reply.put(("err", e))


def _ensure_worker():
    global _WORKER
    # Hold the lock only to start the thread (fast). The browser install +
    # launch happen INSIDE the worker, off the request path, so a slow
    # first-time install never blocks unrelated render requests on this lock.
    with _PW_LOCK:
        if _WORKER is not None and _WORKER.is_alive():
            return
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


def _render_playwright(template, data, w, h, scale):
    try:
        import playwright  # noqa: F401
    except ImportError:
        return None
    _ensure_worker()
    reply = queue.Queue()
    _JOB_Q.put((template, data, w, h, scale, reply))
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
    # Fast path: persistent Playwright page (engine pre-loaded) renders from
    # template+data directly.
    png = _render_playwright(template, data, w, h, scale)
    if png:
        return png
    # Fallback (local dev / no Playwright): system Chrome on a built HTML page.
    png = _render_syschrome(build_page(template, data), w, h, scale)
    if png:
        return png
    raise RuntimeError(
        "Нет движка рендера: установите Playwright "
        "(pip install playwright && playwright install chromium) или Chrome.")
