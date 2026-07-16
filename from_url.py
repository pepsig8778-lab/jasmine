#!/usr/bin/env python3
"""
from_url.py — CLI: Subito listing URL -> screenshot config JSON (+ optional PNG).

  python from_url.py "https://www.subito.it/.../annuncio.htm"
  python from_url.py "<url>" --render --scale 2 --qr corner

Options: --out DIR, --render, --scale 1|2|3, --qr block|corner|free|product|none,
         --no-qr, --ship-pickup 2,39, --ship-home 5,99,
         --prot-fixed --prot-rate1 --prot-rate2 --prot-cap

Fetching goes through the proxy (SUBITO_PROXY env / proxy.txt); see api/_subito.py.
Everything is editable afterwards in the constructor UI or the JSON.
"""
import sys, os, json, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "api"))
import _subito  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="Subito listing URL -> screenshot config")
    ap.add_argument("url")
    ap.add_argument("--out", default=os.path.join(HERE, "examples"))
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--scale", type=int, default=2, choices=[1, 2, 3])
    ap.add_argument("--qr", default="corner", choices=["block", "corner", "free", "product", "none"])
    ap.add_argument("--no-qr", action="store_true")
    ap.add_argument("--ship-pickup", default="2,39")
    ap.add_argument("--ship-home", default="5,99")
    ap.add_argument("--prot-fixed", type=float, default=1.20)
    ap.add_argument("--prot-rate1", type=float, default=0.05)
    ap.add_argument("--prot-rate2", type=float, default=0.045)
    ap.add_argument("--prot-cap", type=float, default=51.0)
    a = ap.parse_args()

    opts = {
        "qr": "none" if a.no_qr else a.qr,
        "ship_pickup": a.ship_pickup, "ship_home": a.ship_home,
        "prot_fixed": a.prot_fixed, "prot_rate1": a.prot_rate1,
        "prot_rate2": a.prot_rate2, "prot_cap": a.prot_cap,
    }

    print("> fetching", a.url, "(proxy: %s)" % ("on" if _subito.proxy_url() else "off"))
    cfg = _subito.build_config(a.url, opts)
    m = cfg.get("_meta", {})
    print("  title:", m.get("title"))
    print("  price ~%s  protezione ~%s  totale ~%s" %
          (_subito.eur(m.get("price", 0)), _subito.eur(m.get("protezione", 0)), _subito.eur(m.get("total", 0))))

    os.makedirs(a.out, exist_ok=True)
    slug = _subito.slug_from_url(a.url)
    out_json = os.path.join(a.out, slug + ".json")
    cfg.pop("_meta", None)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print("  wrote", out_json)

    if a.render:
        try:
            import batch_render
            chrome = batch_render.find_chrome()
            out_png = os.path.join(a.out, slug + ".png")
            ok = batch_render.render_one(chrome, cfg, out_png, a.scale)
            print("  rendered", out_png if ok else "(FAILED)")
        except Exception as e:  # noqa: BLE001
            print("  ! render failed:", e)
    else:
        print("  tip: --render чтобы получить PNG, или откройте JSON в конструкторе.")


if __name__ == "__main__":
    main()
