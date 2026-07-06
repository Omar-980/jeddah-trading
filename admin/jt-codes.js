/* =========================================================
   Jeddah Trading — self-contained barcode (Code128) + QR.
   No external libraries / no internet required. Works offline
   and on any host. Exposes window.JTBarcode and window.JTQR
   (and module.exports for tests).
   ========================================================= */
(function (root) {
  'use strict';

  /* ---------------- Code128 (auto B/C) ---------------- */
  // 107 module patterns (values 0..106); each is widths of bar,space,bar,... ; stop has 7.
  var C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112'];
  var START_B = 104, START_C = 105, STOP = 106;

  function code128Values(data) {
    // Choose Code C when the whole string is an even number of digits (compact, common for numeric barcodes).
    var allDigits = /^\d+$/.test(data);
    var codes, i, sum, check;
    if (allDigits && data.length % 2 === 0) {
      codes = [START_C];
      for (i = 0; i < data.length; i += 2) codes.push(parseInt(data.substr(i, 2), 10));
    } else {
      // Code B: printable ASCII 32..127 → value = code-32
      codes = [START_B];
      for (i = 0; i < data.length; i++) {
        var c = data.charCodeAt(i);
        if (c < 32 || c > 126) c = 32 + 31; // replace unsupported char with '?' area safely
        codes.push(c - 32);
      }
    }
    sum = codes[0];
    for (i = 1; i < codes.length; i++) sum += codes[i] * i;
    check = sum % 103;
    codes.push(check);
    codes.push(STOP);
    return codes;
  }

  // Returns an array of bar widths where index 0 is a black bar, 1 a space, alternating.
  function code128Bars(data) {
    var codes = code128Values(data), widths = [], i, j, pat;
    for (i = 0; i < codes.length; i++) {
      pat = C128[codes[i]];
      for (j = 0; j < pat.length; j++) widths.push(parseInt(pat[j], 10));
    }
    return widths; // starts with a bar, alternating bar/space
  }

  function barcodeSVG(data, opt) {
    opt = opt || {};
    var unit = opt.unit || 2, height = opt.height || 60, pad = opt.pad != null ? opt.pad : 10, fontSize = opt.fontSize || 14;
    var showText = opt.text !== false;
    var widths = code128Bars(String(data || ''));
    var totalUnits = widths.reduce(function (a, b) { return a + b; }, 0);
    var w = totalUnits * unit + pad * 2;
    var textH = showText ? fontSize + 6 : 0;
    var h = height + pad + textH;
    var rects = '', x = pad, isBar = true;
    for (var i = 0; i < widths.length; i++) {
      var ww = widths[i] * unit;
      if (isBar) rects += '<rect x="' + x + '" y="' + pad + '" width="' + ww + '" height="' + height + '" fill="#000"/>';
      x += ww; isBar = !isBar;
    }
    var label = showText ? '<text x="' + (w / 2) + '" y="' + (pad + height + fontSize) + '" text-anchor="middle" font-family="monospace" font-size="' + fontSize + '" fill="#000">' + String(data) + '</text>' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><rect width="' + w + '" height="' + h + '" fill="#fff"/>' + rects + label + '</svg>';
  }

  /* ---------------- QR Code (byte mode, EC level M, versions 1..10) ---------------- */
  // Galois field GF(256) tables
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var k = 255; k < 512; k++) EXP[k] = EXP[k - 255];
  })();
  function gmul(a, b) { if (a === 0 || b === 0) return 0; return EXP[LOG[a] + LOG[b]]; }
  function rsGenPoly(n) {
    var poly = [1];
    for (var i = 0; i < n; i++) {
      var np = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        np[j] ^= gmul(poly[j], 1);
        np[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = np;
    }
    return poly;
  }
  function rsEncode(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var res = data.slice().concat(new Array(ecLen).fill(0));
    for (var i = 0; i < data.length; i++) {
      var coef = res[i];
      if (coef !== 0) for (var j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], coef);
    }
    return res.slice(data.length);
  }

  // Per-version (1..10), EC level M: [total data codewords, ec per block, num blocks group1, dc per block g1, num g2, dc g2]
  // Source: QR spec tables for EC level M.
  var VER_M = {
    1: { ec: 10, blocks: [[1, 16]] },
    2: { ec: 16, blocks: [[1, 28]] },
    3: { ec: 26, blocks: [[1, 44]] },
    4: { ec: 18, blocks: [[2, 32]] },
    5: { ec: 24, blocks: [[2, 43]] },
    6: { ec: 16, blocks: [[4, 27]] },
    7: { ec: 18, blocks: [[4, 31]] },
    8: { ec: 22, blocks: [[2, 38], [2, 39]] },
    9: { ec: 22, blocks: [[3, 36], [2, 37]] },
    10: { ec: 26, blocks: [[4, 43], [1, 44]] }
  };
  function versionCapacityBytes(v) {
    var info = VER_M[v], dataCW = 0;
    info.blocks.forEach(function (b) { dataCW += b[0] * b[1]; });
    // byte mode: 4 bits mode + count bits + 8*n + ... ; count bits = 8 (v1-9) or 16 (v10+)
    var countBits = v <= 9 ? 8 : 16;
    return Math.floor((dataCW * 8 - 4 - countBits) / 8);
  }

  function buildData(strBytes, v) {
    var info = VER_M[v], totalDataCW = 0;
    info.blocks.forEach(function (b) { totalDataCW += b[0] * b[1]; });
    var countBits = v <= 9 ? 8 : 16;
    var bits = [];
    function push(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    push(0x4, 4);                 // byte mode
    push(strBytes.length, countBits);
    for (var i = 0; i < strBytes.length; i++) push(strBytes[i], 8);
    // terminator
    var cap = totalDataCW * 8;
    var term = Math.min(4, cap - bits.length);
    for (var t = 0; t < term; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var bytes = [];
    for (var b = 0; b < bits.length; b += 8) { var v8 = 0; for (var k = 0; k < 8; k++) v8 = (v8 << 1) | bits[b + k]; bytes.push(v8); }
    var pad = [0xEC, 0x11], pi = 0;
    while (bytes.length < totalDataCW) { bytes.push(pad[pi % 2]); pi++; }
    // split into blocks, compute EC, interleave
    var blocks = [], idx = 0;
    info.blocks.forEach(function (grp) {
      for (var n = 0; n < grp[0]; n++) {
        var dc = bytes.slice(idx, idx + grp[1]); idx += grp[1];
        var ec = rsEncode(dc, info.ec);
        blocks.push({ dc: dc, ec: ec });
      }
    });
    var maxDc = 0; blocks.forEach(function (bl) { maxDc = Math.max(maxDc, bl.dc.length); });
    var result = [];
    for (var c = 0; c < maxDc; c++) blocks.forEach(function (bl) { if (c < bl.dc.length) result.push(bl.dc[c]); });
    for (var e = 0; e < info.ec; e++) blocks.forEach(function (bl) { result.push(bl.ec[e]); });
    return result;
  }

  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

  function buildMatrix(dataCW, v) {
    var size = 17 + v * 4;
    var m = [], reserved = [];
    for (var i = 0; i < size; i++) { m.push(new Array(size).fill(null)); reserved.push(new Array(size).fill(false)); }
    function setF(r, c, val) { m[r][c] = val ? 1 : 0; reserved[r][c] = true; }
    function placeFinder(r, c) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        var inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        var inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setF(rr, cc, inRing || inCore ? 1 : 0);
      }
    }
    placeFinder(0, 0); placeFinder(0, size - 7); placeFinder(size - 7, 0);
    // timing
    for (var t = 8; t < size - 8; t++) { setF(6, t, t % 2 === 0 ? 1 : 0); setF(t, 6, t % 2 === 0 ? 1 : 0); }
    // alignment patterns
    var ap = ALIGN[v];
    for (var ai = 0; ai < ap.length; ai++) for (var aj = 0; aj < ap.length; aj++) {
      var cr = ap[ai], cc2 = ap[aj];
      if ((cr <= 7 && cc2 <= 7) || (cr <= 7 && cc2 >= size - 8) || (cr >= size - 8 && cc2 <= 7)) continue;
      for (var ddr = -2; ddr <= 2; ddr++) for (var ddc = -2; ddc <= 2; ddc++) {
        var ring = Math.max(Math.abs(ddr), Math.abs(ddc));
        setF(cr + ddr, cc2 + ddc, ring === 1 ? 0 : 1);
      }
    }
    // dark module
    setF(size - 8, 8, 1);
    // reserve format areas
    for (var fi = 0; fi <= 8; fi++) { if (!reserved[8][fi]) reserved[8][fi] = true; if (!reserved[fi][8]) reserved[fi][8] = true; }
    for (var f2 = 0; f2 < 8; f2++) { reserved[8][size - 1 - f2] = true; reserved[size - 1 - f2][8] = true; }
    reserved[8][8] = true;
    // reserve version info (v>=7) — not needed for v<=6, but include for completeness
    if (v >= 7) {
      for (var vr = 0; vr < 6; vr++) for (var vc = 0; vc < 3; vc++) { reserved[vr][size - 11 + vc] = true; reserved[size - 11 + vc][vr] = true; }
    }
    // place data
    var bitIdx = 0, dirUp = true;
    function bitAt(i) { return (dataCW[i >> 3] >> (7 - (i & 7))) & 1; }
    var totalBits = dataCW.length * 8;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (var rowStep = 0; rowStep < size; rowStep++) {
        var row = dirUp ? size - 1 - rowStep : rowStep;
        for (var cpair = 0; cpair < 2; cpair++) {
          var cc3 = col - cpair;
          if (reserved[row][cc3]) continue;
          var bit = bitIdx < totalBits ? bitAt(bitIdx) : 0;
          m[row][cc3] = bit; bitIdx++;
        }
      }
      dirUp = !dirUp;
    }
    return { m: m, reserved: reserved, size: size };
  }

  function applyMaskAndFormat(base) {
    var size = base.size;
    var masks = [
      function (r, c) { return (r + c) % 2 === 0; },
      function (r, c) { return r % 2 === 0; },
      function (r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; },
      function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return ((r * c) % 2 + (r * c) % 3) === 0; },
      function (r, c) { return (((r * c) % 2 + (r * c) % 3) % 2) === 0; },
      function (r, c) { return (((r + c) % 2 + (r * c) % 3) % 2) === 0; }
    ];
    function formatBits(maskId) {
      // EC level M = 0b00 ; format = (ecBits<<3 | mask) with BCH(15,5) + xor mask 0x5412
      var ec = 0; // M
      var data = (ec << 3) | maskId;
      var rem = data << 10;
      var g = 0x537;
      for (var i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= g << (i - 10);
      var bits = ((data << 10) | rem) ^ 0x5412;
      return bits & 0x7fff;
    }
    function buildMasked(maskId) {
      var mm = [];
      for (var r = 0; r < size; r++) mm.push(base.m[r].slice());
      for (var r2 = 0; r2 < size; r2++) for (var c = 0; c < size; c++) {
        if (!base.reserved[r2][c] && masks[maskId](r2, c)) mm[r2][c] ^= 1;
      }
      // place format info
      var fb = formatBits(maskId);
      for (var i = 0; i < 15; i++) {
        var bit = (fb >> i) & 1;
        // around top-left
        if (i < 6) mm[8][i] = bit;
        else if (i === 6) mm[8][7] = bit;
        else if (i === 7) mm[8][8] = bit;
        else if (i === 8) mm[7][8] = bit;
        else mm[14 - i][8] = bit;
        // mirror copy
        if (i < 8) mm[size - 1 - i][8] = bit;
        else mm[8][size - 15 + i] = bit;
      }
      mm[size - 8][8] = 1; // dark module ensured
      return mm;
    }
    function penalty(mm) {
      var p = 0, r, c, i;
      // rule 1: runs
      for (r = 0; r < size; r++) {
        var rc = 1, cc = 1;
        for (c = 1; c < size; c++) {
          if (mm[r][c] === mm[r][c - 1]) { rc++; if (rc === 5) p += 3; else if (rc > 5) p++; } else rc = 1;
          if (mm[c][r] === mm[c - 1][r]) { cc++; if (cc === 5) p += 3; else if (cc > 5) p++; } else cc = 1;
        }
      }
      // rule 2: 2x2 blocks
      for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) {
        var v = mm[r][c]; if (v === mm[r][c + 1] && v === mm[r + 1][c] && v === mm[r + 1][c + 1]) p += 3;
      }
      // rule 3: finder-like patterns
      var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      function match(arr, i, get) {
        for (var k = 0; k < 11; k++) if (get(i + k) !== arr[k]) return false; return true;
      }
      for (r = 0; r < size; r++) for (c = 0; c < size - 10; c++) {
        if (match(pat1, c, function (x) { return mm[r][x]; }) || match(pat2, c, function (x) { return mm[r][x]; })) p += 40;
      }
      for (c = 0; c < size; c++) for (r = 0; r < size - 10; r++) {
        if (match(pat1, r, function (x) { return mm[x][c]; }) || match(pat2, r, function (x) { return mm[x][c]; })) p += 40;
      }
      // rule 4: dark ratio
      var dark = 0; for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += mm[r][c];
      var ratio = dark * 100 / (size * size);
      p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
      return p;
    }
    var best = null, bestP = Infinity;
    for (var mid = 0; mid < 8; mid++) { var mm = buildMasked(mid); var pp = penalty(mm); if (pp < bestP) { bestP = pp; best = mm; } }
    return best;
  }

  function qrMatrix(text) {
    var bytes = toUTF8(String(text));
    var v = 1; while (v <= 10 && bytes.length > versionCapacityBytes(v)) v++;
    if (v > 10) throw new Error('QR payload too long');
    var dataCW = buildData(bytes, v);
    var base = buildMatrix(dataCW, v);
    return applyMaskAndFormat(base);
  }
  function toUTF8(s) {
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }
  function qrSVG(text, opt) {
    opt = opt || {};
    var scale = opt.scale || 4, quiet = opt.quiet != null ? opt.quiet : 4;
    var m = qrMatrix(text), size = m.length, dim = (size + quiet * 2) * scale;
    var rects = '';
    for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) if (m[r][c]) {
      rects += '<rect x="' + ((c + quiet) * scale) + '" y="' + ((r + quiet) * scale) + '" width="' + scale + '" height="' + scale + '" fill="#000"/>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim + '" viewBox="0 0 ' + dim + ' ' + dim + '"><rect width="' + dim + '" height="' + dim + '" fill="#fff"/>' + rects + '</svg>';
  }

  var JTBarcode = { svg: barcodeSVG, bars: code128Bars, values: code128Values };
  var JTQR = { svg: qrSVG, matrix: qrMatrix };
  root.JTBarcode = JTBarcode; root.JTQR = JTQR;
  if (typeof module !== 'undefined' && module.exports) module.exports = { JTBarcode: JTBarcode, JTQR: JTQR };
})(typeof window !== 'undefined' ? window : this);
