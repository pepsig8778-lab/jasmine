/* ============================================================================
 * apply.js — shared, DOM-light logic used by BOTH the editor (app.js) and the
 * server-side API renderer (api/_render.py builds a page that loads this).
 *
 *   SubitoApply.applyListingData(template, data) -> config
 *   SubitoApply.renderQR(qr)                     -> Promise (fills qr.image)
 *   SubitoApply.eurJS(n) / parsePriceJS(s)
 *
 * Keeping this in one place guarantees the API renders EXACTLY what the
 * constructor preview shows.
 * ==========================================================================*/
(function (root) {
  'use strict';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* 1100 -> "1.100,00 €" (Italian format, like the real screen) */
  function eurJS(x) {
    var s = (Math.round(x * 100) / 100).toFixed(2).split('.');
    return s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + s[1] + ' €';
  }
  /* "a partire da 1.100,00 €" -> 1100 */
  function parsePriceJS(s) {
    s = String(s == null ? '' : s).replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
    return parseFloat(s) || 0;
  }

  /* Options for the styled QR renderer, from a qr config. */
  function qrOpts(q) {
    return {
      // no explicit data yet -> encode the link pasted in the Parser, so the
      // QR works in the constructor before anything is parsed
      data: q.data || q.linkOverride, ecl: q.ecl || 'M', scale: 8,
      moduleShape: q.moduleShape || 'square', eyeShape: q.eyeShape || 'square',
      dark: q.dark || '#000000',
      // transparent -> the QR sits directly on the themed card (no white slab)
      light: q.transparentBg ? 'transparent' : (q.light || '#ffffff'),
      eyeColor: q.eyeColor || '', margin: q.margin == null ? 4 : q.margin,
      gradient: q.gradient || 'none', gradientColor: q.gradientColor || q.dark,
      gradientAngle: q.gradientAngle == null ? 45 : q.gradientAngle,
      radius: q.radius || 0, logo: q.logo || '', logoScale: q.logoScale || 0.22
    };
  }

  /* Fill q.image: custom QR stays as-is, generated QR is (re)rendered. */
  function renderQR(q) {
    if (!q) return Promise.resolve();
    if (q.mode === 'custom') { q.image = q.custom || ''; return Promise.resolve(); }
    if ((!q.data && !q.linkOverride) || !root.QR || !root.QR.render) { q.image = ''; return Promise.resolve(); }
    return root.QR.render(qrOpts(q)).then(function (url) { q.image = url; },
                                          function () { q.image = ''; });
  }

  /* Inject listing DATA into the user's template, keeping ALL styling/layout. */
  function applyListingData(base, data) {
    var cfg = clone(base);
    var s = cfg.summary || (cfg.summary = {});
    s.product = s.product || {};
    if (data.image) s.product.image = data.image;
    if (data.title) s.product.title = data.title;

    var rows = s.rows || [];
    function findRow(re) {
      for (var i = 0; i < rows.length; i++) { if (re.test(rows[i].label || '')) return rows[i]; }
      return null;
    }
    var itemRow = findRow(/oggett|item|товар|prezzo|цена/i) || rows[0];
    var protRow = findRow(/protezion|protection|защит/i);
    if (itemRow) itemRow.value = eurJS(data.price);
    if (protRow) protRow.value = eurJS(data.protezione);

    var shipRow = findRow(/spediz|shipping|достав/i);
    var ship = shipRow ? parsePriceJS(shipRow.value) : (data.ship_pickup || 0);
    if (s.total) s.total.value = eurJS(data.price + ship + data.protezione);

    // QR: keep the template's style; custom stays, generated points at the listing
    if (cfg.qr) {
      if (cfg.qr.mode === 'custom') cfg.qr.image = cfg.qr.custom || cfg.qr.image || '';
      // a link pasted in the Parser (qr.linkOverride) wins over the listing URL
      else cfg.qr.data = cfg.qr.linkOverride || data.url;
    }
    return cfg;
  }

  root.SubitoApply = {
    applyListingData: applyListingData, renderQR: renderQR,
    qrOpts: qrOpts, eurJS: eurJS, parsePriceJS: parsePriceJS
  };
})(typeof window !== 'undefined' ? window : this);
