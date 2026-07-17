/* ============================================================================
 * app.js — Constructor UI: schema-light form generator + live preview + export.
 * Depends on: config.js (DEFAULT_CONFIG), builder.js (renderScreen, SCREEN_CSS,
 * renderScreenHTML, themeVars, mergeConfig).
 * ==========================================================================*/
(function () {
  'use strict';

  var LS_KEY = 'subito-constructor-v1';

  /* ---- deep clone / path helpers -------------------------------------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function getPath(obj, path) {
    return path.split('.').reduce(function (a, k) {
      return a == null ? a : a[/^\d+$/.test(k) ? Number(k) : k];
    }, obj);
  }
  function setPath(obj, path, val) {
    var parts = path.split('.');
    var last = parts.pop();
    var tgt = parts.reduce(function (a, k) {
      var key = /^\d+$/.test(k) ? Number(k) : k;
      if (a[key] == null) a[key] = {};
      return a[key];
    }, obj);
    tgt[/^\d+$/.test(last) ? Number(last) : last] = val;
  }

  /* ---- state ----------------------------------------------------------- */
  /* The user's template lives in the browser (localStorage), so a new DEPLOY
     never resets it: new code just merges any NEW default fields UNDER the
     saved template — the user's own edits always win. */
  var LS_BACKUP = LS_KEY + ':backup';
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  /* The renderer falls back to CUSTOM_DEFAULTS, so an unset prop still DRAWS a
     value — but the panel reads state and would show empty/wrong. Materialise
     the defaults so panel and canvas always agree. */
  function fillCustomDefaults(cfg) {
    (cfg.custom || []).forEach(function (c) {
      var d = (window.CUSTOM_DEFAULTS || {})[c.type] || {};
      Object.keys(d).forEach(function (k) { if (c[k] === undefined) c[k] = d[k]; });
      if (c.z == null) c.z = 30;
    });
    return cfg;
  }
  function loadState() {
    var raw = lsGet(LS_KEY);
    if (!raw) return fillCustomDefaults(clone(window.DEFAULT_CONFIG));
    try {
      // saved OVER defaults -> new fields appear, user's settings are kept
      return fillCustomDefaults(window.mergeConfig(clone(window.DEFAULT_CONFIG), JSON.parse(raw)));
    } catch (e) {
      lsSet(LS_BACKUP, raw);          // corrupt: keep a copy, never lose it silently
      return fillCustomDefaults(clone(window.DEFAULT_CONFIG));
    }
  }
  var state = loadState();

  function backupState() { return lsSet(LS_BACKUP, JSON.stringify(state)); }
  function hasBackup() { return !!lsGet(LS_BACKUP); }

  /* ---- change journal (undo / redo by steps) --------------------------- */
  var hist = [], histIdx = -1, restoring = false;
  var pendingLabel = 'Изменение', pendingCoalesce = null, lastCK = null, lastT = 0;
  var HIST_MAX = 80;

  function markChange(label, coalesceKey) {   // handlers call this before rendering
    pendingLabel = label || 'Изменение';
    pendingCoalesce = coalesceKey || null;
  }
  function snapshot(label, ck) {
    var json = JSON.stringify(state);
    if (histIdx >= 0 && hist[histIdx].json === json) return;   // nothing actually changed
    var now = Date.now();
    if (ck && ck === lastCK && (now - lastT) < 900 && histIdx >= 0) {
      hist[histIdx] = { json: json, label: label, t: now };     // coalesce fast typing
    } else {
      hist.length = histIdx + 1;                                // drop the redo tail
      hist.push({ json: json, label: label, t: now });
      histIdx = hist.length - 1;
      if (hist.length > HIST_MAX) { hist.shift(); histIdx--; }
    }
    lastCK = ck; lastT = now;
    updateHistUI();
  }
  function persist() {
    lsSet(LS_KEY, JSON.stringify(state));
    if (!restoring) snapshot(pendingLabel, pendingCoalesce);
    pendingLabel = 'Изменение'; pendingCoalesce = null;
  }
  function restoreTo(i) {
    if (i < 0 || i >= hist.length || i === histIdx) return;
    restoring = true;
    histIdx = i;
    state = JSON.parse(hist[i].json);
    genQR().then(function () {
      rebuildForm(); renderPreview();
      restoring = false; updateHistUI(); updateRestoreBtn();
    });
  }
  function undo() { if (histIdx > 0) { restoreTo(histIdx - 1); flash('Отменено: ' + hist[histIdx].label); } }
  function redo() { if (histIdx < hist.length - 1) restoreTo(histIdx + 1); }

  function agoStr(t) {
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return s + ' с';
    if (s < 3600) return Math.round(s / 60) + ' мин';
    return Math.round(s / 3600) + ' ч';
  }
  function updateHistUI() {
    var u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
    if (u) u.disabled = histIdx <= 0;
    if (r) r.disabled = histIdx >= hist.length - 1;
    var m = document.getElementById('histMenu');
    if (!m || !m.classList.contains('open')) return;
    var rows = '';
    for (var i = hist.length - 1; i >= 0; i--) {                // newest first
      rows += '<div class="hist-item' + (i === histIdx ? ' now' : (i > histIdx ? ' future' : '')) +
        '" data-hist="' + i + '"><span class="lbl">' + (i === histIdx ? '● ' : '') +
        esc(hist[i].label) + '</span><span class="t">' + agoStr(hist[i].t) + '</span></div>';
    }
    m.innerHTML = '<div class="hh">Журнал изменений — кликните, чтобы вернуться</div>' + rows;
  }

  /* ---- DOM refs -------------------------------------------------------- */
  var preview = document.getElementById('preview');
  var controls = document.getElementById('controls');
  var canvasWrap = document.getElementById('canvasWrap');
  var zoom = 1;

  /* Inject screenshot CSS once. */
  var st = document.createElement('style');
  st.textContent = window.SCREEN_CSS;
  document.head.appendChild(st);

  /* ---- render preview -------------------------------------------------- */
  var fitNeed = 0;
  /* Warn when content doesn't fit the fixed canvas (it gets silently cropped,
     e.g. after adding rows or turning the QR "block" on). */
  function updateFitWarn() {
    var box = document.getElementById('fitWarn');
    if (!box) return;
    var body = preview.querySelector('.sc-body');
    var need = body ? body.offsetTop + body.scrollHeight : 0;
    Array.prototype.forEach.call(preview.querySelectorAll('[data-block].free'), function (el) {
      need = Math.max(need, el.offsetTop + el.offsetHeight);
    });
    fitNeed = Math.ceil(need) + 6;
    var over = fitNeed > (state.canvas.height || 826) + 1;
    box.style.display = over ? 'flex' : 'none';
    if (over) document.getElementById('fitMsg').textContent =
      '⚠ Контент обрезан (нужно ' + fitNeed + 'px)';
  }
  function renderPreview() {
    window.renderScreen(preview, state);
    preview.style.transform = 'scale(' + zoom + ')';
    canvasWrap.style.width = (state.canvas.width * zoom) + 'px';
    canvasWrap.style.height = (state.canvas.height * zoom) + 'px';
    if (selId) {
      var se = preview.querySelector('[data-custom="' + selId + '"]');
      if (se) se.classList.add('sel');
    }
    positionSelBar();
    updateFitWarn();
    persist();
  }

  /* ---- form building blocks ------------------------------------------- */
  function el(html) {
    var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fText(label, path, opts) {
    opts = opts || {};
    var v = getPath(state, path);
    var input = opts.area
      ? '<textarea data-path="' + path + '" rows="' + (opts.rows || 3) + '">' + esc(v) + '</textarea>'
      : '<input type="text" data-path="' + path + '" value="' + esc(v) + '"' +
        (opts.ph ? ' placeholder="' + esc(opts.ph) + '"' : '') + '>';
    return '<label class="fld"><span class="fld-l">' + esc(label) + '</span>' + input + '</label>';
  }
  function fNum(label, path, min, max, step) {
    var v = getPath(state, path);
    return '<label class="fld"><span class="fld-l">' + esc(label) + '</span>' +
      '<input type="number" data-path="' + path + '" value="' + esc(v) + '" min="' + min +
      '" max="' + max + '" step="' + (step || 1) + '"></label>';
  }
  function fRange(label, path, min, max, step) {
    var v = getPath(state, path);
    return '<label class="fld"><span class="fld-l">' + esc(label) +
      ' <b>' + v + '</b></span>' +
      '<input type="range" data-path="' + path + '" value="' + esc(v) + '" min="' + min +
      '" max="' + max + '" step="' + (step || 1) + '"></label>';
  }
  function fCheck(label, path) {
    var v = getPath(state, path);
    return '<label class="chk"><input type="checkbox" data-path="' + path + '"' +
      (v ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
  }
  function fColor(label, path) {
    var v = getPath(state, path) || '#000000';
    return '<label class="fld color"><span class="fld-l">' + esc(label) + '</span>' +
      '<span class="color-wrap"><input type="color" data-path="' + path + '" value="' + esc(v) + '">' +
      '<input type="text" class="hex" data-path="' + path + '" value="' + esc(v) + '"></span></label>';
  }
  function fSelect(label, path, options) {
    var v = getPath(state, path);
    var opts = options.map(function (o) {
      var val = o.v == null ? o : o.v, lab = o.l == null ? o : o.l;
      return '<option value="' + esc(val) + '"' + (String(v) === String(val) ? ' selected' : '') +
        '>' + esc(lab) + '</option>';
    }).join('');
    return '<label class="fld"><span class="fld-l">' + esc(label) + '</span>' +
      '<select data-path="' + path + '" data-select="1">' + opts + '</select></label>';
  }
  /* Full rich editor right in the panel: type, append, select a part and format
     it — exactly like on the canvas. Never a read-only "notice". */
  function hasRich(v) { return /<(b|strong|i|em|u|s|span)\b/i.test(String(v || '')); }
  function fRichText(label, path, opts) {
    opts = opts || {};
    var v = String(getPath(state, path) == null ? '' : getPath(state, path));
    var minH = (opts.rows || 2) * 19 + 12;
    return '<div class="fld"><span class="fld-l">' + esc(label) + '</span>' +
      '<div class="rich-input" contenteditable="true" data-rich="' + path + '" ' +
        'style="min-height:' + minH + 'px">' + window.sanitizeRich(v) + '</div>' +
      '<div class="rich-hint">Выделите часть текста → панель <b>B / A+ / 🎨</b>' +
        (hasRich(v) ? ' · <button class="lnk" data-act="stripRich" data-path="' + path +
          '">убрать форматирование</button>' : '') + '</div></div>';
  }

  /* optional colour: empty = inherit from theme (no misleading black swatch) */
  function fColorOpt(label, path, fallback) {
    var v = getPath(state, path);
    var on = !!v;
    return '<div class="fld color"><span class="fld-l">' + esc(label) + '</span>' +
      '<div class="color-wrap">' +
      '<label class="chk mini" title="Свой цвет или наследовать из темы">' +
        '<input type="checkbox" data-act="optColor" data-path="' + path + '" data-fb="' +
        esc(fallback || '#3c4858') + '"' + (on ? ' checked' : '') + '><span>свой</span></label>' +
      (on ? '<input type="color" data-path="' + path + '" value="' + esc(v) + '">' +
            '<input type="text" class="hex" data-path="' + path + '" value="' + esc(v) + '">'
          : '<span class="opt-auto">из темы</span>') +
      '</div></div>';
  }
  function fFile(label, path, opts) {
    opts = opts || {};
    var v = getPath(state, path);
    var thumb = v ? '<img class="thumb" src="' + esc(v) + '" alt="">' : '<span class="thumb empty">—</span>';
    return '<div class="fld file"><span class="fld-l">' + esc(label) + '</span>' +
      '<div class="file-row">' + thumb +
      '<label class="btn sm file-btn">Загрузить<input type="file" accept="image/*" data-file="' + path + '"></label>' +
      (v && opts.clear ? '<button class="btn sm ghost" data-act="clear" data-path="' + path + '">Убрать</button>' : '') +
      '</div></div>';
  }
  function section(title, inner, open) {
    return '<details class="sec"' + (open ? ' open' : '') + '><summary>' + esc(title) +
      '</summary><div class="sec-body">' + inner + '</div></details>';
  }

  /* ---- dynamic list editors ------------------------------------------- */
  function reorderBtns(kind, i, n) {
    return '<span class="reorder">' +
      '<button class="btn xs ghost" data-act="up" data-kind="' + kind + '" data-i="' + i + '"' +
        (i === 0 ? ' disabled' : '') + ' title="Вверх">↑</button>' +
      '<button class="btn xs ghost" data-act="down" data-kind="' + kind + '" data-i="' + i + '"' +
        (i === n - 1 ? ' disabled' : '') + ' title="Вниз">↓</button></span>';
  }
  function rowEditor(r, i, n) {
    return '<div class="item"><div class="item-h"><b>Строка ' + (i + 1) + '</b>' +
      '<span class="item-actions">' + reorderBtns('row', i, n) +
      '<button class="btn xs ghost" data-act="delRow" data-i="' + i + '">✕</button></span></div>' +
      fText('Название', 'summary.rows.' + i + '.label') +
      fText('Значение', 'summary.rows.' + i + '.value') +
      '<div class="chk-row">' + fCheck('Иконка info (i)', 'summary.rows.' + i + '.info') +
      fCheck('Приглушённый текст', 'summary.rows.' + i + '.muted') + '</div></div>';
  }
  function optEditor(o, i, n) {
    return '<div class="item"><div class="item-h"><b>Опция ' + (i + 1) + '</b>' +
      '<span class="item-actions">' + reorderBtns('opt', i, n) +
      '<button class="btn xs ghost" data-act="delOpt" data-i="' + i + '">✕</button></span></div>' +
      '<div class="chk-row">' + fCheck('Выбрана (тёмная рамка)', 'shipping.options.' + i + '.selected') + '</div>' +
      fText('Бейдж (пусто = нет)', 'shipping.options.' + i + '.badge') +
      fText('Заголовок', 'shipping.options.' + i + '.title') +
      fText('Цена', 'shipping.options.' + i + '.price') +
      fText('Текст кнопки (пусто = нет)', 'shipping.options.' + i + '.button') +
      fText('Перевозчик (пусто = нет)', 'shipping.options.' + i + '.carrier') +
      fFile('Логотип перевозчика (пусто = Poste)', 'shipping.options.' + i + '.carrierLogo', { clear: true }) +
      '</div>';
  }
  var SECTION_LABELS = { header: 'Шапка', summary: 'Сводка заказа', discount: 'Промокод', shipping: 'Доставка' };
  function sectionRow(k, i, n) {
    var free = (state.layout && state.layout.free) || {};
    var isFree = !!free[k];
    var showPath = k + '.show';
    var shown = getPath(state, showPath) !== false;
    var move = k === 'header' ? '' :
      '<button class="btn xs ghost" data-act="up" data-kind="sec" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="btn xs ghost" data-act="down" data-kind="sec" data-i="' + i + '"' + (i === n - 1 ? ' disabled' : '') + '>↓</button>';
    return '<div class="item ord"><span class="ord-name">' + esc(SECTION_LABELS[k] || k) +
      (isFree ? ' <span class="tag-free">своб.</span>' : '') + '</span>' +
      '<span class="item-actions">' +
      '<label class="chk mini"><input type="checkbox" data-path="' + showPath + '"' + (shown ? ' checked' : '') + '><span>вид.</span></label>' +
      '<button class="btn xs ghost' + (isFree ? ' on' : '') + '" data-act="toggleFree" data-key="' + k + '" title="Свободное перетаскивание">✥</button>' +
      move + '</span></div>';
  }
  function layoutEditor() {
    var order = (state.layout && state.layout.order) || ['summary', 'discount', 'shipping'];
    var rows = sectionRow('header', 0, 1) + order.map(function (k, i) { return sectionRow(k, i, order.length); }).join('');
    return '<div class="hint">✥ — сделать раздел «свободным»: тогда его можно ' +
      '<b>таскать мышью в любое место</b> прямо на превью. ↑↓ — порядок в потоке, «вид.» — показать/скрыть.</div>' +
      rows +
      '<button class="btn sm ghost" data-act="resetLayout" style="width:100%;margin-top:10px">Сбросить раскладку</button>';
  }

  var QR_POS = [['block', 'Блок'], ['corner', 'Угол'], ['free', 'Свободно'], ['product', 'В товаре']];
  function posPills(cur) {
    return '<div class="fld"><span class="fld-l">Позиция QR</span><div class="pills">' +
      QR_POS.map(function (o) {
        return '<button class="pill' + (cur === o[0] ? ' active' : '') +
          '" data-act="qrPos" data-pos="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div></div>';
  }
  function qrPills(label, path, options) {
    var cur = getPath(state, path);
    return '<div class="fld"><span class="fld-l">' + esc(label) + '</span><div class="pills">' +
      options.map(function (o) {
        return '<button class="pill' + (String(cur) === String(o[0]) ? ' active' : '') +
          '" data-act="qrpill" data-path="' + path + '" data-val="' + esc(o[0]) + '">' + esc(o[1]) + '</button>';
      }).join('') + '</div></div>';
  }
  var QR_PRESETS = {
    classic: { label: 'Классика', set: { moduleShape: 'square', eyeShape: 'square', gradient: 'none', dark: '#000000', light: '#ffffff', eyeColor: '', logo: '' } },
    dots: { label: 'Точки', set: { moduleShape: 'dots', eyeShape: 'circle', gradient: 'none', dark: '#111827', light: '#ffffff', eyeColor: '' } },
    rounded: { label: 'Скругл.', set: { moduleShape: 'rounded', eyeShape: 'rounded', gradient: 'none', dark: '#1f2937', light: '#ffffff', eyeColor: '' } },
    gradient: { label: 'Градиент', set: { moduleShape: 'rounded', eyeShape: 'rounded', gradient: 'linear', dark: '#6a5cff', gradientColor: '#c026d3', gradientAngle: 45, light: '#ffffff', eyeColor: '' } },
    neon: { label: 'Неон', set: { moduleShape: 'dots', eyeShape: 'circle', gradient: 'linear', dark: '#22d3ee', gradientColor: '#a855f7', light: '#0b1020', eyeColor: '#22d3ee' } },
    ocean: { label: 'Океан', set: { moduleShape: 'rounded', eyeShape: 'circle', gradient: 'radial', dark: '#0ea5e9', gradientColor: '#1d4ed8', light: '#ffffff', eyeColor: '' } },
    fire: { label: 'Огонь', set: { moduleShape: 'diamond', eyeShape: 'rounded', gradient: 'linear', dark: '#f59e0b', gradientColor: '#ef4444', gradientAngle: 90, light: '#ffffff', eyeColor: '#ef4444' } },
    mono: { label: 'Инверт', set: { moduleShape: 'square', eyeShape: 'square', gradient: 'none', dark: '#ffffff', light: '#0b1020', eyeColor: '' } }
  };
  function qrSection(q) {
    q = q || {};
    var mode = q.mode || 'generated';
    var pos = q.position || 'block';
    var thumb = '<div class="qr-prev big"><img src="' + esc(q.image || '') + '" alt=""></div>';
    var modeTabs = '<div class="pills mode">' +
      '<button class="pill' + (mode === 'generated' ? ' active' : '') + '" data-act="qrMode" data-val="generated">⚙ Сгенерировать</button>' +
      '<button class="pill' + (mode === 'custom' ? ' active' : '') + '" data-act="qrMode" data-val="custom">🖼 Своя картинка</button>' +
      '</div>';

    var genUI =
      fText('Данные (ссылка или текст)', 'qr.data', { area: true, rows: 2 }) +
      '<div class="fld"><span class="fld-l">Пресеты стиля</span><div class="pills wrap">' +
        Object.keys(QR_PRESETS).map(function (k) {
          return '<button class="pill" data-act="qrPreset" data-preset="' + k + '">' + esc(QR_PRESETS[k].label) + '</button>';
        }).join('') + '</div></div>' +
      qrPills('Форма модулей', 'qr.moduleShape', [['square', 'Квадраты'], ['dots', 'Точки'], ['rounded', 'Скругл.'], ['diamond', 'Ромбы']]) +
      qrPills('Форма «глаз»', 'qr.eyeShape', [['square', 'Квадрат'], ['rounded', 'Скругл.'], ['circle', 'Круг']]) +
      '<div class="grid2">' + fColor('Цвет модулей', 'qr.dark') +
        (q.transparentBg ? '<div class="fld"><span class="fld-l">Фон QR</span>' +
            '<div class="hint" style="padding:7px 0 0">прозрачный — виден фон карточки</div></div>'
          : fColor('Фон QR', 'qr.light')) + '</div>' +
      fCheck('Прозрачный фон QR (наследует тему)', 'qr.transparentBg') +
      '<div class="grid2">' + fColor('Цвет «глаз»', 'qr.eyeColor') +
        fSelect('Градиент', 'qr.gradient', [{ v: 'none', l: 'Нет' }, { v: 'linear', l: 'Линейный' }, { v: 'radial', l: 'Радиальный' }]) + '</div>' +
      (q.gradient && q.gradient !== 'none'
        ? '<div class="grid2">' + fColor('Цвет 2', 'qr.gradientColor') + fRange('Угол', 'qr.gradientAngle', 0, 360, 5) + '</div>' : '') +
      '<div class="grid2">' + fSelect('Коррекция', 'qr.ecl', [
        { v: 'L', l: 'L 7%' }, { v: 'M', l: 'M 15%' }, { v: 'Q', l: 'Q 25%' }, { v: 'H', l: 'H 30%' }]) +
        fRange('Отступ (модули)', 'qr.margin', 0, 10, 1) + '</div>' +
      '<div class="sub">Логотип по центру</div>' +
      fFile('Картинка логотипа', 'qr.logo', { clear: true }) +
      (q.logo ? fRange('Размер лого', 'qr.logoScale', 0.1, 0.33, 0.01) : '') +
      '<div class="qr-actions">' +
        '<button class="btn sm ghost" data-act="qrRegen">Обновить QR</button>' +
        '<button class="btn sm ghost" data-act="qrDownload">Скачать QR</button></div>';

    var customUI =
      '<div class="hint">Загрузите свою картинку QR — она будет использоваться «как есть», ' +
      'и в парсере тоже <b>не заменяется</b> сгенерированным.</div>' +
      fFile('Своя картинка QR', 'qr.custom', { clear: true });

    var posFields =
      pos === 'corner' ? '<div class="grid2">' + fNum('Отступ сверху', 'qr.top', 0, 1200, 1) +
          fNum('Отступ справа', 'qr.right', 0, 400, 1) + '</div>'
      : pos === 'free' ? '<div class="grid2">' + fNum('X (слева)', 'qr.x', 0, 900, 1) +
          fNum('Y (сверху)', 'qr.y', 0, 1600, 1) + '</div>' + fCheck('Без рамки/фона', 'qr.bare') +
          '<div class="hint">💡 Перетаскивайте QR прямо на превью в любое место.</div>'
      : '';

    return fCheck('Показывать QR-код', 'qr.show') +
      thumb + modeTabs +
      (mode === 'custom' ? customUI : genUI) +
      '<div class="sub">Размещение</div>' + posPills(pos) + posFields +
      '<div class="grid2">' + fRange('Размер', 'qr.size', 40, 300, 2) +
        fRange('Скругление углов', 'qr.radius', 0, 40, 1) + '</div>' +
      fText('Подпись', 'qr.caption');
  }

  /* ---- editor for user-added elements ---------------------------------- */
  var FONTS = [{ v: '', l: 'Как в шаблоне' }, { v: 'Arial, Helvetica, sans-serif', l: 'Arial' },
    { v: '"Segoe UI", system-ui, sans-serif', l: 'Segoe UI' },
    { v: '"Roboto", "Segoe UI", sans-serif', l: 'Roboto' },
    { v: '"Helvetica Neue", Helvetica, sans-serif', l: 'Helvetica Neue' },
    { v: 'Tahoma, Geneva, sans-serif', l: 'Tahoma' },
    { v: '"Trebuchet MS", sans-serif', l: 'Trebuchet MS' },
    { v: 'Calibri, "Segoe UI", sans-serif', l: 'Calibri' },
    { v: '"Century Gothic", "Apple Gothic", sans-serif', l: 'Century Gothic' },
    { v: 'Georgia, serif', l: 'Georgia' },
    { v: '"Times New Roman", serif', l: 'Times' },
    { v: '"Palatino Linotype", Palatino, serif', l: 'Palatino' },
    { v: 'Garamond, "Times New Roman", serif', l: 'Garamond' },
    { v: 'Cambria, Georgia, serif', l: 'Cambria' },
    { v: 'Verdana, sans-serif', l: 'Verdana' },
    { v: '"Courier New", monospace', l: 'Courier' },
    { v: 'Consolas, "Lucida Console", monospace', l: 'Consolas' },
    { v: '"Comic Sans MS", cursive', l: 'Comic Sans' },
    { v: '"Segoe Script", cursive', l: 'Segoe Script' },
    { v: 'Impact, sans-serif', l: 'Impact' },
    { v: '"Arial Black", sans-serif', l: 'Arial Black' },
    { v: '"Arial Narrow", Arial, sans-serif', l: 'Arial Narrow' }];
  var ALIGN2 = [{ v: 'left', l: 'Слева' }, { v: 'center', l: 'Центр' }, { v: 'right', l: 'Справа' }];
  var TRANSFORM = [{ v: 'none', l: 'Как есть' }, { v: 'uppercase', l: 'ВЕРХНИЙ' },
    { v: 'lowercase', l: 'нижний' }, { v: 'capitalize', l: 'С Заглавной' }];
  var LSTYLE = [{ v: 'solid', l: 'Сплошная' }, { v: 'dashed', l: 'Пунктир' }, { v: 'dotted', l: 'Точки' }];
  var WEIGHTS = [{ v: 300, l: 'Тонкий' }, { v: 400, l: 'Обычный' }, { v: 600, l: 'Полужирный' },
    { v: 700, l: 'Жирный' }, { v: 800, l: 'Чёрный' }];

  /* ---- reusable property groups (same language for every element) ------ */
  function grpText(p, o) {
    o = o || {};
    return '<div class="sub">Текст</div>' +
      '<div class="grid2">' + fNum('Размер, px', p + 'size', 6, 96, 1) +
        fSelect('Жирность', p + 'weight', WEIGHTS) + '</div>' +
      '<div class="grid2">' + fSelect('Шрифт', p + 'font', FONTS) + fColorOpt('Цвет', p + 'color') + '</div>' +
      (o.noAlign ? '' : fSelect('Выравнивание', p + 'align', ALIGN2)) +
      '<div class="grid2">' + fNum('Межстрочный', p + 'lh', 0.8, 3, 0.05) +
        fNum('Межбуквенный', p + 'ls', -2, 10, 0.1) + '</div>' +
      (o.noTransform ? '' : fSelect('Регистр', p + 'transform', TRANSFORM));
  }
  function grpBox(p, o) {
    o = o || {};
    return '<div class="sub">Фон и рамка</div>' +
      '<div class="grid2">' + fColorOpt('Фон', p + 'bg', '#ffffff') +
        fColorOpt('Цвет рамки', p + 'border', '#e7e9ef') + '</div>' +
      '<div class="grid2">' + fNum('Толщина рамки', p + 'bw', 0, 12, 1) +
        fNum('Скругление', p + 'radius', 0, 100, 1) + '</div>' +
      '<div class="grid2">' + fNum('Внутр. отступ', p + 'pad', 0, 60, 1) +
        (o.noShadow ? '' : fCheck('Тень', p + 'shadow')) + '</div>';
  }
  function grpGeom(p, i, o) {
    o = o || {};
    return '<div class="sub">Размер и положение</div>' +
      '<div class="grid2">' + fNum('X', p + 'x', -400, 1600, 1) + fNum('Y', p + 'y', -400, 3000, 1) + '</div>' +
      (o.noW && o.noH ? '' : '<div class="grid2">' + (o.noW ? '' : fNum('Ширина', p + 'w', 4, 1600, 1)) +
        (o.noH ? '' : fNum('Высота', p + 'h', 1, 2000, 1)) + '</div>') +
      '<div class="grid2">' + fNum('Поворот, °', p + 'rotate', -180, 180, 1) +
        fNum('Прозрачн., %', p + 'opacity', 5, 100, 5) + '</div>' +
      '<div class="fld"><span class="fld-l">Слой (порядок наложения)</span><div class="pills">' +
        '<button class="pill" data-act="zBack" data-i="' + i + '">назад</button>' +
        '<button class="pill" data-act="zFront" data-i="' + i + '">вперёд</button>' +
      '</div></div>';
  }

  function customFields(c, p, i) {
    switch (c.type) {
      case 'text': return fRichText('Содержимое (Enter — новая строка)', p + 'text', { rows: 4 }) +
        grpText(p) + grpBox(p) + grpGeom(p, i, { noH: true });
      case 'info': return fRichText('Содержимое (Enter — новая строка)', p + 'text', { rows: 3 }) +
        '<div class="grid2">' + fCheck('Иконка', p + 'icon') + fColorOpt('Цвет иконки', p + 'iconColor') + '</div>' +
        grpText(p, { noTransform: true }) + grpBox(p) + grpGeom(p, i, { noH: true });
      case 'btn': return fRichText('Надпись', p + 'text', { rows: 1 }) +
        grpText(p, { noAlign: true, noTransform: true }) + grpBox(p) + grpGeom(p, i);
      case 'badge': return fRichText('Надпись', p + 'text', { rows: 1 }) +
        grpText(p, { noAlign: true }) + grpBox(p, { noShadow: true }) + grpGeom(p, i, { noW: true, noH: true });
      case 'row': return '<div class="grid2">' + fRichText('Слева', p + 'label', { rows: 1 }) +
          fRichText('Справа', p + 'value', { rows: 1 }) + '</div>' +
        '<div class="sub">Текст</div>' +
        '<div class="grid2">' + fNum('Размер, px', p + 'size', 6, 60, 1) + fSelect('Шрифт', p + 'font', FONTS) + '</div>' +
        '<div class="grid2">' + fColorOpt('Цвет слева', p + 'color') + fColorOpt('Цвет справа', p + 'vcolor') + '</div>' +
        '<div class="grid2">' + fSelect('Жирн. слева', p + 'lweight', WEIGHTS) +
          fSelect('Жирн. справа', p + 'weight', WEIGHTS) + '</div>' +
        grpBox(p, { noShadow: true }) + grpGeom(p, i, { noH: true });
      case 'box': return grpBox(p) + grpGeom(p, i);
      case 'image': return fFile('Картинка', p + 'src') +
        fSelect('Вписывание', p + 'fit', [{ v: 'cover', l: 'Заполнить' }, { v: 'contain', l: 'Вместить' },
          { v: 'fill', l: 'Растянуть' }]) +
        '<div class="grid2">' + fColorOpt('Цвет рамки', p + 'border', '#e7e9ef') +
          fNum('Толщина рамки', p + 'bw', 0, 12, 1) + '</div>' +
        '<div class="grid2">' + fNum('Скругление', p + 'radius', 0, 300, 1) + fCheck('Тень', p + 'shadow') + '</div>' +
        grpGeom(p, i);
      case 'line': return '<div class="grid2">' + fColorOpt('Цвет', p + 'color', '#eef0f3') +
          fSelect('Стиль', p + 'style', LSTYLE) + '</div>' +
        '<div class="grid2">' + fNum('Толщина', p + 'h', 1, 20, 1) + fNum('Длина', p + 'w', 4, 1600, 1) + '</div>' +
        grpGeom(p, i, { noW: true, noH: true });
    }
    return '';
  }

  function customEditor() {
    var list = state.custom || [];
    var hint = '<div class="hint">'
      + '<b>1.</b> «＋ Добавить на шаблон» вверху → выберите элемент<br>'
      + '<b>2.</b> кликните по превью — элемент встанет туда<br>'
      + '<b>3.</b> <b>двойной клик</b> по нему на шаблоне — печатать текст прямо там (Enter — абзац)<br>'
      + '<b>4.</b> тяните мышью • над выделенным всплывает панель ✎ ⧉ 🗑 • Del — удалить'
      + '</div>';
    if (!list.length) return hint;
    return hint + list.map(function (c, i) {
      var p = 'custom.' + i + '.';
      return '<div class="item" data-cid="' + esc(c.id) + '">' +
        '<div class="item-h"><b>' + esc(ADD_LABELS[c.type] || c.type) + '</b><span class="item-actions">' +
        '<button class="btn xs ghost" data-act="selCustom" data-id="' + esc(c.id) + '" title="Показать на шаблоне">◎</button>' +
        '<button class="btn xs ghost" data-act="dupCustom" data-i="' + i + '" title="Дублировать">⧉</button>' +
        '<button class="btn xs ghost" data-act="delCustom" data-i="' + i + '" title="Удалить">✕</button>' +
        '</span></div>' +
        customFields(c, p, i) + '</div>';
    }).join('');
  }

  /* ---- build full form ------------------------------------------------- */
  function buildForm() {
    var rn = state.summary.rows.length;
    var rows = state.summary.rows.map(function (r, i) { return rowEditor(r, i, rn); }).join('') +
      '<button class="btn sm add" data-act="addRow">+ Добавить строку</button>';
    var on = state.shipping.options.length;
    var opts = state.shipping.options.map(function (o, i) { return optEditor(o, i, on); }).join('') +
      '<button class="btn sm add" data-act="addOpt">+ Добавить опцию</button>';

    var theme = [
      fColor('Фон страницы', 'theme.pageBg'), fColor('Карточка', 'theme.card'),
      fColor('Рамка карточки', 'theme.border'), fColor('Разделители', 'theme.divider'),
      fColor('Текст', 'theme.text'), fColor('Приглушённый текст', 'theme.muted'),
      fColor('Иконки', 'theme.icon'), fColor('Красный бренда', 'theme.red'),
      fColor('Фон инфо-блока', 'theme.infoBg'), fColor('Текст инфо', 'theme.infoText'),
      fColor('Ссылка инфо', 'theme.infoLink'), fColor('Фон бейджа', 'theme.badgeBg'),
      fColor('Текст бейджа', 'theme.badgeText'), fColor('Рамка поля', 'theme.inputBorder'),
      fColor('Placeholder', 'theme.placeholder'), fColor('Рамка кнопки', 'theme.btnBorder'),
      fColor('Рамка выбранного', 'theme.selectedBorder'), fColor('Рамка опции', 'theme.optBorder'),
      fColor('Жёлтый Poste', 'theme.posteYellow'), fColor('Синий Poste', 'theme.posteBlue'),
      fColor('Полоса прокрутки', 'theme.scrollbarThumb'),
      fColor('Фон шапки', 'theme.headerBg'), fColor('Фон поля промокода', 'theme.inputBg'),
      fColor('Фон кнопки', 'theme.btnBg'), fColor('Фон карточки QR', 'theme.qrCardBg'),
      fColor('Подложка фото', 'theme.imgBg')
    ].join('');

    var frame =
      '<div class="grid2">' + fNum('Ширина', 'canvas.width', 280, 900, 1) +
      fNum('Высота', 'canvas.height', 300, 2000, 1) + '</div>' +
      fCheck('Показывать полосу прокрутки', 'canvas.scrollbar') +
      fRange('Положение полосы', 'canvas.scrollTop', 0, 0.9, 0.01) +
      fRange('Высота ползунка', 'canvas.scrollThumb', 0.1, 1, 0.01);

    var header =
      fCheck('Показывать шапку', 'header.show') +
      fText('Заголовок', 'header.title') + fCheck('Показывать крестик (✕)', 'header.showClose');

    var summary =
      fCheck('Показывать раздел', 'summary.show') +
      fText('Заголовок раздела', 'summary.title') +
      fFile('Фото товара', 'summary.product.image') +
      fText('Название товара', 'summary.product.title', { area: true, rows: 2 }) +
      '<div class="sub">Строки сумм</div>' + rows +
      '<div class="sub">Инфо-блок</div>' +
      fCheck('Показывать инфо-блок', 'summary.infoBox.show') +
      fText('Текст', 'summary.infoBox.text', { area: true, rows: 3 }) +
      fText('Текст ссылки', 'summary.infoBox.link') +
      '<div class="sub">Итого</div>' +
      '<div class="grid2">' + fText('Название', 'summary.total.label') +
      fText('Значение', 'summary.total.value') + '</div>';

    var discount =
      fCheck('Показывать раздел', 'discount.show') +
      fText('Заголовок раздела', 'discount.title') +
      fText('Placeholder', 'discount.placeholder') +
      fText('Введённое значение (пусто = placeholder)', 'discount.value');

    var shipping =
      fCheck('Показывать раздел', 'shipping.show') +
      fText('Заголовок раздела', 'shipping.title') +
      '<div class="sub">Опции</div>' + opts;

    var qr = qrSection(state.qr || {});

    var style =
      fSelect('Шрифт', 'theme.font', [{ v: '', l: 'Системный (Segoe UI)' }]
        .concat(FONTS.slice(1).map(function (f) { return { v: f.v, l: f.l }; }))) +
      fRange('Скругление карточек', 'theme.cardRadius', 0, 24, 1) +
      '<div class="theme-grid">' + theme + '</div>';

    controls.innerHTML =
      '<details class="sec" data-sec="custom"><summary>➕ Свои элементы (' +
        ((state.custom || []).length) + ')</summary><div class="sec-body">' + customEditor() + '</div></details>' +
      section('Разделы (порядок / вид)', layoutEditor(), false) +
      section('Рамка и прокрутка', frame, false) +
      section('Шапка', header, false) +
      section('Сводка заказа', summary, true) +
      section('Промокод', discount, false) +
      section('Доставка', shipping, true) +
      section('QR-код', qr, false) +
      section('Стиль и цвета', style, false);
  }

  /* Rebuild form while keeping panel scroll + open sections. */
  function rebuildForm() {
    var sp = controls.scrollTop;
    var open = Array.prototype.map.call(controls.querySelectorAll('details'), function (d) { return d.open; });
    buildForm();
    Array.prototype.forEach.call(controls.querySelectorAll('details'), function (d, i) {
      if (open[i] != null) d.open = open[i];
    });
    controls.scrollTop = sp;
  }

  /* ---- input handling -------------------------------------------------- */
  function coerce(input) {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number' || input.type === 'range') {
      var n = parseFloat(input.value);
      var lo = input.min !== '' ? parseFloat(input.min) : null;
      var hi = input.max !== '' ? parseFloat(input.max) : null;
      if (!isFinite(n)) n = lo != null ? lo : 0;               // cleared field -> min, not 0
      if (lo != null && n < lo) n = lo;
      if (hi != null && n > hi) n = hi;
      return n;
    }
    return input.value;
  }

  /* shared with the API renderer — see assets/apply.js */
  var renderQR = window.SubitoApply.renderQR;
  /* Generate QR for the builder's state, then refresh thumb. Returns Promise. */
  function genQR() {
    var q = state.qr || (state.qr = {});
    return renderQR(q).then(refreshQRThumb);
  }
  function afterQR() { genQR().then(function () { rebuildForm(); renderPreview(); }); }
  function refreshQRThumb() {
    var img = controls.querySelector('.qr-prev img');
    if (img) img.src = state.qr && state.qr.image ? state.qr.image : '';
  }
  var QR_DISPLAY_ONLY = { position: 1, size: 1, caption: 1, top: 1, right: 1, x: 1, y: 1, bare: 1, show: 1 };
  function qrNeedsRegen(path) {
    if (path.slice(0, 3) !== 'qr.') return false;
    return !QR_DISPLAY_ONLY[path.slice(3)];
  }

  /* human label for the journal, from a data-path */
  var FIELD_LABELS = {
    'header.title': 'заголовок шапки', 'summary.product.title': 'название товара',
    'summary.total.value': 'сумма «Итого»', 'summary.total.label': 'подпись «Итого»',
    'discount.value': 'промокод', 'qr.data': 'данные QR', 'qr.caption': 'подпись QR',
    'canvas.width': 'ширина', 'canvas.height': 'высота'
  };
  function pathLabel(p) {
    if (FIELD_LABELS[p]) return FIELD_LABELS[p];
    if (/\.show$/.test(p)) return 'раздел «' + (SECTION_LABELS[p.split('.')[0]] || p.split('.')[0]) + '»';
    if (p.indexOf('theme.') === 0) return 'цвет/стиль';
    if (p.indexOf('qr.') === 0) return 'QR: ' + p.slice(3);
    if (/summary\.rows\.\d+\.(label|value)/.test(p)) return 'строка суммы';
    if (/shipping\.options\.\d+\./.test(p)) return 'опция доставки';
    return p;
  }

  controls.addEventListener('input', function (e) {
    var t = e.target;
    if (t.dataset.rich) {                       // rich editor in the panel
      markChange('Правка текста', t.dataset.rich);
      setPath(state, t.dataset.rich, normalizeRich(t.innerHTML));
      renderPreview(); return;
    }
    if (!t.dataset.path) return;
    markChange('Правка: ' + pathLabel(t.dataset.path), t.dataset.path);
    setPath(state, t.dataset.path, coerce(t));
    // keep hex<->color pickers and range labels in sync without full rebuild
    if (t.type === 'color' || t.classList.contains('hex')) {
      var mates = controls.querySelectorAll('[data-path="' + t.dataset.path + '"]');
      Array.prototype.forEach.call(mates, function (m) { if (m !== t) m.value = t.value; });
    }
    if (t.type === 'range') {
      var b = t.parentNode.querySelector('b'); if (b) b.textContent = t.value;
    }
    if (qrNeedsRegen(t.dataset.path)) {
      genQR().then(renderPreview); return;
    }
    renderPreview();
  });

  controls.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset.select && t.dataset.path) {          // <select>
      markChange('Выбрано: ' + pathLabel(t.dataset.path));
      setPath(state, t.dataset.path, t.value);
      if (t.dataset.path === 'qr.gradient') { afterQR(); return; }   // show/hide grad fields
      if (qrNeedsRegen(t.dataset.path)) { genQR().then(renderPreview); return; }
      if (t.dataset.path === 'qr.position') { rebuildForm(); }
      renderPreview();
      return;
    }
    if (t.type === 'checkbox' && t.dataset.path) {
      markChange((t.checked ? 'Включено: ' : 'Выключено: ') + pathLabel(t.dataset.path));
      setPath(state, t.dataset.path, t.checked);
      if (t.dataset.path === 'qr.show' && t.checked && state.qr && state.qr.data && !state.qr.image) {
        afterQR(); return;
      }
      renderPreview();
      return;
    }
    if (t.type === 'file' && t.dataset.file) {
      var f = t.files && t.files[0];
      if (!f) return;
      var r = new FileReader();
      var path = t.dataset.file;
      r.onload = function () {
        markChange('Загружено изображение: ' + pathLabel(path));
        setPath(state, path, r.result);
        if (path === 'qr.custom') { state.qr.mode = 'custom'; }
        if (path.slice(0, 3) === 'qr.') { afterQR(); }
        else { rebuildForm(); renderPreview(); }
      };
      r.readAsDataURL(f);
    }
  });

  var ACT_LABELS = {
    addRow: 'Добавлена строка', delRow: 'Удалена строка',
    addOpt: 'Добавлена опция', delOpt: 'Удалена опция', delCustom: 'Удалён элемент', dupCustom: 'Дублирован элемент',
    clear: 'Очищено поле', up: 'Порядок ↑', down: 'Порядок ↓',
    toggleFree: 'Свободное размещение', resetLayout: 'Сброс раскладки',
    qrRegen: 'QR обновлён', qrpill: 'Стиль QR', qrPreset: 'Пресет QR',
    qrMode: 'Режим QR', qrPos: 'Позиция QR'
  };
  controls.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act;
    markChange(ACT_LABELS[act] || 'Действие');
    if (act === 'addRow') {
      state.summary.rows.push({ label: 'Nuova voce', value: '0,00 €', info: false, muted: false });
    } else if (act === 'delRow') {
      state.summary.rows.splice(Number(b.dataset.i), 1);
    } else if (act === 'addOpt') {
      state.shipping.options.push({ kind: 'custom', selected: false, badge: '', title: 'Nuova opzione', price: '0,00 €', button: '', carrier: '', carrierLogo: '' });
    } else if (act === 'delOpt') {
      state.shipping.options.splice(Number(b.dataset.i), 1);
    } else if (act === 'clear') {
      setPath(state, b.dataset.path, '');
      // removing the custom QR image must fall back to the generated one
      if (b.dataset.path === 'qr.custom') state.qr.mode = 'generated';
      if (b.dataset.path.slice(0, 3) === 'qr.') { afterQR(); return; }
    } else if (act === 'up' || act === 'down') {
      var arr = b.dataset.kind === 'row' ? state.summary.rows
        : b.dataset.kind === 'opt' ? state.shipping.options
        : (state.layout || (state.layout = { order: ['summary', 'discount', 'shipping'] })).order;
      var i = Number(b.dataset.i), j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= arr.length) return;
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    } else if (act === 'zFront' || act === 'zBack') {
      var el0 = state.custom[Number(b.dataset.i)];
      if (el0) {
        var zs = state.custom.map(function (x) { return x.z == null ? 30 : x.z; });
        el0.z = act === 'zFront' ? Math.max.apply(null, zs) + 1 : Math.min.apply(null, zs) - 1;
        markChange(act === 'zFront' ? 'Слой: вперёд' : 'Слой: назад');
      }
    } else if (act === 'stripRich') {
      var tmp = document.createElement('div');
      tmp.innerHTML = String(getPath(state, b.dataset.path) || '').replace(/<br\s*\/?>/gi, '\n');
      setPath(state, b.dataset.path, tmp.textContent || '');
      markChange('Убрано форматирование');
    } else if (act === 'optColor') {
      var cur = getPath(state, b.dataset.path);
      setPath(state, b.dataset.path, cur ? '' : (b.dataset.fb || '#3c4858'));
    } else if (act === 'selCustom') {
      selectCustom(b.dataset.id); return;
    } else if (act === 'delCustom') {
      state.custom.splice(Number(b.dataset.i), 1); selId = null;
    } else if (act === 'dupCustom') {
      var src = state.custom[Number(b.dataset.i)];
      var cp = JSON.parse(JSON.stringify(src)); cp.id = uid(); cp.x += 12; cp.y += 12;
      state.custom.push(cp); selId = cp.id;
    } else if (act === 'toggleFree') {
      var key = b.dataset.key;
      state.layout = state.layout || { order: ['summary', 'discount', 'shipping'] };
      state.layout.free = state.layout.free || {};
      if (state.layout.free[key]) { delete state.layout.free[key]; }
      else {
        var elb = preview.querySelector('[data-block="' + key + '"]');
        // hidden sections aren't rendered -> fall back to a sane in-frame default
        var fp = { x: 16, y: 90, w: Math.max(80, (state.canvas.width || 418) - 32) };
        if (elb) {
          var pr = preview.getBoundingClientRect(), rr = elb.getBoundingClientRect();
          fp = { x: Math.round((rr.left - pr.left) / zoom), y: Math.round((rr.top - pr.top) / zoom), w: Math.round(elb.offsetWidth) };
        }
        state.layout.free[key] = fp;
      }
    } else if (act === 'resetLayout') {
      state.layout = { order: ['summary', 'discount', 'shipping'], free: {} };
      flash('Раскладка сброшена');
    } else if (act === 'qrRegen') {
      afterQR(); return;
    } else if (act === 'qrpill') {
      setPath(state, b.dataset.path, b.dataset.val); afterQR(); return;
    } else if (act === 'qrPreset') {
      var p = QR_PRESETS[b.dataset.preset];
      if (p) { Object.keys(p.set).forEach(function (k) { state.qr[k] = p.set[k]; }); state.qr.mode = 'generated'; }
      afterQR(); return;
    } else if (act === 'qrMode') {
      state.qr.mode = b.dataset.val; afterQR(); return;
    } else if (act === 'qrPos') {
      setPath(state, 'qr.position', b.dataset.pos);
    } else if (act === 'qrDownload') {
      var im = state.qr && state.qr.image;
      if (im) download(dataURLToBlob(im), 'qr.png'); else flash('Сначала сгенерируйте QR');
      return;
    } else { return; }
    rebuildForm(); renderPreview();
  });

  /* ---- toolbar / IO ---------------------------------------------------- */
  function download(data, filename, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function dataURLToBlob(dataURL) {
    var parts = dataURL.split(','), mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
    var bin = atob(parts[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /* PNG export via SVG <foreignObject> — no external libraries, no taint
     (all images are data URLs). */
  function exportPNG(scale, cfg) {
    scale = scale || 2;
    cfg = cfg || state;
    var w = cfg.canvas.width, h = cfg.canvas.height;
    var inner = window.renderScreenHTML(cfg);
    var styleAttr = 'width:' + w + 'px;height:' + h + 'px;' + window.themeVars(cfg);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
      '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">' +
      '<style>' + window.SCREEN_CSS + '</style>' +
      '<div class="screen" style="' + styleAttr + '">' + inner + '</div>' +
      '</div></foreignObject></svg>';
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.drawImage(img, 0, 0);
      c.toBlob(function (blob) {
        if (blob) {
          download(blob, 'acquista-a-distanza@' + scale + 'x.png', 'image/png');
          flash('✓ Скачано: acquista-a-distanza@' + scale + 'x.png');
        } else alert('Экспорт не удался в этом браузере.');
      }, 'image/png');
    };
    img.onerror = function () { alert('Экспорт не удался: не удалось сериализовать вид (проверьте, нет ли в тексте незакрытых тегов).'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function bind(id, fn) { var e = document.getElementById(id); if (e) e.addEventListener('click', fn); }

  bind('undoBtn', undo);
  bind('redoBtn', redo);
  bind('histBtn', function () {
    var m = document.getElementById('histMenu');
    m.classList.toggle('open'); updateHistUI();
  });
  document.getElementById('histMenu').addEventListener('click', function (e) {
    var it = e.target.closest('[data-hist]');
    if (it) { restoreTo(Number(it.dataset.hist)); this.classList.remove('open'); }
  });
  document.addEventListener('click', function (e) {          // close on outside click
    if (!e.target.closest('.hist-wrap')) {
      var m = document.getElementById('histMenu');
      if (m) m.classList.remove('open');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });

  bind('fitBtn', function () {
    if (fitNeed > 0) { markChange('Подогнана высота'); state.canvas.height = fitNeed; rebuildForm(); renderPreview(); flash('Высота подогнана: ' + fitNeed + 'px'); }
  });
  bind('zoomIn', function () { zoom = Math.min(2, zoom + 0.1); renderPreview(); });
  bind('zoomOut', function () { zoom = Math.max(0.4, zoom - 0.1); renderPreview(); });
  bind('zoomReset', function () { zoom = 1; renderPreview(); });
  bind('png1', function () { exportPNG(1); });
  bind('png2', function () { exportPNG(2); });
  bind('png3', function () { exportPNG(3); });

  bind('copyJson', function () {
    var json = JSON.stringify(state, null, 2);
    navigator.clipboard && navigator.clipboard.writeText(json).then(
      function () { flash('Конфиг скопирован в буфер'); },
      function () { showJson(json); });
  });
  bind('downloadJson', function () {
    download(JSON.stringify(state, null, 2), 'acquista-config.json', 'application/json');
  });
  bind('importJson', function () { document.getElementById('importFile').click(); });
  document.getElementById('importFile').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var cfg = JSON.parse(r.result);
        state = fillCustomDefaults(window.mergeConfig(clone(window.DEFAULT_CONFIG), cfg));
        markChange('Импорт JSON'); rebuildForm(); renderPreview(); flash('Конфиг импортирован');
      } catch (err) { alert('Неверный JSON: ' + err.message); }
    };
    r.readAsText(f); e.target.value = '';
  });
  function updateRestoreBtn() {
    var b = document.getElementById('restore');
    if (b) b.style.display = hasBackup() ? '' : 'none';
  }
  bind('reset', function () {
    if (!confirm('Сбросить шаблон к исходному виду?\n\n' +
                 'Текущие настройки сохранятся в резервную копию — их можно вернуть ' +
                 'кнопкой «Восстановить».')) return;
    backupState(); markChange('Сброс шаблона');
    state = clone(window.DEFAULT_CONFIG);
    rebuildForm(); renderPreview(); updateRestoreBtn();
    flash('Сброшено — можно вернуть кнопкой «Восстановить»');
  });
  bind('restore', function () {
    var raw = lsGet(LS_BACKUP);
    if (!raw) { flash('Резервной копии нет'); return; }
    if (!confirm('Восстановить шаблон из резервной копии?\n\nТекущий вид будет заменён.')) return;
    try {
      state = fillCustomDefaults(window.mergeConfig(clone(window.DEFAULT_CONFIG), JSON.parse(raw)));
    } catch (e) { flash('Резервная копия повреждена'); return; }
    genQR().then(function () { rebuildForm(); renderPreview(); flash('Шаблон восстановлен'); });
  });

  function flash(msg) {
    var f = document.getElementById('flash');
    f.textContent = msg; f.classList.add('show');
    clearTimeout(flash._t); flash._t = setTimeout(function () { f.classList.remove('show'); }, 1800);
  }
  function showJson(json) {
    var w = window.open('', '_blank');
    if (w) { w.document.write('<pre>' + esc(json) + '</pre>'); }
  }

  /* ---- drag the QR on a preview (free position) ----------------------- */
  function setupDrag(el, getCfg, getZoom, onEnd) {
    var drag = null;
    el.addEventListener('pointerdown', function (e) {
      var q = e.target.closest && e.target.closest('[data-qr-drag]');
      if (!q) return;
      e.preventDefault();
      var z = getZoom();
      var erect = q.getBoundingClientRect();
      drag = {
        q: q, prect: el.getBoundingClientRect(),
        grabX: (e.clientX - erect.left) / z, grabY: (e.clientY - erect.top) / z,
        w: q.offsetWidth, h: q.offsetHeight
      };
      try { q.setPointerCapture(e.pointerId); } catch (err) {}
      q.style.transition = 'none';
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var z = getZoom(), cfg = getCfg();
      var x = (e.clientX - drag.prect.left) / z - drag.grabX;
      var y = (e.clientY - drag.prect.top) / z - drag.grabY;
      x = Math.max(0, Math.min(cfg.canvas.width - drag.w, x));
      y = Math.max(0, Math.min(cfg.canvas.height - drag.h, y));
      drag.q.style.left = Math.round(x) + 'px';
      drag.q.style.top = Math.round(y) + 'px';
      drag._x = Math.round(x); drag._y = Math.round(y);
    });
    function end() {
      if (!drag) return;
      var cfg = getCfg();
      if (drag._x != null && cfg.qr) { markChange('Перемещён QR'); cfg.qr.x = drag._x; cfg.qr.y = drag._y; }
      drag = null; onEnd();
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  setupDrag(preview, function () { return state; }, function () { return zoom; },
    function () { renderPreview(); rebuildForm(); });
  setupDrag(document.getElementById('parserPreview'), function () { return parserState; },
    function () { return parserZoom; }, function () { parserRender(); });

  /* ---- drag ANY section/block to a free (arbitrary) position ----------- */
  function setupBlockDrag(host, getCfg, getZoom, onEnd) {
    var drag = null;
    host.addEventListener('pointerdown', function (e) {
      if (e.target.closest('[data-qr-drag]')) return;        // QR has its own drag
      var el = e.target.closest('[data-block],[data-custom]');
      if (!el || !host.contains(el)) return;
      e.preventDefault();
      var z = getZoom();
      var hostRect = host.getBoundingClientRect();
      var elRect = el.getBoundingClientRect();
      var w = el.offsetWidth;
      drag = {
        el: el, key: el.dataset.block, cid: el.dataset.custom || null, hostRect: hostRect, w: w,
        grabX: (e.clientX - elRect.left) / z, grabY: (e.clientY - elRect.top) / z
      };
      // lift into absolute at its current visual spot (no jump)
      el.style.position = 'absolute';
      el.style.left = ((elRect.left - hostRect.left) / z) + 'px';
      el.style.top = ((elRect.top - hostRect.top) / z) + 'px';
      el.style.width = w + 'px'; el.style.margin = '0'; el.style.zIndex = '60';
      el.classList.add('dragging');
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
    });
    host.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var z = getZoom(), cfg = getCfg(), cw = (cfg.canvas && cfg.canvas.width) || 418,
          ch = (cfg.canvas && cfg.canvas.height) || 826;
      var x = Math.max(-8, Math.min(cw - 30, (e.clientX - drag.hostRect.left) / z - drag.grabX));
      var y = Math.max(0, Math.min(ch - 24, (e.clientY - drag.hostRect.top) / z - drag.grabY));
      drag.el.style.left = Math.round(x) + 'px';
      drag.el.style.top = Math.round(y) + 'px';
      drag._x = Math.round(x); drag._y = Math.round(y);
    });
    function end() {
      if (!drag) return;
      if (drag._x != null) {
        var cfg = getCfg();
        if (drag.cid) {                       // user-added element
          var it = (cfg.custom || []).filter(function (c) { return c.id === drag.cid; })[0];
          if (it) { markChange('Перемещён элемент'); it.x = drag._x; it.y = drag._y; }
        } else {
          markChange('Перемещён блок: ' + (SECTION_LABELS[drag.key] || drag.key));
          cfg.layout = cfg.layout || { order: ['summary', 'discount', 'shipping'] };
          cfg.layout.free = cfg.layout.free || {};
          cfg.layout.free[drag.key] = { x: drag._x, y: drag._y, w: drag.w };
        }
      }
      drag = null; onEnd();
    }
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
  }
  setupBlockDrag(preview, function () { return state; }, function () { return zoom; },
    function () { renderPreview(); rebuildForm(); });
  setupBlockDrag(document.getElementById('parserPreview'), function () { return parserState; },
    function () { return parserZoom; }, function () { parserRender(); });

  /* ===================================================================== */
  /* Parser view (tab 2): Subito URL -> ready image                        */
  /* ===================================================================== */
  var parserState = null;
  var parserZoom = 1;

  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    document.getElementById('view-builder').classList.toggle('active', name === 'builder');
    document.getElementById('view-parser').classList.toggle('active', name === 'parser');
    try { localStorage.setItem('active-tab', name); } catch (e) {}
    if (name === 'parser') reapplyParser();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () { switchTab(t.dataset.tab); });
  });

  function parserRender() {
    var el = document.getElementById('parserPreview');
    var ph = document.getElementById('pPlaceholder');
    var bar = document.getElementById('pToolbar');
    if (!parserState) { el.style.display = 'none'; ph.style.display = 'block'; bar.style.display = 'none'; return; }
    ph.style.display = 'none'; el.style.display = 'block'; bar.style.display = 'flex';
    window.renderScreen(el, parserState);
    var scroll = el.parentNode;
    parserZoom = Math.min(1, (scroll.clientWidth - 24) / parserState.canvas.width);
    el.style.zoom = parserZoom;
  }

  /* shared with the API renderer — see assets/apply.js */
  var applyListingData = window.SubitoApply.applyListingData;

  function renderParserOpts() {
    var box = document.getElementById('pOpts');
    if (!parserState) {
      box.innerHTML = '<h3>Данные объявления</h3>' +
        '<div class="hint">Вставьте ссылку и нажмите «Собрать». Оформление, цвета, ' +
        'разделы и QR берутся из вкладки «Конструктор».</div>';
      return;
    }
    var s = parserState.summary || {};
    function kv(k, v) { return '<div class="kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; }
    box.innerHTML =
      '<h3>Данные объявления</h3>' +
      kv('Товар', (s.product && s.product.title) || '—') +
      (s.rows || []).map(function (r) { return kv(r.label, r.value); }).join('') +
      (s.total ? kv(s.total.label, s.total.value) : '') +
      '<div class="hint" style="margin-top:12px">🎨 Оформление, цвета, порядок разделов ' +
      'и QR берутся из вкладки «Конструктор» — как настроите там, так парсер и сделает.<br>' +
      'Точечные правки этого объявления — кнопка «Открыть в конструкторе».</div>';
  }

  var lastListingData = null;
  function reapplyParser() {
    if (!lastListingData) { parserRender(); return; }
    parserState = applyListingData(state, lastListingData);
    renderQR(parserState.qr).then(function () { renderParserOpts(); parserRender(); });
  }

  function parserLoad() {
    var input = document.getElementById('pUrl');
    var url = (input.value || '').trim();
    var go = document.getElementById('pGo');
    if (!/subito\.it\//i.test(url)) { flash('Вставьте ссылку subito.it'); input.focus(); return; }
    go.disabled = true; go.textContent = 'Собираю…';
    var ph = document.getElementById('pPlaceholder');
    var el = document.getElementById('parserPreview');
    el.style.display = 'none'; ph.style.display = 'block';
    ph.innerHTML = '<span class="big">⏳</span>Собираю данные объявления…<br>обычно 3–6 секунд' +
      '<br><small style="opacity:.6">(на бесплатном хостинге первый запрос после простоя — дольше)</small>';
    fetch('api/parse?url=' + encodeURIComponent(url)).then(function (r) {
      return r.json().catch(function () { throw new Error('HTTP ' + r.status); });
    }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'parse error');
      lastListingData = res.data;
      parserState = applyListingData(state, res.data);
      return renderQR(parserState.qr).then(function () {
        renderParserOpts(); parserRender();
        flash('Готово: ' + (res.data.title || ''));
      });
    }).catch(function (err) {
      ph.innerHTML = '<span class="big">⚠️</span>' + esc(err.message) +
        '<br><small style="opacity:.7">Нажмите «Собрать» ещё раз.</small>';
      flash('Ошибка: ' + err.message);
    }).then(function () { go.disabled = false; go.textContent = 'Собрать'; });
  }
  /* ===================================================================== */
  /* Add custom elements: pick in the toolbar -> click on the template      */
  /* ===================================================================== */
  var ADD_LABELS = { text: 'Текст', box: 'Блок / карточка', image: 'Картинка',
    row: 'Строка «цена»', btn: 'Кнопка', badge: 'Бейдж', info: 'Инфо-блок', line: 'Линия',
    link: 'Ссылка' };
  var placing = null, selId = null;

  function setPlacing(type) {
    placing = type;
    document.body.classList.toggle('placing', !!type);
    if (type) document.getElementById('placeHint').textContent =
      'Кликните на шаблон — поставлю «' + ADD_LABELS[type] + '»   ·   Esc — отмена';
  }
  function uid() { return 'c' + Math.random().toString(36).slice(2, 8); }

  function addCustom(type, x, y) {
    state.custom = state.custom || [];
    // "Ссылка" is just a text element carrying the {{link}} placeholder, so it
    // can be dropped anywhere and styled like any other text.
    var real = type === 'link' ? 'text' : type;
    var d = (window.CUSTOM_DEFAULTS || {})[real] || {};
    var c = { id: uid(), type: real, x: Math.max(0, x), y: Math.max(0, y) };
    Object.keys(d).forEach(function (k) { c[k] = d[k]; });
    if (type === 'link') { c.text = '{{link}}'; c.color = '#1a73e8'; c.w = 300; c.size = 12; }
    markChange('Добавлен элемент: ' + ADD_LABELS[type]);
    state.custom.push(c);
    rebuildForm(); renderPreview(); selectCustom(c.id);
    flash('«' + ADD_LABELS[type] + '» добавлен — тяните мышью, настройки слева');
  }
  function selectCustom(id) {
    selId = id;
    Array.prototype.forEach.call(preview.querySelectorAll('[data-custom]'), function (el) {
      el.classList.toggle('sel', el.dataset.custom === id);
    });
    positionSelBar();
    var det = controls.querySelector('details[data-sec="custom"]');
    if (det) {
      det.open = true;
      var it = controls.querySelector('[data-cid="' + id + '"]');
      if (it) it.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  document.getElementById('addBtn').addEventListener('click', function () {
    document.getElementById('addMenu').classList.toggle('open');
  });
  document.getElementById('addMenu').addEventListener('click', function (e) {
    var b = e.target.closest('[data-add]');
    if (!b) return;
    this.classList.remove('open');
    setPlacing(b.dataset.add);
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.add-wrap')) document.getElementById('addMenu').classList.remove('open');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && placing) setPlacing(null);
    if ((e.key === 'Delete' || e.key === 'Backspace') && selId &&
        !/input|textarea/i.test((e.target.tagName || ''))) {
      var i = (state.custom || []).findIndex(function (c) { return c.id === selId; });
      if (i >= 0) { markChange('Удалён элемент'); state.custom.splice(i, 1); selId = null; rebuildForm(); renderPreview(); }
    }
  });
  // click on the canvas in placing mode -> drop the element there
  preview.addEventListener('click', function (e) {
    if (!placing) return;
    var r = preview.getBoundingClientRect();
    addCustom(placing, Math.round((e.clientX - r.left) / zoom), Math.round((e.clientY - r.top) / zoom));
    setPlacing(null);
  });
  // click an existing custom element -> select it
  preview.addEventListener('pointerdown', function (e) {
    if (placing) return;
    var el = e.target.closest && e.target.closest('[data-custom]');
    if (el) selectCustom(el.dataset.custom);
    else { selId = null; positionSelBar();
      Array.prototype.forEach.call(preview.querySelectorAll('[data-custom].sel'),
        function (x) { x.classList.remove('sel'); }); }
  });

  /* ===================================================================== */
  /* Inline editing: double-click ANY text on the template and just type    */
  /* ===================================================================== */
  var editing = null;
  function normalizeRich(html) {
    return window.sanitizeRich(html)
      .replace(/<div><br><\/div>/gi, '<br>')
      .replace(/<div>/gi, '<br>').replace(/<\/div>/gi, '')
      .replace(/^(?:<br>)+/i, '').replace(/(?:<br>)+$/i, '');
  }
  var TEXT_FIELD = { text: 'text', badge: 'text', btn: 'text', info: 'text' };

  /* ---- format the SELECTED part of the text (bold / size / colour) ------
     Rules that make this actually work:
       1. remember the selection — opening the colour picker clears it;
       2. never hand-wrap <span>s (that nested a new span per mouse-move and
          made re-colouring a second part impossible). Let the browser
          normalise via execCommand, which replaces existing formatting. */
  var fmtBar = document.getElementById('fmtBar');
  var savedRange = null;
  function hideFmtBar() { fmtBar.style.display = 'none'; savedRange = null; }

  function selInside() {
    var sel = window.getSelection();
    if (!editing || !sel || !sel.rangeCount || sel.isCollapsed) return null;
    return editing.contains(sel.anchorNode) && editing.contains(sel.focusNode) ? sel : null;
  }
  function showFmtBarForSelection() {
    if (!editing) return hideFmtBar();
    var sel = selInside(), r = null;
    if (sel) {
      savedRange = sel.getRangeAt(0).cloneRange();     // survive the colour picker
      var rr = sel.getRangeAt(0).getBoundingClientRect();
      if (rr.width || rr.height) r = rr;
    }
    var whole = !r;
    if (!r) r = editing.getBoundingClientRect();
    fmtBar.style.display = 'flex';
    fmtBar.style.left = (r.left + r.width / 2) + 'px';
    fmtBar.style.top = (r.top - 8) + 'px';
    fmtBar.classList.toggle('whole', whole);
    var tip = fmtBar.querySelector('.fmt-tip');
    if (tip) tip.textContent = whole ? 'весь текст' : 'выделено';
  }
  document.addEventListener('selectionchange', function () {
    if (editing && !fmtBusy) showFmtBarForSelection();
  });

  /* Put the caret/selection back exactly where it was, then focus the editor
     so execCommand targets it. Falls back to "the whole text". */
  var fmtBusy = false;
  function restoreSel() {
    if (!editing) return false;
    editing.focus();
    if (selInside()) return true;                       // still selected
    var sel = window.getSelection();
    if (savedRange && editing.contains(savedRange.commonAncestorContainer)) {
      sel.removeAllRanges(); sel.addRange(savedRange);  // picker stole it -> restore
      return true;
    }
    var r = document.createRange(); r.selectNodeContents(editing);
    sel.removeAllRanges(); sel.addRange(r);             // nothing selected -> whole text
    return true;
  }
  function afterFmt() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) savedRange = sel.getRangeAt(0).cloneRange();
    if (editing && editing.dataset.rich) {              // panel editor -> save live
      setPath(state, editing.dataset.rich, normalizeRich(editing.innerHTML));
      markChange('Формат текста', editing.dataset.rich);
      renderPreview();
    }
    showFmtBarForSelection();
  }
  /* Size of the text that is ACTUALLY selected. A range often starts at the very
     end of the previous text node — taking that node's parent would read the
     base size and A+ would never compound. So find the first text node that the
     range really covers. */
  function selectionFontSize() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editing) return 14;
    var r = sel.getRangeAt(0), node = null;
    var w = document.createTreeWalker(editing, NodeFilter.SHOW_TEXT, null, false), n;
    while ((n = w.nextNode())) {
      if (!r.intersectsNode(n) || !n.nodeValue.trim()) continue;
      if (n === r.startContainer && r.startOffset >= n.nodeValue.length) continue; // touches the end only
      if (n === r.endContainer && r.endOffset === 0) continue;                     // touches the start only
      node = n; break;
    }
    if (!node) node = r.startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    return parseFloat(window.getComputedStyle(node).fontSize) || 14;
  }
  /* execCommand('fontSize') only speaks 1..7, so use it to let the BROWSER split
     the range correctly, then swap the <font> tags for real px spans. */
  function applyFontSize(px) {
    // styleWithCSS must be OFF here, otherwise Chrome emits font-size:xxx-large
    // (a keyword) instead of the <font size=7> tags we convert to real px.
    try { document.execCommand('styleWithCSS', false, false); } catch (e) {}
    document.execCommand('fontSize', false, '7');
    try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
    Array.prototype.forEach.call(editing.querySelectorAll('font[size="7"]'), function (f) {
      var sp = document.createElement('span');
      sp.style.fontSize = px + 'px';
      while (f.firstChild) sp.appendChild(f.firstChild);
      f.parentNode.replaceChild(sp, f);
    });
    // belt & braces: if the browser used the CSS keyword anyway, fix it up
    Array.prototype.forEach.call(editing.querySelectorAll('span[style*="x-large"]'), function (sp) {
      sp.style.fontSize = px + 'px';
    });
  }
  // keep the selection when clicking the bar (but let the colour picker open)
  // Opening the native colour picker moves DOM focus away from the editable
  // element, which would otherwise look like "user is done editing" and end
  // the edit session before a colour is even picked. This flag tells the
  // blur/focusout handlers to stay put while the picker is up.
  var pickingColor = false;
  fmtBar.addEventListener('mousedown', function (e) {
    if (e.target.closest('.fmt-color')) pickingColor = true;
    else e.preventDefault();
  });
  fmtBar.addEventListener('click', function (e) {
    var b = e.target.closest('[data-fmt]'); if (!b || !editing) return;
    fmtBusy = true;
    restoreSel();
    try { document.execCommand('styleWithCSS', false, true); } catch (err) {}
    var f = b.dataset.fmt;
    if (f === 'bold' || f === 'italic' || f === 'underline') document.execCommand(f, false, null);
    else if (f === 'clear') document.execCommand('removeFormat', false, null);
    else if (f === 'bigger') applyFontSize(Math.min(96, Math.round(selectionFontSize() * 1.2)));
    else if (f === 'smaller') applyFontSize(Math.max(6, Math.round(selectionFontSize() / 1.2)));
    fmtBusy = false;
    afterFmt();
  });
  var fmtColorEl = document.getElementById('fmtColor');
  function applyColour() {
    if (!editing) return;
    fmtBusy = true;
    restoreSel();
    try { document.execCommand('styleWithCSS', false, true); } catch (err) {}
    document.execCommand('foreColor', false, fmtColorEl.value);   // browser replaces, never nests
    fmtBusy = false;
    afterFmt();
  }
  fmtColorEl.addEventListener('input', applyColour);
  fmtColorEl.addEventListener('change', applyColour);
  // Picker closed (colour chosen or cancelled) — hand focus back to the editor.
  fmtColorEl.addEventListener('blur', function () {
    pickingColor = false;
    if (editing) editing.focus();
  });

  /* Rich inline editor: type freely, Enter = new line, select any part ->
     the format bar lets you make just that part bold / bigger / coloured. */
  function customById(id) {
    return (state.custom || []).filter(function (c) { return c.id === id; })[0];
  }
  function caretToEnd(el) {
    try {
      var rg = document.createRange(); rg.selectNodeContents(el); rg.collapse(false);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
    } catch (e) {}
  }
  function startInlineEdit(el, apply, initial, caretEnd) {
    if (editing) return;
    editing = el;
    el.setAttribute('contenteditable', 'true');
    el.classList.add('inline-edit');
    el.focus();
    // NB: never select-all — that made typing wipe the text. A double-click
    // keeps the browser's word selection; the ✎ button puts the caret at the end
    // so you can just keep typing (дописать).
    if (caretEnd) caretToEnd(el);
    setTimeout(showFmtBarForSelection, 0);
    function finish(commit) {
      el.removeEventListener('blur', onBlur);
      if (!editing) return;
      editing = null; hideFmtBar();
      var html = normalizeRich(el.innerHTML);
      el.removeAttribute('contenteditable'); el.classList.remove('inline-edit');
      if (commit && html !== initial) { markChange('Правка текста на шаблоне'); apply(html); }
      rebuildForm(); renderPreview();
    }
    function onBlur() {
      if (pickingColor) return;                  // colour picker stole focus — keep editing
      finish(true);
    }
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', function (ev) {
      ev.stopPropagation();                       // don't trigger Del/undo shortcuts
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); el.blur(); }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); el.blur(); }
    });
  }
  preview.addEventListener('dblclick', function (e) {
    if (placing) return;
    var cu = e.target.closest && e.target.closest('[data-custom]');
    if (cu) {
      var c = customById(cu.dataset.custom);
      if (!c) return;
      if (c.type === 'row') {                      // edit the half you clicked
        var part = e.target.closest('[data-part]');
        var f = part ? part.dataset.part : 'label';
        return startInlineEdit(part || cu, function (t) { c[f] = t; }, c[f]);
      }
      var fld = TEXT_FIELD[c.type];
      if (!fld) return;
      var ce = cu.dataset.caretEnd === '1'; delete cu.dataset.caretEnd;
      return startInlineEdit(cu, function (t) { c[fld] = t; }, c[fld], ce);
    }
    var ed = e.target.closest && e.target.closest('[data-edit]');
    if (ed) {
      var path = ed.dataset.edit;
      startInlineEdit(ed, function (t) { setPath(state, path, t); },
        String(getPath(state, path) == null ? '' : getPath(state, path)));
    }
  });

  /* the panel's rich editor uses the very same format bar */
  controls.addEventListener('focusin', function (e) {
    if (e.target.dataset && e.target.dataset.rich) { editing = e.target; setTimeout(showFmtBarForSelection, 0); }
  });
  controls.addEventListener('focusout', function (e) {
    if (e.target.dataset && e.target.dataset.rich) setTimeout(function () {
      if (pickingColor) return;                  // colour picker stole focus — keep editing
      if (editing === e.target) { editing = null; hideFmtBar(); }
    }, 150);
  });

  /* ---- floating toolbar over the selected custom element --------------- */
  function positionSelBar() {
    var bar = document.getElementById('selBar');
    if (!bar) return;
    var el = selId && preview.querySelector('[data-custom="' + selId + '"]');
    if (!el) { bar.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    bar.style.display = 'flex';
    bar.style.left = (r.left + r.width / 2) + 'px';
    bar.style.top = (r.top - 10) + 'px';
  }
  document.getElementById('selBar').addEventListener('click', function (e) {
    var b = e.target.closest('[data-sb]'); if (!b || !selId) return;
    var i = (state.custom || []).findIndex(function (c) { return c.id === selId; });
    if (i < 0) return;
    var act = b.dataset.sb;
    if (act === 'edit') {
      var el = preview.querySelector('[data-custom="' + selId + '"]');
      if (el) { el.dataset.caretEnd = '1'; el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }
      return;
    }
    if (act === 'dup') {
      var cp = JSON.parse(JSON.stringify(state.custom[i])); cp.id = uid(); cp.x += 12; cp.y += 12;
      markChange('Дублирован элемент'); state.custom.push(cp); selId = cp.id;
    }
    if (act === 'del') { markChange('Удалён элемент'); state.custom.splice(i, 1); selId = null; }
    rebuildForm(); renderPreview();
  });

  /* ---- API card (key + publish template + docs) ------------------------ */
  var apiKeyEl = document.getElementById('apiKey');
  function apiOrigin() { return location.origin + location.pathname.replace(/\/[^\/]*$/, ''); }
  function apiMsg(html, bad) {
    document.getElementById('apiMsg').innerHTML =
      '<span style="color:' + (bad ? '#ff9' : '#c9ffdc') + '">' + html + '</span>';
  }
  function refreshApiDocs() {
    var k = (apiKeyEl.value || 'ВАШ_КЛЮЧ').trim();
    var base = apiOrigin() + '/api/image';
    var u = base + '?key=' + encodeURIComponent(k) + '&url=<ССЫЛКА_SUBITO>&scale=2';
    document.getElementById('apiUrl').textContent = 'GET ' + u;
    document.getElementById('apiCurl').textContent =
      'curl -o out.png "' + base + '?key=' + k +
      '&url=https://www.subito.it/.../annuncio-123.htm&scale=2"';
    try { localStorage.setItem('api-key', apiKeyEl.value || ''); } catch (e) {}
  }
  apiKeyEl.addEventListener('input', refreshApiDocs);
  try { apiKeyEl.value = localStorage.getItem('api-key') || ''; } catch (e) {}
  // on localhost the server reveals the auto-generated key for convenience
  if (!apiKeyEl.value) {
    fetch('api/key').then(function (r) { return r.json(); }).then(function (res) {
      if (res.ok && res.key) { apiKeyEl.value = res.key; refreshApiDocs(); }
    }).catch(function () {});
  }
  refreshApiDocs();

  document.getElementById('apiPublish').addEventListener('click', function () {
    var k = (apiKeyEl.value || '').trim();
    if (!k) { apiMsg('Сначала укажите API-ключ', true); return; }
    apiMsg('Публикую шаблон…');
    fetch('api/template?key=' + encodeURIComponent(k), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'ошибка');
      apiMsg('✓ Шаблон опубликован — API теперь рендерит в этом оформлении.');
    }).catch(function (e) { apiMsg('Ошибка: ' + esc(e.message), true); });
  });
  document.getElementById('apiTest').addEventListener('click', function () {
    var k = (apiKeyEl.value || '').trim();
    var url = (document.getElementById('pUrl').value || '').trim();
    if (!/subito\.it\//i.test(url)) { apiMsg('Вставьте ссылку Subito в поле выше — проверю на ней', true); return; }
    apiMsg('Проверяю API…');
    fetch('api/image?key=' + encodeURIComponent(k) + '&url=' + encodeURIComponent(url) + '&scale=1')
      .then(function (r) {
        if (r.headers.get('content-type') === 'image/png') return r.blob();
        return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
      })
      .then(function (b) { apiMsg('✓ API работает — картинка ' + Math.round(b.size / 1024) + ' КБ. ' +
        '<a href="' + URL.createObjectURL(b) + '" target="_blank" style="color:#9fd">открыть</a>'); })
      .catch(function (e) { apiMsg('Ошибка: ' + esc(e.message), true); });
  });
  document.getElementById('apiTpl').addEventListener('click', function () {
    download(JSON.stringify(state, null, 2), 'template.json', 'application/json');
    apiMsg('Положите template.json в корень репозитория и запушьте — шаблон переживёт перезапуск.');
  });

  /* ---- QR link override (lives in the template, so it sticks) ---------- */
  var pQrLink = document.getElementById('pQrLink');
  function qrLinkNote() {
    var v = (state.qr && state.qr.linkOverride || '').trim();
    document.getElementById('pQrLinkNote').textContent = v
      ? '✓ QR ведёт сюда' : 'QR ведёт на объявление';
  }
  pQrLink.value = (state.qr && state.qr.linkOverride) || '';
  qrLinkNote();
  pQrLink.addEventListener('input', function () {
    markChange('Ссылка для QR', 'qr.linkOverride');
    state.qr = state.qr || {};
    state.qr.linkOverride = this.value.trim();
    persist(); qrLinkNote();
    rebuildForm();
    if (lastListingData) reapplyParser();      // live: re-point the QR right away
    else renderPreview();
  });
  // One click puts the link on the template as a {{link}} text block (or jumps
  // to the one that is already there) — no need to know about the add-menu.
  document.getElementById('pQrPlace').addEventListener('click', function () {
    var ex = (state.custom || []).filter(function (c) {
      return /\{\{\s*link\s*\}\}/.test(String(c.text || ''));
    })[0];
    switchTab('builder');
    if (ex) { selectCustom(ex.id); flash('Блок со ссылкой уже на шаблоне — выделил его'); }
    else { addCustom('link', 53, 380); flash('Блок «Ссылка» добавлен — тяните его куда нужно'); }
  });

  document.getElementById('pGo').addEventListener('click', parserLoad);
  document.getElementById('pUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') parserLoad(); });

  document.querySelector('.parser-result').addEventListener('click', function (e) {
    var ex = e.target.closest && e.target.closest('[data-pexport]');
    if (ex && parserState) { exportPNG(Number(ex.dataset.pexport), parserState); }
  });
  document.getElementById('pToBuilder').addEventListener('click', function () {
    if (!parserState) return;
    state = clone(parserState); rebuildForm(); renderPreview(); switchTab('builder');
    flash('Открыто в конструкторе');
  });
  document.getElementById('pDownJson').addEventListener('click', function () {
    if (parserState) download(JSON.stringify(parserState, null, 2), 'subito-config.json', 'application/json');
  });
  document.getElementById('pDownQr').addEventListener('click', function () {
    var im = parserState && parserState.qr && parserState.qr.image;
    if (im) download(dataURLToBlob(im), 'qr.png'); else flash('В этом шаблоне нет QR');
  });
  window.addEventListener('resize', function () { if (parserState) parserRender(); positionSelBar(); });
  document.querySelector('.canvas-scroll').addEventListener('scroll', positionSelBar);

  /* ---- console / automation API --------------------------------------- */
  window.Builder = {
    get: function () { return clone(state); },
    set: function (cfg) { markChange('Загружен конфиг'); state = fillCustomDefaults(window.mergeConfig(clone(window.DEFAULT_CONFIG), cfg)); return genQR().then(function () { rebuildForm(); renderPreview(); }); },
    patch: function (path, val) {
      markChange('Правка: ' + pathLabel(path), path);
      setPath(state, path, val);
      if (qrNeedsRegen(path)) return genQR().then(function () { rebuildForm(); renderPreview(); });
      rebuildForm(); renderPreview();
    },
    exportPNG: exportPNG,
    reset: function () { state = clone(window.DEFAULT_CONFIG); rebuildForm(); renderPreview(); }
  };

  /* ---- boot ------------------------------------------------------------ */
  buildForm();
  markChange('Начальное состояние');
  renderPreview();
  renderParserOpts();
  updateRestoreBtn();
  // (re)render the QR with the styled engine if it's on
  if (state.qr && state.qr.show && (state.qr.data || state.qr.mode === 'custom')) {
    genQR().then(renderPreview);
  }
  try {
    var savedTab = localStorage.getItem('active-tab');
    if (savedTab === 'parser') switchTab('parser');
  } catch (e) {}
})();
