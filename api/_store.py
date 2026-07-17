"""
_store.py — API key + published template storage.

API key:
  1. env API_KEY            <- use this on a host (stable, secret)
  2. .apikey file           <- auto-generated for local dev (gitignored)

Template (what the API renders with), first match wins:
  1. published at runtime via POST /api/template   (fast; lost on restart)
  2. env SUBITO_TEMPLATE  (JSON)                   (persistent)
  3. template.json in the repo                     (persistent)
  4. the built-in default template
"""
import os, json, secrets, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RUNTIME = os.path.join(tempfile.gettempdir(), "subito_template.json")


def get_api_key():
    k = (os.environ.get("API_KEY") or "").strip()
    if k:
        return k, "env"
    p = os.path.join(ROOT, ".apikey")
    try:
        with open(p, "r", encoding="utf-8") as f:
            v = f.read().strip()
        if v:
            return v, "file"
    except OSError:
        pass
    v = secrets.token_urlsafe(24)
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write(v)
    except OSError:
        pass
    return v, "file"


def check_key(k):
    if not k:
        return False
    try:
        return secrets.compare_digest(str(k), get_api_key()[0])
    except Exception:
        return False


def load_template():
    try:
        with open(RUNTIME, "r", encoding="utf-8") as f:
            return json.load(f), "published"
    except Exception:
        pass
    env = os.environ.get("SUBITO_TEMPLATE")
    if env:
        try:
            return json.loads(env), "env"
        except Exception:
            pass
    try:
        with open(os.path.join(ROOT, "template.json"), "r", encoding="utf-8") as f:
            return json.load(f), "template.json"
    except Exception:
        pass
    return {}, "default"


def save_template(cfg):
    with open(RUNTIME, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False)
    return RUNTIME
