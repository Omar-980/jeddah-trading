'use strict';
/* ---------- Yobal Express ----------
   Yobal Express carries the shop's home deliveries. The shop is a "business sender" on Yobal:
   it asks for a price (quote), books a courier when an order is confirmed, and Yobal reports
   each step back by signed webhook. This is the same business API OneSac uses.

   Two modes, chosen in Settings:
     test — a practice Yobal inside the shop. It prices like Yobal's starting fares and lets
            staff press "courier assigned / picked up / delivered" in the admin to see the whole
            flow. Nothing leaves the shop and no courier is sent.
     live — Yobal's real business API (API address + API key + webhook secret from Yobal).

   Money crosses this file in dalasi; Yobal counts in bututs (D1 = 100 bututs). */
const crypto = require('node:crypto');

module.exports = function createYobal({ getSetting }) {
  const setting = (k, d = '') => String(getSetting(k, d) ?? d).trim();
  const apiKey = () => process.env.YOBAL_API_KEY || setting('yobal_api_key');
  const hookSecret = () => process.env.YOBAL_WEBHOOK_SECRET || setting('yobal_webhook_secret');
  const apiUrl = () => (process.env.YOBAL_API_URL || setting('yobal_api_url')).replace(/\/+$/, '');
  const mode = () => (setting('yobal_mode', 'test') === 'live' ? 'live' : 'test');

  /** Yobal carries home deliveries only when switched on, and in live mode only once keys exist. */
  function enabled() {
    if (setting('delivery_provider', 'own') !== 'yobal') return false;
    return mode() === 'test' || !!(apiUrl() && apiKey());
  }

  const num = v => { const n = Number(v); return Number.isFinite(n) && v !== '' && v !== null ? n : null; };
  /** A point on the map that could be in The Gambia (rough box, generous at the edges). */
  function validPoint(lat, lng) {
    lat = num(lat); lng = num(lng);
    if (lat === null || lng === null) return null;
    if (lat < 12.9 || lat > 13.95 || lng < -17.1 || lng > -13.7) return null;
    return { lat, lng };
  }
  /** The shop, as Yobal's courier will find it. */
  function pickupPlace() {
    // the exact spot if it was set; otherwise the centre of the shop's area (Bundung)
    const pt = validPoint(setting('yobal_pickup_lat'), setting('yobal_pickup_lng')) || listedPoint(setting('yobal_pickup_area') || 'Bundung');
    if (!pt) return null;
    return { ...pt, area: setting('yobal_pickup_area') || 'Bundung',
      landmark: setting('yobal_pickup_landmark') || setting('store_name') || 'Jeddah Trading',
      contactName: setting('store_name') || 'Jeddah Trading',
      contactPhone: e164(setting('yobal_pickup_phone') || setting('whatsapp_number')) };
  }
  /** Gambian numbers as Yobal wants them: +220 and seven digits. */
  function e164(p) {
    const d = String(p || '').replace(/[^0-9]/g, '');
    if (!d) return '';
    if (d.length === 7) return '+220' + d;
    return '+' + d;
  }

  // Straight-line distance, km — the test fare and nothing else uses it.
  function km(a, b) {
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  /** Yobal's starting fares (D25 + D12/km, at least D50, rounded up to D5) — the practice price. */
  function testFare(k) { return Math.ceil(Math.max(50, 25 + k * 12) / 5) * 5; }

  /* ---------- Where each delivery area is ----------
     Staff never type map positions. An area's point comes from this list of area centres — the
     same one OneSac prices Yobal deliveries with — and an area not on it is looked up once on
     OpenStreetMap, the map Yobal's own app searches, inside Yobal's service area. Approximate on
     purpose: a customer who shares their location is always priced from where they really are. */
  const AREA_CENTRES = {
    banjul: [13.4549, -16.579], bakau: [13.478, -16.682], fajara: [13.47, -16.692], kotu: [13.457, -16.704],
    kololi: [13.447, -16.717], senegambia: [13.44, -16.722], bijilo: [13.425, -16.725], brusubi: [13.409, -16.733],
    brufut: [13.388, -16.746], sukuta: [13.411, -16.709], farato: [13.36, -16.69], serrekunda: [13.438, -16.678],
    kanifing: [13.447, -16.675], latrikunda: [13.438, -16.665], tallinding: [13.42, -16.66], bundung: [13.418, -16.672],
    pipeline: [13.455, -16.69], westfield: [13.442, -16.68], 'kerr serign': [13.433, -16.72], abuko: [13.405, -16.656],
    lamin: [13.38, -16.65], yundum: [13.35, -16.65], busumbala: [13.34, -16.66], brikama: [13.271, -16.648],
    tanji: [13.353, -16.795], sanyang: [13.27, -16.79], gunjur: [13.2, -16.76], 'cape point': [13.486, -16.664],
    'kairaba avenue': [13.456, -16.69], 'old jeshwang': [13.444, -16.643], 'new jeshwang': [13.439, -16.655],
    dippakunda: [13.435, -16.668], ebo: [13.432, -16.688], eboe: [13.432, -16.688], manjai: [13.446, -16.7],
    'bundung kakunda': [13.418, -16.672], bakoteh: [13.418, -16.697], wellingara: [13.389, -16.688],
  };
  // Yobal's Greater Banjul service area (west, north, east, south) — nothing outside it is looked up.
  const SERVICE_BOX = { w: -16.86, n: 13.52, e: -16.50, s: 13.20 };
  const inBox = p => p && p.lng >= SERVICE_BOX.w && p.lng <= SERVICE_BOX.e && p.lat >= SERVICE_BOX.s && p.lat <= SERVICE_BOX.n;
  // "Bakau / Fajara" → ['bakau', 'fajara']; "Other (Greater Banjul)" → ['other', 'greater banjul']
  const nameParts = name => String(name || '').toLowerCase().split(/[\/,&()+]|\band\b/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  /** An area's centre from the built-in list — the midpoint when the name covers several places. */
  function listedPoint(name) {
    const hits = nameParts(name).map(p => AREA_CENTRES[p]).filter(Boolean);
    if (!hits.length) return null;
    const lat = hits.reduce((s, h) => s + h[0], 0) / hits.length, lng = hits.reduce((s, h) => s + h[1], 0) / hits.length;
    return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
  }
  /** Not on the list: ask OpenStreetMap once, only inside Yobal's area. Anything vague stays unplaced. */
  async function mapPoint(name) {
    if (process.env.YOBAL_MAP_LOOKUP === 'off') return null;
    const parts = nameParts(name).filter(p => !/^(other|others|upcountry|other regions|greater banjul|rest of .*)$/.test(p));
    const found = [];
    for (const part of parts.slice(0, 3)) {
      try {
        const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gm&bounded=1'
          + `&viewbox=${SERVICE_BOX.w},${SERVICE_BOX.n},${SERVICE_BOX.e},${SERVICE_BOX.s}&q=` + encodeURIComponent(part);
        const r = await fetch(u, { headers: { 'User-Agent': 'JeddahTrading/1.0 (shopjeddahtrading.com)', 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(8000) });
        const rows = await r.json();
        const p = rows && rows[0] ? { lat: Number(rows[0].lat), lng: Number(rows[0].lon) } : null;
        if (inBox(p)) found.push(p);
      } catch { /* the map is unreachable — the area simply stays unplaced for now */ }
      await new Promise(res => setTimeout(res, 1100));   // OpenStreetMap asks for at most one search a second
    }
    if (!found.length) return null;
    return { lat: Math.round(found.reduce((s, p) => s + p.lat, 0) / found.length * 1e5) / 1e5,
             lng: Math.round(found.reduce((s, p) => s + p.lng, 0) / found.length * 1e5) / 1e5 };
  }

  /* ---------- Place search for checkout ----------
     Like Yobal Express's own app: the customer types a few letters and picks the place from a
     list — Yobal's well-known landmarks, the area centres above, and OpenStreetMap results
     (preferring Greater Banjul, but anywhere in The Gambia). Answers are kept for a day, and the
     map is asked at most once a second, as OpenStreetMap requires. */
  const LANDMARKS = [
    ['Banjul International Airport', 'Yundum', 13.338, -16.6522], ['Westfield Junction', 'Serrekunda', 13.4446, -16.6789],
    ['Serrekunda Market', 'Serrekunda', 13.438, -16.6781], ['Senegambia Strip', 'Kololi', 13.441, -16.733],
    ['Kairaba Avenue', 'Pipeline', 13.456, -16.69], ['Arch 22', 'Banjul', 13.4531, -16.5779],
    ['Banjul Ferry Terminal', 'Banjul', 13.4466, -16.5752], ['Bakau Fish Market', 'Bakau', 13.48, -16.683],
    ['Brusubi Turntable', 'Brusubi', 13.412, -16.746], ['Brikama Market', 'Brikama', 13.2717, -16.6481],
    ['Sukuta Traffic Lights', 'Sukuta', 13.4105, -16.7085], ['Tipper Garage', 'Bakoteh', 13.4245, -16.6935],
    ['Old Jeshwang', 'Kanifing', 13.444, -16.643], ['Coastal Road', 'Brufut / Sanyang', 13.37, -16.77],
  ];
  const title = s => s.replace(/\b\w/g, c => c.toUpperCase());
  const PLACE_CACHE = new Map();   // query → { t, rows }
  let lastMapCall = 0;
  async function mapSearch(q) {
    if (process.env.YOBAL_MAP_LOOKUP === 'off') return [];
    const wait = lastMapCall + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastMapCall = Date.now();
    try {
      const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=gm&addressdetails=0'
        + `&viewbox=${SERVICE_BOX.w},${SERVICE_BOX.n},${SERVICE_BOX.e},${SERVICE_BOX.s}&q=` + encodeURIComponent(q);
      const r = await fetch(u, { headers: { 'User-Agent': 'JeddahTrading/1.0 (shopjeddahtrading.com)', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(8000) });
      const rows = await r.json();
      return (Array.isArray(rows) ? rows : []).map(x => {
        const [name, ...rest] = String(x.display_name || '').split(', ');
        return { name, detail: rest.filter(p => p !== 'The Gambia' && p !== 'Gambia').slice(0, 2).join(', '), lat: Number(x.lat), lng: Number(x.lon) };
      }).filter(p => p.name && validPoint(p.lat, p.lng));
    } catch { return []; }
  }
  async function searchPlaces(query) {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (q.length < 2) return [];
    const key = q.toLowerCase();
    const hit = PLACE_CACHE.get(key);
    if (hit && Date.now() - hit.t < 86400000) return hit.rows;
    const local = [
      ...LANDMARKS.filter(l => (l[0] + ' ' + l[1]).toLowerCase().includes(key)).map(l => ({ name: l[0], detail: l[1], lat: l[2], lng: l[3] })),
      ...Object.entries(AREA_CENTRES).filter(([n]) => n.includes(key)).map(([n, p]) => ({ name: title(n), detail: 'Area', lat: p[0], lng: p[1] })),
    ];
    const remote = q.length >= 3 ? await mapSearch(q) : [];
    // one entry per place: drop map results sitting on top of a landmark of the same name
    const rows = [];
    for (const p of [...local, ...remote]) {
      if (rows.some(r => r.name.toLowerCase() === p.name.toLowerCase() && Math.abs(r.lat - p.lat) < 0.01 && Math.abs(r.lng - p.lng) < 0.01)) continue;
      rows.push({ name: p.name.slice(0, 80), detail: String(p.detail || '').slice(0, 80), lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5 });
      if (rows.length >= 10) break;
    }
    PLACE_CACHE.set(key, { t: Date.now(), rows });
    if (PLACE_CACHE.size > 2000) PLACE_CACHE.delete(PLACE_CACHE.keys().next().value);
    return rows;
  }
  /** Straight-line km between two points (exported for "which area is this in"). */
  function distanceKm(a, b) { return km(a, b); }

  class YobalError extends Error { constructor(msg, code) { super(msg); this.code = code || ''; } }

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(apiUrl() + path, {
        method,
        headers: { Authorization: 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { throw new YobalError('Yobal Express could not be reached', 'unreachable'); }
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) {
      const code = typeof data.error === 'string' ? data.error : String(res.status);
      const msg = (Array.isArray(data.message) ? data.message.join('; ') : data.message) || data.error || ('Yobal Express error ' + res.status);
      throw new YobalError(String(msg), code);
    }
    return data;
  }
  // Within Yobal's limits (area 80, landmark 160, details 200, name 80), so a long address is never refused.
  const cut = (v, n) => String(v || '').trim().slice(0, n);
  const wirePlace = p => ({ lat: p.lat, lng: p.lng, approximate: !!p.approximate, area: cut(p.area, 80), landmark: cut(p.landmark, 160),
    details: cut(p.details, 200) || undefined, contactName: cut(p.contactName, 80) || 'Customer', contactPhone: cut(p.contactPhone, 20) });

  /** Price for one parcel from the shop to `dropoff`. → { quoteId, fare (D), etaMinutes, distanceKm } */
  async function quote(dropoff) {
    const pickup = pickupPlace();
    if (!pickup) throw new YobalError("The shop's map position is not set in Settings → Delivery", 'no_pickup');
    if (mode() === 'test') {
      const k = Math.round(km(pickup, dropoff) * 10) / 10;
      return { quoteId: 'tq_' + crypto.randomBytes(6).toString('hex'), fare: testFare(k), etaMinutes: 15 + Math.round(k * 3), distanceKm: k };
    }
    const q = await call('POST', '/quotes', { pickup: wirePlace(pickup), dropoff: wirePlace(dropoff), parcelSize: 'small' });
    return { quoteId: String(q.quoteId), fare: Math.round(Number(q.fareButut)) / 100, etaMinutes: Number(q.etaMinutes) || 0, distanceKm: Number(q.distanceKm) || 0 };
  }

  /** Books the courier. Booking the same order number twice returns the same delivery. */
  async function book(b) {
    const pickup = pickupPlace();
    if (!pickup) throw new YobalError("The shop's map position is not set in Settings → Delivery", 'no_pickup');
    if (mode() === 'test') {
      const id = 'test_' + crypto.randomBytes(8).toString('hex');
      return { deliveryId: id, status: 'searching', deliveryCode: String(crypto.randomInt(1000, 10000)), trackingUrl: '', fare: b.fare };
    }
    const d = await call('POST', '/deliveries', {
      externalRef: b.externalRef,
      quoteId: b.quoteId || undefined,
      fareButut: Math.round(b.fare * 100),
      pickup: wirePlace(pickup),
      dropoff: wirePlace(b.dropoff),
      readyAt: b.readyAt.toISOString(),
      parcelDescription: b.parcelDescription,
      parcelSize: 'small',
      payer: 'business',
      codButut: Math.round(b.cod * 100),
    });
    return { deliveryId: String(d.deliveryId), status: String(d.status || 'searching'), deliveryCode: String(d.deliveryCode || ''),
      trackingUrl: String(d.trackingUrl || ''), fare: Math.round(Number(d.fareButut)) / 100 };
  }

  async function cancel(deliveryId, reason) {
    if (mode() === 'test' || String(deliveryId).startsWith('test_')) return;
    await call('POST', '/deliveries/' + encodeURIComponent(deliveryId) + '/cancel', { reason });
  }

  /** `Yobal-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, at most 5 minutes old. */
  function verifySignature(raw, header, now = Date.now()) {
    const secret = hookSecret();
    if (!secret || !header) return false;
    const parts = {};
    for (const kv of String(header).split(',')) { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
    const t = Number(parts.t);
    if (!parts.v1 || !Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
    const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + raw).digest('hex');
    const a = Buffer.from(expected, 'hex'), b = Buffer.from(parts.v1, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return { enabled, mode, validPoint, pickupPlace, e164, quote, book, cancel, verifySignature, hasSecret: () => !!hookSecret(), YobalError,
    listedPoint, mapPoint, searchPlaces, distanceKm };
};
