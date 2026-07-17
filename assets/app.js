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

  function loadState() {
    var raw = lsGet(LS_KEY);
    if (!raw) return clone(window.DEFAULT_CONFIG);
    try {
      // saved OVER defaults -> new fields appear, user's settings are kept
      return window.mergeConfig(clone(window.DEFAULT_CONFIG), JSON.parse(raw));
    } catch (e) {
      lsSet(LS_BACKUP, raw);          // corrupt: keep a copy, never lose it silently
      return clone(window.DEFAULT_CONFIG);
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
      fSelect('Шрифт', 'theme.font', [
        { v: '', l: 'Системный (Segoe UI)' },
        { v: 'Arial, Helvetica, sans-serif', l: 'Arial / Helvetica' },
        { v: '"Roboto", system-ui, sans-serif', l: 'Roboto' },
        { v: 'Verdana, Geneva, sans-serif', l: 'Verdana' },
        { v: '"Trebuchet MS", sans-serif', l: 'Trebuchet MS' }]) +
      fRange('Скругление карточек', 'theme.cardRadius', 0, 24, 1) +
      '<div class="theme-grid">' + theme + '</div>';

    controls.innerHTML =
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
    if (input.type === 'number' || input.type === 'range') return Number(input.value);
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
    addOpt: 'Добавлена опция', delOpt: 'Удалена опция',
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
        if (blob) download(blob, 'acquista-a-distanza@' + scale + 'x.png', 'image/png');
        else alert('Экспорт не удался в этом браузере.');
      }, 'image/png');
    };
    img.onerror = function () { alert('Экспорт не удался: не удалось сериализовать вид.'); };
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
        state = window.mergeConfig(clone(window.DEFAULT_CONFIG), cfg);
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
      state = window.mergeConfig(clone(window.DEFAULT_CONFIG), JSON.parse(raw));
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
      var el = e.target.closest('[data-block]');
      if (!el || !host.contains(el)) return;
      e.preventDefault();
      var z = getZoom();
      var hostRect = host.getBoundingClientRect();
      var elRect = el.getBoundingClientRect();
      var w = el.offsetWidth;
      drag = {
        el: el, key: el.dataset.block, hostRect: hostRect, w: w,
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
        markChange('Перемещён блок: ' + (SECTION_LABELS[drag.key] || drag.key));
        var cfg = getCfg();
        cfg.layout = cfg.layout || { order: ['summary', 'discount', 'shipping'] };
        cfg.layout.free = cfg.layout.free || {};
        cfg.layout.free[drag.key] = { x: drag._x, y: drag._y, w: drag.w };
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
      if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
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
  window.addEventListener('resize', function () { if (parserState) parserRender(); });

  /* ---- console / automation API --------------------------------------- */
  window.Builder = {
    get: function () { return clone(state); },
    set: function (cfg) { markChange('Загружен конфиг'); state = window.mergeConfig(clone(window.DEFAULT_CONFIG), cfg); return genQR().then(function () { rebuildForm(); renderPreview(); }); },
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
