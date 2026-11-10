/* Box certificate parser.
 * Turns raw OCR text from a corrugated box stamp into structured fields.
 * Works in the browser (window.BoxParser) and in Node (module.exports) so it can be tested. */
(function (root) {
  'use strict';

  // OCR confuses letters/digits constantly; fix digits inside numeric contexts only.
  function digits(s) {
    return String(s).replace(/[OoQD]/g, '0').replace(/[IlL|!]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8');
  }

  function norm(text) {
    return String(text || '')
      .toUpperCase()
      .replace(/[‘’`]/g, "'")
      .replace(/[–—]/g, '-')
      .replace(/[ \t]+/g, ' ');
  }

  // Edit-distance fuzzy contains: does `hay` contain something within `max` edits of `needle`?
  function fuzzyHas(hay, needle, max) {
    var n = needle.length;
    for (var i = 0; i + n - max <= hay.length; i++) {
      for (var len = n - max; len <= n + max; len++) {
        if (i + len > hay.length) break;
        if (lev(hay.substr(i, len), needle) <= max) return true;
      }
    }
    return false;
  }
  function lev(a, b) {
    var m = a.length, n = b.length, prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  function parseDimensions(t) {
    // 12 x 9 x 9   (OCR may give X, x, ×, *, K, % for the separator; allow halves like 12 1/2)
    var num = '(\\d{1,3}(?:\\.5|\\s?1/2)?)';
    var sep = '\\s*[X×*K%]\\s*';
    var m = new RegExp('(?:^|[^\\d])' + num + sep + num + sep + num + '(?!\\d)').exec(t);
    if (!m) return null;
    var d = [m[1], m[2], m[3]].map(function (v) {
      return parseFloat(String(v).replace(/\s?1\/2/, '.5'));
    });
    if (d.some(function (v) { return !(v > 0 && v <= 120); })) return null;
    return { l: d[0], w: d[1], h: d[2] };
  }

  function parseModel(t) {
    // Uline style: S-19852  (S = stock number). OCR may drop the hyphen or read 5/8 for S.
    var m = /(?:^|[^A-Z0-9])S\s*[-.]?\s*(\d{3,6})(?!\d)/.exec(t);
    if (m) return 'S-' + m[1];
    // spaced digits: "S- 1 9852"
    m = /(?:^|[^A-Z0-9])[S5$]\s*-\s*(\d(?:\s?\d){3,5})(?!\d)/.exec(t);
    if (m) return 'S-' + m[1].replace(/\s/g, '');
    m = /(?:^|[^A-Z0-9])[S5$]\s*-\s*([0-9OIl]{4,6})(?!\d)/.exec(t);
    if (m) return 'S-' + digits(m[1]);
    return null;
  }

  function parseWall(t) {
    var flat = t.replace(/[^A-Z]/g, '');
    if (/TRIPLE\s?WALL/.test(t) || fuzzyHas(flat, 'TRIPLEWALL', 1)) return 'triple';
    // check double first: "DOUBLEWALL" is not a fuzzy match for SINGLEWALL, but be explicit.
    var dbl = /D[O0]UBLE\s?WALL/.test(t) || fuzzyHas(flat, 'DOUBLEWALL', 2) || /DOUBL/.test(flat);
    var sgl = /S[I1]NGLE\s?WALL/.test(t) || fuzzyHas(flat, 'SINGLEWALL', 2) || /SINGL/.test(flat);
    if (dbl && !sgl) return 'double';
    if (sgl && !dbl) return 'single';
    if (dbl && sgl) {
      // Both fuzzy-matched; prefer whichever is the closer match.
      var ds = bestDist(flat, 'DOUBLEWALL'), ss = bestDist(flat, 'SINGLEWALL');
      return ds < ss ? 'double' : 'single';
    }
    return null;
  }
  function bestDist(hay, needle) {
    var best = 99, n = needle.length;
    for (var i = 0; i + n - 2 <= hay.length; i++) {
      for (var len = n - 2; len <= n + 2 && i + len <= hay.length; len++) {
        best = Math.min(best, lev(hay.substr(i, len), needle));
      }
    }
    return best;
  }

  function parseStrength(t) {
    var out = {};
    var m = /(\d{2,3})\s*ECT/.exec(t) || /ECT\s*[:=-]?\s*(\d{2,3})(?!\d)/.exec(t);
    if (m) out.ect = parseInt(m[1], 10);
    // The certificate prints the ECT value before "LBS/IN"
    if (!out.ect) {
      m = /(\d{2,3})\s*\n?\s*LBS?\s*\/\s*IN/.exec(t);
      if (m) out.ect = parseInt(m[1], 10);
    }
    m = /(\d{3})\s*(?:#|LBS?\.?)?\s*(?:BURST|MULLEN)/.exec(t) || /(?:BURST|MULLEN)[^0-9]{0,20}(\d{3})/.exec(t);
    if (m) out.burst = parseInt(m[1], 10);
    m = /SIZE\s*LIMIT[^0-9]{0,12}(\d{2,3})/.exec(t);
    if (m) out.sizeLimit = parseInt(m[1], 10);
    m = /GROSS[^0-9]{0,18}(\d{2,3})\s*LBS?/.exec(t) || /GROSS\s*W[TL]?\.?\s*L[TI]?[^0-9]{0,8}(\d{2,3})/.exec(t);
    if (m) out.grossLimit = parseInt(m[1], 10);
    return out;
  }

  function parse(raw) {
    var t = norm(raw);
    var s = parseStrength(t);
    return {
      size: parseDimensions(t),
      model: parseModel(t),
      wall: parseWall(t),
      ect: s.ect || null,
      burst: s.burst || null,
      sizeLimit: s.sizeLimit || null,
      grossLimit: s.grossLimit || null,
      maker: /U[L1I|]{1,2}[NH]E/.test(t) ? 'Uline' : null
    };
  }

  // Hint used only when the stamp doesn't spell out the wall type.
  // Single-wall boxes are typically 32-44 ECT; double-wall start around 48 ECT.
  function wallHint(ect, burst) {
    if (ect) return ect >= 48 ? 'double' : 'single';
    if (burst) return burst >= 275 ? 'double' : 'single';
    return null;
  }

  var api = { parse: parse, parseDimensions: parseDimensions, parseModel: parseModel, parseWall: parseWall, wallHint: wallHint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxParser = api;
})(typeof window !== 'undefined' ? window : this);
