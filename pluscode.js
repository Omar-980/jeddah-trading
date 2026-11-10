'use strict';
/* Digital addresses — Google Plus Codes (Open Location Code), worked out here with no outside
   service. A customer finds theirs in Google Maps (tap their spot; the code looks like
   "8FQ7+2X Serrekunda", or in full "7CVM8FQ7+2X") and pastes it at checkout. A full code is one
   exact spot anywhere on earth; a short one needs the town after it to say which spot it is.
   Pasted map coordinates ("13.4446, -16.6789") are accepted too and turned into a code. */

const ALPHA = '23456789CFGHJMPQRVWX';
const SEP = '+', SEP_POS = 8;
const clean = s => String(s || '').toUpperCase().replace(/\s+/g, '');

function isValid(code) {
  code = clean(code);
  const sep = code.indexOf(SEP);
  if (sep < 0 || sep !== code.lastIndexOf(SEP) || sep > SEP_POS || sep % 2 === 1 || code.length < 2) return false;
  const pad = code.indexOf('0');
  if (pad >= 0) {
    if (sep < SEP_POS || pad === 0 || pad % 2 === 1) return false;
    const runs = code.match(/0+/g);
    if (runs.length > 1 || runs[0].length % 2 === 1 || code[code.length - 1] !== SEP) return false;
  }
  if (code.length - sep - 1 === 1) return false;
  for (const ch of code.replace(SEP, '').replace(/0+/, '')) if (!ALPHA.includes(ch)) return false;
  return true;
}
function isFull(code) {
  code = clean(code);
  if (!isValid(code) || code.indexOf(SEP) !== SEP_POS) return false;
  return ALPHA.indexOf(code[0]) * 20 < 180 && ALPHA.indexOf(code[1]) * 20 < 360;
}
const isShort = code => isValid(code) && clean(code).indexOf(SEP) < SEP_POS;

/** Centre of the area a full code names → { lat, lng } */
function decode(code) {
  if (!isFull(code)) return null;
  const c = clean(code).replace(SEP, '').replace(/0+$/, '').slice(0, 15);
  let lat = -90, lng = -180, res = 20, latRes = 20, lngRes = 20;
  for (let i = 0; i < Math.min(c.length, 10); i += 2) {
    lat += ALPHA.indexOf(c[i]) * res; lng += ALPHA.indexOf(c[i + 1]) * res;
    latRes = lngRes = res; res /= 20;
  }
  for (let i = 10; i < c.length; i++) {          // the finer grid after the first ten digits
    latRes /= 5; lngRes /= 4;
    const d = ALPHA.indexOf(c[i]);
    lat += Math.floor(d / 4) * latRes; lng += (d % 4) * lngRes;
  }
  return { lat: lat + latRes / 2, lng: lng + lngRes / 2 };
}
/** A point as a code, `pairs` pairs long (5 pairs = the usual 10-digit code, about 14 m). */
function encode(lat, lng, pairs = 5) {
  let la = Math.min(89.9999999, Math.max(-90, lat)) + 90, lo = ((lng + 180) % 360 + 360) % 360;
  let out = '', res = 20;
  for (let i = 0; i < pairs; i++) {
    const a = Math.min(19, Math.floor(la / res + 1e-9)), b = Math.min(19, Math.floor(lo / res + 1e-9));
    out += ALPHA[a] + ALPHA[b]; la -= a * res; lo -= b * res; res /= 20;
  }
  return out.length > SEP_POS ? out.slice(0, SEP_POS) + SEP + out.slice(SEP_POS) : out.padEnd(SEP_POS, '0') + SEP;
}
/** A short code made whole again, using a point near it (the town written after it). */
function recoverNearest(short, refLat, refLng) {
  short = clean(short);
  const padLen = SEP_POS - short.indexOf(SEP);
  const resolution = Math.pow(20, 2 - padLen / 2), half = resolution / 2;
  const prefix = encode(refLat, refLng, 4).replace(SEP, '').slice(0, padLen);
  const p = decode(prefix + short);
  if (!p) return null;
  let { lat, lng } = p;
  if (refLat + half < lat && lat - resolution >= -90) lat -= resolution;
  else if (refLat - half > lat && lat + resolution <= 90) lat += resolution;
  if (refLng + half < lng) lng -= resolution;
  else if (refLng - half > lng) lng += resolution;
  // the corrected prefix is exact: re-derive it from the moved centre
  return encode(lat, lng, 4).replace(SEP, '').slice(0, padLen) + short;
}

// Towns far from Greater Banjul, so a short code from upcountry is read in the right place.
const TOWNS = {
  banjul: [13.4531, -16.5779], serrekunda: [13.438, -16.678], brikama: [13.2717, -16.6481], bakau: [13.478, -16.68],
  farafenni: [13.567, -15.6], soma: [13.433, -15.533], basse: [13.31, -14.22], 'basse santa su': [13.31, -14.22],
  janjanbureh: [13.535, -14.766], georgetown: [13.535, -14.766], kerewan: [13.49, -16.09], mansakonko: [13.45, -15.55],
  essau: [13.48, -16.53], barra: [13.48, -16.545], kuntaur: [13.67, -14.89], bwiam: [13.25, -15.98], gunjur: [13.18, -16.75],
  sanyang: [13.26, -16.78], kartong: [13.09, -16.76], lamin: [13.36, -16.64], yundum: [13.34, -16.68], sukuta: [13.41, -16.71],
};
const DEFAULT_REF = TOWNS.serrekunda;
// at least two characters after the "+", as Google Maps always shows — so a half-typed code isn't read early
const CODE_RE = /(^|[^0-9A-Z])([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,7})(?![0-9A-Z])/i;
const COORD_RE = /(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})/;

/**
 * Reads a digital address out of whatever the customer typed or pasted (a code, a code and its
 * town, a plus.codes link, or map coordinates). `placeOf(name)` may give a town's point.
 * → { code (full), lat, lng, typed, town } or null
 */
function parse(text, placeOf) {
  const s = String(text || '').slice(0, 200);
  const m = s.toUpperCase().match(CODE_RE);
  if (m) {
    const typed = m[2].toUpperCase();
    if (!isValid(typed)) return null;
    let full = typed;
    const town = s.slice(m.index + m[0].length).replace(/\b(the\s+)?gambia\b/ig, '').replace(/^[\s,]+|[\s,.]+$/g, '').split(',')[0].trim();
    if (isShort(typed)) {
      const t = town.toLowerCase();
      const ref = (t && typeof placeOf === 'function' && placeOf(town)) || (t && TOWNS[t] && { lat: TOWNS[t][0], lng: TOWNS[t][1] })
        || { lat: DEFAULT_REF[0], lng: DEFAULT_REF[1] };
      full = recoverNearest(typed, ref.lat, ref.lng);
    } else if (!isFull(typed)) return null;
    const p = decode(full);
    if (!p) return null;
    return { code: full, typed, town, lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
  }
  const c = s.match(COORD_RE);
  if (c) {
    const lat = Number(c[1]), lng = Number(c[2]);
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return null;
    return { code: encode(lat, lng, 5), typed: `${lat}, ${lng}`, town: '', lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, coords: true };
  }
  return null;
}
/** A full code from the browser, checked and decoded here — never taken on trust. */
function fromOrder(code) {
  const c = clean(code).slice(0, 20);
  if (!isFull(c)) return null;
  const p = decode(c);
  return p ? { code: c, lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 } : null;
}

module.exports = { isValid, isFull, isShort, decode, encode, recoverNearest, parse, fromOrder };
