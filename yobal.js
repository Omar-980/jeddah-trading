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
    const pt = validPoint(setting('yobal_pickup_lat'), setting('yobal_pickup_lng'));
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
  const wirePlace = p => ({ lat: p.lat, lng: p.lng, approximate: !!p.approximate, area: p.area, landmark: p.landmark,
    details: p.details || undefined, contactName: p.contactName, contactPhone: p.contactPhone });

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

  return { enabled, mode, validPoint, pickupPlace, e164, quote, book, cancel, verifySignature, hasSecret: () => !!hookSecret(), YobalError };
};
