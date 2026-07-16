/* ============================================================================
 * qr.js — self-contained QR Code generator (byte mode, versions 1..10,
 * EC levels L/M/Q/H). No dependencies. Exposes:
 *   QR.matrix(text, {ecl})        -> boolean[][]  (true = dark module)
 *   QR.toDataURL(text, {ecl,scale,margin,dark,light}) -> PNG data URL
 * Implements ISO/IEC 18004 encoding + Reed-Solomon EC + mask selection.
 * ==========================================================================*/
(function (root) {
  'use strict';

  /* --- GF(256) tables (primitive poly 0x11d) --- */
  var EXP = new Array(256), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (i = 255; i < 256; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[(LOG[a] + LOG[b]) % 255]; }

  /* generator polynomial for `deg` EC codewords */
  function genPoly(deg) {
    var p = [1];
    for (var i = 0; i < deg; i++) {
      var np = new Array(p.length + 1).fill(0);
      for (var j = 0; j < p.length; j++) {
        np[j] ^= p[j];
        np[j + 1] ^= gmul(p[j], EXP[i]);
      }
      p = np;
    }
    return p;
  }
  function rsEncode(data, ecLen) {
    var gen = genPoly(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      for (var j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1] || 0, factor);
    }
    return res;
  }

  /* --- RS block table for versions 1..10, order [M,L,H,Q] per Arase idx --- */
  /* We store as VER_EC[version][ecl] = array of [totalPerBlock, dataPerBlock, count] */
  var EC = { L: 0, M: 1, Q: 2, H: 3 };
  /* Each version: {L:[[tot,data,cnt],...], M:..., Q:..., H:...} */
  var RS = {
    1: { L: [[26,19,1]], M: [[26,16,1]], Q: [[26,13,1]], H: [[26,9,1]] },
    2: { L: [[44,34,1]], M: [[44,28,1]], Q: [[44,22,1]], H: [[44,16,1]] },
    3: { L: [[70,55,1]], M: [[70,44,1]], Q: [[35,17,2]], H: [[35,13,2]] },
    4: { L: [[100,80,1]], M: [[50,32,2]], Q: [[50,24,2]], H: [[25,9,4]] },
    5: { L: [[134,108,1]], M: [[67,43,2]], Q: [[33,15,2],[34,16,2]], H: [[33,11,2],[34,12,2]] },
    6: { L: [[86,68,2]], M: [[43,27,4]], Q: [[43,19,4]], H: [[43,15,4]] },
    7: { L: [[98,78,2]], M: [[49,31,4]], Q: [[32,14,2],[33,15,4]], H: [[39,13,4],[40,14,1]] },
    8: { L: [[121,97,2]], M: [[60,38,2],[61,39,2]], Q: [[40,18,4],[41,19,2]], H: [[40,14,4],[41,15,2]] },
    9: { L: [[146,116,2]], M: [[58,36,3],[59,37,2]], Q: [[36,16,4],[37,17,4]], H: [[36,12,4],[37,13,4]] },
    10:{ L: [[86,68,2],[87,69,2]], M: [[69,43,4],[70,44,1]], Q: [[43,19,6],[44,20,2]], H: [[43,15,6],[44,16,2]] }
  };
  function dataCapacity(ver, ecl) {
    return RS[ver][ecl].reduce(function (s, b) { return s + b[1] * b[2]; }, 0);
  }

  /* alignment pattern centers per version (2..10) */
  var ALIGN = {
    1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30], 6: [6,34],
    7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50]
  };

  function size(ver) { return ver * 4 + 17; }

  /* --- bit buffer --- */
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function utf8Bytes(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff) {
        c = 0x10000 + ((c & 0x3ff) << 10) + (str.charCodeAt(++i) & 0x3ff);
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }

  function chooseVersion(len, ecl) {
    for (var v = 1; v <= 10; v++) {
      var ccBits = v <= 9 ? 8 : 16;
      var need = 4 + ccBits + len * 8;
      if (need <= dataCapacity(v, ecl) * 8) return v;
    }
    throw new Error('QR: data too long for versions 1..10 (' + len + ' bytes)');
  }

  function buildCodewords(bytes, ver, ecl) {
    var cap = dataCapacity(ver, ecl);
    var bb = new BitBuf();
    bb.put(4, 4);                       // byte mode
    bb.put(bytes.length, ver <= 9 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);
    // terminator
    var maxBits = cap * 8;
    for (i = 0; i < 4 && bb.bits.length < maxBits; i++) bb.bits.push(0);
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);
    var data = [];
    for (i = 0; i < bb.bits.length; i += 8) {
      var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bb.bits[i + j];
      data.push(b);
    }
    var pad = [0xec, 0x11], p = 0;
    while (data.length < cap) data.push(pad[p++ % 2]);

    // split into blocks, compute EC, then interleave
    var blocks = [], di = 0;
    RS[ver][ecl].forEach(function (spec) {
      var tot = spec[0], dcount = spec[1], cnt = spec[2];
      for (var c = 0; c < cnt; c++) {
        var d = data.slice(di, di + dcount); di += dcount;
        blocks.push({ data: d, ec: rsEncode(d, tot - dcount) });
      }
    });
    var maxD = 0, maxE = 0;
    blocks.forEach(function (b) { maxD = Math.max(maxD, b.data.length); maxE = Math.max(maxE, b.ec.length); });
    var out = [];
    for (i = 0; i < maxD; i++) blocks.forEach(function (b) { if (i < b.data.length) out.push(b.data[i]); });
    for (i = 0; i < maxE; i++) blocks.forEach(function (b) { if (i < b.ec.length) out.push(b.ec[i]); });
    return out;
  }

  /* --- module placement --- */
  function newMatrix(n) {
    var m = []; for (var i = 0; i < n; i++) { m.push([]); for (var j = 0; j < n; j++) m[i].push(null); }
    return m;
  }
  function setFinder(m, r, c) {
    for (var i = -1; i <= 7; i++) for (var j = -1; j <= 7; j++) {
      var rr = r + i, cc = c + j;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      var dark = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                 (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                 (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      m[rr][cc] = dark;
    }
  }
  function place(codewords, ver, mask) {
    var n = size(ver), m = newMatrix(n), i, j;
    setFinder(m, 0, 0); setFinder(m, 0, n - 7); setFinder(m, n - 7, 0);
    // timing
    for (i = 8; i < n - 8; i++) { if (m[6][i] == null) m[6][i] = (i % 2 === 0); if (m[i][6] == null) m[i][6] = (i % 2 === 0); }
    // alignment
    var ap = ALIGN[ver];
    for (var a = 0; a < ap.length; a++) for (var b = 0; b < ap.length; b++) {
      var r = ap[a], c = ap[b];
      // omit only the three patterns that overlap the finder patterns; the
      // ones on the timing row/col (e.g. (6,22)) are still drawn.
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 8) || (r >= n - 8 && c <= 8)) continue;
      for (i = -2; i <= 2; i++) for (j = -2; j <= 2; j++)
        m[r + i][c + j] = (Math.max(Math.abs(i), Math.abs(j)) !== 1);
    }
    m[n - 8][8] = true; // dark module
    // reserve format/version areas (mark as taken, value set later)
    var reserved = newMatrix(n);
    function reserve(r, c) { reserved[r][c] = true; }
    for (i = 0; i < 9; i++) { if (m[8][i] == null) reserve(8, i); if (m[i][8] == null) reserve(i, 8); }
    for (i = 0; i < 8; i++) { if (m[8][n - 1 - i] == null) reserve(8, n - 1 - i); if (m[n - 1 - i][8] == null) reserve(n - 1 - i, 8); }
    if (ver >= 7) {
      for (i = 0; i < 6; i++) for (j = 0; j < 3; j++) { reserve(i, n - 11 + j); reserve(n - 11 + j, i); }
    }

    // place data with zig-zag
    var bitIdx = 0, dir = -1, col = n - 1;
    function maskFn(r, c) {
      switch (mask) {
        case 0: return (r + c) % 2 === 0;
        case 1: return r % 2 === 0;
        case 2: return c % 3 === 0;
        case 3: return (r + c) % 3 === 0;
        case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
        case 5: return (r * c) % 2 + (r * c) % 3 === 0;
        case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
        case 7: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
      }
    }
    for (; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (var count = 0; count < n; count++) {
        var row = dir < 0 ? n - 1 - count : count;
        for (var csub = 0; csub < 2; csub++) {
          var cc = col - csub;
          if (m[row][cc] != null || reserved[row][cc]) continue;
          var dark = false;
          if (bitIdx < codewords.length * 8) {
            var byte = codewords[bitIdx >> 3];
            dark = ((byte >> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          if (maskFn(row, cc)) dark = !dark;
          m[row][cc] = dark;
        }
      }
      dir = -dir;
    }

    // format info
    var ecBits = { L: 1, M: 0, Q: 3, H: 2 };
    var fmt = (ecBits[ecl0] << 3) | mask;
    var f = fmt << 10;
    var g = 0x537;
    for (i = 14; i >= 10; i--) if ((f >> i) & 1) f ^= g << (i - 10);
    var format = ((fmt << 10) | f) ^ 0x5412;
    var fbits = []; for (i = 14; i >= 0; i--) fbits.push((format >> i) & 1);
    // place format around top-left, and split around others
    var coords1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    for (i = 0; i < 15; i++) m[coords1[i][0]][coords1[i][1]] = fbits[i] === 1;
    for (i = 0; i < 7; i++) m[n - 1 - i][8] = fbits[i] === 1;
    for (i = 0; i < 8; i++) m[8][n - 8 + i] = fbits[7 + i] === 1;

    // version info (>=7)
    if (ver >= 7) {
      var vd = ver << 12, gp = 0x1f25;
      for (i = 17; i >= 12; i--) if ((vd >> i) & 1) vd ^= gp << (i - 12);
      var vinfo = (ver << 12) | vd;
      for (i = 0; i < 18; i++) {
        var bit = ((vinfo >> i) & 1) === 1;
        var rr = Math.floor(i / 3), cc2 = i % 3;
        m[rr][n - 11 + cc2] = bit; m[n - 11 + cc2][rr] = bit;
      }
    }
    return m;
  }

  var ecl0; // ec level in scope for place()
  function penalty(m) {
    var n = m.length, p = 0, i, j, k;
    // rule 1: runs
    for (i = 0; i < n; i++) for (var t = 0; t < 2; t++) {
      var run = 1, prev = t ? m[0][i] : m[i][0];
      for (j = 1; j < n; j++) {
        var cur = t ? m[j][i] : m[i][j];
        if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else { run = 1; prev = cur; }
      }
    }
    // rule 2: 2x2 blocks
    for (i = 0; i < n - 1; i++) for (j = 0; j < n - 1; j++)
      if (m[i][j] === m[i][j + 1] && m[i][j] === m[i + 1][j] && m[i][j] === m[i + 1][j + 1]) p += 3;
    // rule 3: finder-like patterns
    var pat = [true,false,true,true,true,false,true];
    function match(get) {
      for (i = 0; i < n; i++) for (j = 0; j <= n - 7; j++) {
        var ok = true; for (k = 0; k < 7; k++) if (get(i, j + k) !== pat[k]) { ok = false; break; }
        if (ok) p += 40;
      }
    }
    match(function (r, c) { return m[r][c]; });
    match(function (r, c) { return m[c][r]; });
    // rule 4: dark ratio
    var dark = 0; for (i = 0; i < n; i++) for (j = 0; j < n; j++) if (m[i][j]) dark++;
    var ratio = dark * 100 / (n * n);
    p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return p;
  }

  function matrix(text, opts) {
    opts = opts || {};
    ecl0 = (opts.ecl && EC.hasOwnProperty(opts.ecl)) ? opts.ecl : 'M';
    var bytes = utf8Bytes(String(text == null ? '' : text));
    var ver = opts.version || chooseVersion(bytes.length, ecl0);
    var cw = buildCodewords(bytes, ver, ecl0);
    if (opts.mask != null) return place(cw, ver, opts.mask);
    var best = null, bestP = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      var m = place(cw, ver, mk), pen = penalty(m);
      if (pen < bestP) { bestP = pen; best = m; }
    }
    return best;
  }

  function toDataURL(text, opts) {
    opts = opts || {};
    var m = matrix(text, opts);
    var n = m.length, scale = opts.scale || 4, margin = opts.margin == null ? 4 : opts.margin;
    var dim = (n + margin * 2) * scale;
    var c = document.createElement('canvas'); c.width = c.height = dim;
    var ctx = c.getContext('2d');
    ctx.fillStyle = opts.light || '#ffffff'; ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = opts.dark || '#000000';
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) if (m[i][j])
      ctx.fillRect((j + margin) * scale, (i + margin) * scale, scale, scale);
    return c.toDataURL('image/png');
  }

  root.QR = { matrix: matrix, toDataURL: toDataURL };
})(typeof window !== 'undefined' ? window : this);
