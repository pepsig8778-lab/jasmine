#!/usr/bin/env python3
"""
batch_render.py — Automate screenshot generation from JSON configs.

Renders one or many "Acquista a distanza" screenshots to PNG using headless
Chrome/Edge and the same builder.js render engine the UI uses. No server needed.

USAGE
  python batch_render.py config1.json [config2.json ...] [options]
  python batch_render.py configs/*.json --out out/ --scale 2

Each JSON file is a FULL or PARTIAL config (same shape as "Scarica JSON" from the
UI). Anything you omit falls back to the default screenshot. Example partial:

  { "header": { "title": "Buy it now" },
    "summary": { "product": { "image": "photos/card.png",
                              "title": "Charizard VMAX 074/073" },
                 "total": { "value": "£ 1.272,49" } } }

IMAGE PATHS: summary.product.image and shipping.options[].carrierLogo may be a
local file path (png/jpg/webp/svg) OR a data: URL OR an http(s) URL. Local paths
are auto-embedded so the PNG is self-contained.

OPTIONS
  --out DIR      output directory (default: ./out)
  --scale N      pixel scale, 1/2/3 (default: 2)
  --chrome PATH  explicit Chrome/Edge binary
"""
import sys, os, json, base64, subprocess, tempfile, mimetypes, argparse, glob

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome(explicit=None):
    if explicit:
        return explicit
    for p in CHROME_CANDIDATES:
        if os.path.isfile(p):
            return p
    raise SystemExit("Chrome/Edge not found. Pass --chrome <path>.")


def to_file_url(path):
    return "file:///" + os.path.abspath(path).replace("\\", "/")


def embed_image(val):
    """Turn a local image path into a data URL; pass through data:/http(s)."""
    if not isinstance(val, str) or not val:
        return val
    if val.startswith(("data:", "http:", "https:")):
        return val
    if os.path.isfile(val):
        mime = mimetypes.guess_type(val)[0] or "image/png"
        with open(val, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        return "data:%s;base64,%s" % (mime, b64)
    print("  ! image not found, leaving as-is:", val)
    return val


def resolve_images(cfg):
    s = cfg.get("summary", {})
    prod = s.get("product") if isinstance(s.get("product"), dict) else None
    if prod and "image" in prod:
        prod["image"] = embed_image(prod["image"])
    for opt in (cfg.get("shipping", {}) or {}).get("options", []) or []:
        if isinstance(opt, dict) and opt.get("carrierLogo"):
            opt["carrierLogo"] = embed_image(opt["carrierLogo"])
    return cfg


PAGE_TMPL = """<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fff">
<div class="screen" id="screen"></div>
<script src="{config_js}"></script>
<script src="{builder_js}"></script>
<script>
  var st=document.createElement('style');st.textContent=window.SCREEN_CSS;
  document.head.appendChild(st);
  var patch={patch_json};
  var cfg=window.mergeConfig(window.DEFAULT_CONFIG, patch);
  window.renderScreen(document.getElementById('screen'), cfg);
  document.title='READY';
</script>
</body></html>"""


def render_one(chrome, patch, out_png, scale):
    patch = resolve_images(patch)
    canvas = patch.get("canvas", {}) or {}
    w = int(canvas.get("width", 418))
    h = int(canvas.get("height", 826))
    html = PAGE_TMPL.format(
        config_js=to_file_url(os.path.join(ASSETS, "config.js")),
        builder_js=to_file_url(os.path.join(ASSETS, "builder.js")),
        patch_json=json.dumps(patch, ensure_ascii=False),
    )
    tmp = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False,
                                      dir=HERE, encoding="utf-8")
    tmp.write(html); tmp.close()
    prof = tempfile.mkdtemp(prefix="cr-")
    # Render with vertical headroom, then crop to the exact canvas height. Chrome
    # headless can drop the last flex line when window height == content height.
    pad = 80
    try:
        cmd = [chrome, "--headless=new", "--no-sandbox", "--disable-gpu",
               "--hide-scrollbars", "--force-device-scale-factor=%d" % scale,
               "--user-data-dir=" + prof, "--virtual-time-budget=4000",
               "--window-size=%d,%d" % (w, h + pad),
               "--screenshot=" + os.path.abspath(out_png), to_file_url(tmp.name)]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        try: os.unlink(tmp.name)
        except OSError: pass
    if os.path.isfile(out_png):
        try:
            from PIL import Image
            im = Image.open(out_png)
            im.crop((0, 0, w * scale, h * scale)).save(out_png)
        except Exception:
            pass
        return True
    return False


def main():
    ap = argparse.ArgumentParser(description="Render config JSON -> PNG screenshots")
    ap.add_argument("configs", nargs="+", help="config JSON file(s); globs ok")
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--scale", type=int, default=2, choices=[1, 2, 3])
    ap.add_argument("--chrome", default=None)
    args = ap.parse_args()

    chrome = find_chrome(args.chrome)
    os.makedirs(args.out, exist_ok=True)

    files = []
    for pat in args.configs:
        files.extend(glob.glob(pat) if any(c in pat for c in "*?[") else [pat])
    if not files:
        raise SystemExit("No config files matched.")

    ok = 0
    for path in files:
        name = os.path.splitext(os.path.basename(path))[0]
        out_png = os.path.join(args.out, name + ".png")
        try:
            with open(path, "r", encoding="utf-8") as f:
                patch = json.load(f)
        except Exception as e:
            print("x %-30s bad JSON: %s" % (name, e)); continue
        print("> %s -> %s (scale %d)" % (name, out_png, args.scale))
        if render_one(chrome, patch, out_png, args.scale):
            ok += 1; print("  done")
        else:
            print("  FAILED (no PNG produced)")
    print("\n%d/%d rendered into %s" % (ok, len(files), args.out))


if __name__ == "__main__":
    main()
