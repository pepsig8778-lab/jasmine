/* ============================================================================
 * builder.js  —  Pure render engine for the "Acquista a distanza" screenshot.
 * Exposes on window:
 *    SCREEN_CSS      : string   (all styles for the screenshot itself)
 *    renderScreen(cfg): sets innerHTML/vars of a .screen node from a config
 *    buildScreenNode(cfg) -> HTMLElement (a fully styled .screen element)
 *    mergeConfig(base, over) -> deep-merged config
 * No framework, no build step. Works from file:// and http://localhost.
 * ==========================================================================*/
(function (root) {
  'use strict';

  /* ----------------------------------------------------------------------- */
  /* Inline SVG icons (stroke follows currentColor)                          */
  /* ----------------------------------------------------------------------- */
  var NS = ' xmlns="http://www.w3.org/2000/svg"';
  var ICONS = {
    close:
      '<svg' + NS + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    info:
      '<svg' + NS + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 10.7v5.4" stroke-linecap="round"/><circle cx="12" cy="7.7" r="1.05" fill="currentColor" stroke="none"/></svg>',
    truck:
      '<svg' + NS + ' viewBox="0 0 26 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10v9H4z"/><path d="M14 10h4.2l3.3 3.2V16H14z"/><circle cx="8" cy="18" r="1.7"/><circle cx="18.2" cy="18" r="1.7"/><path d="M1.5 9.5H4M1 12.5h3" opacity="0.9"/></svg>'
  };

  /* ----------------------------------------------------------------------- */
  /* Screenshot styles                                                        */
  /* ----------------------------------------------------------------------- */
  var SCREEN_CSS = [
'.screen{',
'  position:relative;box-sizing:border-box;overflow:hidden;',
'  background:var(--page-bg);color:var(--text);',
'  font-family:var(--font,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif);',
'  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;',
'  font-size:14px;line-height:1.3;letter-spacing:0;}',
'.screen *{box-sizing:border-box;}',

/* ---- header ---- */
'.sc-header{display:flex;align-items:center;gap:14px;height:52px;',
'  padding:0 16px;background:#fff;}',
'.sc-close{width:21px;height:21px;color:var(--icon);flex:0 0 auto;cursor:default;}',
'.sc-close svg{width:100%;height:100%;display:block;}',
'.sc-title{font-size:18px;font-weight:700;color:var(--text);letter-spacing:.1px;}',
'.sc-header-line{height:1px;background:var(--header-line);}',

/* ---- body ---- */
'.sc-body{padding:27px 16px 16px;}',
'.sc-section-title{font-size:15px;font-weight:700;color:var(--text);',
'  margin:0 2px 9px;letter-spacing:.1px;}',
'.sc-section-title.mt{margin-top:16px;}',

/* ---- card ---- */
'.sc-card{background:var(--card);border:1px solid var(--border);border-radius:var(--card-radius,12px);',
'  box-shadow:0 1px 2px rgba(24,39,75,.05);padding:14px 14px;}',

/* ---- product ---- */
'.sc-product{display:flex;align-items:center;gap:12px;}',
'.sc-product-img{width:44px;height:44px;border-radius:6px;object-fit:cover;',
'  flex:0 0 auto;background:#eceef2;border:1px solid rgba(0,0,0,.04);}',
'.sc-product-title{font-size:13.5px;font-weight:700;color:var(--text);line-height:1.25;}',

'.sc-divider{height:1px;background:var(--divider);margin:11px 0;}',

/* ---- summary rows ---- */
'.sc-rows{display:flex;flex-direction:column;gap:11px;}',
'.sc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
'.sc-row-label{display:inline-flex;align-items:center;gap:6px;font-size:14px;color:var(--text);}',
'.sc-row-info{width:14px;height:14px;color:var(--icon);flex:0 0 auto;}',
'.sc-row-info svg{width:100%;height:100%;display:block;}',
'.sc-row-value{font-size:14px;color:var(--text);white-space:nowrap;}',
'.sc-row-value.muted{color:var(--muted);}',

/* ---- info box ---- */
'.sc-info{display:flex;gap:8px;background:var(--info-bg);border-radius:9px;',
'  padding:10px 12px;margin-top:12px;}',
'.sc-info-ico{width:16px;height:16px;color:var(--info-text);flex:0 0 auto;margin-top:1px;}',
'.sc-info-ico svg{width:100%;height:100%;display:block;}',
'.sc-info-txt{font-size:12px;line-height:1.42;color:var(--info-text);}',
'.sc-info-link{color:var(--info-link);cursor:default;}',

/* ---- total ---- */
'.sc-total{display:flex;align-items:center;justify-content:space-between;}',
'.sc-total .l,.sc-total .v{font-size:15px;font-weight:700;color:var(--text);}',

/* ---- discount ---- */
'.sc-discount{width:100%;height:42px;border:1px solid var(--input-border);',
'  border-radius:22px;background:#fff;display:flex;align-items:center;',
'  padding:0 17px;font-size:14px;color:var(--placeholder);}',
'.sc-discount.filled{color:var(--text);}',

/* ---- shipping ---- */
'.sc-ship-head{display:flex;align-items:center;gap:8px;margin-bottom:12px;}',
'.sc-ship-ico{width:21px;height:19px;color:var(--text);flex:0 0 auto;}',
'.sc-ship-ico svg{width:100%;height:100%;display:block;}',
'.sc-ship-head-title{font-size:15px;font-weight:700;color:var(--text);}',
'.sc-opt{border:1px solid var(--opt-border);border-radius:11px;padding:11px 12px;}',
'.sc-opt+.sc-opt{margin-top:9px;}',
'.sc-opt.selected{border:1.5px solid var(--selected-border);padding:10px 11px;}',
'.sc-opt-badge{display:inline-block;background:var(--badge-bg);color:var(--badge-text);',
'  font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;',
'  padding:3px 7px;border-radius:4px;margin-bottom:7px;}',
'.sc-opt-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
'.sc-opt-title{font-size:14px;font-weight:700;color:var(--text);}',
'.sc-opt-price{font-size:14px;font-weight:700;color:var(--text);white-space:nowrap;}',
'.sc-opt-btn{margin-top:9px;width:100%;height:34px;border:1px solid var(--btn-border);',
'  border-radius:20px;background:#fff;color:var(--red);font-size:14px;font-weight:700;',
'  display:flex;align-items:center;justify-content:center;cursor:default;}',
'.sc-carrier{display:flex;align-items:center;gap:10px;margin-top:11px;}',
'.sc-carrier-txt{font-size:13px;color:var(--muted);}',
'.sc-poste{display:inline-block;background:var(--poste-yellow);color:var(--poste-blue);',
'  border-radius:2px;padding:3px 5px 4px;text-align:left;vertical-align:middle;}',
'.sc-poste .l1{display:block;font-size:11px;font-weight:800;line-height:1.05;letter-spacing:.2px;}',
'.sc-poste .l2{display:block;font-size:8.5px;font-weight:700;line-height:1;letter-spacing:.3px;}',
'.sc-poste-img{height:28px;width:auto;border-radius:2px;display:block;}',

/* ---- fake browser scrollbar ---- */
'.sc-scrollbar{position:absolute;top:0;right:0;width:15px;height:100%;',
'  background:transparent;pointer-events:none;}',
'.sc-scrollbar .track{position:absolute;top:0;right:0;width:15px;height:100%;',
'  background:var(--scrollbar-track);}',
'.sc-scrollbar .thumb{position:absolute;right:3px;width:9px;border-radius:6px;',
'  background:var(--scrollbar-thumb);}',

/* ---- QR code ---- */
'.sc-qr-img{display:block;image-rendering:pixelated;image-rendering:crisp-edges;',
'  border-radius:4px;background:#fff;}',
'.sc-qr-block{display:flex;align-items:center;gap:14px;background:var(--card);',
'  border:1px solid var(--border);border-radius:12px;box-shadow:0 1px 2px rgba(24,39,75,.05);',
'  padding:13px 14px;margin-top:15px;}',
'.sc-qr-block .sc-qr-img{border:1px solid var(--divider);padding:3px;}',
'.sc-qr-cap{font-size:13px;color:var(--muted);line-height:1.4;}',
'.sc-qr-corner,.sc-qr-free{position:absolute;display:flex;flex-direction:column;align-items:center;',
'  gap:4px;background:#fff;border:1px solid var(--border);border-radius:8px;padding:6px;',
'  box-shadow:0 3px 10px rgba(24,39,75,.14);}',
'.sc-qr-free.bare{background:transparent;border:0;box-shadow:none;padding:0;}',
'.sc-qr-corner .sc-qr-cap,.sc-qr-free .sc-qr-cap{font-size:9px;text-align:center;max-width:120px;line-height:1.15;}',
'.sc-qr-inprod{margin-left:auto;flex:0 0 auto;padding-left:10px;}',
'.sc-qr-free[data-qr-drag]{cursor:move;}'
  ].join('\n');

  /* ----------------------------------------------------------------------- */
  /* Helpers                                                                  */
  /* ----------------------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  function mergeConfig(base, over) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!isPlainObject(over)) return over === undefined ? out : over;
    Object.keys(over).forEach(function (k) {
      if (isPlainObject(out[k]) && isPlainObject(over[k])) {
        out[k] = mergeConfig(out[k], over[k]);
      } else {
        out[k] = over[k];
      }
    });
    return out;
  }

  function posteLogo(opt, theme) {
    if (opt.carrierLogo) {
      return '<img class="sc-poste-img" src="' + esc(opt.carrierLogo) + '" alt=""/>';
    }
    return '<span class="sc-poste"><span class="l1">Poste</span><span class="l2">italiane</span></span>';
  }

  /* ---- QR code ---------------------------------------------------------- */
  function qrOn(cfg) {
    var q = cfg && cfg.qr;
    return q && q.show && q.image ? q : null;
  }
  function qrImg(q, extraClass) {
    var s = q.size || 96;
    return '<img class="sc-qr-img' + (extraClass ? ' ' + extraClass : '') + '" src="' +
      esc(q.image) + '" alt="" style="width:' + s + 'px;height:' + s + 'px"/>';
  }
  function buildQRBlock(q) {
    var cap = q.caption ? '<div class="sc-qr-cap">' + esc(q.caption) + '</div>' : '';
    return '<div class="sc-qr-block">' + qrImg(q) + cap + '</div>';
  }
  function buildQRCorner(q) {
    var cap = q.caption ? '<div class="sc-qr-cap">' + esc(q.caption) + '</div>' : '';
    var pos = 'top:' + (q.top == null ? 66 : q.top) + 'px;right:' +
      (q.right == null ? 24 : q.right) + 'px';
    return '<div class="sc-qr-corner" style="' + pos + '">' + qrImg(q) + cap + '</div>';
  }
  function buildQRFree(q) {
    var cap = q.caption ? '<div class="sc-qr-cap">' + esc(q.caption) + '</div>' : '';
    var pos = 'left:' + (q.x == null ? 280 : q.x) + 'px;top:' + (q.y == null ? 96 : q.y) + 'px';
    return '<div class="sc-qr-free' + (q.bare ? ' bare' : '') + '" data-qr-drag="1" style="' +
      pos + '">' + qrImg(q) + cap + '</div>';
  }

  /* ----------------------------------------------------------------------- */
  /* Theme -> CSS variables                                                   */
  /* ----------------------------------------------------------------------- */
  function themeVars(cfg) {
    var t = cfg.theme || {};
    var v = {
      '--page-bg': t.pageBg,
      '--card': t.card,
      '--border': t.border,
      '--divider': t.divider,
      '--header-line': t.headerLine || t.divider,
      '--text': t.text,
      '--muted': t.muted,
      '--icon': t.icon,
      '--red': t.red,
      '--info-bg': t.infoBg,
      '--info-text': t.infoText,
      '--info-link': t.infoLink,
      '--badge-bg': t.badgeBg,
      '--badge-text': t.badgeText,
      '--input-border': t.inputBorder,
      '--placeholder': t.placeholder,
      '--btn-border': t.btnBorder,
      '--selected-border': t.selectedBorder,
      '--opt-border': t.optBorder || t.divider,
      '--poste-yellow': t.posteYellow,
      '--poste-blue': t.posteBlue,
      '--scrollbar-track': t.scrollbarTrack || t.pageBg,
      '--scrollbar-thumb': t.scrollbarThumb
    };
    if (t.font) v['--font'] = t.font;
    if (t.cardRadius != null && t.cardRadius !== '') v['--card-radius'] = t.cardRadius + 'px';
    return Object.keys(v).filter(function (k) { return v[k] != null && v[k] !== ''; })
      .map(function (k) { return k + ':' + v[k]; }).join(';');
  }

  /* ----------------------------------------------------------------------- */
  /* Section builders                                                         */
  /* ----------------------------------------------------------------------- */
  function buildSummary(s, qr) {
    var rows = (s.rows || []).map(function (r) {
      var info = r.info
        ? '<span class="sc-row-info">' + ICONS.info + '</span>' : '';
      return '<div class="sc-row">' +
        '<span class="sc-row-label">' + esc(r.label) + info + '</span>' +
        '<span class="sc-row-value' + (r.muted ? ' muted' : '') + '">' + esc(r.value) + '</span>' +
        '</div>';
    }).join('');

    var info = '';
    if (s.infoBox && s.infoBox.show) {
      var link = s.infoBox.link
        ? ' <span class="sc-info-link">' + esc(s.infoBox.link) + '</span>' : '';
      info = '<div class="sc-info">' +
        '<span class="sc-info-ico">' + ICONS.info + '</span>' +
        '<div class="sc-info-txt">' + esc(s.infoBox.text) + link + '</div>' +
        '</div>';
    }

    var total = s.total ? '<div class="sc-divider"></div>' +
      '<div class="sc-total"><span class="l">' + esc(s.total.label) + '</span>' +
      '<span class="v">' + esc(s.total.value) + '</span></div>' : '';

    var img = s.product && s.product.image
      ? '<img class="sc-product-img" src="' + esc(s.product.image) + '" alt=""/>'
      : '<div class="sc-product-img"></div>';

    var prodQR = (qr && qr.position === 'product')
      ? qrImg(qr, 'sc-qr-inprod') : '';

    return '' +
      (s.title ? '<div class="sc-section-title">' + esc(s.title) + '</div>' : '') +
      '<div class="sc-card">' +
        '<div class="sc-product">' + img +
          '<div class="sc-product-title">' + esc(s.product ? s.product.title : '') + '</div>' +
          prodQR +
        '</div>' +
        '<div class="sc-divider"></div>' +
        '<div class="sc-rows">' + rows + '</div>' +
        info +
        total +
      '</div>';
  }

  function buildDiscount(d) {
    if (!d) return '';
    var filled = d.value ? ' filled' : '';
    var text = d.value ? esc(d.value) : esc(d.placeholder);
    return '' +
      (d.title ? '<div class="sc-section-title mt">' + esc(d.title) + '</div>' : '') +
      '<div class="sc-discount' + filled + '">' + text + '</div>';
  }

  function buildOption(opt, theme) {
    var badge = opt.badge
      ? '<span class="sc-opt-badge">' + esc(opt.badge) + '</span>' : '';
    var btn = opt.button
      ? '<div class="sc-opt-btn">' + esc(opt.button) + '</div>' : '';
    var carrier = opt.carrier
      ? '<div class="sc-carrier">' + posteLogo(opt, theme) +
        '<span class="sc-carrier-txt">' + esc(opt.carrier) + '</span></div>' : '';
    return '<div class="sc-opt' + (opt.selected ? ' selected' : '') + '">' +
      badge +
      '<div class="sc-opt-row">' +
        '<span class="sc-opt-title">' + esc(opt.title) + '</span>' +
        '<span class="sc-opt-price">' + esc(opt.price) + '</span>' +
      '</div>' +
      btn + carrier +
      '</div>';
  }

  function buildShipping(sh, theme) {
    if (!sh) return '';
    var opts = (sh.options || []).map(function (o) { return buildOption(o, theme); }).join('');
    return '<div class="sc-card" style="margin-top:15px">' +
        '<div class="sc-ship-head">' +
          '<span class="sc-ship-ico">' + ICONS.truck + '</span>' +
          '<span class="sc-ship-head-title">' + esc(sh.title) + '</span>' +
        '</div>' + opts +
      '</div>';
  }

  function buildScrollbar(canvas) {
    if (!canvas || canvas.scrollbar === false) return '';
    var top = Math.max(0, Math.min(1, canvas.scrollTop == null ? 0.06 : canvas.scrollTop)) * 100;
    var h = Math.max(0.05, Math.min(1, canvas.scrollThumb == null ? 0.46 : canvas.scrollThumb)) * 100;
    return '<div class="sc-scrollbar"><div class="track"></div>' +
      '<div class="thumb" style="top:' + top + '%;height:' + h + '%"></div></div>';
  }

  /* ----------------------------------------------------------------------- */
  /* Public: build HTML string for the screen inner content                   */
  /* ----------------------------------------------------------------------- */
  function headerHTML(cfg) {
    var h = cfg.header || {};
    if (h.show === false) return '';
    return '<div class="sc-header">' +
      (h.showClose === false ? '' : '<span class="sc-close">' + ICONS.close + '</span>') +
      '<span class="sc-title">' + esc(h.title) + '</span>' +
      '</div><div class="sc-header-line"></div>';
  }

  function renderScreenHTML(cfg) {
    var q = qrOn(cfg);
    var free = (cfg.layout && cfg.layout.free) || {};

    // inner HTML for each draggable block
    var blocks = {
      header: headerHTML(cfg),
      summary: (cfg.summary && cfg.summary.show === false) ? '' : buildSummary(cfg.summary || {}, q),
      discount: (cfg.discount && cfg.discount.show === false) ? '' : buildDiscount(cfg.discount),
      shipping: (cfg.shipping && cfg.shipping.show === false) ? '' : buildShipping(cfg.shipping, cfg.theme)
    };
    function wrap(key, extraClass) {
      return blocks[key]
        ? '<div class="sc-block' + (extraClass || '') + '" data-block="' + key + '">' + blocks[key] + '</div>' : '';
    }

    // header in flow (unless free)
    var flowHeader = (!free.header) ? wrap('header', ' hdr') : '';

    // body: ordered content sections that are NOT free-positioned
    var order = (cfg.layout && cfg.layout.order) || ['summary', 'discount', 'shipping'];
    var bodyInner = order.filter(function (k) { return !free[k]; }).map(function (k) { return wrap(k); }).join('');
    if (q && (q.position == null || q.position === 'block')) bodyInner += buildQRBlock(q);
    var body = '<div class="sc-body">' + bodyInner + '</div>';

    // free-positioned blocks (absolute overlays, draggable)
    var freeHtml = Object.keys(free).map(function (k) {
      if (!blocks[k]) return '';
      var fb = free[k] || {};
      var w = fb.w ? ('width:' + fb.w + 'px;') : '';
      return '<div class="sc-block free' + (k === 'header' ? ' hdr' : '') + '" data-block="' + k +
        '" style="position:absolute;left:' + (fb.x || 0) + 'px;top:' + (fb.y || 0) + 'px;' + w +
        'z-index:20">' + blocks[k] + '</div>';
    }).join('');

    var overlay = '';
    if (q && q.position === 'corner') overlay = buildQRCorner(q);
    else if (q && q.position === 'free') overlay = buildQRFree(q);
    return flowHeader + body + buildScrollbar(cfg.canvas || {}) + freeHtml + overlay;
  }

  /* Apply config to an existing .screen element. Sets style cleanly each call
     (no accumulation) — callers that add their own inline props, e.g. a preview
     `transform`, should re-apply them after this returns. */
  function renderScreen(el, cfg) {
    var c = cfg.canvas || {};
    el.className = 'screen';
    el.setAttribute('style',
      'width:' + (c.width || 418) + 'px;height:' + (c.height || 826) + 'px;' + themeVars(cfg));
    el.innerHTML = renderScreenHTML(cfg);
    return el;
  }

  /* Build a fresh .screen node */
  function buildScreenNode(cfg) {
    var el = document.createElement('div');
    return renderScreen(el, cfg);
  }

  root.SCREEN_CSS = SCREEN_CSS;
  root.renderScreenHTML = renderScreenHTML;
  root.renderScreen = renderScreen;
  root.buildScreenNode = buildScreenNode;
  root.mergeConfig = mergeConfig;
  root.themeVars = themeVars;

})(typeof window !== 'undefined' ? window : this);
