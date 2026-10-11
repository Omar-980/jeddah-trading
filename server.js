'use strict';
/* =========================================================
   Jeddah Trading — Backend server (ZERO dependencies)
   Run with:  node server.js
   Then open: http://localhost:3000        (storefront)
              http://localhost:3000/admin   (dashboard)
   ========================================================= */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DB_PATH, queries, getSetting, setSetting, hashPassword, verifyPassword, ALL_PERMS, logMove, nextPoNumber, logAct, newReferralCode, recordInvestorSalesForOrder, reverseInvestorSalesForOrder, variantById, variantByCode, r2 } = require('./db');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // bind all interfaces so cloud hosts can route to it
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');
// Uploaded images live with the database (under DATA_DIR) so one persistent volume keeps everything.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = process.env.DATA_DIR ? path.join(DATA_DIR, 'uploads') : path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
  '.webp':'image/webp', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  // the installable-app files: a browser ignores a manifest served as anything else
  '.webmanifest':'application/manifest+json', '.txt':'text/plain; charset=utf-8' };

// Guard so two clicks (or two owners) can never build two database snapshots at once and
// double the temporary disk usage on a small persistent volume.
let BACKUP_RUNNING = false;

/* ---------- helpers ---------- */
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', c => { size += c.length; if (size > 12 * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function publicSettings() {
  return {
    whatsapp_number: getSetting('whatsapp_number'),
    store_name: getSetting('store_name'),
    free_delivery_over: Number(getSetting('free_delivery_over')),
    delivery_fee: Number(getSetting('delivery_fee')),
    announce_en: getSetting('announce_en'),
    announce_ar: getSetting('announce_ar'),
    contact_address_en: getSetting('contact_address_en'),
    contact_address_ar: getSetting('contact_address_ar'),
    contact_hours_en: getSetting('contact_hours_en'),
    contact_hours_ar: getSetting('contact_hours_ar'),
    // Phase 3 — payment account details for checkout
    pay_account_name: getSetting('pay_account_name'),
    pay_wave_number: getSetting('pay_wave_number'),
    pay_afri_number: getSetting('pay_afri_number'),
    pay_qmoney_number: getSetting('pay_qmoney_number'),
    pay_bank_name: getSetting('pay_bank_name'),
    pay_bank_account: getSetting('pay_bank_account'),
    pay_note_en: getSetting('pay_note_en'),
    pay_note_ar: getSetting('pay_note_ar'),
    est_delivery_en: getSetting('est_delivery_en'),
    est_delivery_ar: getSetting('est_delivery_ar'),
    // Advert measurement. Blank means no tracking code is loaded for the shopper at all.
    meta_pixel_id: String(getSetting('meta_pixel_id', '') || '').replace(/[^0-9]/g, '').slice(0, 20),
    catalog_currency: feedCurrency(),
    // The UK side. Everything here is shown to a UK shopper, so it holds nothing private.
    uk_enabled: getSetting('uk_enabled') === '1' ? 1 : 0,
    uk_delivery_fee: Number(getSetting('uk_delivery_fee')) || 0,
    uk_free_over: Number(getSetting('uk_free_over')) || 0,
    uk_business_name: getSetting('uk_business_name'),
    uk_business_address: getSetting('uk_business_address'),
    uk_returns_address: getSetting('uk_returns_address'),
    uk_vat_number: getSetting('uk_vat_number'),
    uk_bank_account_name: getSetting('uk_bank_account_name'),
    uk_bank_name: getSetting('uk_bank_name'),
    uk_sort_code: getSetting('uk_sort_code'),
    uk_account_number: getSetting('uk_account_number'),
    uk_paypal_link: getSetting('uk_paypal_link'),
    uk_dispatch_note: getSetting('uk_dispatch_note'),
    uk_returns_policy: getSetting('uk_returns_policy'),
  };
}

/* ---------- auth (user-based with permissions) ---------- */
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function currentUser(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const s = db.prepare('SELECT user_id FROM sessions WHERE token=?').get(token);
  if (!s) return null;
  const u = db.prepare('SELECT id,username,name,role,permissions,is_active FROM users WHERE id=?').get(s.user_id);
  if (!u || !u.is_active) return null;
  let perms = []; try { perms = JSON.parse(u.permissions || '[]'); } catch {}
  if (u.role === 'owner') perms = ALL_PERMS;     // owner always has every permission
  LAST_STAFF_SEEN = Date.now();                  // presence for the chat "online" indicator
  return { id: u.id, username: u.username, name: u.name, role: u.role, perms };
}
function requireAuth(req, res) {
  const u = currentUser(req);
  if (!u) { send(res, 401, { error: 'unauthorized' }); return null; }
  return u;
}
function hasPerm(u, perm) { return u && (u.role === 'owner' || u.perms.includes(perm)); }
function requirePerm(req, res, perm) {
  const u = requireAuth(req, res); if (!u) return null;
  if (!hasPerm(u, perm)) { send(res, 403, { error: 'You do not have permission for this action' }); return null; }
  return u;
}

/* ---------- image upload (base64 data URL → file) ---------- */
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new Error('Image too large (max 4MB)');
  const name = `p_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}
// Save a gallery: each entry is either an existing "/uploads/..." path (kept) or a new base64 data URL (saved).
function saveImages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, 8)) {
    if (typeof item !== 'string' || !item) continue;
    if (item.startsWith('/uploads/')) { out.push(item); continue; }
    if (item.startsWith('data:image/')) { const u = saveImage(item); if (u) out.push(u); }
  }
  return out;
}

const LOGIN_ATTEMPTS = new Map();   // in-memory login rate limiter (staff + customers)

/* ---------- built-in live chat: SSE bus, presence, typing, rate limits ---------- */
const CHAT_STREAMS = new Map();     // conversationId -> Set<res>  (customer widgets)
const ADMIN_STREAMS = new Set();    // res (staff inboxes — receive events for all conversations)
const CHAT_TYPING = new Map();      // conversationId -> { cust: ts, staff: ts }
const CHAT_RL = new Map();          // key -> { count, t }  (spam / rate limiting)
let LAST_STAFF_SEEN = 0;            // any authenticated staff activity

function chatRateLimited(key, max, windowMs) {
  const now = Date.now();
  const cur = CHAT_RL.get(key) || { count: 0, t: now };
  if (now - cur.t > windowMs) { cur.count = 0; cur.t = now; }
  cur.count++;
  CHAT_RL.set(key, cur);
  if (CHAT_RL.size > 5000) CHAT_RL.clear();          // bounded memory
  return cur.count > max;
}
function chatOnline() {
  const mode = getSetting('chat_online') || 'auto';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return Date.now() - LAST_STAFF_SEEN < 3 * 60 * 1000;   // auto: staff active in the last 3 min
}
function sseInit(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(':ok\n\n');
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch {} }, 25000);
  req.on('close', () => clearInterval(hb));
}
function sseSend(res, event) { try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch {} }
function chatBroadcast(convId, event, { toCustomer = true, toStaff = true } = {}) {
  if (toCustomer) { const set = CHAT_STREAMS.get(convId); if (set) for (const r of set) sseSend(r, event); }
  if (toStaff) for (const r of ADMIN_STREAMS) sseSend(r, { ...event, conversation_id: convId });
}
function convByToken(token) {
  return token ? db.prepare('SELECT * FROM conversations WHERE cust_token=?').get(String(token)) : null;
}
function chatMsgRow(m) {
  return { id: m.id, sender_type: m.sender_type, sender_name: m.sender_name, text: m.message_text,
           attachment_url: m.attachment_url || '', attachment_type: m.attachment_type || '', read_at: m.read_at, created_at: m.created_at };
}
// After a guest's 3rd message, suggest (once) creating an account — with the reasons why.
const NUDGE = {
  create: {
    en: '💚 Tip: create a free Jeddah Trading account and you will keep this conversation on all your devices, earn loyalty points on every order, get a referral code to earn more, and track your orders and wishlist in one place. It takes 30 seconds!',
    ar: '💚 نصيحة: أنشئ حساباً مجانياً في جدة تريدنغ لتحتفظ بهذه المحادثة على جميع أجهزتك، وتكسب نقاط ولاء مع كل طلب، وتحصل على رمز إحالة لكسب المزيد، وتتابع طلباتك ومفضلتك في مكان واحد. لا يستغرق سوى ٣٠ ثانية!'
  },
  signin: {
    en: '💚 Tip: you already have a Jeddah Trading account with this phone — sign in and this conversation, your points, orders and wishlist will follow you on any device.',
    ar: '💚 نصيحة: لديك حساب في جدة تريدنغ بهذا الرقم — سجّل الدخول لتتابعك هذه المحادثة ونقاطك وطلباتك ومفضلتك على أي جهاز.'
  }
};
function maybeAccountNudge(conv, lang) {
  if (conv.customer_id || conv.account_nudge) return;
  const n = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE conversation_id=? AND sender_type='customer'").get(conv.id).c;
  if (n < 3) return;
  const hasAccount = !!queries.customerByPhone(conv.customer_phone);
  const kind = hasAccount ? 'signin' : 'create';
  addChatMessage(conv.id, 'system', null, '', NUDGE[kind][lang === 'ar' ? 'ar' : 'en'], '', 'account_nudge:' + kind);
  db.prepare('UPDATE conversations SET account_nudge=1 WHERE id=?').run(conv.id);
}
function addChatMessage(convId, senderType, senderId, senderName, text, attachUrl, attachType) {
  const info = db.prepare(`INSERT INTO chat_messages(conversation_id,sender_type,sender_id,sender_name,message_text,attachment_url,attachment_type)
    VALUES(?,?,?,?,?,?,?)`).run(convId, senderType, senderId, senderName || '', String(text || '').slice(0, 2000), attachUrl || '', attachType || '');
  const preview = (text || (attachUrl ? '📎 Photo' : '')).slice(0, 120);
  db.prepare("UPDATE conversations SET last_message=?, last_message_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(preview, convId);
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid);
  chatBroadcast(convId, { type: 'message', message: chatMsgRow(m) });
  return m;
}

/* ---------- customer accounts (storefront) ---------- */
function currentCustomer(req) {
  const t = req.headers['x-customer-token'] || '';
  return t ? queries.customerByToken(t) : null;
}
function couponDiscount(coupon, subtotal) {
  if (!coupon || !coupon.is_active) return { ok: false, err: 'Invalid coupon code' };
  if (coupon.expires && coupon.expires < new Date().toISOString().slice(0, 10)) return { ok: false, err: 'This coupon has expired' };
  if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) return { ok: false, err: 'This coupon has been fully used' };
  if (subtotal < (coupon.min_subtotal || 0)) return { ok: false, err: 'Minimum order for this coupon is D' + coupon.min_subtotal };
  const d = coupon.kind === 'fixed' ? Math.min(coupon.value, subtotal) : Math.round(subtotal * coupon.value / 100);
  return { ok: true, discount: Math.max(0, d) };
}
function customerPublic(c) {
  return { id: c.id, name: c.name, phone: c.phone, email: c.email || '', address: c.address || '',
           zone_id: c.zone_id || null, points: c.points || 0, referral_code: c.referral_code,
           point_value: Number(getSetting('loyalty_point_value')) || 1,
           max_redeem_pct: Number(getSetting('loyalty_max_redeem_pct')) || 30 };
}
const money0 = n => 'D' + Number(n || 0).toLocaleString('en-US');

/* ---------- sale lines: one pricing path for the website and the shop counter ----------
   Whatever the browser sends is treated as a hint. Every price, cost and size label below is
   read back out of the database, so a tampered request cannot change what is charged. */
/* `market` is 'gm' (the shop in The Gambia, in dalasi) or 'uk' (the partner's stock in Britain,
   in pounds). A UK line is priced from the product's own UK price, never from a conversion, and
   a product that has not been switched on for the UK is dropped entirely — so nothing that
   cannot lawfully be sent there can be bought by accident. */
function resolveSaleItems(raw, market) {
  const uk = market === 'uk';
  let subtotal = 0; const items = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    const p = queries.productById(Number(it.id));
    if (!p) continue;
    if (uk && !p.ukActive) continue;
    const qty = Math.max(1, Math.trunc(Number(it.qty) || 1));
    const vid = Number(it.variant_id || it.variantId) || 0;
    let unit, cost, variantId = null, label = '', labelAr = '';
    if (vid) {
      const v = variantById(vid);
      // A size must belong to this product and still be switched on, or the line is dropped.
      if (!v || v.productId !== p.id || !v.active) continue;
      if (uk) {
        if (!(v.ukPrice > 0)) continue;          // this size has no UK price yet
        unit = v.ukSale || v.ukPrice;
      } else unit = v.sale || v.price;
      cost = v.cost; variantId = v.id;
      label = v.label_en; labelAr = v.label_ar;
    } else {
      // A product sold by size cannot be bought without choosing one.
      if (p.hasSizes) continue;
      if (uk) {
        if (!(p.ukPrice > 0)) continue;
        unit = p.ukSale || p.ukPrice;
      } else unit = p.sale || p.price;
      cost = p.cost || 0;
    }
    const line = r2(unit * qty);
    subtotal = r2(subtotal + line);
    items.push({ id: p.id, name: p.en.name, name_ar: p.ar.name, variantId,
                 variant_label: label, variant_label_ar: labelAr, price: unit, cost, qty, line });
  }
  return { items, subtotal };
}
// Takes stock from the chosen size when there is one, from the product itself otherwise.
// A UK order moves the UK count — the partner's shelf in Britain — and never the shop's own.
function decrementStockForItems(items, reason, ref, byUser, market) {
  const uk = market === 'uk';
  const decP = db.prepare(uk ? 'UPDATE products SET uk_stock = MAX(0, uk_stock - ?) WHERE id=?'
                             : 'UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?');
  const decV = db.prepare(uk ? 'UPDATE product_variants SET uk_stock = MAX(0, uk_stock - ?) WHERE id=?'
                             : 'UPDATE product_variants SET stock = MAX(0, stock - ?) WHERE id=?');
  for (const it of items) {
    if (it.variantId) decV.run(it.qty, it.variantId); else decP.run(it.qty, it.id);
    logMove(it.id, -it.qty, uk ? (reason + '_uk') : reason, ref, byUser || '', it.variantId || null);
  }
}
/* Final discount at the counter.
   The discount is pushed DOWN into the line prices rather than just subtracted from the total,
   because profit reporting and the investor profit split both read the per-line price. If the
   discount only lived on the total, an investor would be paid a share of money nobody received.
   Lines are apportioned by largest remainder so they add up to the discounted total exactly. */
function applyFinalDiscount(items, subtotal, b, me) {
  const kind = b.discount_kind === 'percent' ? 'percent' : 'amount';
  const raw = Number(b.discount_value) || 0;
  if (raw <= 0 || subtotal <= 0) return { discount: 0 };

  let discount = kind === 'percent' ? r2(subtotal * Math.min(raw, 100) / 100) : r2(raw);
  discount = Math.min(discount, subtotal);

  // The cap is enforced here, on the server. The owner is never capped.
  if (me.role !== 'owner') {
    const maxPct = Number(getSetting('max_staff_discount_pct', '10')) || 0;
    const maxAmount = r2(subtotal * maxPct / 100);
    if (discount > maxAmount) {
      return { error: maxPct <= 0
        ? 'Discounts are switched off for your account — ask the owner'
        : `You can give at most ${maxPct}% (D${maxAmount.toLocaleString('en-US')}) on this sale` };
    }
  }

  const target = r2(subtotal - discount);
  const exact = items.map(it => it.line / subtotal * target);
  const floored = exact.map(v => Math.floor(v * 100) / 100);
  let bututs = Math.round((target - floored.reduce((a, v) => a + v, 0)) * 100);
  const order = exact.map((v, i) => ({ i, frac: v * 100 - Math.floor(v * 100) }))
                     .sort((a, z) => z.frac - a.frac);
  for (let k = 0; k < order.length && bututs > 0; k++, bututs--) floored[order[k].i] = r2(floored[order[k].i] + 0.01);

  items.forEach((it, i) => {
    it.line = floored[i];
    it.price = it.qty ? floored[i] / it.qty : 0;   // left unrounded so price × qty === line exactly
  });
  return { discount: r2(subtotal - floored.reduce((a, v) => r2(a + v), 0)) };
}

/* ---------- order number ---------- */
function nextOrderNumber() {
  const row = db.prepare("SELECT COUNT(*) c FROM orders").get();
  const n = (row.c + 1).toString().padStart(4, '0');
  return `JT-2026-${n}`;
}

/* ---------- API router ---------- */
async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const r = seg.slice(1); // after 'api'
  const method = req.method;

  /* ----- PUBLIC ----- */
  if (r[0] === 'products' && method === 'GET') return send(res, 200, { products: queries.activeProducts() });
  if (r[0] === 'categories' && method === 'GET') return send(res, 200, { categories: queries.activeCategories() });
  if (r[0] === 'settings' && method === 'GET') return send(res, 200, publicSettings());
  /* Is everything the home-screen app needs actually on the server? An upload that misses a
     folder is invisible from the outside — the shop looks fine and the phone just quietly
     never offers to install it. This says which files landed and how big they are. It gives
     away nothing: these are the same public files any visitor can already download. */
  if (r[0] === 'appcheck' && method === 'GET') {
    const want = [
      'manifest.webmanifest', 'manifest-admin.webmanifest', 'manifest-investor.webmanifest',
      'sw.js', 'offline.html',
      'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png',
      'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
      'icons/logo.png',
    ];
    const files = {}; const absent = [];
    for (const f of want) {
      let size = null;
      try { size = fs.statSync(path.join(PUBLIC_DIR, f)).size; } catch {}
      if (size != null) { files[f] = { from: 'uploaded file', bytes: size }; continue; }
      const built = f.startsWith('icons/') ? appIcon(f.slice(6)) : null;
      if (built) { files[f] = { from: 'built into the server', bytes: built.length }; continue; }
      files[f] = { from: 'MISSING', bytes: 0 }; absent.push(f);
    }
    // What a phone actually insists on before it will build a real app rather than a bookmark.
    const needed = ['manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png'];
    const blocking = needed.filter(f => files[f].from === 'MISSING');
    return send(res, 200, {
      installable: blocking.length === 0,
      note: blocking.length === 0
        ? 'Everything a phone needs is here — it should offer to install the app.'
        : 'A phone will not install the app until these are uploaded: ' + blocking.join(', '),
      blocking,
      missing_but_not_blocking: absent.filter(f => !blocking.includes(f)),
      files,
    });
  }
  if (r[0] === 'faqs' && method === 'GET') return send(res, 200, { faqs: queries.activeFaqs() });
  if (r[0] === 'zones' && method === 'GET') return send(res, 200, { zones: queries.activeZones() });
  if (r[0] === 'reviews' && method === 'GET') {
    const pid = url.searchParams.get('product');
    if (pid) return send(res, 200, { reviews: queries.productReviews(Number(pid)) });
    return send(res, 200, { reviews: queries.approvedReviews() });
  }

  // ---- CUSTOMER ACCOUNTS (public storefront) ----
  if (r[0] === 'customer' && r[1] === 'register' && method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '').replace(/[^0-9]/g, '');
    const name = String(b.name || '').trim();
    if (!name || phone.length < 7) return send(res, 400, { error: 'Enter your name and a valid phone number' });
    if (String(b.password || '').length < 4) return send(res, 400, { error: 'Password must be at least 4 characters' });
    if (queries.customerByPhone(phone)) return send(res, 400, { error: 'An account with this phone already exists — sign in instead' });
    let referredBy = null;
    if (b.referral) { const ref = db.prepare('SELECT id FROM customers WHERE upper(referral_code)=upper(?)').get(String(b.referral).trim()); if (ref) referredBy = ref.id; }
    const info = db.prepare('INSERT INTO customers(name,phone,email,pass_hash,referral_code,referred_by) VALUES(?,?,?,?,?,?)')
      .run(name.slice(0, 80), phone, String(b.email || '').trim().slice(0, 120), hashPassword(b.password), newReferralCode(), referredBy);
    const token = newToken();
    db.prepare('INSERT INTO customer_sessions(token,customer_id) VALUES(?,?)').run(token, info.lastInsertRowid);
    // adopt any guest chat threads started with this (now proven) phone number
    db.prepare('UPDATE conversations SET customer_id=? WHERE customer_id IS NULL AND customer_phone=?').run(info.lastInsertRowid, phone);
    return send(res, 201, { ok: true, token, customer: customerPublic(queries.customerById(info.lastInsertRowid)) });
  }
  if (r[0] === 'customer' && r[1] === 'login' && method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '').replace(/[^0-9]/g, '');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const rlKey = 'cust|' + ip + '|' + phone;
    const rl = LOGIN_ATTEMPTS.get(rlKey);
    if (rl && rl.count >= 8 && Date.now() - rl.t < 10 * 60 * 1000)
      return send(res, 429, { error: 'Too many attempts — try again in 10 minutes' });
    const c = queries.customerByPhone(phone);
    if (!c || !c.is_active || !verifyPassword(String(b.password || ''), c.pass_hash)) {
      const cur = LOGIN_ATTEMPTS.get(rlKey) || { count: 0, t: Date.now() };
      if (Date.now() - cur.t > 10 * 60 * 1000) { cur.count = 0; cur.t = Date.now(); }
      cur.count++; if (cur.count === 1) cur.t = Date.now();
      LOGIN_ATTEMPTS.set(rlKey, cur);
      return send(res, 401, { error: 'Wrong phone or password' });
    }
    LOGIN_ATTEMPTS.delete(rlKey);
    const token = newToken();
    db.prepare('INSERT INTO customer_sessions(token,customer_id) VALUES(?,?)').run(token, c.id);
    // adopt any guest chat threads started with this (now proven) phone number
    db.prepare('UPDATE conversations SET customer_id=? WHERE customer_id IS NULL AND customer_phone=?').run(c.id, c.phone);
    return send(res, 200, { ok: true, token, customer: customerPublic(c) });
  }
  if (r[0] === 'customer' && r[1] === 'logout' && method === 'POST') {
    const t = req.headers['x-customer-token'] || '';
    db.prepare('DELETE FROM customer_sessions WHERE token=?').run(t);
    return send(res, 200, { ok: true });
  }
  if (r[0] === 'customer' && r[1] === 'me' && method === 'GET') {
    const c = currentCustomer(req);
    if (!c) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { customer: customerPublic(c) });
  }
  if (r[0] === 'customer' && r[1] === 'me' && method === 'PATCH') {
    const c = currentCustomer(req);
    if (!c) return send(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    if (b.new_password) {
      if (!verifyPassword(String(b.password || ''), c.pass_hash)) return send(res, 400, { error: 'Current password is wrong' });
      if (String(b.new_password).length < 4) return send(res, 400, { error: 'New password must be at least 4 characters' });
      db.prepare('UPDATE customers SET pass_hash=? WHERE id=?').run(hashPassword(b.new_password), c.id);
    }
    db.prepare('UPDATE customers SET name=?, email=?, address=?, zone_id=? WHERE id=?').run(
      b.name != null ? String(b.name).slice(0, 80) : c.name,
      b.email != null ? String(b.email).slice(0, 120) : c.email,
      b.address != null ? String(b.address).slice(0, 240) : c.address,
      b.zone_id !== undefined ? (b.zone_id ? Number(b.zone_id) : null) : c.zone_id, c.id);
    return send(res, 200, { ok: true, customer: customerPublic(queries.customerById(c.id)) });
  }
  if (r[0] === 'customer' && r[1] === 'wishlist' && method === 'GET') {
    const c = currentCustomer(req);
    if (!c) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { ids: db.prepare('SELECT product_id FROM customer_wishlist WHERE customer_id=?').all(c.id).map(x => x.product_id) });
  }
  if (r[0] === 'customer' && r[1] === 'wishlist' && method === 'POST') {
    const c = currentCustomer(req);
    if (!c) return send(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    const clean = a => (Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
    const ins = db.prepare('INSERT INTO customer_wishlist(customer_id,product_id) VALUES(?,?) ON CONFLICT DO NOTHING');
    for (const id of clean(b.add)) { if (queries.productById(id)) ins.run(c.id, id); }
    const del = db.prepare('DELETE FROM customer_wishlist WHERE customer_id=? AND product_id=?');
    for (const id of clean(b.remove)) del.run(c.id, id);
    return send(res, 200, { ids: db.prepare('SELECT product_id FROM customer_wishlist WHERE customer_id=?').all(c.id).map(x => x.product_id) });
  }
  // ---- INVESTOR PORTAL (read-only; investors see ONLY their own data) ----
  if (r[0] === 'investor' && r[1] === 'login' && method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '').replace(/[^0-9]/g, '');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const rlKey = 'inv|' + ip + '|' + phone;
    const rl = LOGIN_ATTEMPTS.get(rlKey);
    if (rl && rl.count >= 8 && Date.now() - rl.t < 10 * 60 * 1000)
      return send(res, 429, { error: 'Too many attempts — try again in 10 minutes' });
    const v = queries.investorByPhone(phone);
    if (!v || v.status !== 'active' || !verifyPassword(String(b.password || ''), v.pass_hash)) {
      const cur = LOGIN_ATTEMPTS.get(rlKey) || { count: 0, t: Date.now() };
      if (Date.now() - cur.t > 10 * 60 * 1000) { cur.count = 0; cur.t = Date.now(); }
      cur.count++; if (cur.count === 1) cur.t = Date.now();
      LOGIN_ATTEMPTS.set(rlKey, cur);
      return send(res, 401, { error: 'Wrong phone or password' });
    }
    LOGIN_ATTEMPTS.delete(rlKey);
    const token = newToken();
    db.prepare('INSERT INTO investor_sessions(token,investor_id) VALUES(?,?)').run(token, v.id);
    logAct('investor:' + v.name, 'investor_login', 'from ' + ip);
    return send(res, 200, { ok: true, token, investor: { name: v.name, phone: v.phone } });
  }
  if (r[0] === 'investor' && r[1] === 'logout' && method === 'POST') {
    db.prepare('DELETE FROM investor_sessions WHERE token=?').run(req.headers['x-investor-token'] || '');
    return send(res, 200, { ok: true });
  }
  if (r[0] === 'investor' && r[1] === 'dashboard' && method === 'GET') {
    const v = queries.investorByToken(req.headers['x-investor-token']);
    if (!v) return send(res, 401, { error: 'unauthorized' });
    const investments = queries.allInvestments().filter(i => i.investor_id === v.id && i.status !== 'cancelled');
    const totalInvested = investments.reduce((s, i) => s + i.amount, 0);
    // Money still sitting in unsold stock — the investor's real current exposure, as opposed to
    // the lifetime total, which counts the same capital again each time it is put back to work.
    const capitalAtWork = investments.reduce((s, i) => s + Math.max(0, i.qty_remaining) * (i.cost_per_unit || 0), 0);
    const revenue = investments.reduce((s, i) => s + i.revenue, 0);
    const profit = investments.reduce((s, i) => s + i.investor_profit, 0);
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM investor_payouts WHERE investor_id=?').get(v.id).a;
    // profit over the last 30 days for the chart
    const series = db.prepare(`SELECT date(created_at) d, COALESCE(SUM(investor_profit),0) p FROM investor_sales
      WHERE investor_id=? AND created_at >= datetime('now','-30 days') GROUP BY date(created_at) ORDER BY d`).all(v.id);
    return send(res, 200, { investor: { name: v.name, phone: v.phone, email: v.email },
      totals: { invested: totalInvested, capital_at_work: Math.round(capitalAtWork * 100) / 100,
                // The capital the investor actually handed over — their starting figure, net of
                // any capital returned. Shown first so there is no doubt what they put in.
                capital_deposited: Math.round(db.prepare('SELECT COALESCE(SUM(amount),0) a FROM investor_deposits WHERE investor_id=?').get(v.id).a * 100) / 100,
                revenue, profit, paid, balance: Math.round((profit - paid) * 100) / 100 },
      investments: investments.map(i => ({ id: i.id, product_name: i.product_name, batch_no: i.batch_no,
        round_no: i.round_no, rounds_total: i.rounds_total,
        qty_funded: i.qty_funded, qty_sold: i.qty_sold, qty_remaining: i.qty_remaining,
        amount: i.amount, cost_per_unit: i.cost_per_unit, investor_pct: i.investor_pct,
        revenue: i.revenue, investor_profit: i.investor_profit, status: i.status, invested_at: i.invested_at })),
      series, ledger: queries.investorLedger(v.id) });
  }

  // Investor enquiries ride the built-in chat system → they appear in the staff Chat inbox.
  if (r[0] === 'investor' && r[1] === 'enquiries' && method === 'GET') {
    const v = queries.investorByToken(req.headers['x-investor-token']);
    if (!v) return send(res, 401, { error: 'unauthorized' });
    const conv = db.prepare('SELECT * FROM conversations WHERE investor_id=? ORDER BY id DESC').get(v.id);
    if (!conv) return send(res, 200, { messages: [] });
    const unread = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE conversation_id=? AND sender_type='staff' AND read_at IS NULL").get(conv.id).c;
    if (unread) {
      db.prepare("UPDATE chat_messages SET read_at=datetime('now') WHERE conversation_id=? AND sender_type='staff' AND read_at IS NULL").run(conv.id);
      chatBroadcast(conv.id, { type: 'read', by: 'customer' }, { toCustomer: false });
    }
    return send(res, 200, { messages: db.prepare('SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY id').all(conv.id).map(chatMsgRow) });
  }
  if (r[0] === 'investor' && r[1] === 'enquiries' && method === 'POST') {
    const v = queries.investorByToken(req.headers['x-investor-token']);
    if (!v) return send(res, 401, { error: 'unauthorized' });
    if (chatRateLimited('invmsg|' + v.id, 10, 60 * 1000)) return send(res, 429, { error: 'Slow down a little — too many messages' });
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!text) return send(res, 400, { error: 'Empty message' });
    let conv = db.prepare('SELECT * FROM conversations WHERE investor_id=? ORDER BY id DESC').get(v.id);
    if (!conv) {
      const info = db.prepare(`INSERT INTO conversations(customer_name,customer_phone,customer_email,source,cust_token,investor_id)
        VALUES(?,?,?,?,?,?)`).run(v.name + ' (Investor)', v.phone, v.email || '', 'investor_portal', newToken(), v.id);
      conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(info.lastInsertRowid);
      for (const r2 of ADMIN_STREAMS) sseSend(r2, { type: 'new_conversation', conversation_id: conv.id });
    } else if (conv.status !== 'open') {
      db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(conv.id);
    }
    const m = addChatMessage(conv.id, 'customer', null, v.name + ' (Investor)', text, '', '');
    return send(res, 201, { ok: true, message: chatMsgRow(m) });
  }

  // ---- BUILT-IN LIVE CHAT (public, WhatsApp-independent) ----
  if (r[0] === 'chat' && r[1] === 'start' && method === 'POST') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (chatRateLimited('chatstart|' + ip, 4, 10 * 60 * 1000)) return send(res, 429, { error: 'Too many chats started — please wait a few minutes' });
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 80);
    const phone = String(b.phone || '').replace(/[^0-9]/g, '');
    const lang = b.lang === 'ar' ? 'ar' : 'en';
    if (!name || phone.length < 7) return send(res, 400, { error: 'Enter your name and a valid phone number' });
    const cust = currentCustomer(req);
    // resume: same browser token first, else the signed-in customer's latest thread
    let conv = convByToken(b.token);
    if (cust) {
      // The customer has proven this phone is theirs (it is their login), so adopt any guest
      // conversations they started with the same phone before creating / signing into the account.
      db.prepare('UPDATE conversations SET customer_id=? WHERE customer_id IS NULL AND customer_phone=?').run(cust.id, cust.phone);
      if (!conv) conv = db.prepare("SELECT * FROM conversations WHERE customer_id=? AND status!='closed' ORDER BY id DESC").get(cust.id);
      if (!conv) conv = db.prepare('SELECT * FROM conversations WHERE customer_id=? ORDER BY id DESC').get(cust.id);
    }
    let productId = Number(b.product_id) || null;
    if (productId && !queries.productById(productId)) productId = null;
    let orderId = null;
    if (b.order_ref) {
      const o = db.prepare('SELECT id, customer_phone FROM orders WHERE order_number=?').get(String(b.order_ref).trim());
      if (o && o.customer_phone.replace(/[^0-9]/g, '') === phone) orderId = o.id;   // only their own order
    }
    if (!conv) {
      const token = newToken();
      const src = ['product_page', 'order_page', 'checkout_page'].includes(b.source) ? b.source : 'website';
      const info = db.prepare(`INSERT INTO conversations(customer_name,customer_phone,customer_email,customer_id,product_id,order_id,source,cust_token)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(name, phone, String(b.email || '').slice(0, 120), cust ? cust.id : null, productId, orderId, src, token);
      conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(info.lastInsertRowid);
      addChatMessage(conv.id, 'system', null, '', getSetting(lang === 'ar' ? 'chat_welcome_ar' : 'chat_welcome_en'), '', '');
      for (const r2 of ADMIN_STREAMS) sseSend(r2, { type: 'new_conversation', conversation_id: conv.id });
    } else {
      // context can be added onto an existing thread
      const upd = [];
      if (productId && !conv.product_id) { db.prepare('UPDATE conversations SET product_id=? WHERE id=?').run(productId, conv.id); upd.push(1); }
      if (orderId && !conv.order_id) { db.prepare('UPDATE conversations SET order_id=? WHERE id=?').run(orderId, conv.id); upd.push(1); }
      if (conv.status === 'resolved' || conv.status === 'closed') db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(conv.id);
      conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(conv.id);
    }
    if (productId) {
      const p = queries.productById(productId);
      addChatMessage(conv.id, 'system', null, '', (lang === 'ar' ? 'استفسار عن المنتج: ' : 'Asking about product: ') + p.en.name + ' (D' + (p.sale || p.price) + ')', '', '');
    }
    if (orderId) {
      const o = db.prepare('SELECT order_number,status,total FROM orders WHERE id=?').get(orderId);
      addChatMessage(conv.id, 'system', null, '', (lang === 'ar' ? 'استفسار عن الطلب: ' : 'Asking about order: ') + o.order_number + ' — ' + o.status, '', '');
    }
    const msgs = db.prepare('SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY id').all(conv.id).map(chatMsgRow);
    return send(res, 200, { token: conv.cust_token, conversation_id: conv.id, status: conv.status, online: chatOnline(), messages: msgs });
  }
  if (r[0] === 'chat' && r[1] === 'history' && method === 'GET') {
    const conv = convByToken(req.headers['x-chat-token'] || url.searchParams.get('token'));
    if (!conv) return send(res, 404, { error: 'no conversation' });
    // customer is reading: staff messages become "read"
    const unread = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE conversation_id=? AND sender_type='staff' AND read_at IS NULL").get(conv.id).c;
    if (unread) {
      db.prepare("UPDATE chat_messages SET read_at=datetime('now') WHERE conversation_id=? AND sender_type='staff' AND read_at IS NULL").run(conv.id);
      chatBroadcast(conv.id, { type: 'read', by: 'customer' }, { toCustomer: false });
    }
    const t = CHAT_TYPING.get(conv.id) || {};
    const msgs = db.prepare('SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY id').all(conv.id).map(chatMsgRow);
    return send(res, 200, { conversation_id: conv.id, status: conv.status, online: chatOnline(),
      staff_typing: !!(t.staff && Date.now() - t.staff < 6000), messages: msgs });
  }
  if (r[0] === 'chat' && r[1] === 'message' && method === 'POST') {
    const b = await readBody(req);
    const conv = convByToken(req.headers['x-chat-token'] || b.token);
    if (!conv) return send(res, 404, { error: 'no conversation' });
    if (chatRateLimited('chatmsg|' + conv.id, 12, 60 * 1000)) return send(res, 429, { error: 'Slow down a little — too many messages' });
    const text = String(b.text || '').trim().slice(0, 2000);
    let attach = '', attachType = '';
    if (b.attachment_data) {
      if (getSetting('chat_upload') !== '1') return send(res, 400, { error: 'Attachments are disabled' });
      try { attach = saveImage(b.attachment_data) || ''; attachType = attach ? 'image' : ''; }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (!text && !attach) return send(res, 400, { error: 'Empty message' });
    if (conv.status === 'resolved' || conv.status === 'closed') db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(conv.id);
    else if (conv.status === 'pending') db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(conv.id);
    const m = addChatMessage(conv.id, 'customer', null, conv.customer_name, text, attach, attachType);
    maybeAccountNudge(conv, b.lang);
    // offline auto-reply, at most once per 2 hours per conversation
    if (!chatOnline()) {
      const lang = b.lang === 'ar' ? 'ar' : 'en';
      const recent = db.prepare(`SELECT COUNT(*) c FROM chat_messages WHERE conversation_id=? AND sender_type='system'
        AND message_text=? AND created_at > datetime('now','-2 hours')`).get(conv.id, getSetting(lang === 'ar' ? 'chat_offline_ar' : 'chat_offline_en')).c;
      if (!recent) addChatMessage(conv.id, 'system', null, '', getSetting(lang === 'ar' ? 'chat_offline_ar' : 'chat_offline_en'), '', '');
    }
    return send(res, 201, { ok: true, message: chatMsgRow(m), online: chatOnline() });
  }
  if (r[0] === 'chat' && r[1] === 'typing' && method === 'POST') {
    const b = await readBody(req);
    const conv = convByToken(req.headers['x-chat-token'] || b.token);
    if (!conv) return send(res, 404, { error: 'no conversation' });
    const t = CHAT_TYPING.get(conv.id) || {}; t.cust = Date.now(); CHAT_TYPING.set(conv.id, t);
    chatBroadcast(conv.id, { type: 'typing', by: 'customer' }, { toCustomer: false });
    return send(res, 200, { ok: true });
  }
  if (r[0] === 'chat' && r[1] === 'stream' && method === 'GET') {
    const conv = convByToken(url.searchParams.get('token'));
    if (!conv) return send(res, 404, { error: 'no conversation' });
    sseInit(req, res);
    let set = CHAT_STREAMS.get(conv.id);
    if (!set) { set = new Set(); CHAT_STREAMS.set(conv.id, set); }
    set.add(res);
    req.on('close', () => { set.delete(res); if (!set.size) CHAT_STREAMS.delete(conv.id); });
    return;
  }

  if (r[0] === 'customer' && r[1] === 'orders' && method === 'GET') {
    const c = currentCustomer(req);
    if (!c) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { orders: queries.customerOrders(c) });
  }

  // Coupon validation (public — checkout preview)
  if (r[0] === 'coupon' && method === 'POST') {
    const b = await readBody(req);
    const chk = couponDiscount(queries.couponByCode(String(b.code || '')), Number(b.subtotal) || 0);
    if (!chk.ok) return send(res, 400, { error: chk.err });
    return send(res, 200, { ok: true, discount: chk.discount });
  }

  // Promo banners (public)
  if (r[0] === 'banners' && method === 'GET') return send(res, 200, { banners: queries.activeBanners() });

  // Newsletter signup (public)
  if (r[0] === 'newsletter' && method === 'POST') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address' });
    queries.addSubscriber(email.slice(0, 160), String(b.name || '').slice(0, 80));
    return send(res, 201, { ok: true });
  }

  // Customer order tracking / receipt — requires the order number AND a matching phone (prevents enumeration).
  if (r[0] === 'track' && method === 'GET') {
    const ref = String(url.searchParams.get('ref') || '').trim();
    const phone = String(url.searchParams.get('phone') || '').replace(/[^0-9]/g, '');
    if (!ref || !phone) return send(res, 400, { error: 'Enter your order number and phone' });
    const o = db.prepare('SELECT * FROM orders WHERE order_number=?').get(ref);
    if (!o || o.customer_phone.replace(/[^0-9]/g, '') !== phone)
      return send(res, 404, { error: 'No order found with that number and phone' });
    let items = []; try { items = JSON.parse(o.items_json); } catch {}
    return send(res, 200, { order: {
      order_number: o.order_number, status: o.status, payment_status: o.payment_status,
      customer_name: o.customer_name, customer_phone: o.customer_phone,
      delivery_method: o.delivery_method, delivery_address: o.delivery_address,
      delivery_area: o.delivery_area, delivery_zone: o.delivery_zone,
      payment_method: o.payment_method, subtotal: o.subtotal, discount: o.discount || 0, coupon_code: o.coupon_code || '', delivery_fee: o.delivery_fee,
      total: o.total, notes: o.notes, created_at: o.created_at, items,
    } });
  }
  if (r[0] === 'reviews' && method === 'POST') {
    const b = await readBody(req);
    if (!b.name || !b.text) return send(res, 400, { error: 'Please add your name and review' });
    const rating = Math.min(5, Math.max(1, Number(b.rating) || 5));
    // optional: a review tied to a specific product (star ratings on the product page)
    let pid = null;
    if (b.product_id) { const p = db.prepare('SELECT id FROM products WHERE id=?').get(Number(b.product_id)); if (p) pid = p.id; }
    db.prepare("INSERT INTO reviews(name,location,rating,text_en,product_id,status) VALUES(?,?,?,?,?,'pending')")
      .run(String(b.name).slice(0,80), String(b.location||'').slice(0,80), rating, String(b.text).slice(0,600), pid);
    return send(res, 201, { ok: true }); // held for admin approval before showing
  }

  if (r[0] === 'orders' && method === 'POST') {
    const b = await readBody(req);
    if (!b.customer_name || !b.customer_phone || !Array.isArray(b.items) || !b.items.length)
      return send(res, 400, { error: 'Missing name, phone, or items' });
    // Which market this order belongs to. A UK order is priced in pounds from the UK fields and
    // posted by the partner in Britain; it only exists at all once the UK side is switched on.
    const market = (b.market === 'uk' && getSetting('uk_enabled') === '1') ? 'uk' : 'gm';
    const currency = market === 'uk' ? 'GBP' : 'GMD';
    // recompute totals server-side from live prices (sizes included); cost is snapshotted so
    // profit stays accurate even if the cost price changes later
    const resolved = resolveSaleItems(b.items, market);
    const items = resolved.items;
    let subtotal = resolved.subtotal;
    if (!items.length) return send(res, 400, { error: 'No valid items' });
    const isPickup = market === 'gm' && b.delivery_method === 'pickup';
    // Delivery fee comes from the chosen zone (authoritative, server-side); free over the threshold.
    let freeOver, zoneName = '', zoneFee;
    if (market === 'uk') {
      freeOver = Number(getSetting('uk_free_over')) || 0;
      zoneFee = Number(getSetting('uk_delivery_fee')) || 0;
      zoneName = 'United Kingdom';
    } else {
      freeOver = Number(getSetting('free_delivery_over'));
      zoneFee = Number(getSetting('delivery_fee')) || 0;
      if (!isPickup && b.delivery_zone_id) {
        const z = queries.zoneById(Number(b.delivery_zone_id));
        if (z) { zoneName = z.name_en; zoneFee = Number(z.fee) || 0; }
      }
    }
    /* ---- discounts: coupon + loyalty points (all validated server-side) ----
       Coupons and loyalty points are held in dalasi, so they are not offered on a UK order —
       taking D50 off a £20 basket would be meaningless. A separate UK scheme can come later. */
    let discount = 0, couponCode = '';
    if (market === 'uk') { /* no coupon or points on a UK order */ }
    else if (b.coupon) {
      const coupon = queries.couponByCode(String(b.coupon));
      const chk = couponDiscount(coupon, subtotal);
      if (!chk.ok) return send(res, 400, { error: chk.err });
      discount += chk.discount; couponCode = coupon.code;
      db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id=?').run(coupon.id);
    }
    const cust = currentCustomer(req);
    let redeemed = 0;
    if (market === 'gm' && cust && Number(b.redeem_points) > 0) {
      const pv = Number(getSetting('loyalty_point_value')) || 1;
      const maxPct = Number(getSetting('loyalty_max_redeem_pct')) || 30;
      const capPts = Math.floor(subtotal * maxPct / 100 / pv);
      redeemed = Math.min(Math.floor(Number(b.redeem_points)), cust.points || 0, capPts);
      if (redeemed > 0) {
        discount += redeemed * pv;
        db.prepare('UPDATE customers SET points = points - ? WHERE id=?').run(redeemed, cust.id);
      }
    }
    discount = Math.min(discount, subtotal);
    const goods = subtotal - discount;
    const fee = isPickup ? 0 : (goods >= freeOver ? 0 : zoneFee);
    const total = goods + fee;
    // Optional payment proof screenshot (mobile money / bank transfer)
    let proof = '';
    try { if (b.payment_proof_data) proof = saveImage(b.payment_proof_data) || ''; } catch (e) { return send(res, 400, { error: e.message }); }
    const orderNumber = nextOrderNumber();
    const info = db.prepare(`INSERT INTO orders
      (order_number,customer_name,customer_phone,customer_email,postcode,market,currency,delivery_method,delivery_address,delivery_area,delivery_zone,payment_method,payment_proof,subtotal,discount,coupon_code,customer_id,delivery_fee,total,notes,language,items_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        orderNumber, String(b.customer_name).slice(0,120), String(b.customer_phone).slice(0,40),
        String(b.customer_email||'').slice(0,160), String(b.postcode||'').slice(0,16).toUpperCase(),
        market, currency,
        isPickup ? 'pickup' : 'home', String(b.delivery_address||'').slice(0,300),
        String(b.delivery_area||'').slice(0,120), String(zoneName).slice(0,120), String(b.payment_method||'cod').slice(0,30),
        proof, subtotal, discount, couponCode, cust ? cust.id : null, fee, total, String(b.notes||'').slice(0,500), b.language === 'ar' ? 'ar' : 'en', JSON.stringify(items));
    // decrement stock for confirmed inventory + record in the stock ledger
    decrementStockForItems(items, 'order', orderNumber, '', market);
    /* Investors funded stock in dalasi at Gambian cost prices. Feeding a pound sale into that
       same pot would put two currencies in one profit figure and quietly corrupt every
       investor's balance, so UK orders are deliberately left out until the UK side has a
       profit model of its own. */
    if (market === 'gm') recordInvestorSalesForOrder(info.lastInsertRowid, orderNumber, items);
    return send(res, 201, { ok: true, order_number: orderNumber, id: info.lastInsertRowid, subtotal, discount, redeemed, delivery_fee: fee, total, currency, market });
  }

  /* ----- ADMIN AUTH (rate limited) ----- */
  if (r[0] === 'admin' && r[1] === 'login' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim().toLowerCase();
    const password = String(b.password || '');
    // brute-force protection: 8 failures per IP+username → locked for 10 minutes
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const rlKey = ip + '|' + username;
    const rl = LOGIN_ATTEMPTS.get(rlKey);
    if (rl && rl.count >= 8 && Date.now() - rl.t < 10 * 60 * 1000)
      return send(res, 429, { error: 'Too many attempts — try again in 10 minutes' });
    let user;
    if (username) {
      user = db.prepare('SELECT * FROM users WHERE lower(username)=? AND is_active=1').get(username);
    } else {
      // legacy: password-only logs in the owner
      user = db.prepare("SELECT * FROM users WHERE role='owner' AND is_active=1").get();
    }
    if (!user || !verifyPassword(password, user.pass_hash)) {
      const cur = LOGIN_ATTEMPTS.get(rlKey) || { count: 0, t: Date.now() };
      if (Date.now() - cur.t > 10 * 60 * 1000) { cur.count = 0; cur.t = Date.now(); }
      cur.count++; if (cur.count === 1) cur.t = Date.now();
      LOGIN_ATTEMPTS.set(rlKey, cur);
      logAct(username || 'owner', 'login_failed', 'from ' + ip);
      return send(res, 401, { error: 'Wrong username or password' });
    }
    LOGIN_ATTEMPTS.delete(rlKey);
    logAct(user.username, 'login', 'from ' + ip);
    LAST_STAFF_SEEN = Date.now();   // signing in counts as staff presence for chat
    const token = newToken();
    db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run(token, user.id);
    let perms = []; try { perms = JSON.parse(user.permissions || '[]'); } catch {}
    if (user.role === 'owner') perms = ALL_PERMS;
    return send(res, 200, { ok: true, token, user: { username: user.username, name: user.name, role: user.role, perms } });
  }
  if (r[0] === 'admin' && r[1] === 'logout' && method === 'POST') {
    const h = req.headers['authorization'] || ''; const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    return send(res, 200, { ok: true });
  }

  /* ----- ADMIN (protected) ----- */
  // Staff chat live stream (EventSource cannot set headers, so the session token comes via query)
  if (r[0] === 'admin' && r[1] === 'chat-stream' && method === 'GET') {
    const qt = url.searchParams.get('auth') || '';
    const s = db.prepare('SELECT user_id FROM sessions WHERE token=?').get(qt);
    const u = s ? db.prepare('SELECT id,role,permissions,is_active FROM users WHERE id=?').get(s.user_id) : null;
    let perms = []; try { perms = JSON.parse((u && u.permissions) || '[]'); } catch {}
    if (!u || !u.is_active || !(u.role === 'owner' || perms.includes('chat'))) return send(res, 401, { error: 'unauthorized' });
    LAST_STAFF_SEEN = Date.now();
    sseInit(req, res);
    ADMIN_STREAMS.add(res);
    req.on('close', () => ADMIN_STREAMS.delete(res));
    return;
  }

  if (r[0] === 'admin') {
    const me = requireAuth(req, res); if (!me) return;

    // who am I (used by the dashboard to gate the UI)
    if (r[1] === 'me' && method === 'GET') return send(res, 200, { user: me, allPerms: ALL_PERMS,
      // How much this person may take off a sale. The browser uses it to warn early; the server
      // enforces it again on every sale, so editing this value in the page changes nothing.
      maxDiscountPct: me.role === 'owner' ? 100 : (Number(getSetting('max_staff_discount_pct', '10')) || 0) });

    /* ---- DATABASE BACKUP (owner only) ----
       Streams a consistent snapshot of the live database. VACUUM INTO is used rather than a raw
       file copy because the store keeps serving orders while the backup runs — copying the file
       byte-for-byte under write load can produce a torn, unopenable database. This is deliberately
       restricted to the owner role: the file contains every customer record and password hash. */
    if (r[1] === 'backup' && method === 'GET') {
      if (me.role !== 'owner') return send(res, 403, { error: 'Only the store owner can download a backup' });
      if (BACKUP_RUNNING) return send(res, 429, { error: 'A backup is already being prepared — please wait a moment' });

      const dbDir = path.dirname(DB_PATH);
      // VACUUM INTO writes a second copy beside the database, so refuse if the disk cannot hold it.
      try {
        const dbSize = fs.statSync(DB_PATH).size;
        const st = fs.statfsSync(dbDir);
        if (st.bavail * st.bsize < dbSize * 1.5) {
          return send(res, 507, { error: 'Not enough free disk space to build a backup right now' });
        }
      } catch { /* statfs is unavailable on some platforms — proceed rather than block the backup */ }

      const tmp = path.join(dbDir, `.backup_${crypto.randomBytes(8).toString('hex')}.db`);
      BACKUP_RUNNING = true;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true; BACKUP_RUNNING = false;
        try { fs.unlinkSync(tmp); } catch {}
      };

      try {
        db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      } catch (e) {
        cleanup();
        return send(res, 500, { error: 'Backup failed: ' + e.message });
      }

      let size = 0;
      try { size = fs.statSync(tmp).size; } catch { cleanup(); return send(res, 500, { error: 'Backup failed' }); }

      const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="jeddah-backup-${stamp}.db"`,
        'Content-Length': size,
        'Cache-Control': 'no-store',
      });
      const rs = fs.createReadStream(tmp);
      rs.on('error', () => { cleanup(); res.destroy(); });
      rs.on('close', cleanup);
      res.on('close', cleanup);
      rs.pipe(res);
      logAct(me.username, 'backup_download', (size / 1048576).toFixed(2) + ' MB');
      return;
    }

    // overview stats
    if (r[1] === 'stats' && method === 'GET') {
      const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
      const newOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='new'").get().c;
      const revenue = db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE market='gm' AND status NOT IN ('cancelled','returned','refunded')").get().s;
      const products = db.prepare('SELECT COUNT(*) c FROM products').get().c;
      const threshold = Number(getSetting('low_stock_threshold')) || 5;
      /* Low stock uses each item's own minimum where set, otherwise the shop-wide threshold.
         A product sold in sizes is reported size by size — its product-level stock column is no
         longer the real figure, so counting it would raise alerts for stock that doesn't exist. */
      const HAS_SIZES = "EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id AND v.is_active=1)";
      const lowStockItems = db.prepare(
        `SELECT name_en, stock, min_stock FROM products
         WHERE is_active=1 AND NOT ${HAS_SIZES} AND stock>0 AND stock <= (CASE WHEN min_stock>0 THEN min_stock ELSE ? END)
         ORDER BY stock ASC`).all(threshold)
        .map(p => ({ name_en: p.name_en, stock: p.stock, min: p.min_stock>0?p.min_stock:threshold }));
      const lowSizes = db.prepare(
        `SELECT p.name_en, v.label_en, v.stock, v.min_stock FROM product_variants v
         JOIN products p ON p.id = v.product_id
         WHERE p.is_active=1 AND v.is_active=1 AND v.stock>0 AND v.stock <= (CASE WHEN v.min_stock>0 THEN v.min_stock ELSE ? END)
         ORDER BY v.stock ASC`).all(threshold)
        .map(v => ({ name_en: v.name_en + ' · ' + v.label_en, stock: v.stock, min: v.min_stock>0?v.min_stock:threshold }));
      lowStockItems.push(...lowSizes);
      lowStockItems.sort((a, b) => a.stock - b.stock);

      const outItems = db.prepare(`SELECT name_en, stock FROM products WHERE is_active=1 AND NOT ${HAS_SIZES} AND stock<=0`).all();
      outItems.push(...db.prepare(
        `SELECT p.name_en || ' · ' || v.label_en AS name_en, v.stock FROM product_variants v
         JOIN products p ON p.id = v.product_id
         WHERE p.is_active=1 AND v.is_active=1 AND v.stock<=0`).all());
      // Items expiring within 60 days (only those that carry an expiry date).
      const expiringItems = db.prepare("SELECT name_en, expiry_date FROM products WHERE is_active=1 AND expiry_date IS NOT NULL AND expiry_date!='' AND date(expiry_date) <= date('now','+60 days') ORDER BY expiry_date ASC").all()
        .map(p => ({ name_en: p.name_en, expiry: p.expiry_date }));
      const byPay = db.prepare("SELECT payment_method m, COUNT(*) c FROM orders GROUP BY payment_method").all();
      const onlineCount = db.prepare("SELECT COUNT(*) c FROM orders WHERE channel='online'").get().c;
      const onsiteCount = db.prepare("SELECT COUNT(*) c FROM orders WHERE channel='onsite'").get().c;
      // top selling products (by units sold)
      const sold = {};
      const allItems = db.prepare("SELECT items_json FROM orders WHERE status NOT IN ('cancelled','returned','refunded')").all();
      for (const o of allItems) { try { JSON.parse(o.items_json).forEach(i => { sold[i.name] = (sold[i.name]||0) + (i.qty||0); }); } catch {} }
      const topSellers = Object.entries(sold).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,qty])=>({name,qty}));
      // profit = sum over non-cancelled order items of (price - cost) * qty
      let grossProfit = 0;
      if (hasPerm(me, 'profit')) {
        for (const o of allItems) { try { JSON.parse(o.items_json).forEach(i => { grossProfit += ((i.price||0) - (i.cost||0)) * (i.qty||0); }); } catch {} }
      }
      const expenses = queries.totalExpenses();
      const seeFin = hasPerm(me, 'profit');
      return send(res, 200, { totalOrders, newOrders, revenue, products,
        lowStock: lowStockItems.length, outStock: outItems.length, lowStockItems, outItems,
        expiring: expiringItems.length, expiringItems,
        threshold, byPay, onlineCount, onsiteCount, topSellers,
        profit: seeFin ? grossProfit : null, expenses: seeFin ? expenses : null,
        netProfit: seeFin ? (grossProfit - expenses) : null, canSeeProfit: seeFin });
    }

    // ---- PRODUCTS ----
    if (r[1] === 'products' && method === 'GET') return send(res, 200, { products: queries.allProducts() });
    if (r[1] === 'categories' && method === 'GET') return send(res, 200, { categories: queries.allCategories() });

    /* Original photo files still on disk ------------------------------------------------
       Shrinking a photo writes a new file and points the product at it; the file it replaced
       is left alone. This lists the upload files nothing in the shop refers to any more, so
       the admin page can offer to put an original back. Payment proofs, chat attachments,
       category pictures and banners are all treated as "in use" and never listed. */
    if (r[1] === 'photo-originals' && method === 'GET') {
      if (!hasPerm(me, 'products')) return send(res, 403, { error: 'No permission' });
      const used = new Set();
      const add = v => { const s = String(v || '').trim(); if (s.startsWith('/uploads/')) used.add(s.slice('/uploads/'.length)); };
      for (const row of db.prepare('SELECT image, images FROM products').all()) {
        add(row.image);
        try { const g = JSON.parse(row.images || '[]'); if (Array.isArray(g)) g.forEach(add); } catch {}
      }
      for (const row of db.prepare('SELECT image FROM categories').all()) add(row.image);
      for (const row of db.prepare('SELECT image FROM banners').all()) add(row.image);
      for (const row of db.prepare("SELECT attachment_url FROM chat_messages WHERE attachment_url<>''").all()) add(row.attachment_url);
      for (const row of db.prepare("SELECT payment_proof FROM orders WHERE payment_proof<>''").all()) add(row.payment_proof);
      let names = [];
      try { names = fs.readdirSync(UPLOAD_DIR); } catch {}
      const spare = [];
      for (const name of names) {
        if (used.has(name)) continue;
        if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) continue;
        let size = 0;
        try { const st = fs.statSync(path.join(UPLOAD_DIR, name)); if (!st.isFile()) continue; size = st.size; } catch { continue; }
        spare.push({ url: '/uploads/' + name, size });
      }
      spare.sort((a, b) => b.size - a.size);
      return send(res, 200, { originals: spare.slice(0, 600), inUse: used.size });
    }

    if (r[1] === 'products' && method === 'POST') {
      if (!requirePerm(req, res, 'products')) return;
      const b = await readBody(req);
      let gallery = [];
      try {
        if (Array.isArray(b.images)) gallery = saveImages(b.images);
        else if (b.image_data) { const u = saveImage(b.image_data); if (u) gallery = [u]; }
      } catch (e) { return send(res, 400, { error: e.message }); }
      const image = gallery[0] || null;                          // first image is the primary/thumbnail
      const status = ['active','draft','archived'].includes(b.status) ? b.status : 'active';
      const info = db.prepare(`INSERT INTO products
        (category_slug,icon,image,images,sku,barcode,brand,price,discount_price,cost,wholesale_price,stock,min_stock,batch_no,expiry_date,supplier_id,status,
         is_featured,is_bestseller,is_new,is_active,name_en,name_ar,desc_en,desc_ar,use_en,use_ar,benefits_en,benefits_ar,
         ingredients_en,ingredients_ar,warnings_en,warnings_ar,weight,dimensions,video_url,uk_active,gbp_price,gbp_sale,uk_stock,weight_g)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        b.cat||'general', b.icon||'grid', image, JSON.stringify(gallery),
        String(b.sku||'').slice(0,40), String(b.barcode||'').slice(0,60), String(b.brand||'').slice(0,80),
        Number(b.price)||0, Number(b.discount)||0, Number(b.cost)||0, Number(b.wholesale)||0,
        Number(b.stock)||0, Number(b.minStock)||0, String(b.batchNo||'').slice(0,60), String(b.expiry||'').slice(0,20),
        b.supplierId?Number(b.supplierId):null, status,
        b.feat?1:0, b.bestsellerManual?1:0, b.isNew?1:0, status==='archived'?0:(b.active===false?0:1),
        b.name_en||'Untitled', b.name_ar||'',
        b.desc_en||'', b.desc_ar||'', b.use_en||'', b.use_ar||'',
        JSON.stringify(splitLines(b.benefits_en)), JSON.stringify(splitLines(b.benefits_ar)),
        b.ingredients_en||'', b.ingredients_ar||'', b.warnings_en||'', b.warnings_ar||'',
        String(b.weight||'').slice(0,60), String(b.dims||'').slice(0,80), String(b.video||'').slice(0,300),
        b.ukActive?1:0, Number(b.ukPrice)||0, Number(b.ukSale)||0,
        Math.max(0,Math.trunc(Number(b.ukStock)||0)), Math.max(0,Math.trunc(Number(b.weightG)||0)));
      if ((Number(b.stock)||0) > 0) logMove(info.lastInsertRowid, Number(b.stock), 'manual', 'initial stock', me.username);
      logAct(me.username, 'product_add', b.name_en || '');
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }

    /* ---- PRODUCT SIZES (variants) ----
       Placed before the generic /products/:id handlers so the extra path segment is matched first. */
    if (r[1] === 'products' && r[2] && r[3] === 'variants' && method === 'GET') {
      if (!hasPerm(me, 'products')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { variants: queries.variantsOf(Number(r[2])) });
    }
    // Saves the whole size list for one product in a single call — that is how the product form works.
    if (r[1] === 'products' && r[2] && r[3] === 'variants' && method === 'PUT') {
      if (!requirePerm(req, res, 'products')) return;
      const pid = Number(r[2]);
      const prod = db.prepare('SELECT id,name_en FROM products WHERE id=?').get(pid);
      if (!prod) return send(res, 404, { error: 'Product not found' });
      const body = await readBody(req);
      const incoming = Array.isArray(body.sizes) ? body.sizes : [];

      // Reject sizes that are obviously unusable rather than silently saving a broken price list.
      for (const s of incoming) {
        if (!String(s.label_en || '').trim()) return send(res, 400, { error: 'Every size needs a name, e.g. 500g' });
        if (!(Number(s.price) > 0)) return send(res, 400, { error: `Size "${s.label_en}" needs a price above zero` });
        if (Number(s.discount_price) > 0 && Number(s.discount_price) >= Number(s.price))
          return send(res, 400, { error: `The sale price for "${s.label_en}" must be lower than its normal price` });
      }

      const existing = db.prepare('SELECT * FROM product_variants WHERE product_id=?').all(pid);
      const keptIds = new Set(incoming.map(s => Number(s.id)).filter(Boolean));

      for (const old of existing) {
        if (keptIds.has(old.id)) continue;
        // A size that has already been sold is switched off, never deleted: past sales, stock
        // movements and investor profit rows must keep pointing at something real.
        if (queries.variantWasSold(old.id)) queries.deactivateVariant(old.id);
        else queries.deleteVariant(old.id);
      }

      let order = 0;
      for (const s of incoming) {
        const payload = { ...s, sort_order: order++ };
        const id = Number(s.id) || 0;
        if (id && existing.some(e => e.id === id)) {
          const before = existing.find(e => e.id === id);
          queries.updateVariant(id, payload);
          const newStock = Math.max(0, Math.trunc(Number(payload.stock) || 0));
          if (newStock !== before.stock)
            logMove(pid, newStock - before.stock, 'manual', 'size edited in product form', me.username, id);
        } else {
          const newId = queries.addVariant(pid, payload);
          const startStock = Math.max(0, Math.trunc(Number(payload.stock) || 0));
          if (startStock) logMove(pid, startStock, 'manual', 'size added in product form', me.username, newId);
        }
      }
      logAct(me.username, 'product_sizes', `${prod.name_en}: ${incoming.length} size(s)`);
      return send(res, 200, { ok: true, variants: queries.variantsOf(pid) });
    }
    // Adjust one size's stock from the Inventory screen.
    if (r[1] === 'variants' && r[2] && r[3] === 'adjust' && method === 'POST') {
      if (!requirePerm(req, res, 'products')) return;
      const v = variantById(Number(r[2]));
      if (!v) return send(res, 404, { error: 'Size not found' });
      const bb = await readBody(req);
      const next = bb.mode === 'set'
        ? Math.max(0, Math.trunc(Number(bb.qty) || 0))
        : Math.max(0, v.stock + Math.trunc(Number(bb.qty) || 0));
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(next, v.id);
      if (next !== v.stock)
        logMove(v.productId, next - v.stock, String(bb.reason || 'adjustment').slice(0, 30), String(bb.note || '').slice(0, 120), me.username, v.id);
      return send(res, 200, { ok: true, stock: next });
    }

    const pmatch = r[1] === 'products' && r[2];
    if (pmatch && method === 'PATCH') {
      if (!requirePerm(req, res, 'products')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      // Images: if a gallery is supplied, rebuild it (keeping existing /uploads paths, saving new data URLs).
      let gallery = null, image = cur.image;
      try {
        if (Array.isArray(b.images)) { gallery = saveImages(b.images); image = gallery[0] || null; }
        else if (b.image_data) { const u = saveImage(b.image_data); if (u) { image = u; let ex = []; try { ex = JSON.parse(cur.images||'[]'); } catch {} gallery = [u, ...ex.filter(x=>x!==u)].slice(0,8); } }
      } catch (e) { return send(res, 400, { error: e.message }); }
      const status = b.status!=null ? (['active','draft','archived'].includes(b.status)?b.status:cur.status) : cur.status;
      db.prepare(`UPDATE products SET category_slug=?,icon=?,image=?,images=?,sku=?,barcode=?,brand=?,price=?,discount_price=?,cost=?,wholesale_price=?,
        stock=?,min_stock=?,batch_no=?,expiry_date=?,supplier_id=?,status=?,is_featured=?,is_bestseller=?,is_new=?,is_active=?,
        name_en=?,name_ar=?,desc_en=?,desc_ar=?,use_en=?,use_ar=?,benefits_en=?,benefits_ar=?,
        ingredients_en=?,ingredients_ar=?,warnings_en=?,warnings_ar=?,weight=?,dimensions=?,video_url=?,
        uk_active=?,gbp_price=?,gbp_sale=?,uk_stock=?,weight_g=?,updated_at=datetime('now') WHERE id=?`).run(
        b.cat??cur.category_slug, b.icon??cur.icon, image, gallery!=null?JSON.stringify(gallery):cur.images,
        b.sku!=null?String(b.sku).slice(0,40):cur.sku, b.barcode!=null?String(b.barcode).slice(0,60):cur.barcode,
        b.brand!=null?String(b.brand).slice(0,80):cur.brand,
        b.price!=null?Number(b.price):cur.price, b.discount!=null?Number(b.discount):cur.discount_price,
        b.cost!=null?Number(b.cost):cur.cost, b.wholesale!=null?Number(b.wholesale):cur.wholesale_price,
        b.stock!=null?Number(b.stock):cur.stock, b.minStock!=null?Number(b.minStock):cur.min_stock,
        b.batchNo!=null?String(b.batchNo).slice(0,60):cur.batch_no, b.expiry!=null?String(b.expiry).slice(0,20):cur.expiry_date,
        b.supplierId!==undefined?(b.supplierId?Number(b.supplierId):null):cur.supplier_id, status,
        b.feat!=null?(b.feat?1:0):cur.is_featured, b.bestsellerManual!=null?(b.bestsellerManual?1:0):cur.is_bestseller,
        b.isNew!=null?(b.isNew?1:0):cur.is_new,
        b.active!=null?(b.active?1:0):(status==='archived'?0:cur.is_active),
        b.name_en??cur.name_en, b.name_ar??cur.name_ar, b.desc_en??cur.desc_en, b.desc_ar??cur.desc_ar,
        b.use_en??cur.use_en, b.use_ar??cur.use_ar,
        b.benefits_en!=null?JSON.stringify(splitLines(b.benefits_en)):cur.benefits_en,
        b.benefits_ar!=null?JSON.stringify(splitLines(b.benefits_ar)):cur.benefits_ar,
        b.ingredients_en??cur.ingredients_en, b.ingredients_ar??cur.ingredients_ar,
        b.warnings_en??cur.warnings_en, b.warnings_ar??cur.warnings_ar,
        b.weight!=null?String(b.weight).slice(0,60):cur.weight, b.dims!=null?String(b.dims).slice(0,80):cur.dimensions,
        b.video!=null?String(b.video).slice(0,300):cur.video_url,
        b.ukActive!=null?(b.ukActive?1:0):cur.uk_active,
        b.ukPrice!=null?Number(b.ukPrice):cur.gbp_price,
        b.ukSale!=null?Number(b.ukSale):cur.gbp_sale,
        b.ukStock!=null?Math.max(0,Math.trunc(Number(b.ukStock))):cur.uk_stock,
        b.weightG!=null?Math.max(0,Math.trunc(Number(b.weightG))):cur.weight_g, id);
      if (b.stock != null && Number(b.stock) !== cur.stock)
        logMove(id, Number(b.stock) - cur.stock, 'manual', 'edited in product form', me.username);
      logAct(me.username, 'product_edit', cur.name_en);
      return send(res, 200, { ok: true });
    }
    if (pmatch && method === 'DELETE') {
      const meDel = requirePerm(req, res, 'products'); if (!meDel) return;
      const delP = db.prepare('SELECT name_en FROM products WHERE id=?').get(Number(r[2]));
      db.prepare('DELETE FROM products WHERE id=?').run(Number(r[2]));
      logAct(meDel.username, 'product_delete', delP ? delP.name_en : ('#' + r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- ORDERS ----
    if (r[1] === 'orders' && method === 'GET') {
      if (!hasPerm(me, 'orders')) return send(res, 403, { error: 'No permission' });
      const status = url.searchParams.get('status');
      const rows = status
        ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY id DESC').all(status)
        : db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
      rows.forEach(o => { o.items = (() => { try { return JSON.parse(o.items_json); } catch { return []; } })(); delete o.items_json; });
      return send(res, 200, { orders: rows });
    }
    if (r[1] === 'orders' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'orders')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      // optional courier (re)assignment — snapshot the name for display
      let courierId = cur.courier_id, courierName = cur.courier_name;
      if (b.courier_id !== undefined) {
        if (b.courier_id === null || b.courier_id === '') { courierId = null; courierName = ''; }
        else { const u = db.prepare('SELECT id,name,username FROM users WHERE id=?').get(Number(b.courier_id));
          if (u) { courierId = u.id; courierName = u.name || u.username; } }
      }
      const nextStatus = b.status || cur.status;
      let payStatus = b.payment_status || cur.payment_status;
      // Order didn't complete (cancelled / returned / refunded): the goods that were
      // decremented at order time come back onto the shelf. Guard against double-restock
      // if the order moves between two terminal states (e.g. returned → refunded).
      const TERMINAL = ['cancelled', 'returned', 'refunded'];
      if (TERMINAL.includes(nextStatus) && !TERMINAL.includes(cur.status)) {
        try {
          JSON.parse(cur.items_json || '[]').forEach(it => {
            // Goods go back exactly where they came from: to the size if the line had one,
            // to the product otherwise. Restocking the product for a sized line would put the
            // units somewhere nothing reads and quietly lose them.
            // ...and back to the right country: a UK order's goods return to the partner's
            // shelf in Britain, never to the shop in Banjul.
            const ukOrder = cur.market === 'uk';
            if (it.variantId) db.prepare(ukOrder ? 'UPDATE product_variants SET uk_stock = uk_stock + ? WHERE id=?'
                                                 : 'UPDATE product_variants SET stock = stock + ? WHERE id=?').run(it.qty || 0, it.variantId);
            else db.prepare(ukOrder ? 'UPDATE products SET uk_stock = uk_stock + ? WHERE id=?'
                                    : 'UPDATE products SET stock = stock + ? WHERE id=?').run(it.qty || 0, it.id);
            logMove(it.id, it.qty || 0, (nextStatus === 'returned' ? 'return' : nextStatus) + (ukOrder ? '_uk' : ''), cur.order_number, me.username, it.variantId || null);
          });
        } catch {}
      }
      // Delivered: award loyalty points once, plus the referral bonus on a first delivered order
      if (nextStatus === 'delivered' && cur.status !== 'delivered' && cur.customer_id && !cur.points_awarded && cur.market !== 'uk') {
        const earnPer = Number(getSetting('loyalty_earn_per')) || 100;
        const pts = Math.floor(cur.total / earnPer);
        if (pts > 0) db.prepare('UPDATE customers SET points = points + ? WHERE id=?').run(pts, cur.customer_id);
        db.prepare('UPDATE orders SET points_awarded=? WHERE id=?').run(pts || 1, id);
        const buyer = queries.customerById(cur.customer_id);
        if (buyer && buyer.referred_by && !buyer.referral_paid) {
          const bonus = Number(getSetting('referral_bonus_points')) || 0;
          if (bonus > 0) db.prepare('UPDATE customers SET points = points + ? WHERE id=?').run(bonus, buyer.referred_by);
          db.prepare('UPDATE customers SET referral_paid=1 WHERE id=?').run(buyer.id);
        }
      }
      if (nextStatus === 'refunded') payStatus = 'refunded';
      // Cancelled / returned / refunded → reverse any investor profit that this order generated
      if (TERMINAL.includes(nextStatus) && !TERMINAL.includes(cur.status) && cur.market !== 'uk')
        reverseInvestorSalesForOrder(id);
      db.prepare('UPDATE orders SET status=?, payment_status=?, courier_id=?, courier_name=? WHERE id=?').run(
        nextStatus, payStatus, courierId, courierName, id);
      // Stamp the moment it became a sale, so the day's takings follow the delivery date.
      // Cleared again if the order is later taken back out of delivered.
      if (nextStatus === 'delivered' && cur.status !== 'delivered')
        db.prepare("UPDATE orders SET delivered_at = datetime('now') WHERE id=? AND (delivered_at IS NULL OR delivered_at='')").run(id);
      if (nextStatus !== 'delivered' && cur.status === 'delivered')
        db.prepare('UPDATE orders SET delivered_at = NULL WHERE id=?').run(id);
      if (b.status && b.status !== cur.status) logAct(me.username, 'order_status', cur.order_number + ' → ' + nextStatus);
      return send(res, 200, { ok: true });
    }

    // ---- COURIERS (for the assignment dropdown) ----
    if (r[1] === 'couriers' && method === 'GET') {
      if (!hasPerm(me, 'orders')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { couriers: queries.couriers() });
    }

    // ---- DELIVERIES (courier's own assigned orders) ----
    if (r[1] === 'deliveries' && method === 'GET') {
      if (!hasPerm(me, 'delivery')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { deliveries: queries.deliveriesFor(me.id) });
    }
    // Lightweight polling endpoint for in-app notifications (new orders / new assignments / pending reviews)
    if (r[1] === 'pulse' && method === 'GET') {
      const out = {};
      if (hasPerm(me, 'orders')) {
        out.maxOrderId = db.prepare('SELECT COALESCE(MAX(id),0) m FROM orders').get().m;
        out.pendingOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('new','confirmed','paid','packed','out_for_delivery')").get().c;
      }
      if (hasPerm(me, 'delivery')) {
        const a = db.prepare("SELECT COALESCE(MAX(id),0) m, COUNT(*) c FROM orders WHERE courier_id=? AND status NOT IN ('delivered','cancelled','returned','refunded')").get(me.id);
        out.maxAssignedId = a.m; out.assignedCount = a.c;
      }
      if (hasPerm(me, 'reviews')) out.pendingReviews = db.prepare("SELECT COUNT(*) c FROM reviews WHERE status='pending'").get().c;
      if (hasPerm(me, 'chat')) out.chatUnread = db.prepare(`SELECT COUNT(*) c FROM chat_messages m JOIN conversations c2 ON c2.id=m.conversation_id
        WHERE m.sender_type='customer' AND m.read_at IS NULL AND c2.status!='closed'`).get().c;
      return send(res, 200, out);
    }

    // ---- INVESTORS (admin; gated by the 'profit' permission) ----
    if (r[1] === 'investors' && !r[2] && method === 'GET') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { investors: queries.allInvestors() });
    }
    if (r[1] === 'investors' && !r[2] && method === 'POST') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const b = await readBody(req);
      const phone = String(b.phone || '').replace(/[^0-9]/g, '');
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name || phone.length < 7) return send(res, 400, { error: 'Enter a name and valid phone' });
      if (String(b.password || '').length < 4) return send(res, 400, { error: 'Set a login password (min 4 characters)' });
      if (queries.investorByPhone(phone)) return send(res, 400, { error: 'An investor with this phone already exists' });
      const info = db.prepare('INSERT INTO investors(name,phone,email,address,pass_hash) VALUES(?,?,?,?,?)')
        .run(name, phone, String(b.email || '').slice(0, 120), String(b.address || '').slice(0, 200), hashPassword(b.password));
      logAct(me.username, 'investor_create', name);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'investors' && r[2] && method === 'PATCH') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const v = queries.investorById(Number(r[2]));
      if (!v) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.name) db.prepare('UPDATE investors SET name=? WHERE id=?').run(String(b.name).slice(0, 80), v.id);
      if (b.email !== undefined) db.prepare('UPDATE investors SET email=? WHERE id=?').run(String(b.email).slice(0, 120), v.id);
      if (b.address !== undefined) db.prepare('UPDATE investors SET address=? WHERE id=?').run(String(b.address).slice(0, 200), v.id);
      if (b.status && ['active', 'inactive'].includes(b.status)) db.prepare('UPDATE investors SET status=? WHERE id=?').run(b.status, v.id);
      if (b.new_password) {
        if (String(b.new_password).length < 4) return send(res, 400, { error: 'Password too short' });
        db.prepare('UPDATE investors SET pass_hash=? WHERE id=?').run(hashPassword(String(b.new_password)), v.id);
        db.prepare('DELETE FROM investor_sessions WHERE investor_id=?').run(v.id);
        logAct(me.username, 'investor_password_reset', v.name);
      }
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'investments' && !r[2] && method === 'GET') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { investments: queries.allInvestments() });
    }
    if (r[1] === 'investments' && !r[2] && method === 'POST') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const b = await readBody(req);
      const v = queries.investorById(Number(b.investor_id));
      const p = queries.productById(Number(b.product_id));
      if (!v) return send(res, 400, { error: 'Choose an investor' });
      if (!p) return send(res, 400, { error: 'Choose a product' });
      // An investment may target one size of a product ("100 × Ajwa 1000g"). Left empty, it funds
      // the product as a whole, which is how every investment made before sizes existed behaves.
      const vid = Number(b.variant_id) || 0;
      let variant = null;
      if (vid) {
        variant = variantById(vid);
        if (!variant || variant.productId !== p.id) return send(res, 400, { error: 'That size does not belong to this product' });
      }
      const qty = Math.max(1, Math.trunc(Number(b.qty_funded) || 0));
      const cost = Number(b.cost_per_unit) || (variant ? variant.cost : p.cost) || 0;
      if (cost <= 0) return send(res, 400, { error: 'Enter the cost price per unit' });
      const pct = Math.min(95, Math.max(5, Number(b.investor_pct) || 50));
      const sellRef = variant ? (variant.sale || variant.price) : (p.sale || p.price);
      const info = db.prepare(`INSERT INTO investments(investor_id,product_id,variant_id,batch_no,purchase_order_id,qty_funded,cost_per_unit,amount,sell_price_ref,investor_pct,invested_at,notes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(v.id, p.id, variant ? variant.id : null, String(b.batch_no || p.batchNo || '').slice(0, 60), Number(b.purchase_order_id) || null,
             qty, cost, Math.round(qty * cost * 100) / 100, sellRef, pct,
             /^\d{4}-\d{2}-\d{2}$/.test(b.invested_at || '') ? b.invested_at : new Date().toISOString().slice(0, 10),
             String(b.notes || '').slice(0, 300));
      logAct(me.username, 'investment_create', `${v.name} → ${p.en.name}${variant ? ' ' + variant.label_en : ''} ×${qty} (D${qty * cost})`);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    // Batch: one investor funding several products at once (each line has its own qty, cost and %).
    if (r[1] === 'investments' && r[2] === 'batch' && method === 'POST') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const b = await readBody(req);
      const v = queries.investorById(Number(b.investor_id));
      if (!v) return send(res, 400, { error: 'Choose an investor' });
      const lines = Array.isArray(b.lines) ? b.lines : [];
      if (!lines.length) return send(res, 400, { error: 'Add at least one product line' });
      const investedAt = /^\d{4}-\d{2}-\d{2}$/.test(b.invested_at || '') ? b.invested_at : new Date().toISOString().slice(0, 10);
      const prepared = [];
      for (const ln of lines) {
        const p = queries.productById(Number(ln.product_id));
        if (!p) return send(res, 400, { error: 'One of the lines has no valid product' });
        // A line may name one size of the product; empty means the product as a whole.
        const lv = Number(ln.variant_id) || 0;
        let variant = null;
        if (lv) {
          variant = variantById(lv);
          if (!variant || variant.productId !== p.id) return send(res, 400, { error: `That size does not belong to ${p.en.name}` });
        }
        const qty = Math.max(1, Math.trunc(Number(ln.qty_funded) || 0));
        const cost = Number(ln.cost_per_unit) || (variant ? variant.cost : p.cost) || 0;
        if (cost <= 0) return send(res, 400, { error: `Enter the cost price for ${p.en.name}${variant ? ' ' + variant.label_en : ''}` });
        const pct = Math.min(95, Math.max(5, Number(ln.investor_pct) || 50));
        prepared.push({ p, variant, qty, cost, pct, batch: String(ln.batch_no || p.batchNo || '').slice(0, 60) });
      }
      const ins = db.prepare(`INSERT INTO investments(investor_id,product_id,variant_id,batch_no,purchase_order_id,qty_funded,cost_per_unit,amount,sell_price_ref,investor_pct,invested_at,notes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      let n = 0, total = 0;
      db.exec('BEGIN');
      try {
        for (const x of prepared) {
          ins.run(v.id, x.p.id, x.variant ? x.variant.id : null, x.batch, null, x.qty, x.cost,
                  Math.round(x.qty * x.cost * 100) / 100,
                  x.variant ? (x.variant.sale || x.variant.price) : (x.p.sale || x.p.price),
                  x.pct, investedAt, String(b.notes || '').slice(0, 300));
          n++; total += x.qty * x.cost;
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} return send(res, 500, { error: 'Could not save the investments' }); }
      logAct(me.username, 'investment_batch', `${v.name} → ${n} product(s) (D${Math.round(total)})`);
      return send(res, 201, { ok: true, count: n, total: Math.round(total * 100) / 100 });
    }
    if (r[1] === 'investments' && r[2] && r[2] !== 'batch' && method === 'PATCH') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const inv = db.prepare('SELECT * FROM investments WHERE id=?').get(Number(r[2]));
      if (!inv) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.status === 'cancelled') {
        const sold = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM investor_sales WHERE investment_id=?').get(inv.id).q;
        if (sold > 0) return send(res, 400, { error: 'Cannot cancel — sales already recorded against it. Settle it instead.' });
        db.prepare("UPDATE investments SET status='cancelled' WHERE id=?").run(inv.id);
      } else if (b.status === 'settled') {
        db.prepare("UPDATE investments SET status='settled' WHERE id=?").run(inv.id);
      }
      if (b.notes !== undefined) db.prepare('UPDATE investments SET notes=? WHERE id=?').run(String(b.notes).slice(0, 300), inv.id);
      return send(res, 200, { ok: true });
    }
    /* ---- INVESTOR DEPOSITED CAPITAL ----
       The money handed over, recorded payment by payment. A negative amount is capital handed
       back. Distinct from investor-payouts, which pays out PROFIT and leaves capital alone. */
    if (r[1] === 'investor-deposits' && method === 'GET') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const vid = Number(url.searchParams.get('investor_id')) || 0;
      const rows = db.prepare(`SELECT d.*, v.name investor_name FROM investor_deposits d JOIN investors v ON v.id=d.investor_id
        ${vid ? 'WHERE d.investor_id=?' : ''} ORDER BY d.deposited_at DESC, d.id DESC LIMIT 200`).all(...(vid ? [vid] : []));
      return send(res, 200, { deposits: rows });
    }
    if (r[1] === 'investor-deposits' && method === 'POST') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const b = await readBody(req);
      const v = queries.investorById(Number(b.investor_id));
      if (!v) return send(res, 400, { error: 'Choose an investor' });
      const kind = b.kind === 'return' ? 'return' : 'deposit';
      const raw = Math.abs(Number(b.amount) || 0);
      if (raw <= 0) return send(res, 400, { error: 'Enter the amount' });
      const held = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM investor_deposits WHERE investor_id=?').get(v.id).a;
      // Capital cannot be handed back that was never handed in — that would read as a negative
      // starting figure, which is exactly the confusion this is meant to remove.
      if (kind === 'return' && raw > held + 0.001)
        return send(res, 400, { error: 'That is more capital than is on record (D' + Math.round(held * 100) / 100 + ')' });
      const amount = kind === 'return' ? -raw : raw;
      const info = db.prepare(`INSERT INTO investor_deposits(investor_id,amount,method,reference,notes,deposited_at,by_user)
        VALUES(?,?,?,?,?,?,?)`).run(v.id, amount, String(b.method || 'cash').slice(0, 30),
          String(b.reference || '').slice(0, 60), String(b.notes || '').slice(0, 300),
          /^\d{4}-\d{2}-\d{2}$/.test(b.deposited_at || '') ? b.deposited_at : new Date().toISOString().slice(0, 10),
          me.username);
      logAct(me.username, kind === 'return' ? 'investor_capital_return' : 'investor_deposit', `${v.name} — D${raw}`);
      return send(res, 201, { ok: true, id: info.lastInsertRowid, capital_deposited: Math.round((held + amount) * 100) / 100 });
    }
    // A mistyped entry is removed rather than corrected in place, so the record stays honest
    // about what was actually entered and when.
    if (r[1] === 'investor-deposits' && r[2] && method === 'DELETE') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const row = db.prepare('SELECT d.*, v.name investor_name FROM investor_deposits d JOIN investors v ON v.id=d.investor_id WHERE d.id=?').get(Number(r[2]));
      if (!row) return send(res, 404, { error: 'not found' });
      db.prepare('DELETE FROM investor_deposits WHERE id=?').run(row.id);
      logAct(me.username, 'investor_deposit_delete', `${row.investor_name} — D${Math.abs(row.amount)}`);
      return send(res, 200, { ok: true });
    }

    if (r[1] === 'investor-payouts' && method === 'GET') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const vid = Number(url.searchParams.get('investor_id')) || 0;
      const rows = db.prepare(`SELECT po.*, v.name investor_name FROM investor_payouts po JOIN investors v ON v.id=po.investor_id
        ${vid ? 'WHERE po.investor_id=?' : ''} ORDER BY po.id DESC LIMIT 200`).all(...(vid ? [vid] : []));
      return send(res, 200, { payouts: rows });
    }
    if (r[1] === 'investor-payouts' && method === 'POST') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const b = await readBody(req);
      const v = queries.investorById(Number(b.investor_id));
      if (!v) return send(res, 400, { error: 'Choose an investor' });
      const amount = Number(b.amount) || 0;
      if (amount <= 0) return send(res, 400, { error: 'Enter the payout amount' });
      const earned = db.prepare('SELECT COALESCE(SUM(investor_profit),0) p FROM investor_sales WHERE investor_id=?').get(v.id).p;
      const paid = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM investor_payouts WHERE investor_id=?').get(v.id).a;
      const balance = Math.round((earned - paid) * 100) / 100;
      if (amount > balance + 0.001) return send(res, 400, { error: 'Amount exceeds the balance owed (D' + balance + ')' });
      db.prepare('INSERT INTO investor_payouts(investor_id,investment_id,amount,method,reference,notes,paid_at,by_user) VALUES(?,?,?,?,?,?,?,?)')
        .run(v.id, Number(b.investment_id) || null, amount, String(b.method || 'cash').slice(0, 30),
             String(b.reference || '').slice(0, 60), String(b.notes || '').slice(0, 300),
             /^\d{4}-\d{2}-\d{2}$/.test(b.paid_at || '') ? b.paid_at : new Date().toISOString().slice(0, 10), me.username);
      logAct(me.username, 'investor_payout', `${v.name} — D${amount} (${b.method || 'cash'})`);
      return send(res, 201, { ok: true, new_balance: Math.round((balance - amount) * 100) / 100 });
    }

    // ---- LOANS: credit given to customers/friends + credit the store takes (suppliers/lenders) ----
    if (r[1] === 'loans' && !r[2] && method === 'GET') {
      if (!hasPerm(me, 'expenses')) return send(res, 403, { error: 'No permission' });
      const loans = queries.allLoans();
      const owedToUs = loans.filter(l => l.direction === 'given' && l.status === 'active').reduce((s, l) => s + (l.amount - l.paid_amount), 0);
      const weOwe = loans.filter(l => l.direction === 'taken' && l.status === 'active').reduce((s, l) => s + (l.amount - l.paid_amount), 0);
      const overdue = loans.filter(l => l.overdue).length;
      return send(res, 200, { loans, totals: { owedToUs, weOwe, overdue } });
    }
    if (r[1] === 'loans' && !r[2] && method === 'POST') {
      if (!hasPerm(me, 'expenses')) return send(res, 403, { error: 'No permission' });
      const b = await readBody(req);
      const direction = b.direction === 'taken' ? 'taken' : 'given';
      const kind = b.kind === 'product' ? 'product' : 'cash';
      const name = String(b.party_name || '').trim().slice(0, 80);
      if (!name) return send(res, 400, { error: 'Enter the person or company name' });
      const dateTaken = /^\d{4}-\d{2}-\d{2}$/.test(b.date_taken || '') ? b.date_taken : new Date().toISOString().slice(0, 10);
      const dateDue = /^\d{4}-\d{2}-\d{2}$/.test(b.date_due || '') ? b.date_due : null;
      let productId = null, productName = '', qty = 0, amount = Number(b.amount) || 0;
      if (kind === 'product') {
        const p = queries.productById(Number(b.product_id));
        if (!p) return send(res, 400, { error: 'Choose a product' });
        qty = Math.max(1, Math.trunc(Number(b.qty) || 1));
        if (direction === 'given' && qty > p.stock) return send(res, 400, { error: 'Only ' + p.stock + ' in stock' });
        productId = p.id; productName = p.en.name;
        if (!amount) amount = (p.sale || p.price) * qty;
        // goods leave the shelf when we lend them out; borrowed goods join our stock
        const delta = direction === 'given' ? -qty : qty;
        db.prepare('UPDATE products SET stock = stock + ? WHERE id=?').run(delta, p.id);
        logMove(p.id, delta, 'loan', 'LOAN ' + (direction === 'given' ? 'to ' : 'from ') + name, me.username);
      }
      if (amount <= 0) return send(res, 400, { error: 'Enter the loan amount' });
      const info = db.prepare(`INSERT INTO loans(direction,party_name,party_phone,kind,product_id,product_name,qty,amount,date_taken,date_due,notes,by_user)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(direction, name, String(b.party_phone || '').replace(/[^0-9+ ]/g, '').slice(0, 30), kind,
             productId, productName, qty, amount, dateTaken, dateDue, String(b.notes || '').slice(0, 500), me.username);
      logAct(me.username, 'loan_create', `${direction} ${kind} D${amount} — ${name}`);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'loans' && r[2] && r[3] === 'settle' && method === 'POST') {
      if (!hasPerm(me, 'expenses')) return send(res, 403, { error: 'No permission' });
      const l = queries.loanById(Number(r[2]));
      if (!l) return send(res, 404, { error: 'not found' });
      if (l.status !== 'active') return send(res, 400, { error: 'This loan is already settled' });
      const b = await readBody(req);
      if (l.kind === 'cash' || b.mode === 'cash') {
        // cash repayment — supports partial payments
        const pay = Number(b.amount) || (l.amount - l.paid_amount);
        if (pay <= 0) return send(res, 400, { error: 'Enter the payment amount' });
        const newPaid = Math.min(l.amount, l.paid_amount + pay);
        const done = newPaid >= l.amount;
        db.prepare("UPDATE loans SET paid_amount=?, status=?, settle_mode=CASE WHEN ? THEN 'cash' ELSE settle_mode END WHERE id=?")
          .run(newPaid, done ? 'paid' : 'active', done ? 1 : 0, l.id);
        logAct(me.username, 'loan_payment', `D${pay} — ${l.party_name}` + (done ? ' (settled)' : ''));
        return send(res, 200, { ok: true, paid_amount: newPaid, status: done ? 'paid' : 'active' });
      }
      // product loan settled by returning the goods — stock moves back
      if (b.mode === 'returned' && l.product_id) {
        const delta = l.direction === 'given' ? l.qty : -l.qty;   // returned to us / we give back
        db.prepare('UPDATE products SET stock = MAX(0, stock + ?) WHERE id=?').run(delta, l.product_id);
        logMove(l.product_id, delta, 'loan_return', 'LOAN RETURN — ' + l.party_name, me.username);
        db.prepare("UPDATE loans SET status='returned', settle_mode='returned', paid_amount=amount WHERE id=?").run(l.id);
        logAct(me.username, 'loan_returned', `${l.product_name} ×${l.qty} — ${l.party_name}`);
        return send(res, 200, { ok: true, status: 'returned' });
      }
      return send(res, 400, { error: 'Choose how the loan was settled' });
    }
    if (r[1] === 'loans' && r[2] && method === 'PATCH') {
      if (!hasPerm(me, 'expenses')) return send(res, 403, { error: 'No permission' });
      const l = queries.loanById(Number(r[2]));
      if (!l) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.date_due !== undefined) db.prepare('UPDATE loans SET date_due=? WHERE id=?').run(/^\d{4}-\d{2}-\d{2}$/.test(b.date_due || '') ? b.date_due : null, l.id);
      if (b.notes !== undefined) db.prepare('UPDATE loans SET notes=? WHERE id=?').run(String(b.notes).slice(0, 500), l.id);
      return send(res, 200, { ok: true });
    }

    // ---- LIVE CHAT: staff inbox ----
    if (r[1] === 'chats' && !r[2] && method === 'GET') {
      if (!hasPerm(me, 'chat')) return send(res, 403, { error: 'No permission' });
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const status = url.searchParams.get('status') || '';
      const unreadOnly = url.searchParams.get('unread') === '1';
      let rows = db.prepare(`SELECT c.*,
          (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id=c.id AND m.sender_type='customer' AND m.read_at IS NULL) unread,
          (SELECT name FROM users u WHERE u.id=c.assigned_staff_id) assigned_name,
          (SELECT order_number FROM orders o WHERE o.id=c.order_id) order_number,
          (SELECT name_en FROM products p WHERE p.id=c.product_id) product_name
        FROM conversations c ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 300`).all();
      if (status) rows = rows.filter(c => c.status === status);
      if (unreadOnly) rows = rows.filter(c => c.unread > 0);
      if (q) rows = rows.filter(c =>
        (c.customer_name || '').toLowerCase().includes(q) || (c.customer_phone || '').includes(q.replace(/[^0-9]/g, '') || q) ||
        (c.order_number || '').toLowerCase().includes(q) || (c.product_name || '').toLowerCase().includes(q));
      return send(res, 200, { chats: rows.map(c => ({ id: c.id, name: c.customer_name, phone: c.customer_phone, status: c.status,
        source: c.source, unread: c.unread, assigned_name: c.assigned_name, assigned_staff_id: c.assigned_staff_id,
        order_number: c.order_number, product_name: c.product_name, last_message: c.last_message, last_message_at: c.last_message_at, created_at: c.created_at })),
        online: chatOnline() });
    }
    if (r[1] === 'chats' && r[2] && !r[3] && method === 'GET') {
      if (!hasPerm(me, 'chat')) return send(res, 403, { error: 'No permission' });
      const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(Number(r[2]));
      if (!c) return send(res, 404, { error: 'not found' });
      const unread = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE conversation_id=? AND sender_type='customer' AND read_at IS NULL").get(c.id).c;
      if (unread) {
        db.prepare("UPDATE chat_messages SET read_at=datetime('now') WHERE conversation_id=? AND sender_type='customer' AND read_at IS NULL").run(c.id);
        chatBroadcast(c.id, { type: 'read', by: 'staff' }, { toStaff: false });
      }
      const msgs = db.prepare('SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY id').all(c.id).map(chatMsgRow);
      // context: linked order, product, and the customer's purchase history (by phone)
      let order = null, product = null;
      if (c.order_id) { const o = db.prepare('SELECT order_number,status,total,payment_method,created_at FROM orders WHERE id=?').get(c.order_id); if (o) order = o; }
      if (c.product_id) { const p = queries.productById(c.product_id); if (p) product = { id: p.id, name: p.en.name, price: p.sale || p.price, stock: p.stock, sku: p.sku }; }
      // Match the customer's own orders by their full (digits-only) phone — not a
      // last-7-digits LIKE, which could pull in a different customer's private history.
      const convDigits = String(c.customer_phone || '').replace(/[^0-9]/g, '');
      const hist = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) spent FROM orders
        WHERE replace(replace(customer_phone,' ',''),'+','')=? AND status NOT IN ('cancelled','returned','refunded')`).get(convDigits);
      const recentOrders = db.prepare(`SELECT order_number,status,total,created_at FROM orders
        WHERE replace(replace(customer_phone,' ',''),'+','')=? ORDER BY id DESC LIMIT 5`).all(convDigits);
      const t = CHAT_TYPING.get(c.id) || {};
      return send(res, 200, { conversation: { id: c.id, name: c.customer_name, phone: c.customer_phone, email: c.customer_email,
          status: c.status, source: c.source, assigned_staff_id: c.assigned_staff_id, staff_notes: c.staff_notes, created_at: c.created_at },
        messages: msgs, order, product, history: { orders: hist.n, spent: hist.spent, recent: recentOrders },
        cust_typing: !!(t.cust && Date.now() - t.cust < 6000), online: chatOnline() });
    }
    if (r[1] === 'chats' && r[2] && r[3] === 'message' && method === 'POST') {
      if (!hasPerm(me, 'chat')) return send(res, 403, { error: 'No permission' });
      const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(Number(r[2]));
      if (!c) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      const text = String(b.text || '').trim().slice(0, 2000);
      let attach = '', attachType = '';
      if (b.attachment_data) { try { attach = saveImage(b.attachment_data) || ''; attachType = attach ? 'image' : ''; } catch (e) { return send(res, 400, { error: e.message }); } }
      if (!text && !attach) return send(res, 400, { error: 'Empty message' });
      if (c.status === 'pending') db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(c.id);
      const m = addChatMessage(c.id, 'staff', me.id, me.name || me.username, text, attach, attachType);
      return send(res, 201, { ok: true, message: chatMsgRow(m) });
    }
    if (r[1] === 'chats' && r[2] && !r[3] && method === 'PATCH') {
      if (!hasPerm(me, 'chat')) return send(res, 403, { error: 'No permission' });
      const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(Number(r[2]));
      if (!c) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.status && ['open', 'pending', 'resolved', 'closed'].includes(b.status)) {
        db.prepare("UPDATE conversations SET status=?, updated_at=datetime('now') WHERE id=?").run(b.status, c.id);
        logAct(me.username, 'chat_status', '#' + c.id + ' → ' + b.status);
        chatBroadcast(c.id, { type: 'status', status: b.status }, { toStaff: true });
      }
      if (b.assigned_staff_id !== undefined) db.prepare('UPDATE conversations SET assigned_staff_id=? WHERE id=?').run(b.assigned_staff_id ? Number(b.assigned_staff_id) : null, c.id);
      if (b.staff_notes !== undefined) db.prepare('UPDATE conversations SET staff_notes=? WHERE id=?').run(String(b.staff_notes).slice(0, 2000), c.id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'chats' && r[2] && r[3] === 'typing' && method === 'POST') {
      if (!hasPerm(me, 'chat')) return send(res, 403, { error: 'No permission' });
      const id = Number(r[2]);
      const t = CHAT_TYPING.get(id) || {}; t.staff = Date.now(); CHAT_TYPING.set(id, t);
      chatBroadcast(id, { type: 'typing', by: 'staff' }, { toStaff: false });
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'deliveries' && r[2] && method === 'PATCH') {
      if (!hasPerm(me, 'delivery')) return send(res, 403, { error: 'No permission' });
      const id = Number(r[2]); const b = await readBody(req);
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (!o) return send(res, 404, { error: 'not found' });
      // a courier may only touch orders assigned to them (owner may act on any)
      if (me.role !== 'owner' && o.courier_id !== me.id) return send(res, 403, { error: 'This delivery is not assigned to you' });
      const MAP = { pickup: 'out_for_delivery', delivered: 'delivered', failed: 'failed' };
      const next = MAP[b.action];
      if (!next) return send(res, 400, { error: 'Unknown action' });
      const paid = (next === 'delivered' && b.mark_paid) ? 'paid' : o.payment_status;
      db.prepare('UPDATE orders SET status=?, payment_status=? WHERE id=?').run(next, paid, id);
      return send(res, 200, { ok: true, status: next });
    }

    // ---- RECORD ON-SITE (SHOP) SALE — for salespeople ----
    if (r[1] === 'sales' && method === 'POST') {
      if (!requirePerm(req, res, 'sales')) return;
      const b = await readBody(req);
      if (!Array.isArray(b.items) || !b.items.length) return send(res, 400, { error: 'Add at least one product to the sale' });
      // Same pricing path as the website: sizes honoured, flash deals honoured, all read from the DB.
      const resolved = resolveSaleItems(b.items, 'gm');   // the counter in Banjul is always dalasi
      const items = resolved.items;
      const grossSubtotal = resolved.subtotal;
      if (!items.length) return send(res, 400, { error: 'No valid products in the sale' });

      // Final discount at the counter — capped for staff, unlimited for the owner.
      const disc = applyFinalDiscount(items, grossSubtotal, b, me);
      if (disc.error) return send(res, 400, { error: disc.error });
      const staffDiscount = disc.discount || 0;
      const subtotal = r2(grossSubtotal - staffDiscount);
      const discountReason = String(b.discount_reason || '').slice(0, 160);

      const orderNumber = nextOrderNumber();
      const seller = me.name || me.username;                 // the person who made the sale (shown on receipts + history)
      const payment = String(b.payment_method||'cash').slice(0,30);
      const customerName = String(b.customer_name||'Walk-in customer').slice(0,120);
      const info = db.prepare(`INSERT INTO orders
        (order_number,customer_name,customer_phone,delivery_method,payment_method,status,payment_status,subtotal,delivery_fee,total,notes,channel,staff,items_json,staff_discount,discount_reason,discounted_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          orderNumber, customerName, String(b.customer_phone||'').slice(0,40),
          'pickup', payment, 'delivered', 'paid',
          subtotal, 0, subtotal, String(b.notes||'').slice(0,300), 'onsite', seller, JSON.stringify(items),
          staffDiscount, discountReason, staffDiscount > 0 ? seller : '');
      decrementStockForItems(items, 'sale', orderNumber, me.username, 'gm');
      recordInvestorSalesForOrder(info.lastInsertRowid, orderNumber, items);   // investor profit share, at the discounted price actually charged
      if (staffDiscount > 0) logAct(me.username, 'sale_discount', `${orderNumber} −D${staffDiscount} ${discountReason}`.trim());
      const createdAt = (db.prepare('SELECT created_at FROM orders WHERE id=?').get(info.lastInsertRowid) || {}).created_at;
      return send(res, 201, { ok: true, order_number: orderNumber, total: subtotal,
        sale: { order_number: orderNumber, created_at: createdAt, staff: seller, payment_method: payment,
                customer_name: customerName, gross_subtotal: grossSubtotal, staff_discount: staffDiscount,
                discount_reason: discountReason, subtotal, total: subtotal, items } });
    }

    // ---- SALES HISTORY (in-shop sales) — visible to salespeople ----
    if (r[1] === 'sales' && method === 'GET') {
      if (!hasPerm(me, 'sales')) return send(res, 403, { error: 'No permission' });
      const unpack = rows => { rows.forEach(o => { o.items = (() => { try { return JSON.parse(o.items_json); } catch { return []; } })(); delete o.items_json; }); return rows; };
      // Counter sales: money taken at the till, so the sale date is when it was rung up.
      const rows = unpack(db.prepare("SELECT id,order_number,customer_name,payment_method,total,staff,created_at,created_at AS sold_at,items_json,staff_discount,discount_reason,discounted_by FROM orders WHERE channel='onsite' ORDER BY id DESC LIMIT 500").all());
      // Online sales: an order becomes a sale on the day it is DELIVERED, not the day it was
      // placed — until then the goods are out but the money is not in. delivered_at is used as
      // the sale date so a Monday order handed over on Wednesday lands in Wednesday's takings.
      const online = unpack(db.prepare(`SELECT id,order_number,customer_name,customer_phone,payment_method,total,created_at,
          COALESCE(NULLIF(delivered_at,''), created_at) AS sold_at, items_json, courier_name, delivery_zone
        FROM orders WHERE channel!='onsite' AND market='gm' AND status='delivered' ORDER BY COALESCE(NULLIF(delivered_at,''), created_at) DESC LIMIT 500`).all());
      // UK orders are kept in their own list: pounds and dalasi must never be added together.
      const uk = unpack(db.prepare(`SELECT id,order_number,customer_name,customer_email,postcode,payment_method,total,currency,status,created_at,
          COALESCE(NULLIF(delivered_at,''), created_at) AS sold_at, items_json
        FROM orders WHERE market='uk' ORDER BY id DESC LIMIT 500`).all());
      return send(res, 200, { sales: rows, online, uk });
    }

    // ---- EXPENSES ----
    if (r[1] === 'expenses' && method === 'GET') {
      if (!hasPerm(me, 'expenses')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { expenses: queries.allExpenses(), total: queries.totalExpenses() });
    }
    if (r[1] === 'expenses' && method === 'POST') {
      if (!requirePerm(req, res, 'expenses')) return;
      const b = await readBody(req);
      if (!(Number(b.amount) > 0)) return send(res, 400, { error: 'Enter a valid amount' });
      const info = db.prepare('INSERT INTO expenses(spent_on,category,description,amount,created_by) VALUES(?,?,?,?,?)')
        .run(b.spent_on || new Date().toISOString().slice(0,10), String(b.category||'General').slice(0,60), String(b.description||'').slice(0,200), Number(b.amount), me.username);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'expenses' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'expenses')) return;
      db.prepare('DELETE FROM expenses WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- CATEGORY MANAGEMENT (add / edit / delete, with image) ----
    if (r[1] === 'categories' && method === 'POST') {
      if (!requirePerm(req, res, 'products')) return;
      const b = await readBody(req);
      let slug = String(b.slug || b.name_en || '').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
      if (!slug) return send(res, 400, { error: 'Category needs a name' });
      if (db.prepare('SELECT id FROM categories WHERE slug=?').get(slug)) slug += '-' + Date.now().toString().slice(-4);
      let image = null;
      try { if (b.image_data) image = saveImage(b.image_data); } catch (e) { return send(res, 400, { error: e.message }); }
      const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM categories').get().n;
      const info = db.prepare('INSERT INTO categories(slug,name_en,name_ar,icon,grad,image,parent_id,sort_order,is_active) VALUES(?,?,?,?,?,?,?,?,1)')
        .run(slug, String(b.name_en||'Untitled').slice(0,60), String(b.name_ar||'').slice(0,60), b.icon||'grid',
             b.grad||'linear-gradient(135deg,#10502f,#1c7d4a)', image, b.parent_id?Number(b.parent_id):null, sort);
      return send(res, 201, { ok: true, id: info.lastInsertRowid, slug });
    }
    if (r[1] === 'categories' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'products')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      let image = cur.image;
      try { if (b.image_data) image = saveImage(b.image_data); } catch (e) { return send(res, 400, { error: e.message }); }
      db.prepare('UPDATE categories SET name_en=?,name_ar=?,icon=?,image=?,is_active=? WHERE id=?').run(
        b.name_en??cur.name_en, b.name_ar??cur.name_ar, b.icon??cur.icon, image,
        b.is_active!=null?(b.is_active?1:0):cur.is_active, id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'categories' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'products')) return;
      const cur = db.prepare('SELECT slug FROM categories WHERE id=?').get(Number(r[2]));
      if (cur) {
        const used = db.prepare('SELECT COUNT(*) c FROM products WHERE category_slug=?').get(cur.slug).c;
        if (used > 0) return send(res, 400, { error: `Move or delete the ${used} product(s) in this category first` });
      }
      db.prepare('DELETE FROM categories WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- SUPPLIERS (gated under the 'products' permission) ----
    if (r[1] === 'suppliers' && method === 'GET') {
      if (!hasPerm(me, 'products')) return send(res, 403, { error: 'No permission' });
      const bal = queries.supplierBalances();
      const sup = queries.allSuppliers().map(x => ({ ...x, ...(bal[x.id] || { purchased: 0, paid: 0, balance: 0 }) }));
      return send(res, 200, { suppliers: sup });
    }
    if (r[1] === 'suppliers' && method === 'POST') {
      if (!requirePerm(req, res, 'products')) return;
      const b = await readBody(req);
      if (!String(b.name||'').trim()) return send(res, 400, { error: 'Supplier needs a name' });
      const info = db.prepare('INSERT INTO suppliers(name,phone,email,address,notes,is_active) VALUES(?,?,?,?,?,?)')
        .run(String(b.name).slice(0,120), String(b.phone||'').slice(0,40), String(b.email||'').slice(0,120),
             String(b.address||'').slice(0,200), String(b.notes||'').slice(0,400), b.is_active===false?0:1);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'suppliers' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'products')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      db.prepare('UPDATE suppliers SET name=?,phone=?,email=?,address=?,notes=?,is_active=? WHERE id=?').run(
        b.name??cur.name, b.phone??cur.phone, b.email??cur.email, b.address??cur.address, b.notes??cur.notes,
        b.is_active!=null?(b.is_active?1:0):cur.is_active, id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'suppliers' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'products')) return;
      const id = Number(r[2]);
      const used = db.prepare('SELECT COUNT(*) c FROM products WHERE supplier_id=?').get(id).c;
      if (used > 0) return send(res, 400, { error: `${used} product(s) use this supplier — reassign them first` });
      db.prepare('DELETE FROM suppliers WHERE id=?').run(id);
      return send(res, 200, { ok: true });
    }

    // ---- NEWSLETTER SUBSCRIBERS (gated under 'settings') ----
    if (r[1] === 'newsletter' && method === 'GET') {
      if (!hasPerm(me, 'settings')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { subscribers: queries.allSubscribers() });
    }
    if (r[1] === 'newsletter' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'settings')) return;
      db.prepare('DELETE FROM newsletter WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- DELIVERY ZONES (gated under 'settings') ----
    if (r[1] === 'zones' && method === 'GET') {
      if (!hasPerm(me, 'settings')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { zones: queries.allZones() });
    }
    if (r[1] === 'zones' && method === 'POST') {
      if (!requirePerm(req, res, 'settings')) return;
      const b = await readBody(req);
      if (!String(b.name_en||'').trim()) return send(res, 400, { error: 'Zone needs a name' });
      const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM delivery_zones').get().n;
      const info = db.prepare('INSERT INTO delivery_zones(name_en,name_ar,fee,sort_order,is_active) VALUES(?,?,?,?,?)')
        .run(String(b.name_en).slice(0,80), String(b.name_ar||'').slice(0,80), Number(b.fee)||0, sort, b.is_active===false?0:1);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'zones' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'settings')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM delivery_zones WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      db.prepare('UPDATE delivery_zones SET name_en=?,name_ar=?,fee=?,is_active=? WHERE id=?').run(
        b.name_en??cur.name_en, b.name_ar??cur.name_ar, b.fee!=null?Number(b.fee):cur.fee,
        b.is_active!=null?(b.is_active?1:0):cur.is_active, id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'zones' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'settings')) return;
      db.prepare('DELETE FROM delivery_zones WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- DASHBOARD (redesigned overview; financial fields gated by 'profit') ----
    if (r[1] === 'dashboard' && method === 'GET') {
      const d = queries.dashboard();
      if (!hasPerm(me, 'profit')) { d.profitMonth = null; d.expMonth = null; }
      d.canSeeProfit = hasPerm(me, 'profit');
      return send(res, 200, d);
    }

    // ---- REPORTS (gated by 'profit') ----
    if (r[1] === 'reports' && method === 'GET') {
      if (!hasPerm(me, 'profit')) return send(res, 403, { error: 'No permission' });
      const type = url.searchParams.get('type') || 'sales';
      const rep = queries.report(type, url.searchParams.get('from'), url.searchParams.get('to'));
      if (!rep) return send(res, 400, { error: 'Unknown report type' });
      return send(res, 200, rep);
    }

    // ---- ACTIVITY LOG (gated by 'users') ----
    if (r[1] === 'activity' && method === 'GET') {
      if (!hasPerm(me, 'users')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { activity: queries.activityLog(Number(url.searchParams.get('limit')) || 100) });
    }

    // ---- INVENTORY: stock ledger + adjustments (products perm) ----
    if (r[1] === 'stock-moves' && method === 'GET') {
      if (!hasPerm(me, 'products')) return send(res, 403, { error: 'No permission' });
      const pid = url.searchParams.get('product');
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 150);
      return send(res, 200, { moves: queries.stockMoves(pid ? Number(pid) : null, limit) });
    }
    if (r[1] === 'adjust' && method === 'POST') {
      if (!requirePerm(req, res, 'products')) return;
      const b = await readBody(req);
      const p = db.prepare('SELECT id,stock,name_en FROM products WHERE id=?').get(Number(b.product_id));
      if (!p) return send(res, 404, { error: 'Product not found' });
      const REASONS = ['adjustment', 'damaged', 'expired', 'count', 'return'];
      const reason = REASONS.includes(b.reason) ? b.reason : 'adjustment';
      let delta;
      if (b.mode === 'set') delta = Math.max(0, Number(b.qty) || 0) - p.stock;   // recount to an absolute level
      else delta = Number(b.qty) || 0;                                            // +/- change
      if (!delta) return send(res, 400, { error: 'No stock change' });
      const newStock = Math.max(0, p.stock + delta);
      db.prepare('UPDATE products SET stock=?, updated_at=datetime(\'now\') WHERE id=?').run(newStock, p.id);
      logMove(p.id, newStock - p.stock, reason, String(b.note || '').slice(0, 160), me.username);
      logAct(me.username, 'stock_adjust', p.name_en + ' ' + (newStock - p.stock) + ' (' + reason + ')');
      return send(res, 200, { ok: true, stock: newStock });
    }
    if (r[1] === 'inventory-report' && method === 'GET') {
      if (!hasPerm(me, 'products')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, queries.inventoryReport());
    }

    // ---- PURCHASE ORDERS (products perm) ----
    if (r[1] === 'purchases' && method === 'GET') {
      if (!hasPerm(me, 'products')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { purchases: queries.allPOs() });
    }
    if (r[1] === 'purchases' && method === 'POST') {
      if (!requirePerm(req, res, 'products')) return;
      const b = await readBody(req);
      const lines = (Array.isArray(b.items) ? b.items : []).map(it => ({
        product: db.prepare('SELECT id,name_en FROM products WHERE id=?').get(Number(it.product_id)),
        qty: Math.max(1, Number(it.qty) || 1), cost: Math.max(0, Number(it.unit_cost) || 0),
      })).filter(l => l.product);
      if (!lines.length) return send(res, 400, { error: 'Add at least one product line' });
      let sup = null;
      if (b.supplier_id) sup = db.prepare('SELECT id,name FROM suppliers WHERE id=?').get(Number(b.supplier_id));
      const total = lines.reduce((sum, l) => sum + l.qty * l.cost, 0);
      const poNumber = nextPoNumber();
      const info = db.prepare(`INSERT INTO purchase_orders
        (po_number,supplier_id,supplier_name,status,expected_date,shipment_ref,notes,total_cost,created_by)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        poNumber, sup ? sup.id : null, sup ? sup.name : '', 'ordered',
        String(b.expected_date || '').slice(0, 20), String(b.shipment_ref || '').slice(0, 120),
        String(b.notes || '').slice(0, 400), total, me.username);
      const ins = db.prepare('INSERT INTO po_items(po_id,product_id,product_name,qty_ordered,unit_cost) VALUES(?,?,?,?,?)');
      lines.forEach(l => ins.run(info.lastInsertRowid, l.product.id, l.product.name_en, l.qty, l.cost));
      logAct(me.username, 'po_create', poNumber + ' · ' + money0(total));
      return send(res, 201, { ok: true, id: info.lastInsertRowid, po_number: poNumber });
    }
    if (r[1] === 'purchases' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'products')) return;
      const po = queries.poById(Number(r[2]));
      if (!po) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.action === 'cancel') {
        if (po.items.some(i => i.qty_received > 0)) return send(res, 400, { error: 'Goods already received — cannot cancel' });
        db.prepare("UPDATE purchase_orders SET status='cancelled' WHERE id=?").run(po.id);
        return send(res, 200, { ok: true });
      }
      if (b.action === 'receive') {
        if (po.status === 'cancelled') return send(res, 400, { error: 'This purchase order was cancelled' });
        const recv = Array.isArray(b.items) ? b.items : [];
        let any = false;
        for (const rIt of recv) {
          const line = po.items.find(i => i.id === Number(rIt.item_id));
          if (!line) continue;
          const qty = Math.max(0, Math.min(Number(rIt.qty) || 0, line.qty_ordered - line.qty_received));
          if (!qty) continue;
          any = true;
          db.prepare('UPDATE po_items SET qty_received = qty_received + ? WHERE id=?').run(qty, line.id);
          // goods in: add stock + refresh the product's cost to the latest purchase price
          db.prepare("UPDATE products SET stock = stock + ?, cost = ?, updated_at=datetime('now') WHERE id=?").run(qty, line.unit_cost, line.product_id);
          logMove(line.product_id, qty, 'purchase', po.po_number, me.username);
        }
        if (!any) return send(res, 400, { error: 'Enter a received quantity' });
        const fresh = queries.poById(po.id);
        const done = fresh.items.every(i => i.qty_received >= i.qty_ordered);
        db.prepare("UPDATE purchase_orders SET status=?, received_at=CASE WHEN ? THEN datetime('now') ELSE received_at END WHERE id=?")
          .run(done ? 'received' : 'partial', done ? 1 : 0, po.id);
        logAct(me.username, 'po_receive', po.po_number + (done ? ' (complete)' : ' (partial)'));
        return send(res, 200, { ok: true, status: done ? 'received' : 'partial' });
      }
      return send(res, 400, { error: 'Unknown action' });
    }
    if (r[1] === 'purchases' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'products')) return;
      const po = queries.poById(Number(r[2]));
      if (!po) return send(res, 404, { error: 'not found' });
      if (po.items.some(i => i.qty_received > 0)) return send(res, 400, { error: 'Goods already received — cancel instead' });
      db.prepare('DELETE FROM po_items WHERE po_id=?').run(po.id);
      db.prepare('DELETE FROM purchase_orders WHERE id=?').run(po.id);
      return send(res, 200, { ok: true });
    }

    // ---- SUPPLIER PAYMENTS & BALANCES (products perm) ----
    if (r[1] === 'supplier-payments' && method === 'GET') {
      if (!hasPerm(me, 'products')) return send(res, 403, { error: 'No permission' });
      const sid = url.searchParams.get('supplier');
      return send(res, 200, { payments: queries.supplierPayments(sid ? Number(sid) : null) });
    }
    if (r[1] === 'supplier-payments' && method === 'POST') {
      if (!requirePerm(req, res, 'products')) return;
      const b = await readBody(req);
      if (!b.supplier_id || !(Number(b.amount) > 0)) return send(res, 400, { error: 'Choose a supplier and enter a valid amount' });
      const info = db.prepare('INSERT INTO supplier_payments(supplier_id,po_id,amount,method,note,paid_on,created_by) VALUES(?,?,?,?,?,?,?)')
        .run(Number(b.supplier_id), b.po_id ? Number(b.po_id) : null, Number(b.amount),
             String(b.method || 'cash').slice(0, 30), String(b.note || '').slice(0, 200),
             b.paid_on || new Date().toISOString().slice(0, 10), me.username);
      logAct(me.username, 'supplier_payment', money0(Number(b.amount)));
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'supplier-payments' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'products')) return;
      db.prepare('DELETE FROM supplier_payments WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- CUSTOMERS (CRM — gated by 'orders') ----
    if (r[1] === 'customers' && method === 'GET') {
      if (!hasPerm(me, 'orders')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { customers: queries.allCustomers() });
    }
    if (r[1] === 'customers' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'orders')) return;
      const c = queries.customerById(Number(r[2]));
      if (!c) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.notes != null) db.prepare('UPDATE customers SET notes=? WHERE id=?').run(String(b.notes).slice(0, 500), c.id);
      if (b.is_active != null) db.prepare('UPDATE customers SET is_active=? WHERE id=?').run(b.is_active ? 1 : 0, c.id);
      if (b.points_delta) {
        const d = Math.trunc(Number(b.points_delta) || 0);
        db.prepare('UPDATE customers SET points = MAX(0, points + ?) WHERE id=?').run(d, c.id);
        logAct(me.username, 'points_adjust', c.name + ' ' + (d > 0 ? '+' : '') + d);
      }
      if (b.new_password) {
        if (String(b.new_password).length < 4) return send(res, 400, { error: 'Password must be at least 4 characters' });
        db.prepare('UPDATE customers SET pass_hash=? WHERE id=?').run(hashPassword(String(b.new_password)), c.id);
        db.prepare('DELETE FROM customer_sessions WHERE customer_id=?').run(c.id);   // sign out any old sessions
        logAct(me.username, 'customer_password_reset', c.name + ' (' + c.phone + ')');
      }
      return send(res, 200, { ok: true });
    }

    // ---- COUPONS (gated by 'settings') ----
    if (r[1] === 'coupons' && method === 'GET') {
      if (!hasPerm(me, 'settings')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { coupons: queries.allCoupons() });
    }
    if (r[1] === 'coupons' && method === 'POST') {
      if (!requirePerm(req, res, 'settings')) return;
      const b = await readBody(req);
      const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!code || !(Number(b.value) > 0)) return send(res, 400, { error: 'Enter a code and a value' });
      if (queries.couponByCode(code)) return send(res, 400, { error: 'That code already exists' });
      const kind = b.kind === 'fixed' ? 'fixed' : 'percent';
      if (kind === 'percent' && Number(b.value) > 90) return send(res, 400, { error: 'Percent discount cannot exceed 90%' });
      const info = db.prepare('INSERT INTO coupons(code,kind,value,min_subtotal,max_uses,expires,is_active) VALUES(?,?,?,?,?,?,1)')
        .run(code.slice(0, 30), kind, Number(b.value), Number(b.min_subtotal) || 0, Math.max(0, Number(b.max_uses) || 0), String(b.expires || '').slice(0, 10));
      logAct(me.username, 'coupon_add', code);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'coupons' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'settings')) return;
      const cur = db.prepare('SELECT * FROM coupons WHERE id=?').get(Number(r[2]));
      if (!cur) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      db.prepare('UPDATE coupons SET is_active=? WHERE id=?').run(b.is_active != null ? (b.is_active ? 1 : 0) : cur.is_active, cur.id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'coupons' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'settings')) return;
      db.prepare('DELETE FROM coupons WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- BANNERS (gated by 'settings') ----
    if (r[1] === 'banners' && method === 'GET') {
      if (!hasPerm(me, 'settings')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { banners: queries.allBanners() });
    }
    if (r[1] === 'banners' && method === 'POST') {
      if (!requirePerm(req, res, 'settings')) return;
      const b = await readBody(req);
      let image = null;
      try { if (b.image_data) image = saveImage(b.image_data); } catch (e) { return send(res, 400, { error: e.message }); }
      if (!image) return send(res, 400, { error: 'Upload a banner image' });
      const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM banners').get().n;
      const info = db.prepare('INSERT INTO banners(image,title_en,title_ar,link,sort_order,is_active) VALUES(?,?,?,?,?,1)')
        .run(image, String(b.title_en || '').slice(0, 120), String(b.title_ar || '').slice(0, 120), String(b.link || '').slice(0, 200), sort);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'banners' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'settings')) return;
      const cur = db.prepare('SELECT * FROM banners WHERE id=?').get(Number(r[2]));
      if (!cur) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      db.prepare('UPDATE banners SET title_en=?,title_ar=?,link=?,is_active=? WHERE id=?').run(
        b.title_en ?? cur.title_en, b.title_ar ?? cur.title_ar, b.link ?? cur.link,
        b.is_active != null ? (b.is_active ? 1 : 0) : cur.is_active, cur.id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'banners' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'settings')) return;
      db.prepare('DELETE FROM banners WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- FAQ MANAGEMENT ----
    if (r[1] === 'faqs' && method === 'GET') return send(res, 200, { faqs: queries.allFaqs() });
    if (r[1] === 'faqs' && method === 'POST') {
      if (!requirePerm(req, res, 'faqs')) return;
      const b = await readBody(req);
      if (!b.q_en || !b.a_en) return send(res, 400, { error: 'Question and answer are required' });
      const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM faqs').get().n;
      const info = db.prepare('INSERT INTO faqs(q_en,a_en,q_ar,a_ar,sort_order,is_active) VALUES(?,?,?,?,?,?)')
        .run(b.q_en, b.a_en, b.q_ar||'', b.a_ar||'', b.sort_order!=null?Number(b.sort_order):sort, b.is_active===false?0:1);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'faqs' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'faqs')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM faqs WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      db.prepare('UPDATE faqs SET q_en=?,a_en=?,q_ar=?,a_ar=?,is_active=? WHERE id=?').run(
        b.q_en??cur.q_en, b.a_en??cur.a_en, b.q_ar??cur.q_ar, b.a_ar??cur.a_ar,
        b.is_active!=null?(b.is_active?1:0):cur.is_active, id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'faqs' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'faqs')) return;
      db.prepare('DELETE FROM faqs WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- REVIEWS MODERATION ----
    if (r[1] === 'reviews' && method === 'GET') {
      if (!hasPerm(me, 'reviews')) return send(res, 403, { error: 'No permission' });
      return send(res, 200, { reviews: queries.allReviews() });
    }
    if (r[1] === 'reviews' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'reviews')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const status = ['pending','approved','rejected'].includes(b.status) ? b.status : 'pending';
      db.prepare('UPDATE reviews SET status=? WHERE id=?').run(status, id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'reviews' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'reviews')) return;
      db.prepare('DELETE FROM reviews WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- USER MANAGEMENT ----
    if (r[1] === 'users' && method === 'GET') {
      if (!hasPerm(me, 'users')) return send(res, 403, { error: 'No permission' });
      const users = queries.allUsers().map(u => ({ ...u, permissions: (()=>{try{return JSON.parse(u.permissions||'[]')}catch{return[]}})() }));
      return send(res, 200, { users });
    }
    if (r[1] === 'users' && method === 'POST') {
      if (!requirePerm(req, res, 'users')) return;
      const b = await readBody(req);
      const username = String(b.username||'').trim().toLowerCase();
      if (!username || !b.password) return send(res, 400, { error: 'Username and password are required' });
      if (db.prepare('SELECT id FROM users WHERE lower(username)=?').get(username)) return send(res, 400, { error: 'That username already exists' });
      const perms = Array.isArray(b.permissions) ? b.permissions.filter(p => ALL_PERMS.includes(p)) : [];
      const info = db.prepare('INSERT INTO users(username,name,pass_hash,role,permissions,is_active) VALUES(?,?,?,?,?,?)')
        .run(username, String(b.name||'').slice(0,80), hashPassword(b.password), b.role||'staff', JSON.stringify(perms), b.is_active===false?0:1);
      logAct(me.username, 'user_add', username + ' (' + (b.role || 'staff') + ')');
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'users' && r[2] && method === 'PATCH') {
      if (!requirePerm(req, res, 'users')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      if (cur.role === 'owner' && (b.is_active === false)) return send(res, 400, { error: 'The owner account cannot be disabled' });
      const perms = Array.isArray(b.permissions) ? b.permissions.filter(p => ALL_PERMS.includes(p)) : null;
      db.prepare('UPDATE users SET name=?,role=?,permissions=?,is_active=? WHERE id=?').run(
        b.name??cur.name, cur.role==='owner'?'owner':(b.role??cur.role),
        cur.role==='owner'?JSON.stringify(ALL_PERMS):(perms!=null?JSON.stringify(perms):cur.permissions),
        b.is_active!=null?(b.is_active?1:0):cur.is_active, id);
      if (b.password) db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(b.password), id);
      return send(res, 200, { ok: true });
    }
    if (r[1] === 'users' && r[2] && method === 'DELETE') {
      if (!requirePerm(req, res, 'users')) return;
      const cur = db.prepare('SELECT role FROM users WHERE id=?').get(Number(r[2]));
      if (cur && cur.role === 'owner') return send(res, 400, { error: 'The owner account cannot be deleted' });
      db.prepare('DELETE FROM users WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // ---- SETTINGS ----
    const SETTING_KEYS = ['whatsapp_number','store_name','free_delivery_over','delivery_fee','low_stock_threshold','max_staff_discount_pct',
      'announce_en','announce_ar','contact_address_en','contact_address_ar','contact_hours_en','contact_hours_ar',
      'pay_account_name','pay_wave_number','pay_afri_number','pay_qmoney_number','pay_bank_name','pay_bank_account','pay_note_en','pay_note_ar',
      'est_delivery_en','est_delivery_ar','loyalty_earn_per','loyalty_point_value','loyalty_max_redeem_pct','referral_bonus_points',
      'chat_online','chat_welcome_en','chat_welcome_ar','chat_offline_en','chat_offline_ar','chat_upload','chat_hours',
      'meta_pixel_id','catalog_currency','site_url',
      'uk_enabled','uk_delivery_fee','uk_free_over','uk_business_name','uk_business_address','uk_returns_address',
      'uk_vat_number','uk_bank_account_name','uk_bank_name','uk_sort_code','uk_account_number','uk_paypal_link',
      'uk_dispatch_note','uk_returns_policy'];
    if (r[1] === 'settings' && method === 'GET') {
      const out = {}; SETTING_KEYS.forEach(k => out[k] = getSetting(k)); return send(res, 200, out);
    }
    if (r[1] === 'settings' && method === 'POST') {
      if (!requirePerm(req, res, 'settings')) return;
      const b = await readBody(req);
      SETTING_KEYS.forEach(k => { if (b[k] !== undefined) setSetting(k, b[k]); });
      logAct(me.username, 'settings_update', Object.keys(b).filter(k => k !== 'admin_password').slice(0, 6).join(', '));
      if (b.admin_password) {  // owner password also updates the owner user login
        setSetting('admin_password', b.admin_password);
        db.prepare("UPDATE users SET pass_hash=? WHERE role='owner'").run(hashPassword(b.admin_password));
      }
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'Not found' });
}
function splitLines(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v||'').split('\n').map(s => s.trim()).filter(Boolean);
}

/* ---------- share previews (Open Graph) ----------
   Facebook, WhatsApp, Instagram and the rest never receive the "#..." part of a link and do not
   run the page's JavaScript — they read the raw HTML the server sends and nothing else. So the
   social tags are filled in here, before the page goes out: the shop's own cover for the home
   page, and the product's real photo, name and price for a /p/<id> link. Nothing here exposes
   cost, wholesale or any other private field — only what a shopper already sees on the page. */
const SHELL_PATH = path.join(PUBLIC_DIR, 'index.html');
let SHELL_CACHE = { mtime: -1, html: '' };
function shellHtml() {
  const st = fs.statSync(SHELL_PATH);
  if (st.mtimeMs !== SHELL_CACHE.mtime) SHELL_CACHE = { mtime: st.mtimeMs, html: fs.readFileSync(SHELL_PATH, 'utf8') };
  return SHELL_CACHE.html;
}
// The public address of this site. A `site_url` setting wins; otherwise it is read off the
// request, which is what works on Render behind its proxy without configuring anything.
function siteBase(req) {
  const configured = String(getSetting('site_url', '') || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function absUrl(base, u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return base + (String(u).startsWith('/') ? u : '/' + u);
}
function plain(s, max) {
  const out = String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '…' : out;
}
const SHOP_TAGLINE = 'Herbs, Islamic essentials, perfumes, premium dates, clothing, electronics and household goods. Nationwide delivery in The Gambia — order on WhatsApp.';

function homeSocial(base) {
  const shop = getSetting('store_name', 'Jeddah Trading') || 'Jeddah Trading';
  const title = `${shop} — Quality Goods for Every Home | The Gambia`;
  const img = absUrl(base, '/og-cover.jpg');
  return `
<meta name="description" content="${esc(SHOP_TAGLINE)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(shop)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(SHOP_TAGLINE)}" />
<meta property="og:url" content="${esc(base + '/')}" />
<meta property="og:image" content="${esc(img)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${esc(shop)} — quality goods, nationwide delivery in The Gambia" />
<meta property="og:locale" content="en_GM" />
<meta property="og:locale:alternate" content="ar_AR" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="canonical" href="${esc(base + '/')}" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Store","name":${JSON.stringify(shop)},
 "description":"Herbs, Islamic products, perfumes, dates, clothing, electronics and general goods.",
 "address":{"@type":"PostalAddress","addressLocality":"Serrekunda","addressRegion":"Kanifing","addressCountry":"GM"},
 "telephone":"+2207093900","currenciesAccepted":"GMD","image":${JSON.stringify(img)},
 "paymentAccepted":"Cash, Mobile Money, Bank Transfer","priceRange":"D"}
</script>
<title>${esc(title)}</title>`;
}

function productSocial(p, base) {
  const shop = getSetting('store_name', 'Jeddah Trading') || 'Jeddah Trading';
  const name = p.en.name || shop;
  const low = p.hasSizes ? p.priceFrom : (p.sale || p.price);
  const high = p.hasSizes ? p.priceTo : low;
  const money = n => 'D' + Number(n || 0).toLocaleString('en-US');
  const priceLabel = (p.hasSizes && high > low) ? `${money(low)} – ${money(high)}` : money(low);
  const title = `${name} — ${priceLabel} | ${shop}`;
  const sizes = p.hasSizes ? p.variants.filter(v => v.active).map(v => v.label_en).filter(Boolean) : [];
  const desc = plain(p.en.desc, 180) ||
    `${name} from ${shop}${sizes.length ? ' — available in ' + sizes.join(', ') : ''}. Nationwide delivery in The Gambia.`;
  const photo = p.image || (Array.isArray(p.images) && p.images[0]) || '';
  const img = photo ? absUrl(base, photo) : absUrl(base, '/og-cover.jpg');
  const url = `${base}/p/${p.id}`;
  const inStock = Number(p.stock) > 0;
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product',
    name, description: desc, image: img, sku: String(p.id),
    brand: { '@type': 'Brand', name: p.brand || shop },
    offers: {
      '@type': 'Offer', url, price: Number(low || 0).toFixed(2), priceCurrency: 'GMD',
      availability: 'https://schema.org/' + (inStock ? 'InStock' : 'OutOfStock'),
      seller: { '@type': 'Organization', name: shop },
    },
  };
  return `
<meta name="description" content="${esc(desc)}" />
<meta property="og:type" content="product" />
<meta property="og:site_name" content="${esc(shop)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:image" content="${esc(img)}" />
<meta property="og:image:alt" content="${esc(name)}" />
<meta property="og:locale" content="en_GM" />
<meta property="og:locale:alternate" content="ar_AR" />
<meta property="product:price:amount" content="${esc(Number(low || 0).toFixed(2))}" />
<meta property="product:price:currency" content="GMD" />
<meta property="product:availability" content="${inStock ? 'in stock' : 'out of stock'}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="canonical" href="${esc(url)}" />
<script type="application/ld+json">
${JSON.stringify(ld)}
</script>
<title>${esc(title)}</title>`;
}

// Serves the storefront with its social tags rewritten. `p` null → the home-page tags.
function serveShell(req, res, p) {
  let html;
  try { html = shellHtml(); } catch { return serveStatic(res, PUBLIC_DIR, 'index.html'); }
  const base = siteBase(req);
  const block = p ? productSocial(p, base) : homeSocial(base);
  // A function replacement, so a "$" in a product name is never read as a capture reference.
  const out = /<!--SOCIAL-->[\s\S]*?<!--\/SOCIAL-->/.test(html)
    ? html.replace(/<!--SOCIAL-->[\s\S]*?<!--\/SOCIAL-->/, () => '<!--SOCIAL-->' + block + '\n<!--/SOCIAL-->')
    : html;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(out);
}

/* ---------- product catalog feed ----------
   This is the file Facebook and Instagram read to build catalogue adverts — the carousels that
   show a real product, its real photo and its real price, and follow a shopper who looked at it.
   Meta re-fetches the URL on a schedule, so prices and stock stay right by themselves; nothing
   has to be uploaded by hand. The same format is what Google Merchant Center reads.

   One row per thing a customer can actually buy: a product sold in sizes contributes one row per
   size, each with its own price and stock, tied together by item_group_id so Meta knows they are
   one product. Only public information goes in — never cost or wholesale price. */
const FEED_AVAILABLE = 'in stock', FEED_GONE = 'out of stock';
function feedCurrency() {
  return String(getSetting('catalog_currency', 'GMD') || 'GMD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'GMD';
}
function feedRows(base) {
  const shop = getSetting('store_name', 'Jeddah Trading') || 'Jeddah Trading';
  const cur = feedCurrency();
  const amount = n => Number(n || 0).toFixed(2) + ' ' + cur;
  const catName = {};
  try { for (const c of queries.activeCategories()) catName[c.slug] = c.en; } catch {}
  const rows = [];
  for (const p of queries.activeProducts()) {
    const photo = p.image || (Array.isArray(p.images) && p.images[0]) || '';
    const common = {
      description: plain(p.en.desc, 600) || `${p.en.name} from ${shop}. Nationwide delivery in The Gambia.`,
      condition: 'new',
      brand: (p.brand || shop).slice(0, 70),
      image_link: photo ? absUrl(base, photo) : absUrl(base, '/og-cover.jpg'),
      additional_image_link: (Array.isArray(p.images) ? p.images.slice(1, 11) : []).map(u => absUrl(base, u)).join(','),
      product_type: catName[p.cat] || p.cat || '',
    };
    const live = Array.isArray(p.variants) ? p.variants.filter(v => v.active) : [];
    if (p.hasSizes && live.length) {
      for (const v of live) {
        const label = (v.label_en || '').trim();
        rows.push({ ...common,
          id: `jt-${p.id}-${v.id}`,
          item_group_id: `jt-${p.id}`,
          title: plain(label ? `${p.en.name} — ${label}` : p.en.name, 190),
          availability: v.stock > 0 ? FEED_AVAILABLE : FEED_GONE,
          price: amount(v.price),
          sale_price: v.sale ? amount(v.sale) : '',
          inventory: Math.max(0, Number(v.stock) || 0),
          // The size the advert showed is the size that is already chosen when they arrive.
          link: `${base}/p/${p.id}?size=${v.id}`,
        });
      }
    } else {
      rows.push({ ...common,
        id: `jt-${p.id}`,
        item_group_id: '',
        title: plain(p.en.name, 190),
        availability: Number(p.stock) > 0 ? FEED_AVAILABLE : FEED_GONE,
        price: amount(p.price),
        sale_price: p.sale ? amount(p.sale) : '',
        inventory: Math.max(0, Number(p.stock) || 0),
        link: `${base}/p/${p.id}`,
      });
    }
  }
  return rows;
}
const FEED_COLUMNS = ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price',
  'link', 'image_link', 'additional_image_link', 'brand', 'item_group_id', 'product_type', 'inventory'];
function csvCell(v) {
  return '"' + String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/"/g, '""') + '"';
}
function feedCsv(base) {
  const lines = [FEED_COLUMNS.join(',')];
  for (const row of feedRows(base)) lines.push(FEED_COLUMNS.map(c => csvCell(row[c])).join(','));
  return lines.join('\n') + '\n';
}
function xmlText(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function feedXml(base) {
  const shop = getSetting('store_name', 'Jeddah Trading') || 'Jeddah Trading';
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">', '<channel>',
    `<title>${xmlText(shop)}</title>`, `<link>${xmlText(base + '/')}</link>`,
    `<description>${xmlText(shop + ' product catalogue')}</description>`];
  for (const row of feedRows(base)) {
    out.push('<item>');
    for (const c of FEED_COLUMNS) {
      if (row[c] === '' || row[c] == null) continue;
      out.push(`<g:${c}>${xmlText(row[c])}</g:${c}>`);
    }
    out.push('</item>');
  }
  out.push('</channel>', '</rss>');
  return out.join('\n') + '\n';
}

/* ---------- static files ---------- */
function serveStatic(res, baseDir, relPath, method) {
  let fp = path.join(baseDir, relPath);
  if (!fp.startsWith(baseDir)) return send(res, 403, { error: 'forbidden' });
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const ext = path.extname(fp).toLowerCase();
  // Content-Length lets a browser show real progress, and lets the admin panel ask how big a
  // photo is with a HEAD request instead of downloading the whole thing to find out.
  const size = fs.statSync(fp).size;
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-cache',
  });
  if (String(method || '').toUpperCase() === 'HEAD') return res.end();
  fs.createReadStream(fp).pipe(res);
}

/* ---------- the home-screen app's icons, built in ----------
   These same files also sit in public/icons, and a copy on disk always wins. They are kept
   here as well because the shop is deployed by uploading folders by hand: leave the icons
   folder out once and every phone quietly stops offering to install the app, with nothing
   broken on the site to show why. Flat two-colour PNGs, a few kilobytes each.
   Regenerate with the project's icon script; do not hand-edit. */
const APP_ICONS = {
  'icon-192.png':
    'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAADAFBMVEX////c5N+4ycCVrqBxkoBOd2AqXEEHQSEAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEPC45AAAItElEQVR42u1d' +
    'iY6cMAwdn+H/v7gMA7MQctgQYKiI1KrqsuAXPx8xiXm9nvGMZzzjGT87UIIQ3FZ8kBDoztMfgsK95Q8f+RFvCUBDN/JH+I7y01cB' +
    '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',
  'icon-512.png':
    'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAADAFBMVEX////c5N+4ycCVrqBxkoBOd2AqXEEHQSEAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEPC45AAAeoUlEQVR42u1d' +
    '6YLsKqstEI3v/8RdqaErg0k04gzfn3v2vru7ShawQMDHQ0RERERERERERERERERERERERERERERERERERERERERERERERERERKRx' +
    'ASStzTQZrUBOYzjtKz1N1trJkELR/3Dqp6fynwAwJLofVP3TLITzfwkGBhM0L+1PBuUsRhR6q3/SYvlDun/99v4TPf9vOY7x9G8+' +
    '+tdyFkPK1/53/h+kFjBE/P/o3+y0jZMAoH9RH/1P6ICGkvPpngB81G+1ixsYOaDuCcB06ADQ+aciXQkeOgB4YYPkiMZwAI5oD25m' +
    'KNKjA5gcfF8dRAaRnlLAfQQAUopmed8OGPqIIKHHFMB8HcAv1oO29tUUsBIrsaDvCKB2vn8hRshgp/JfBFqHepw29j9JQahTCmDd' +
    'HPD/evDt/oUJdpsE2qMkgJYRQMJ/txzwEAALbIj+B0gC9gAw4gCGAsA2ysMiBAgDGAAAa5oP71TQvrIBKyngAADYKlm/yoNIc0FI' +
    'OsX6zQL+AaB30LAvr4AzTxQS0G0dYDpggfj0Ce8/mQdGpAzUq6ijWh8tmB8YiQG9Ci6qPauJgFU7MEgaMAALFD8/OgmQes/gMeDp' +
    'AgQC44mRit/geYCVIDA4DVwgQNK9EVnAAgBza6h4geESgWXzz9GCCIHFELWAk+4/lM1R/SJg3f+tXcmAkhRhjGLAqwlga+yAxor+' +
    'u0aA2UBAK/xpXxlpCx6MB7zo4HsgTJvJWtkd1z8C9HQssjtuBFHGutVv5JpwECfwXhU8XTBCkY4h8FoW/lO+fVq/qH80DDxp38wI' +
    'jZlXxsuBDAmCt8hBiMgVgIiIiMh4NQFx/WNHfin9ji0oK4EGjwAyED62kJXu0KHFSIP42BxQ9gIOTgFkS/zYMi+IkxgwchXAvT1e' +
    'ZKAIICRg5CRQxgSHzwFkVnz4CCB5wLg5gCwLkAggMWBgCmhlW4QUAcQFjEsB7WpdiMjADkCqgQPngJIJDiqbKXFxAUM7AEkEuozy' +
    '6MsArhIBcQ+tqR5QkTkL7LSdDrfmrGIwT4/KCGErmn/P/J6O++N+OcTZDvn3jlGjFzAQNFTo8Wer/38MXJ8FAO1aEXKmU/qsEbDT' +
    'yxnIadenfL2M6oYwhAF6VINQ/3ZJvHyBRIR6lE9L5T9tVF8M/MHBhqjz1qAnBFZ7ZcQV1CC4XvUyu/7rcU99tCPq4l/Oe2XWu4We' +
    'IABhBMVM/x3zA7V/EAA8iwEvDGy3DIojKGT6drXjy0/7zgzAMwj8MLBZL2YEA7lt36x9sb2ifWcloCn4KZn59wsGyml/t+oz5PQ3' +
    '/3ijSt/usCfzNOtYMJNPwUAJ7U9B567sJvVb/0HAnYCDDogfSJ7w7Za8Bu53xH3xZ42ooH0B+88TEItE7gT+7a73QIPb6P+lbfQv' +
    'CXu5Aftho+IKeFn/fr1vuK1tK0DvC6DtxRCGfrL97mlxA/yRP9L3vxMAp6p3eQHe8E0OZiJ6Y/T9UcTv+3O2FUA6qgwE6w5Q75eP' +
    'a1lBx6J+h4e9ZV3bhyIWlz+77gC88zn3ZEA2kDOof+f7p5vxVZ9oefd3wANVKxDgV//NE9VnDSAQ1BxwFqz2fFAgUIP6dza+yfdx' +
    'muKjgEAgbey3Ecx6p/9txU/tONzN3+WgrBIIOCwpRv07/m/3NX9i8gHurEWeowqT3RHGqH+f/ztDvGZDgPNdMqkL+Atq1rKKQ//o' +
    'QxNj1ke5uIA8SnZb/VEO1KF/5SzUOzoFIn4vK4UV6h+BJ3+1OhBAEZc6QA42KJdEZyfmCP6xr7liSN8XMP/2nTOzVqjAOVvf20zc' +
    'gamwvj+c9rU8iLFZ3CczEgeOidO+mh6ZQFOY/sGFgLj9MY4vJa/UeBpL/FvejgEAdRGE8GavcIhbkzfK/chfXPEEXPTfo93HQRpj' +
    '94c44oDUhdLHyr1H8Tl3cDFBG/lZ9vmAOIFtrGYPlPto7lfaA5fPtrH6Qm2lOBxwOvFU2UH/vTHlmh6PBuSODEo6cKgrBp5MNnj0' +
    '8yJ7iF4m6XACkg64SXK0aThMONCJuwZIKbaKpyapDXuwv3i7cND/YO0p9/Aw8DoBqQkodrrlLCjcSLscJNJG75XfpQODJ4Q7989x' +
    'HvtSzr2f6iojPA02OjnlR3zD7p+f/Tl8992f6mIS8XvF905g2DCQhBO59H/7p1IKBDg+4phhgGyCc3BwtxhUqQTpoIukDLireu9f' +
    '42/KwX37y9xOwoCAfZPqcERgn/1xpMSK32M7yhTxP3Pv/uxgD1ft66LqkUL/HIZFKXyAI8sciQpSkqKo4r7EO0Qrh7L2WaYaVv88' +
    '/i8dud6TNo4PvA8ug1BBB/3j0D+mcNSH1soC2V1FYAgEgLEpvjZs/TRrecUB2hSVkBGSga075SqGbzXEfZSUJHXfZpn9JwO4W/SF' +
    'SfTDb0qUhLXDYAhA/tsV589NEUxVElXtFtd0jQB0xDxIYEcqx6fnem50G7wMdDs9lozzbM4wjf73MwOKR1NkE2QYbeg/zQ9WiSxo' +
    'hwAuTdEYRUFlE2W9mwCQsqCGab7BEAhIpv/N8VHSCKrSKIpSFjEq1T+boULWYhqleXBW9c4E0+l/pRKb/gngNeHERK6lNyao0jVB' +
    'Ad8wvyfjsAkAB30jIKH+1+EzR+iERHRt4yR7qghhQv2vUoAcN+obW2XkHFsEaNF/mHPJdGKwcjqcdqqmLhEASW+9l5wsl89M5nWo' +
    'x/6A7f0/77fCJIlFiKmymummHmA76BLbtlIwo3pxYjlJk07F1qm7kqBOy2wWPz7nWWEyHenOEEBp9Q+JXHEI8OiREgGNJ4O7zIb5' +
    '66hSpoKJVLTfUdV0KoCpq1s/B5P7nBYugPlLbRHQcCoALA/x+KlBlcM2JjabZlOB6AcZA35D9lD5+9X8uRraPohgekL700JuPwm/' +
    'hC1BuWZ7d9omEaQpeacWFjQSTEnTyLZfE8YMZU0smCz9vE8K9azLJy3WhCHHxYYqaSJ6/QY5N7xs4zTA5Ljc/sbKIhaikrofnNqm' +
    'AXlq2t9QWeTSJHH8waavhlWeW61/rlTCQ/6TgCQAgM0ZtkUDINO99j8AoAgAEv923Ww1YFMBSue+PgAo1D73ZeqpfvvmGBu6FqJc' +
    'F1plAUCJAbAlgs0EAcx2pa2K3pglB8CWSjUSBGDK1tZUGADpCbpuMQjofGVMLAqADPDb0IAmgoDK2NECVQCAMkC8nSAAOXvavgZS' +
    'NASkva9fXws1EAR01s52XfJcKA/GbUPloF35yqTWge0dAI0FAch8haGKeoA86GsqCGwygOR3NFjyrkznuaZZZwJ1BwGVu5EFSjpG' +
    'nUkj2MzFMOS/w/64nBLXwV/LTP+7qZVBAco/2fgOkEX84hcAkO031c4DscBIC07W2jLtEmhtrk6N9cmaWgFgtgEgQwgARbMU6Qh6' +
    '/WbKYo/UwqSIsn3Ms1TJrkz9qSB0NNPo/Z0LWVeVqSCN+wZWlvhqKz9dnFqfZKhbsPYe4c0mEBCVJUl4q3UBymYvAYzGA6tOBTf1' +
    'aiMOILWNVWZiwgDHTgWh0x2nlbmAeussNAkDzEG0a3UBMOQTuKVTQVWrAxAGOJoLwEkuAYZ2Afz9CpBWGnYBtkIXAOwpIJm0gn24' +
    'gFp87bpGqblxzi8t1ykrdAGbGgCHdekprTQMAKyv4Eb8kyACgENrW/vbGipum1sAxeTnrLVJ4sD8c5u+qoLaXAAluAUCpRRpY/j1' +
    'bwyRUk0XKqiuvqsUDuCXDOKMAy7dk0LooEaFdVXd13eUSXZmIpkpLh7YSSvopj6pqyq75xlZeGLgPgTsRF1dT2NN9eBsEwugjL2r' +
    '/t7uJnRFGY3O16UCaroDAd3f1ZSqhwbm7VODG/WBHq+m18S7aHij1C9CrIsguxXUPdf8zo7dVgLx/F1qJPa/dbwlaaDKv78oCAHd' +
    '9iauqJeqxAHkCUYQUhfqtjkZ64B5gWkl2C0iPkkAO+5NNFVUA6nIpIJ/s0DHvYmqhvaGQoMKvi6g6+mE1dmXooGl5hR8S4JdjydR' +
    'Bd+0VHeS8gNA393pWD7bhVIZN/hSwJ4RUEEMUKXm1T0zwc7HE1YMvMyezGLNaSQUYB0DyqxJLGduavQk8G2AhWPAOgJAKfAPygG3' +
    'Cijg7pYRIHPKDUPfA1SSB5ScUfJigf0vqViaYH5/pwrGWx8ADLCnThWlvLpk0dXjOmAAAEDJGABFhy0FADsjzN36WDAHEADUEAN0' +
    '0RFFAcCeiJfk4aoJAKCaJw7rECZz1cWsUJWtud0CwKt4bj+ynxh2/+E8WPL9W3siB5PIrtFky8eaqVjhq/CQ+j0ATNUIFwCwFAlY' +
    'P2eqBACFALCMxFlJT+k9JbcAoPsDwBLUNuf+cFX41kUA4FIElFFAiXzrHgBsfwCAMslY4SRQAPCTMiSg+JISCQGOdMzmqwar0t33' +
    'AgCXLeYjY7p0yVUA4CQBudKx8vsJWgcAX+1suTMjmy2WX1IkAHCWt3JF4+IUICUAtovFb/6Li51mOokychkjFb915S8FG00Kn7J9' +
    'WeC6AdnsXiPAeb3l+X5LncYd5wnHFawoYgaAocMVotfth0dm99pvmR4Aqw+YpyRTwYIaRgC8loh6ftnQ+QNAnb5leXkWedwxlp/B' +
    'ZwSAxgB3Fz6AApQ4C1g15+XRBtnSFIANANaoEA97awIJXR9Wp7HHPP64gg1VXAC4XiIbFQIcRJ0fANlLQVDBfiLiSQNV4PHenUFE' +
    'k3JsKTcLXHPAR7MAsF5vh7EAYL/jlhMAlHk8pPhcOhMA/OIlDwC2v5yVO6vMnJwqWFLJAABPvsQFgPVvZ1VUbhZYfjUJCwA8Pzkb' +
    'AFbUiRUAuVmgrmALB0V3BKlHZgCkK59krgVWsaEwFgD+CuADwLp5J5FJZhjTraAOyOABoAAAFh+A9+AoKyuvIQmIbgr1f9mCEwCY' +
    'qGabNw2oYktxJAACIhcnABamqlPZZPqgXEMSEAuAANyyAgDTAABy0nJYnT00CYAQK2EFwM8F8Hpqk9Emq0gCIsbDQ+ulvADANADQ' +
    'GfNASFXRzgCAO36LFwBf82HmapQRAJskANoDQNjh8wLg64WYAaAyJmabtTQNAiAsSjIDAKfUAEjtlVXhsVAGAEBBAHw+ObOaMOOW' +
    'gCqyQJ8W/yMABJ49NwA+58cLAMhIzKmCq6A4AKiiAFBT4wDQNWSBUSEAigIAkgAgYyGgeQCYsgD4HKBOdx5pAbDCWrmF7BEACPzQ' +
    '7ACg1ABQ2QBgmwRAYOrKDgCVAgCUDwA1XAZHAQALewBMAQCVbTwMWwaAvZG5sAPg7UO5ATCVAEDBh/nu3waa7gGg8wEAG/MAd46H' +
    'HQCvNICbPqEAwNMDBIctfgCQbRkAqmkPYMLDFj8AVAItYbZpPVVFJfgeAObdLcGY5QcAvDbRpEvOBACsOQo/AFJn5/kAYAQAAgAB' +
    'QB0AWFbok/4mEgAIAAQAIwNgMeAoABjbAwgABAACgEoA8BAADA4APRoAJgFAcQBMAgABgISAWjiAFQAIAAQAAgABwKh1gFwAkMsg' +
    'AYAAQAAgDSEVl4KlI0gAkFBQACAAaLUruGcATAIAAYAAYFwA5BsMKfBOpQAgCABWACAAEACMBoB8myJXJScSAAwHgAJPFQsAPABg' +
    's73hoLM/VSwAuJZ8O4JWv0oAUAsA8q2JWwGgsT2BAgBmulFyVawA4Iiap/44dZQCBQDHAHgIAMYDwGSzEbPVqlAlAKgCADjly81X' +
    'ACABQGIAQHUAWD1UqwUAaQGAfj9c5azPVzEdOAoAtF+iRTYjL6uiL3gQAChPfeqcqXkVhYAxAIBTOADS22QVeeAQAEDfkL5qCU0O' +
    'gCo6AkYAwPugVdhnzMDLVwAgAUAqAHzOWfm6inyZeQ0Xwv0DALS/iam8tbka7gO7B8C/n/X5FpSXldWQBvQOgF+cpcDTyKCQGtKA' +
    'zgGw4FkU9P+dxSXXkAb0DYDA0n6+qZB92aHUbUDXAFjF2DAA5LmfXd0GCAC4AbB6ntsHAFlvAnYkAAQArEcAmxWIFHYYWdQB5Vlg' +
    'twBAM5lAAOTmgFWwwE4BAE/3b0I9AEzZC3M0la4F9gkAZXb6vwQArCJyJnNUxWuBPQIAnQuQr1WanQPWwAL7AwCQ+6dfA0Dnt8by' +
    'JKA7ACgz3QTAUhnZ4rEufSPc2bp4NIc//dKpZ74L3ocdUykApmYAgGff5hIAqkROXpwEdAQAPP8ulzqlEgAoTgK6AcCF+q9/eP4y' +
    '0FYBRe6D+gAAvKifiQNAmUEtVXg6pAcAIHl8icsfjmV8cemmEI80sG4AAPpg2COxozKKKE0CGq8DAJnJTyhAEVldceHrgJYB8DF+' +
    'PwiogI+XVQ+FO0PbBQAoX+P38uqqlCcuHANaBQBSkPqvbUsXs8OyiWB7AIDZ+LW36/f82cUoQOkp8QY9gEfSH54EYJkqwC4RVAIA' +
    'Nt4flARQuWx82byYf1dQYwDwqvncSQJ0QTdctC2oKQB41nxuJAFQkogVLQY2BAC4r/5LbK3HgnNbYcl9cc0AAGiKEO0fAQoUY0qO' +
    'iTcCgDj1X3LAohEgIgYAAgwBAGXi9H91qqpkIva43Rk4Fy9oAABEcD9Pv6ptORoeUQuaP/YAAKApWrT/RysynwO3akFopywAYHKK' +
    'NwGAJl7/V9+gdAS4eR/w0p3qHABq4hCsOwLcuxMGFuVUBQDW1D+gwFB8QvPWykCVDQBYCgAs7v/6RMtHgFulAM2inJoBwOP+r79A' +
    'uZvgmFIATNkAAAUAAFzu/1qrBW+CD0oB2j8CZAkBJQCwjop+ud7NCFDwJjiGBn6CRgYAmBIAwPBUj+5FgNVQcLlXi4JpoOHxAMbe' +
    'IOfp00DFqH9TPwW8QQO/gCFG3B0UAnUuANB9/ZuT2yLlHXyLPlu2PB+PLYUwZQMAZQLAz/8G659OGKM/BSz4iPuGi3gYHfIULnxC' +
    'rcoDgAj9KzDHTaLk73mxKADCMsFvH1nsTD3DSAUPAMxS/2Ed33jqxwIo4KOsBF0I/DcSJgcAV2AET5iF2j+dfwndBgUMzgQVz6f2' +
    'OG2u1Aj94kxg/qfR9wfXTQGDM0HiIS40BXDzdB7gRzQxlP1dYNj4o5IepWXZH37lAognS9fZOOCZan+rMcLqf0/zv4Kw8qeANTxe' +
    'f+cGC7l+Y1oOeGrb+OnEfmZz/ggw6vrCwP8i2JZ3AEEsQLF4LsjHAc9ctfr5NRPi/a8B3EwOuDfIC0QqlkqtR8Rly43o6ldASALw' +
    'pKZw/fGvHEBFOeDOSuy5C0AG6IIPB2TLjfSlljAo+PukMAG9gFgFAPxdALBg14MDQoKv5taSHwGcF8GrD1+I7gZ30NBWXMDytJBf' +
    'KfyeUV0GAArgfrB/ESTcAWR/I4rVBWgGJakaIgAGBQDz4n7gVS/2HwisxgEEJAIcfSw6Xw6AVzzdrwOMPuki+dwXYHsOIKAWoOJv' +
    '7K8jANuk5OGv+keY8uV+4NstTP7wr8cB+K+LCOwfKBwByF45gGudGgzAypVSodRqWD4XYGK5Oly3g3FZxqH+/930eQnIvLnfI6Rb' +
    '+HIpjK3SAfizgNWh6iQOgKk8ioedp/8hBv2CP/jfFgesBavKATy8+wIwVlUe/aAc1ZHTvU74/53NdeHnRRWtJwACFkPquvTv2xq0' +
    'iZqK3wFEnwyAIq8l/niR+f8fjfHV/9WiH6yuCHiQ4Z2Ep01gDfwakNYBIGltrojdP3nVHqnfI2RTgH606wC81wVAlLroUv9ROaC2' +
    '1n/mCH24f8isWNDrENU5AG8XsI2H+PBfcKYSD4XqEDvVPuYf0isIAR+P6tP/NhUE3+qaLw/wuniNSwF8APCNAMhr/oEvxEGFAFjb' +
    'J3q7AG80Kw43epllX0QB+/1mdG3+QZsCgt4IVY8qRXtpAk9MJlb/kScDOItS+BX1lt9/P/93XgT8kf+wPVHXVkC11oDcqj0p9NKZ' +
    '1YT8q3S3ALfh+M39QzcFXH9wqJsBOkg6BNyx2E/N9KQuNyUPALF0wdx2/z5jDIuz1bXqf90YoB/+QWCGwIkX8F26mM8y4CIAhU0K' +
    '+aycr50BOlQbFASe5GvSTjcwP7Vip/QEIDoCLKgMcet/2QdCj4rldhB4M+wnBlabhAGVNp7qz7owWZ/q37v2761/rLEP6FK1YUHg' +
    '6wcmo4me1JuInsqfrOdh2pybUhwI/ukF+PXP0kxZVRBgW6ZWxjDUmf4Nu/9fOFarH5WLXxDgWKZcTv/7T29u0n+/MeZGGGBQJuBx' +
    'rxOi/7ybsnZGvtB/2Af3I3T11wBvlIM4EWBfM1eF4txW/6z1322NXT8aEN+BcT4EUGa/qJj078fnoKUAsM2RTjkLFwLyP1y5UrO5' +
    'uSjKN2wtkgrVhP7Xzd/nYwKWgf5lz4vWFOBu/Pd1W6qhDMAZBE4aBAPa5apx/2sAmMX3C9K/N2yXaINWAOC/QTT2ZTVdoiyC8fr3' +
    'hy01FwDeiYv1veqMeV3LlDkS2vMP8NlbcsP8lzVgakj/QS9K3X1fz1Ahl/jbdfXL4yEgmCn/z72MNtASANaE+OoRZAqmAtYWU/8y' +
    'y/kRef/6f1DUWvxYfLQlnk3CHwiEeQE7GVXQHvTelVMa0qLaJAC7aoDHTqj51t/f9xe1hp9bVqEFgEDOinX3gQfkL14EBua7/0vl' +
    'a0J4PB5QwRcL3BQajNsFrzCPBsX3UmD5lZHeINh2Adi5W/upfAX1fK+wTaE33NYiA4RH6wjw5zCAilYzesYY/VS9Qqjra/2Gfy8v' +
    'AIy+gVyOpXo1VQQDTwDg3aUPs9SIa+VNAPUtv9VqBeC4IvjoRHBd3kJ+21/HlXauAM7z2El3BQD8KepoSMhQRNj6nZyBhg8rOBVo' +
    'BQDK5eQWutcUx1lU6wTQiQDVDQD+S4CgZ776L8//Ilq3tsfyZ2z8uKDM6E5iAOCSrC6F69BsP0aDvSEAk9flfhUgSw9o/sBUVwiY' +
    'b2hT0zJt+6JNng1Cbah/9gDqsHbBkzx3kQAeIMC2TmoB1MoBcIf/pcfU0If+V9t9bJtp7VyXVPRm/L/nIjcZAL0K1pHfDxs/qWse' +
    '0BiuYb6cWNxT/vyyWs41ry4sI2oAMHVRADqOa00hYNa92S6O+hCz8/X/32vrUF/5XzexfeTMCwS0VhR+7yZwz6F8gHHRtjSFg2Ax' +
    'Wt6Z/tcIoFaV/wKA99KKuYchDAMd678dHwB4Zd1hLazavxWka/1vEFDrqjv/nTQhGPC7E6a+9Q+rilCNCMC5M5Vd+2+foa9DQef6' +
    'rz0bRNJTOrHXreyqf/0/qq0I+e+ii5FTCPzr33Ss/9UKHScCSvT/hcwkxELgcJ7pq3/bt/5XHSIuBABlvgC/5vzM4s4JVI/136Na' +
    'x4Ia4e66G0xOE8it/SMIqDLbrgrJslMUHS7CZpr7BDIZAr8rJdh+wbH0vy4IKOdfp4dAHtrnBwHVWdtsWDqoXIQo8fR3Ue1/Yr16' +
    'fCccVbsTwPdj7+/8XbBX71HaNBiAIoHfVRra5H8D6X/1mqJrzSOm2gHiNYKcNQ584mH36d8+GTh9A+ddL7CT5pwHxnwJv/eKu6/+' +
    'B6F/B1TQOJOBzzIQYgkF8+R54bjvjAPTsPpfEQFH/Fu4iFgMQJo7vqvqv3X8kY1ZGt11GHCEe1pP2d4DgU/zToKSr/k8e4G4eIOO' +
    '3G8T27Ho35GOHU5w6SLmYBAIAjht7Enj0t/vneBxl/invdgUXXZbU0Xg9DGU/esr75ZbuNL8u5M3s+VvP9vpilT835CZedd9xVcD' +
    'E52XjH79WK+dMe/1ISu1w8vRvjRvbdaYH74LgEbM/h36X+l4FwbgYJXsh059R7L1Z0j78zeZ6d5T+eG32B/fNrT7X+f8h+FQTRXL' +
    'vf7///lfDaL+DRckOKsa1qb9d5kq2P7f7NaO7v6XJ/KbiHYZBU22Wu3fDnpW3P/iUGChY/Wo3AnYKapETdbZFCBMwJ6UBEDV4gRs' +
    '5AXFO7UV83eczM8JuE4HqA7jj1xV/cG5mP9BTcAec8Gox0Xq0P6XzYj5X8cB5xmVhEBk4P+5f4n+p0ek/iHgzJHLQYChM+ENby3m' +
    '70cFDngS5r/WtzxvVJDk/qFs0O0rc0PAsLxR8Wb/4v0960LL3lnH3+e74mdqSHq/kire3/+8zLcwiEdcoeJqn8v8balnDhuHwCFn' +
    'BqQ2bP9t/sL9byUE9iQOfOY7bO3af5u/3PtFQOAkdibp9dV879LBO/pL8L8NAW2vSqec4/2WL+wvzF8Kf5EZwWX1nGvaS7M/TUaH' +
    'NFYkoC7w0u7Fjp1P+/eteGDt/b7zi9KfqJ8jjH68/Eke9enM+TZcW2+XP8Uu9z3zXeL8GU9z3ubgc6ABLeHGq8n8tt+SSz92QviE' +
    'gKdLnWHwmcQx+6Gd90ukmHAjlag/HQbCoirA9w1S/H+JNMfnlNifhAy8B/xrP1xQSso+Sc+38qoqiPqzOAMRERERERERERERERER' +
    'ERERERERERERERERERERERERERERERERERERERGRp/wB+4KGBn+/qqkAAAAASUVORK5CYII=',
  'maskable-192.png':
    'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAADAFBMVEX////c5N+4ycCVrqBxkoBOd2AqXEEHQSEAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEPC45AAAGZElEQVR42u1c' +
    'h27EIAw929jk/7+4RyYzJLmSBMlPaqve9MMTMz4fhUKhUCgUCoVCoVAoFAqFQqFQKBSK/wQJE/QrPrClnocfZHDyA/ZKwAzi/qD0' +
    'qgBrzdcLWKwxXSoBrcXRD0YiPUagkcBXEUOnNkTTyJNBhl59wA09zD8dgns1fs+LZwYA/TIQg2RMr+XEGEOt9FxPACJ07QefzsX/' +
    'pgHqnACbzglY6dyCpoKoX4i13GXwhC2VLSqATgIqfqcwTJsC7OoFRl4/xQdiO1herd7YEbQ+LWNtAX1IP3qwZbG+H4MR96IXJgfk' +
    'seqBqJazMP1OXvmy+m4WP57QWNdXcXYkgbgwmtaL5mk58afx53liEzGYKbxEC1PNTJ+S/FMskiifzRTekWsz5uAeHZYUBpKlyBle' +
    'zwx/KoXxxr+opIm7eeHwj1YfSsYho33698FkB/aTG+/xpQLZEXgqK4ymnco0yY9ZUdPaGuUxMxrlz5SanKcVxKXYjJ7ICVjwQDOU' +
    '5IHCYJsC4xvkp/zjvKczfAeDkvzOgMqTSCiwu59BUX6MKrfM01hicKf/FoMfV4KiKYQcY++ce0I59EllIKE00rcu5JS/DKpScMnY' +
    '5b6MtqNuqHZRqOQjYPfd558dGK4SwOJ78SY3KAXzhQBcJTBqlp50gMmSqwRk5803GBHuR2weaj4w8Ok896+ojBLW5rm4t2pPtnkr' +
    '1bQN19I6IUPjogVb+3HzQMFtBwiyHgymgAsdxMYqMFknGzPbYDMw11RwswLcE66xG4GvNaGxZSDajXIQULjeK2m5plMJcuIRwJ9G' +
    'qZEb1xwMPfv5rdZqlGm4NjabCui3SNHGjaFqnfwPFtTQjesh2qwE4EdXa2JDpipYSKCY3wLgfTZUj28hAcrmtgiDOd2a+SWL0SkC' +
    '9ggo/00NnOBArf5PBBo5wQHLNEEUmtMCE4LDGmPJ/YdL7UH5z+EnXCBHYCspJA6xhXWnSXf/X1MfcIHIhKI2iaQ5ojS7aOIER9JL' +
    '6gOwS8A9RoWUSS18GM4SoM8+ASwI2sKLj2SXxISgQuAznfHI1ST/7sV8isDkxOZTI2DyBFrk4iODEmuAqgQwb0LUgICcJkBhky5L' +
    'APK27hyuAQFzjgCETbosgU++T4evIFCa7RyI8C0IWCXwMIFzJoS9EwAloAR+z8Q/EGiRic8Xcz8QaDElO5LdfyPgHTYzDcppPD0f' +
    'OEvAWw5pcQYQTs/IThIwXmHaYkZ2ZJr3CwHjfTw06WwdUOt1AmOHgjxzbdBbPNUXOkmAwr3J1KQvdMCLLxJAiXpcbc7xnu6NHiMA' +
    'lD4hbRYI6uNynoA7kZK8CRqtktXz+1kCGC5stnWBI5ngHAGUaGHZU3WbxfqoIE2PhJ0hgFxa1odm66yhDYHFHwiYdKUAG1tQbEPG' +
    'XtcAcCr/2lDndts9gjkBpxrgQwTgA771C99lQVEuk3ScOAkoGQIUys8ccTYtt4T5qUDS75G9bTayxJpAfmOiGATSctucr4J0lzTU' +
    'lh4nS/fs32yxqL0LxypIfY32XIAWObdXsbfyx43LiIwK0iUb3tmrgotzrDKLz2X9JGq9bXELRMkuVSz25cjwaltmdRM/ltJNCghy' +
    'QXT6KGMOm1QyAyA3/JvTU/utu9u8BuZl69gBdqM4LQKbXBXkBqH55umtIqJptyIbIr8qxooJju/nnPxtc4Bv6hiXDkd3y82HV8JU' +
    '5tvnHSeBvMlxyqCyWxFT+SlQzy0HQ71kEBXF1ZuEJif15PfP/NFdx4CCFhGu5n/k0gjjlGe8zbGhdu46iBXtmwB0gGPmh4v8El1s' +
    '8B2W+w7zXd4U5i7rGbfKUUKYb71G5uKOHrd0DMXQcOvJ7tMM4FtPuCnE2AZyl6xg/Hk3n+s+wwCIZ08PpmLeKj0+cC79KIPMzvwk' +
    'a+Aj5+pxZgC0Y7zIsrtpccwc+NC9ACjDdCEnc54CGqnvuxTAx66xgmVWxoPEcXGz+4Lcwl+I2EcO1CfZn8ZM/I3uDjQGnB3ZvSwA' +
    '30F49BKurxlNjsD2GOJ64/mbnZfFLTpi73G1BCLPX9HjjAAOUJB0dxa95CJMXJpc5ZCfkd5Fr9dc8oQyj2U2+HB2Zxy96zZqNLxe' +
    'iOeikIytCOZM3Tm9nl53heF3WhD8C3s37UL395AqFAqFQqFQKBQKhUKhUCgUCoVCoVBcxh980FSEx8ehbgAAAABJRU5ErkJggg==',
  'maskable-512.png':
    'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAADAFBMVEX////c5N+4ycCVrqBxkoBOd2AqXEEHQSEAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEPC45AAAU+ElEQVR42u2d' +
    '2ZriIBBGZQ3v/8SttkvQhECgNMI5F/PN9NgaUz+1seR0AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAUVHGumnyzijuxYDos/FD8EZh/iFH/9n859GvuRNj' +
    'Yi7mnyw3YlBcuNjfcCMGxWN/xn/k/5UlExwo/l/t76KKIJANjlP+XfO/KbK4DeSD4wSAi/lD5ACUnzwxYCgHEMzrz4gBIzmAaboN' +
    'eK30mcvPnL6CI+ics7e/tgDvwX+KCA4BjJECPnI+EwmAVLB77LUGnDWB9H9XaKI1NFQKMDO1uv2ImaFBBXBSjP/xBDAP9pc0ILy2' +
    'BqBvAbiXH11qA3pBAwnAzyNAOHt/7ekFjVEFTK9TAfq/+FeWInAEzFvFb+/Jn0YAA3BP+ScC/thJAPO/o8cAUr5RY4C/N/4IAoO6' +
    'gHvvn8bPqFnAQwH4gLELgff2v2E+YAT0UwFungoqR14wnAImZ/41oLQL2H+4UuC/HnDOe09rYCgF2CnEywFZDzJaGHCRBDybw8bz' +
    'Asb5ewzgkJBBNXDZFsARIQAAgwYBcv+xMUwJjY313IOh8awNGzsFYGXQ2Gh2BA+eAkR7RGDAFIAYMHgEIAYMHgFYHjx2DcAOgZEx' +
    'rA8nBWSf4OApIGnguLiJrcI4AFwADoBCoOtST2ljnV4tAdYLAe0M6wV/2/YX0/vpegjUWg/gfkjw0isuu0i9s4YTpH/R+MZeTH9m' +
    '8otrvl+OiV5sB5pLnXh5h7MKEMEPZXePBf+XDR96KwNM5IHKuNnWEUTwKyM/PK2/YrN4c2AqD9TWz/cPEQ4OPfSfxgqXrd8qqwLY' +
    'PDIm0sDELqIDWz88zJ82k5kWcHnS2nxz+Irnn49pv2EgPXtESG47KP4ENHBc6092q6szTwDUPBpsHBCj5qEAP3AY80cFnc+wio/K' +
    'f1XSENSR1NhTfoDIH23zdzktXff8Bf+aEKgMvUUFhKOJ/FXf74t8/6v9byPe5ZQCqxHHEwkOYv48O9j3/m/UFVaZfgcJfN380REv' +
    'udF4bv9H3adDqQKQwPdHf5gl5NnJmF3u/NhyBTyfNoYEPs/c/PmjP2FoN5UrIK4/gueU0Y9l/nti/2v+91LyuWnP8pAXL0BF8KHC' +
    'b16GFXjeyP5mvTlUskDo5WqQwIfbPgU3PB6tb/46VoDZK0haQ8LBP068SpSzZeD4BSXLRE3UISYVkAz+Ye9gixeALBpJxQ+S3+2W' +
    'iAOH8/4vniOsDNJYAUV7RuP4wipz+eFf5mij8i+YvDBRtlZ8XpoE6oH2RDYsfNhLlP6ntPOiALPfQeEEjjP8VfS76XEdu/JCM0b9' +
    'CTIBqeQ/FA7/l4dDbP1yvFy87LNiJ0A50Cz7cxX3VZdmdlGsKT0+JHYC9AQauf+K9MqU13Zm2p8KvjgBwkDr3o+t+eXchwLpGgVE' +
    'bSFywXpczYiy+5L6mmLgJWIRBirD/zyDLz7Oa3/nyNUoIEojaAlUhf+q0tpW1A6mJgrEv40C2oR/U2V/W6W9YiNGfQvqwZ3YqsUW' +
    'tTV53D8q/fgoESAVrE7/yk/zNKHaC7ua/CMSICcR7un+hH1zs+8efPdZsLZKAabFJQyc/tcE8OjXK4bf3I3YGhHyXOoKA+4J4K5R' +
    'ADY5s8iJVBAf0MD+uspulQmY3rFcfPl7oICdJdgO+6uGCbiuyUSiUgIF7LL/nrtmK7KH1NVoFPBp+++6Z7pmzKbiyZ63Iwp8voBz' +
    '0fb/ep7VoKm6HBRQGL933i/d/BDwhxv3db+OAj5h/2cGoNtfVHVLkYfUiUdMJdCBfzSEbO23CnSFc73lXgduJLytqxSln1oWJv3S' +
    '4gj/u79tOgmrK69q7tmYHc5It/fbX8kEW1sZVxQrRAoibc1N0jJ3uVpXepqaVycdNwBM7VBtnm27WuNp2gH5TtJWG8pIyXO/Z5k5' +
    'OEqBpQKgzQyOE/Ky9zSuQlnPFIdSIFkAuHo7CQwxW+9ang2hQCmwkmXXRkglNsJMvXeKjykHiRxZiQ0w1aC/OMtz6Amv3JhK22mx' +
    'Uvs2fG0roZMGLCYAoc0SLgkH+x/BK7MLQz8onQC4Jr5EpND+T+JtM63TDZBokSi5AHsVQHV6OUsECQLvubFu82ZyAqjvMGmCwHoA' +
    'aJC8ywnANLrEZz+IIPCSFrVo3zg5D9Bq1HpawssVYJPc3colga2uUREEFrPiNnfDiJWBtplvMQSBhZSo0Wo5LdcHaOe0HZXAewXQ' +
    'aDD8v6MWEkCjHrNiTuC9Amhls0vDTmQuoKWyDHnga03czBdq750XEcCZZuby5IEvGaAaVfoj54Fm4LXSlRsOe8sAx4uE5IHRNoAB' +
    '78GzGTBqKagG3y7lR3cBbnAnqAcvBfU0+hJZN3Yp6IZfHzm2C2BdxLwPqkd2AOM2Q9XA90DvzwCNu+DdnWuL9vYXl8H1RccYcs9C' +
    'WOEAyn41zJ/XXM5B8k417LRwTQbgpnqOUngM6wJcxTKQS+oUQqhTwEEEMKoLqFsVp5Q2xjq/y/LeWaPVYcabHXNS0LZIf5UyrigB' +
    'CJMzSh11KBgcwJ53Mi5fAvaIg8yN2A57pj4N6l+dGQoO+ghHPWIzqPF6KPtDWV/CBYyTBjZfEWl+2P7Pix8nDXzWgPr0IQUceHQ9' +
    '10WNkgZqgUdpbUSBQydYNgyWBlqBhUAqLYBD51dqsDRQiSyFsuFXHcBwaaAWCcw61QCyP3JHxkgDhRZCuV+NAHOfOEIMkFoEkYgB' +
    'hx9Yj2sfYV2IESrNEzHg8Ld1qBjghNaCq59sAtwYKAYoqacnKf/DAhgoBhixNTn+B9vA7zGACNC+DPiFfSfDxADBhdA/LQA7Si/I' +
    'yPll98MhYJwY4ORWweYJwMRbCe7/SOwo8Hfe/rH84vMfO/z4KDHAy9XmeQKwlauJpdac2zE2ympBt5wpgOkDmIo703chaAT3QRxH' +
    'AHtG8aON0XczUHIJ7G8L4Hn5PScBSnKCNq8MPKwAzAhJgOgS6B8XwBBJgJU8FOg4AtiV4Q6RBDhJlf+4AEZIAh4iF1mjVS0APyP3' +
    'RaGdAB4din6TANldUPsF4N1lv7Ca7RtV62P78SJ12aS8vEfZVN2dfqcDjOi5gPsEECan1Xq5sm1apV0bAaj+s0Ar+hX3CWB5x7Aq' +
    'iu7KNpl96j8L9KJObocAwtqOYVWY3r3sUN4ngEcS0GsWKLwDZocAzPal5o5tWy8A0/seQS17NHB5K1if2gkg2p9q6u5Pr1mgkd0E' +
    'WSwAfWopgPqzjx9Vcq9ZoPDS11IBmFNbAdSvd+09CxTeA1m4IMSeWgvgcQV7BeD6PjNQ+iCEMgGkR9k+AahKAZi+ywDpbfBlAtCn' +
    '9gJ4BIGdAtB9zwgLFwFlAvAnCQHco7ipGyKdPkFHuAgoE4CWEYCpE0DfZYAV7nWXNIL8SUYANxPudeG+680B0gehFAhg08fuFcC/' +
    'g9kdw13XdaAT7nSWeAAlJQBdlcTZnutA8XNQCgSw6WJ3C+Dfi+8VQNd1oJJ+SGCBAKycAK5736oFYBCAqAC0nABMjQB0z/OB4ufg' +
    'FAhAyQlA19hP9TwfKL4BOn8yyJ3kBHBNdaoF0GMjwAidDbRDAFZQAKcaAZz8AAKYvi8AIykAhwA2alz7dQFoSQHYmsmcnluBVjrD' +
    'PYgATI0AHAKQFkC0/0NCACettUIAhxVAadPis+dNPb5DhwJwCKBglPQsAI0AEMBHBRAQAAJAAAgAASAABIAAEAACOLIAAgJAAAgA' +
    'AdAJRADdIX4eehedQAQwtgB6ng00CAABiG59RQAIAAEcGPHj0HsQgEcACEBy6fw3UQhg+2OHEIBHAJsf2+PWMPEnYnQggK43h4pP' +
    'BvQkAI0AhhTA43yALo+Ike4FI4DBO0E/IgCdcICPY0x7tP/zHEw3tAC82f4KrmsBfPegyG8LwKYioO/6gQEKAVzjoN3uA3X6xAh/' +
    'hLOCvysAnRzeqvNnxgjXgT8gAJ0O8H23AcQfjXl8AeiNDM/0/cCI5/ezYwpAb6X4fVeB4hPCRxeA2fz2vT80Sng66OAC2D4tv+u5' +
    'wA9kgYcWgHpenRs1B5Q+JujIApg/WtaNmgNKPxrzwAKInivrtl7Vaw4ovSrssAJ4ebK0GzUHPAk/GvOgAlCv12W3PtP0KwArmeYc' +
    'UgDKvr2FHTYHFG4FHVAAyvgpWwCm8ycHiycBhxPAovnX38L1nwLITggeTADK+qK3UL73NpB0EnAoAej1q9EbH6l7FoBkEnAcASiz' +
    'fi2rzq//NlB0Y32/AtBrvj+d47nu20CxlVSnAkgO/kSON0YKMHN0pkcBrOT9OVWgHiIFEF0T8HUBaDtlYDbSY9W3AAQLwS8LQLsp' +
    'Cz1wF2Cu9PYbxL4qAO2nTFTyA4PpXQByMeATAlixT77515J8M0oEEIwBX/MAuc4/pftBisAo29kyi1I/IQBVYv61axlhKrg0BujS' +
    'u/EdAZipjOUcsO994ftigG8nAC0mAOUL7b/SBxymBojGjN1yFIcXQOnwX/vOI0WA3PkAd3wBFEb/hIUHqgEiS+kNC+hGAlAiAtC+' +
    '3P5EgNw00BxeAOXuf/Ub66EiQF4aaBsKwEsIIKPv711mBLADrAZcbgXYtEbMPlllNt+qBJAR/p3JleIgM8FLaaBKvqKRAFw7Adwu' +
    'OKf6sya3BhgsBZy7gNWpD1U+ItaNYpsJwOts+y/ODZMC5qaBuvyOqIaNwLU3e9h/SwFO2WxXNMZq0MJK0JQnRbphG2BFACY3/pvl' +
    '1+h0CjiQ/TddgCk3nW5YBCwK4H7A5ab9nVqOEZ4u4ELGplMCKLkntmEOuCiAm5C26j9v1lpEK13AMFwKGGW+ydZIie1cwxxw0Z3o' +
    'rP6PVWsv8SdqwGwXoMtHhW+YAizZ0GxkGjfvv+4iTFpqajABpI+OVsXDQrVMARaM6DIKQKcTM0Q+6biCO51GdQEq9b+qYsxWpAB+' +
    'pYS36eCfmiHSaQeghxNAOgtwpS7AyUYAuxUAvFHJDMHhAIqygNJ9Ek0jwLsDuL2LT+V+6QUCiibQ6jCzif/MHRqmZQ3gVt7FpHK/' +
    '9AIBm841RnQA6XagKtyQ3bAGWBrHKvUh19xvIz844QAK24GuaDmHaTYVvLi/0yUywNsjYNLrgzQOIOkCTKJBlhPF1x1AQS9RKa2t' +
    '86v2U+vBf6s/aDccgBpUAKl1Aeo1wu5qAxc4ALPlwG1iftjt2Q72eEd7GpXU0qDH4yWu+lC7bFey1dJsDGC1Pvw3loeuuTA9ugOY' +
    'u+6kC7gPtK1coqoJdI45IdxFF55/Pf9DLzuA+1VtTQ/pjQhoTuOS6gbZzFiui89jWn4bu8a1xfOeZuQN//VLNyOuA1gdBQvOOr7l' +
    'Tpe7biMh1Tj5314dbrYaYXpoAajEaDXv5fb7uPVTkwBQ2hzKdf/rCd69zHGnsUkFgfimh/Dfb5/X7G5H7lUp1Hlhsr05bPv5MGpw' +
    'AaT6ga9x95yYeWu0Vuq/Zp/CntyrQQSwW+2HbSd0cx3Bjm7/ZDNgLb/zOeuyZWQ6M+v25kC7mbn6E6QmhXZtwBOwfzTW3Wb1sZ2E' +
    'kgHmBYHdCmh8Y/X7sDY19r93uQgAW5XALgUEr6W8VL79vd7+xl5h/fn4Wpz8L1dAcIKHUObaP3kNjgDwckNSj5XWPrQ4haNFCuDv' +
    '8d9UXYOhAljNsZbGhLIl5ncCbvW1UtFV16CoANaTrOWbkn8Uo9eSl5dnf2/y4gkBILMheP3/jMo/bN762qvL2h1uVd6bGay+0BlL' +
    'HMe83XbVwhdn4hp+30XoiQow6RjD6h1MPYvFO6Ok1elepLpwFXZTg498EouvJoIJSyqzIIKz8bX6gDjVRgHgrcr3dHQANlPt1ddp' +
    'bR5rNS5TQx/yTjqZAGYM/vdsApZLgcNNkftHzF45+sFmylCRAGSVAvZ4Ari5Jfcef6zJPtj+Lh+HrXeWAt8TwC0A+PtM9Pkv7mz7' +
    'sgB063iSAG6WAgeLkf6xBGTGDn0HEsDfVIBvYjOD/UuKwSMpwLdISjQFQLN2wCev51J13teA6gflIeD+xegA5yrgy6slzpa31vnb' +
    'qdXqMYRve4a8v6aA+dfoizeroYCvKUD9bxMO8yP8lFlpQecVAo4lAD+igIvx33YYnKOAX5+DzJiHsNi/SAFBbnFHOlFb3mrip41F' +
    'SVutwFsBiP1LFfBJH6Aus41h2ktqMsBg/6MrQKXmmjPXoq6uR8H+OwziPpkH1Fs/Oi1w0f7E/0JWTgpsP/vbzPoriwIM9f8+zGJP' +
    'ULdd+KVMS+svLQrE/vUKiG6eblcbpLeXt5GAof9b4ZwXFXBOEG0DCSgtZP1rPmgi+3vsX1kMxAmUC5OrywVU28C/uj3RHKGp/dvF' +
    'QFjaNWjzF+F9w/rPZ4cEma2KQxUDiw0Be/Wze5aCa+OmzxC8pfxrmAjEcfSeIBZpYHFReZPa78Y0m0A66Oq2n0wEFouBx55hb3NE' +
    'cDa+a5vn/c8IG/1YHvZ/dNH5c9yzpUz617In5BZ7hVdbuNUNAmejGOtaj/z0etDLEVbfmc3qNQz4pUTgrYdzHpHXrSI3zP9gbO7v' +
    'c5YA/F8x4b9dNbDYEXAZjrr1yNfZzy/A/Uu0BZ1abBZ+hOyM81q64P5lnEA8rpQLR7P+7UrJ/gWcwNK8uvHiEijrOFzDP8NfxAnY' +
    'pVyw7Aihxmt9VmIVw1+4HDCnT0mgsON8DUkMf8k44JfmV84SEAkEpXNOl/aUZ/h/JA7Yk7QXKJ9qsBlnREErCbyW2art0q7yiSZ1' +
    'nabGPp9IBdzigWyNVvhcvPgOO56LFLz/JyUQZgtvIjcQPu3578Pf4P0/LYEFl1u13GP3aXMmBIL/N3qDYbHm2qcBZ/euMzsn/5R+' +
    'X5HAtShcHHqFiz/2G/+alGL+7/UFLpFgxfved3lveH1bd86k9Zj/224gJKpvdV0X8PaYqcspX7bsiIeVxhTmP0BCaP1W3X5drjU/' +
    '4UW1+WBL4X8UDXzBFEoz+g8UCjAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACU8gezfVVb8kkfkAAAAABJRU5ErkJggg==',
  'apple-touch-icon.png':
    'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAMAAAAKE/YAAAADAFBMVEX////c5N+4ycCVrqBxkoBOd2AqXEEHQSEAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEPC45AAAHn0lEQVR42u1d' +
    '25KsIAw0N/D/v3gVnRlQ7qAuVfJw6uyOuk1sOgkEZpre9ra3ve1tb3vb28ZvKEoIhoIMrDUOZmZQWhkrj2RqmfWGWcbBTFpvaFGP' +
    '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' +
    '4QAAAABJRU5ErkJggg==',
  'favicon-32.png':
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAADAFBMVEX////c5N+4ycCVrqBxkoBOd2AqXEEHQSEAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEPC45AAABCElEQVR42o2T' +
    'gZKDMAhEWVig///FBzbGpHbsMdMRy2MJSEQ2M4U8Gah8BIT2rCCiv4CnCmoqmqzn1zrm9bcG3ARKu8WdlVVxQfDAP0SiUzre7OLP' +
    '/EOSOt7kkyC3Doj3oa7jx5ijbE/XWaA9mJfpOvdTAkOAmbp3ptsJakgpxmFdxriDBSDD/FW/xFLj7KeByrH0s+NRO+QCdADAHMgO' +
    'yACWif0HwFfAJrB2MQH1mF0Yb4B61uacgQJhY1ANvGiZUVOdO1H741MbnuV4XhUOCYba+1PANOjt8/oyVYyR52FR8fK3K7QuaS11' +
    'Lxj4eaOOK6Ol1Oa31e+8OIOA3ve+FBrxIxO/LuBif6NlBTnIgXoMAAAAAElFTkSuQmCC',
  'logo.png':
    'iVBORw0KGgoAAAANSUhEUgAAAoAAAAKACAMAAAA7EzkRAAADAFBMVEX////o7uvS3Ne7y8Kluq6OqZp4l4ZhhnJLdV40ZEkeUjUH' +
    'QSEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACoHbNXAAAyKElEQVR42u1d' +
    'h5qcOrMc5YDe/3lNRgIhkkRYV33/PddezzIgFZ279fsBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4NgCYBnGUiZkEpyMBF4gH1Mmcq5SgsQELgf3FQ1/QzIBzwBVtOvqmxDPwIK' +
    'AndDNvSrDMVKAE9Yf9o1/NMEfjDwBEb+eZwEFYGbxN9PtfyzJPgZx8oA90C0/KuYr3+J1VgY4BbQln4uJBwLBCIAFDQAq14A+vaf' +
    'qioOjwS4TwCagG7E1j4J1ga4AaojoOgJSGpQIlqZSFpgiYCSPrANNDDRtkb3o6r9owYDgYJgPdeGHEgfkx7gwD+gKGTHN7P4SQeJ' +
    'FQLu8IEnH4T8+MQ/eMJAYRPQdEzTE9NI7xjXQG0CcBMBTcQuBAGB25xgL+9B2tos59rYDADcIgEDYVfbhU41FQoKCwTc44RU3JeK' +
    'ztZ/5fX/gwsCFIbqCegJO+5kW5lKlJ8gBoASENXCCBS87RCu/8dRFAgUxhBycQg5A084IaMRiJgL8KgO9mPRAHCfDBxqXyoBBgJP' +
    'iMCx+ICBgcADItB4tQcAcLsbQr3qq4UIZCAlUBpT/VWbAhmK81v9jGkdwJ0MrPzxWIRbBGeAmxlYVVYLzrmQ2joDrwS4BdQErSCd' +
    'MERBPnCfLyKrOQUNShGAO4WgtL7003B/gbulIJPaWGuNUQLOB/AMCTEMAQAAAAAeAXJvwJMm4E+iLhB4EspgDYAHRaCpIACB50BR' +
    'FQg8aQJyzEMAniSgqiqUwADPMdCiQRN4ENwfWA4Ad6MdFQMdDDypgSvMJAIegliMygKAG2EWo7IA4Db9Ow2Hxmxe4AmMk7IgAoEH' +
    '4I1IgAgECupaEtfA2usNhggEipp7ETC/JzMZjEbXCHBe+lEutUy4wKmBqVJyCvIB53QuYaJpu6yc0zQiE8XsmMyYCGSVq6zRAw3B' +
    'RWAnAxux11CvOQBJsQ0PJHFQIWntxPoqRgtGfmAhsE0+JtSkXc1ay7maE3DFD2HaTlOMJAf9gJSnQbmy1Tj1xUi6JrL4YjbRakKO' +
    'CuPNkdGSgYRAXPRJ7Us0SdepSqsI1k8LbjgYzHNDCSGwYJ8d5ZRzVqXllIkR0KZoFXKwAgcB3+eQgYRSralG1gWg9IayecZgujCQ' +
    'MGUdOAhsyCYjSNpXJT/u8YgT65uBafuOcF1BDgIzSjhf+O1wEVgQ/gv8EbHl5YRjBeuvbr8Qbsn/6vTKQCnaViBtJc5omAAJcsIJ' +
    'R2RVDHaRHnDw/wNTVTjjdJcs8lVulwIOGMn2EJ8pG0ZwoIn/Q/qFckjtbOwgvsGoO0YFWbl916Ei1MQafSX/melnzomggH9j8kOH' +
    'DCRnbgEU/K/o5xb028EaEvLPsaha3n+IISj4nypfE/qhdGfFHulrC4bf9GoAw8zIPgaS+a2Agv+l7XfA/ie+4HTK5xKvqsN24PJ2' +
    'OlsQDvEfjrzQsIpF0wO/TMNERsgTMUsLnxTI3RsBCv5RzOl3SNzQwNCbpd2C9Ny+eOCaO2IFAQP/pvgLpZQ9UpxHZvyLFB6E5Jb7' +
    'uV3zTYQX5xCCf5B+M1Unj6TAyI9t8Y/MGKgOUYjIsMAfkek/x0B1wdKaOxnxwisShAObs1uPcHBmHkiIwD8l/niY9GUHfz+UT2uF' +
    'fzMGWnpMkYbhIejhv+R8BMw4LF2Icnv4N2fg4fnlRMyVOBj4JyD8iit3+FzfIPxXpY9Fn/UqicNvSnVeUAMvVcAL8XdMroThv3n8' +
    'b44wGnP8EPXQVoAl+H1we8W9JOEEjh3ObahGG76Sg+/L7Bh2cPDT3oc8G52L80lu/f7cYa7MMVeEzFs+IQQ/7X2EjuVxm0q6avcM' +
    'olFmWnc6K9JeILAEXcNgkPCb8i+QJe6EV6lOUKkmUFjtdeIcB3HFmQbeQkA5z28ddl+qfeGXDb/HycMMDET3cVcGeIH4C+lzIrkV' +
    'VJ/W/ssREoWm5wkGBpmbY98NvIJ/YfJWniBwyL+DzgCfM/C4+46Q4Jdx2YoK+XfCkzDVxTcgdGZgCH4Kgfdq6PHdJ3P/mRy+QmgI' +
    'iqtXwCD0Dylg5fbnLrbln9PnsrLyKgNDU1KhOuGT7oc8c4lA9qiz+84vR1P4pawK8AjC2mVxhn8yi+6b5/HOVJmyRB8A8AH+nfIe' +
    'eSbrf9bIdIo/gTNztMQQeCD8cqUmtN/zbPGP0Jlx6vjdzAwKMPDtYBeq4gfofBse8sfxq/cDBr4cPIPzKgKleXm7SXCk1/HL1b8S' +
    'OPVg4Iv1b8C/k+dI051Tn/cTSF++J+WumrXALfLPXeefX1VP87wWvh3Izl3Cd8uhhT+hf+XJXaInxlwdcMz1SRJL2IGf4t/5CiZ9' +
    'oYxvj2vE8jAQeHX8pTor/yYBeFqFR29uGqKqzt3ZTAtDAr47/nK+glMVyTr4uT169hLSISfyXtA8/JtmnbJS93e+qsVjoNPY8ndp' +
    'YJvB//XtyMxV8GSKLprz11B5HhLIzz+TqX590JT5jazpFmkWBqI+8E3QLg//RkFaoP6YnS4MjPnoqJF+E1Qu85yVs/GnE5WumG9B' +
    'oSyCMS+ByBagECXVG8/Bbt/YRTDmFeZfGAC8liRQJXd2lF70ytPSi80GQPYAjK2yZc/02H1R4k2RWSI8DK7wax3gil+s3jNFzXuW' +
    'w3sIj6aDI/K8A3JpCEtcmBay7gf77ept+j4XHJH3OCDXFRLdMQM1w8sir1Y5eFEn5OSeBds7O/fA1ZwqVe0kshCQ+K6wkyjNetIA' +
    'tFnDYix7HVb0dblK8NAVhhn4DgMwx0awoXWolMOezXfliAa+QPwFE4hyVA+wwk0XncDOoDWDrDBiMU/xL4jJ5lCb9CsEDKNPHGbg' +
    'Mww0ufVQb1LSsgTMQxiKCv2nIfO3KprCEtBkdBu8ABSqU58AKzBEWefthisrYb1oIGoDH1DAtkCHhLyDgDZ/s2cFI/B+BVwiH8XL' +
    'GvUdAbMpzKkPHy0iTypgJzJftVggmmZuN9EIRz8GU6RBrBVR5bJbNKvBFqTkkBO+F6JIZXrXvltOn/Hc460EepSeAb0y/DtFwCa2' +
    '4Yoltxq7NW+tjUZG7hHozCmQiYKsRrG4Ls1+dYqM3MMeyP9dkRnM68DcwNuW3ZQ7x+9risz3Q8CMm956LwkFy8cLBiIUc/tLjzX3' +
    '524hFHMPFBIAK34IQjE3Lzh6wsLaVBgktwjAHHMA/6hJAhF4qwDEC987ZViRG6Fz5EC882JIg6Nb/loRCJ1QGgxzkpeACLwx6HCp' +
    'AolrpXQOvMvYCqxAUPAuAXhiqZsIjqsx+TH+X/w559Uqmt9wL8s6TKF5iMDbXODjAjCcsXwJLyOgJwKRDrnHBT5X1VRLwBWRdwT1' +
    'Jd5FQN8RRkb4tQKwITAXUhlziX7WKCneVnniiUAUxdwhAC+5wIQwoU6xUEtO32lkCdQF3gCv+O2yqUOoOMZBZ8WLM3+eCER+8oZF' +
    'vhoD7GLP3Lj99OOkjVq/9uVEMPrGYEMWX68hE7c7CajIy4tVKYLRxWEKJEGI3sW/18d3/RATIjFlwMp0wql9/CPfWR5USZaBLlMH' +
    'SLZ9EfWJ/JaBG3KTkZN5ijjdJOAXNtQPRsMNKbu+eWOtJBg0GHOAPzKIfgoSoE6oxPKaYjYO/QMCsIFCNuQeFySzl+c3lsUEoP7e' +
    'EiEbUvL1zh3nIv6hBxECfqfEziAUeIOBU8DETuvg7+izKVKPUGBBDZzfJEtGYj4kTSh08A0auMQpzalg9HdcSq9hATq4mAZ2osDG' +
    'iVQJ1ncWCTr4oxo46YV8SZtBB5eCLBsUYckw9IcAHfxBDfx3COjbEohFf0YD/yUJSJEPLvJiT7X4uvC+bWSCCW3RjHqewMK/LsHo' +
    '7N9Z6lf6fzunQzXywSUYaArPf9pNwGyNxds9AOdEmEBNVll+0AcI+PsQAVlZY/k/xRTeMj8QcKeyQF10PqjSpvXfIeB0hwjEFAjC' +
    'lAou7Cagfj0BOQIxBYMkloCAW49iYQRmNwELNYO8nYDXAjFOYVRgJujitaEvJGB1joBehwuMwPwmYKnY1gudkOqsBOSIBBZjR7F3' +
    '+i8RkGJCQl75N73STv3eSUCrpeA8SK6t11jzIOvGpTJ2hYAnF8wgHVwqCsjfSECrGEnYrTtaTAhXNh8Bp6PMEIrOgxtGTpwnoBV+' +
    'qcL0hxQBSSDg278SYbMRcMwbwQvJbgK+zgZs6Ud+1yRgx0SRi4AMoeisuGPq0zkCOk23Q0f7uzypzkPAKWoALySHDyJuOIrvHAFl' +
    'YmblcQKSXzik5rwLoeGF5CTgdDwwexcBxS4SHOhzD7rzLlRiSxTE5GTgNG+CPk9Avfd06DME/Pn1pBcIyJELyUlAb+gYeREB1a8E' +
    'AScRe4GADLmQItzQvxcQcG+I4ywBx/ftAgEpvJCM4HfMiTxOQLZxM2cJOIqvCwQcrRaHszOvQ1w7nKsQATdLnU4TcFTCF1xYVGRl' +
    'xC1jPw8TkO7lwHEC0usElJ+brfkJJ5i8gIBqb3zjPAGH77hAQLjBZZzg9xCQlSQguzyRgYGARZzg1xBwx7twgYCd0L9CQIo4TDaw' +
    'ywWa+Qm4p93nPAH7QSRXCIhscIEoTFWyyeugBKQlCdjfzaWhSAadcdmjMEVf5mME3GONXiFgJ8AuxAGncKVEHOYi5C3FbccIuIca' +
    'VwjY1V9ckYBjAQcCgVehbrGnjxGQlyVgXxRzhYDSlU9f/ie4Z+bsMQLSsgTsPa8rBBQoyMpOQPMaAu66k0sEbI3AKwTkGFOZC+Z9' +
    'BNS/0gRsn/oKARGJzoWbxt0dIqAsT0B1kYD0hiLe/4SA9paDL44UpO6LrV0jYO1EuCwERCokGwHlKwgorbWsPAG5tZcC7wQE/KME' +
    'JGRnX8A1AtbfQ0mWZUNrcC5miFcQ8Lj3/sjpryAgCPgSAqIaAQR8goAGBMwDds+wOxAQ2CCgAwGPwNyiOCABQUAQEAR8IwE1CAgC' +
    'goAgIFQwCJiLGSDgKQLCCwYBQcA/QUAEokHAJwnoQMADQCA6GzMsCHiGgChGyL2SToKAIOADBDQg4CUCoiA1FwEVCAgCPgB9y6zF' +
    'v0ZA9IRkJ2AFAp55HrRlXsU45eQdfcEfISD6gkHAVxDQYTLCVchbzh79awTkmA2TC+Pht++YjvURAgqMZ8v+Lr9jPuBHCCgdzsvM' +
    'Tg0OAu6Ed8IoUsHZqFH02Km/RkDvRDHg4mLaO1IhHyRg6m2cimEQh74Mc0cq5GsEJD/J97y1mM6WwZx51VFdb5GALFmgSzEgNaND' +
    'BwJGdaxI0hNhwAJxGAoCDvzT6QALrxAGzIZbGjM/RkBV2eTEWHnDGd//jxV4R1vSlwhYOyA1/5IE1NNAHRAwg7lTfkr0dwhIOvmX' +
    'NO8QhcnqBusb6mE+Q0Cy58xsVANmJaC4oR7mQxJQbzu4o9lswJ8MBGQ3JLE+QkDyo3vOTfFqYYCM5CjYGvwVCcjsngPkx1IETCbK' +
    '6oUUzAZ/hIDCu0yCgAZNwVmhyps0nyAg1ZXdIwGnTDB8kCwQ5Z261xOwfnJhK7tLAsIHyYwbvJD3S0BW61Wff6sOxhQ2cCiHzmQE' +
    '2ikXQv5DAtbPTNXiMmrbZEE5dCaUb05/twQkMnIZuem0IQ+SC+UrshIErJ4mIKmNv1D7prUBigE/aAS+k4CklX42fpnVGB9qscoZ' +
    'gcXM6rdKQKqi0i95GYkB+d8zAl9JQMKbi1h78DIaYejsKB4JfJkT0jwlFY0zYdeustpuhFKYovzg/wUBf4St694NDwNjYUoYgaaw' +
    'Yf0uApJO+KX4t04vmIAF+Fc8EPMmAlKZZN6GZepHAaGDPxOIeQ0Be8djm4B860kQBfxSIOYlBCR8W/duXEXcMtT9/0PhkqxXELA1' +
    '/faQL+UE61tOmP//UHhM4NMEJH3GbTf0ioE3FW5AA5fRwWVGLj4vAbmpjkCteGt8GuUEBn5IBz9NQL5f+aZ9EI1SrOI6eLPIiGtF' +
    'P0VAqqujoBvPgTTIczqYnjAUUwQUpQl4yPhLx1g4GjKLYXcsuhnQnVECVoUJeEL8NS8hiZqA0MDlsDcWTc7UAj9HQFGdAYcGvl8H' +
    '7xxSxM+sPz1h718nIPkRdYp/a1FAXkEDl4PY44Z0WigrAVkpAvqDNo5Bb30pSgGLhkrElrNymIDsuMN5mYAk+a2euFv+ABr44VAg' +
    '2aDSJwi4x/yrySfN4mdrj4fzke5yQxKDP+Up0vAEB0ghAqo9/LNCz0Xg6nRe9GOWxvZosuFUh6M20Bg/O1B6fJKAmuzmX/3lTEcy' +
    'JCz+6KiFLo3tbAjpSXrUcxVHs66nCWhG/u0IPytmIx/TK68EzucqHonxju0iyY8cneEhczfFrRFwCKDs4h9n0QzxlguCUtQbIjEk' +
    'zdGjrSMqdxjwZ9YMQNIRfpt/mrADNgFBM8itkRiZJuBRIaBzO8ErBBQzriT8D7FmF6xId5wPd4MKngINNq2CD9KG2NxOcJSAneVA' +
    'NuMv9d1ousbSOL8I6hBuF4FJOSBOXjbig5xiYJTSNZlJF3+2afoZPk3D32uTIgZzC7bOzhw2/ljZKs9dihAnIGtFFbUb0s+K1Ifo' +
    'RpAUpdD3iMC1Mj1zPBSRtMlOyhO2KrtIqvzK2spKsv5G2DXJj6mUt1mBGyJQnbGE1jlxtgFArHqvMi3+2mJuebgOZngxHWIwD4tA' +
    'eWIwAM2ugWM+CFsVjV7opQnThNPw992PRDfmS6zAM+MZRWYNTGIqVG8rYNOyJ5r96AWkwVTUFznC0YAYPVHHl10Dx1wQ2jNzfeCa' +
    'aFzkRpbZVQ3NVkrxJSzAG0VgMhY4natk9orAzBqYRMWcHphp18qu6t/rSlTt4bz0SHgIwDtEoE3GApXXT0mOMfq6Bm6/kBoXz8GR' +
    'eArO9r4HaY0Be2IexxifhwC8wxFOZ4TZ0WL6dQHoTkShCZXrCdy16J6p75SQtIGYkMejAEQd1j0UTI6r9O0vuofPCQHIjlGPMaHM' +
    'OnfIWs2DbBN0P27PzYOZLEDUYd2D9KQi6XydRbb4xzIJQJJqMLJkPQeiO/dks0FuVQFDAN4OnfJSabhpJM2/VGLskAVIbJXOKK8k' +
    'XER3g9sNcmxVhCMLfDdYIhQTKjrLNhhocw2FIdbVWLkUX/su078hYnM40WofDCs6NwyIO67r0Wgy8yrEL0HBlNw5WIhFpF4HjVVh' +
    '2Y4zvfdhzwzj8NUBejHv9ENsahKtjLmYsZAJs9knIuw3Em17Z82trec+dnSmMIRgngjF8JRqmm+16jbaZ2HzZyLPjKHPYDf0/Bua' +
    'i7bVb+p4dIMY9LN+SEwJz/baVZovPrVxGkL+/ZRLhrenEe7oz0zcjEAr3DNIt4fMN9s5qzgjU8hO6MqdmQCZTwP3UWWiL/FvsEUw' +
    'FP92JSxS8YlIUK7mmzVaSSmVtpVz505ByKaB+bYXtFUC479p8ECeDAbGimKOTx0t6YD85jVffO9t2tU+9IDVaMV8UAlHqw7YFf6x' +
    'An0VOsK/He5v0hkaBT0aQZ5AKiNHrjCwBP+CKHTvubMdo/GTom30QJADeQSp4miSDvIlhpLbIqf8MY9rvGsP5tv8SydyKBTww55I' +
    'MhxdG1juBAFVCWUWVALyuQBfD/+l3wWNIoSHMWYBouHoMxOYbal8wjCNyHbp610mgkhzmqMI4fFYzFR6Fd8Ebl8g/nx3oW/s3cM/' +
    'Q3fKf+Tg3hqLaYSgPEA/XS6bQGdBlc34S9+ilHj5NGbBvMkMjO9DvYV0nx52Jek3RYX69yRdvVr1/elJ/g0eMHLAzyphtjW2rKHg' +
    'tiK2qmwulYUBI52m3453gcIAfAnGDINb37Um9ZtkHyf33KVYuMSR2UR73gUYgO/BvkPkKO/6heaRGaslK67Ehmp8vR2AMZLGyxfn' +
    'TvWl6XFAVkfEjQZWuvyeMiGVNsaaBlpJwelN+6e8N4TGAtC2exs4+e2hFEcR4EsdkT0bQkhYnHobAbtgZe2ARFPAVou99hxFDcyr' +
    'QLcdkZF7qb8WJaAdXo/aAOwRGAJ8vzdBTgxBBO5xhflLbSI1iiu2EHxKsM4SIDsfd2ilRwr4NQzkBStJcxFwKMGSQkrVQNY2aE09' +
    'clQW9xHA3bNvgDuDMWVqWa4TcBizcP3m+gS4Qw3gu4Ix7rXHZDQej+oDxmSO0wYvHOCXaWHl3uwa6lwBu7GqgUAAvs/MetGc7l62' +
    'EUIZr42+YQKRqP/cQtT2HxuikAduWOM4pPfKwK3jJG+7k05XMqG0saPD0ISY25i5G4fIWKulYPu9kOkZKeTfqxn49K1QLrWd8n62' +
    'O6OGmWgO2Bq1Lwg41T8y8O+V0NWzNXKtGBuyzuFsPyZ0YhBX/c7sSYOICvx7OQMfPrGPMGlWqly2+1M2ODhFO5EAebEn8iADCVd7' +
    'eJbkIN/RhQ7+fSIac7Mn0rLvOpyVdOXJwL9vQD7gCxOuq1xw0XL8aewm+Pd2GSi8PiUSuKa/7LZ7W17Fssi+RXdUeK9038hh4AUM' +
    '5Ct5YalIdgqueh0XYWaVqV0XnbOI/32BgeNQjlm+QOYuYKKiCPu8kwsD+ecM8h/fwDR1L9RYwhmeTQpuD7nMoYh/01kSTkP6fUYK' +
    '6tjo7saTdKY9mOPqVuZ0O5KDGsh0lon6Qf9+B2M4RgRpVmoz9ABnCrnsCcrwKf6HY0C+BRGf99JpZyNOW1P0Lvb1ZaeUvbvZAFh3' +
    'RVwsINhr56EZney9XEmf18sJL4Vg91+E/77HwNEQnO3eUFJidV8KlaqFGmOJzWT9UqLPNl3KTZNI/R89lHD5LET58zch45P2vMkE' +
    'TSXU5uYSsn4O6zV5V/Oua0wKIuaEti30pvzUOKAwxoig8rIiZHY4QlsVSqOnebXDFCIiKYfUa1qBSSBnyfzb+/GGAubfdxWxik67' +
    'nY8NHA4REYL36Id4VJsnipwKMu+Su4PDhOzHlw3BaUgqj2zuA/Aszy3xDfX7JyhIddySkk+wr/O9d3FKYPzanxGC1ZhKJYGB6G5m' +
    '3+5BcP2AdSR//wiojk5TqS3B+yioDwzBbCyE5s4Emn//jiXoBl9k3NPa76XqHvZ1mZf9ZOJ7xuQDnyKhjIQEm0PT9U3sO/K6SMy+' +
    '+osxQT0GZKI/L2T4HZ0ATDqDQUP8/T1wE5+rx0xZp/fgXdruwCZYf39NCdcWfW8KBuKFlFLEmh+uPOy9Xwny/V1TsKagnW9xc56N' +
    'zJtv02cKvroSHmjfvx2SkVOpZ0DBjEXO+mS5IZHOGYSe/3pIhqo2/DcTNO1YF2kvRwaHYffk+I3V4q85Ig7W39+nYBeBjphaF0tO' +
    '+zlXpxhUiz8Yf/+TLdgeSRmN15yrPJ2qDM656LaSFNLv/5GCncln4vGOWhAeIqFR4tqBX7UbrqB8/zcOMmVro385BqM/OaGpRd1k' +
    'oa25x+nFAfhEWdDvfxWDzkUPRx1mPFPGh9JUn3bWDmfNbXaV7DAHjELk5f8Nywiz43zetk9jAKU03yFfhCvYfv+xFGyjL0I9535S' +
    'Bu6Bgz/6JAvAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AASdPf8JKGM8iuy91YQfOiKSMH6NhISdm6pG' +
    'xgUJl8b/29BSXGqtUreXY21eBB2fX+Zc3gOVm7Mpnd2zaq3sa8+QdvwK+6SpnD51q8ePKZS3su/q2rwL0kbnpVib7wnrFetmpFmy' +
    'm6yXjhUaj0A/RUC2b3iWT0B1n8ISuoqdeFg/slbik2KR0OVQ7z2H7x0RfcOJvmSP5JoGm54iIBHTBU4RkC+1gZv9daY1biJgMOww' +
    'JGB3EM53jyKZne+S7zjv2UGqmwTkgTg+QUASPIo+PqWA9Ie6NUduWqOkFA20f0xI+yOp9DR+Vd+xSSIQugEByXBKmf0kAwkhwb5n' +
    'PM82tKe2CSjdVQLaywSUkcO4vJMQlSeR1J0EDE5j9AlIvGVTnxSAJHg4m9OSINR7cbevXNsD6hIBGz11kYDdDVi2sj7Kv2Z/dKe5' +
    'SQWruAQkk56xH1XCnt3jdLFr71udizZgravcBQL232/CAZMrBCS99WLusv51lIC0iPl0K1gQU8i7nJNW3ENA4t3LSQLSKxKwEyd2' +
    'dq7lmgSs/6xzK41dL/NfIyAtSUBzTALSqwScGH+KgDayjR4B58tDm8/T2wVFoII9w5eCgH+AgOqXIuBc4z9NQDJFMdw3nZCQgCL3' +
    'hEVzzL25TkBzhYA0xqcUARvGstv3Kdglaj/ug4CA/tdHxIgXHpKxf2Q3jUWlq4Hoqg9EExBw3XX7BAFZ7HuTBGRNZvZZAjapOKU+' +
    'XKEAAk6OZqxmIklAYp8n4NcBAnryLGLIpwjYhKlfQcAv11CCgN42kmME/N04Fx8S8O8TMIqAgOQN+/R/E/DYs295wWQt1pWBgJlE' +
    '1Wom5GZhSM+IiS8cW7ePgM0BVzuPtWo+SfaHYboLd6u1QwKm7yMqAf0bKknA4JCc5ksTT7DvhppV789bnF7O+C4Ruv1W7FqIdqeH' +
    'c/PueLl2EJAKbay1lbX9Mc4rd97WlDafbD9IgkwIib6dzVmq3eclS0vA/tOmreK2Rku2j4BMtqcTDqeflyEg6VepK02o/483hd31' +
    'd5K1J6j6FUpIrnEtdXsCXZyApG8UkWammYcfjwcp98fWJheC8GE/mqND6fRjXTDMvUlAriuvVM9Vai32T4T1P2nq5U9KwPnneVIC' +
    'UjVrIDB8g4ANEcz0DfbcKXK7JGDXh9ImUprDY6e7CELGcvYEVq6/zc3aTIuj2boK7hpFmhj6/MfNLfUVTkz7Ve8k+iBU+V9Z/7GW' +
    'CrU0rC/vSmYcN3LBtG9dMkqNm6mi+8CH2tz67W5X2hmackLEWMvbyQTnlJ/vDAUC7d8COx236pwmaQlI9IyytAgB/Xr5hoB+Yb8X' +
    '1xH98hntnRi7onP4bG3qrYlLQCqG9zIgIJ2Oim8XYlb3HpVnsr8/q1X/yz0dXdlKhzQB+yL17hRcqqby7/kHx2e0gja6uHlt3NT1' +
    'tCDgSA7dnNRL20PPnY0TsNnTrvGBt3p+2G63WEjiyx626Lk6Uzu1RUAeHIXNCBHRrR5eZNlYYWQs1Y131alRyEfWZiIgkZ6AnwhI' +
    'pAlKw3/UzvsflxtIhh7JVk8QOV+6hwjYM47P+Nirmtj9j1KJBl2f4daTiSnjpdmsNyAI9/ayg8xI4ebloONlnWkMygUDT5SPbhCQ' +
    'VC7sqREu1mRDbMi3sWPGieUlAy4s1mYiIPNbpCYCBj+uCciqRf+tm0epxoUT8522pm3GYg8QkAz8E5OboeJdbqM8U20wt7MxlFuV' +
    'PePzsiGKT/zq8pkEHPa0TzrUvzCSW64RULNRhblg83JLQCZ9/UbnrcX9xvU3bAlZOPwL2TLyz/NITIyAtc9gYv15/o9r5dWbLiZY' +
    'CB7dv5HFU7OJra1AIQuewpyQgP096OCFj8bZVK8hDPFr1TwZOJOAugoo1TPQrkjA+VZ52zdTwtNGNXZWo8HC1pQTSniHE+IZfdTU' +
    '4qc2ombfN7xCnuBRa81Ew3ur/LWhdqUnREfrAT2jryZe7cOQWY9O0MvitTZNnu+4G6Vrvte9YB5Tt7JacmfaARZECOiaDSHj0WIe' +
    'b0oSkcZDs+KteBJh+idffhxWJV4mZNULnpz9mg+aTo8ysEIvScVW3gke0zFTx+i8IJUtVXD7MkftmbWFoJG+v+kbVdlgNl3vOI29' +
    'oTTyChEbzX8Rv+mYxhIebM2FCAioFgT0rqzXrtBq96VslSUI6Cth2Vkgrds0+Onj9/skiYec6Erej6w0ptMYAcOF4F6g1ka13fiM' +
    'k1RJGgn3EFBFQ3LTI7ClAJ9H5licgGb0VMmauosSkCy884VuX9kmcX5iwi4CunkzVL1/yoyB6HHRvF2fFlJGLzV38+RZAm4vxHQr' +
    'NLqW8hEC0hX+68UrStdjLXZJQDIqmWrhEcQzIdItRTGPv56eDRiQe7qRw37wMQKuZAx0ROSbmBHIVl8UtkHA2d15CxH/uCFLNR5u' +
    'oL405uQyAdUY6fC30lN+Zu4vRQoAopkQ49bssXgmhPbuG40SkG3mgoPFPGxS78mEqK3xBN07Fxb8R/Z3ijIsX86VahhSxb96rSoj' +
    'tiOjRLDkF7sX+4QNOMiMRbO6mj/BJF1EwjqPiNblc62k4towmGG/CwRUNxFwrYiiTYOoTQGzNHC2CEgPEdCLTNhJAoo4AeWjBORT' +
    'GjKEDpWf303OEgSkSzPE/HYSsJnKyEL3ZnxpdxLw/GIeI+BqTQqdzbIkEwG9dWBux8t5iYAqQkD5RgIqtzknj87tWrpq+/gETJgW' +
    '+wtSjxGQPE3AwTOJro2JuKPmTgKu7OCzKtjsJqDeQ0DPCbHrztVOAhLm1ZXcSEB5noDzJ5iKCAKy7Xo5sxOQbxDwNifEM+K8qS6m' +
    'Rlci5kObIcaVKrmKEJBWZwlI+q0Lsv/lVbDLSMCucLAdG+siCWp/sEMpAqas8nDZ9e1hGI+AweNGELOblyEILxpFl+GE5X5uScCx' +
    '8MmabxJwKJRqiu0iEjA1W6kgAeMRoYRDdCsBtzpxaKpkJ0JAnij+ShKQDIVPTVEv/yQB6VAlYBUnERuQVY9IwHhYn90TBlwhICtG' +
    'wNHnd+oIAcdy4q6M+DABq5IElLsIOJaWdwNYIwTkDxGQmMi11U1j37YIuMV/touAk3oWiXFOqwSkQ1jcCjKzm79CQG6m8vqupCxC' +
    'QFcd9oJtBgJ6uRD6m9WLOXlXu98KAbdyV8z3B8gRApq9gWivMIOcDERnIeBqGEZu5u1HhducgUFmYZhIcMmeISA5TcBxPd2QufMq' +
    'BH/3S0ASKlay8/dFgoBkQab9mRDp5afI7QSsMhBwLIo3kXhojIDLC+1QwRcIOBZdu3ZCNmFDGE78niDgLyxg2ktAtYeAPFGbR5PF' +
    'CP6dfIuA4235vRgRArLElPayEpB4XYde/5m5YfohjZ3SQLwAyoYO9qi6/GSEgCwhMaME5LHswLcI6IlwkpKAtKpWqxq2COiuScCm' +
    'dc75B/E0kSJ+x2CFaEl+UEsanf8UWciISIsQkCaOUogQkEw5Gel9+eFccAYCurMEnB6LRFNxsbipTUUIChCw6ZJ1RozdJOc7+bOk' +
    '4oLmVhudhMHYwqhb7lCEgGHRMtmUgCxCtY8RcIg8uaD8YqxLMRF6LNVDUQnYpuja+m1CaFNyQu8bKbNRjhV3xFsvhS506nz9I2m6' +
    '4OQXnVjkRdwwoNojKlieJKCuYqVtSwL+wtd+ZZ9cCQK2N0N+Yenn7QQMC+GrlBKu3bqhIJVEWwPXCBgeTDK7cIyAysXk5bsIqJIE' +
    'HN/lbQImXvsdBDwfB2wW2alnJmmtHXVCZ31VwaSk5rH58DexQlUSPymJ+IU2YYxHRwg47pPzO2ZEXI0/FIjeSUDfmPFsW73y2oct' +
    'hmqFgDnCMDxtYdxHQLry6g+zOQYLUYSF5DYmRAkJlTOJRbtaYnbnVJPA3JoikhMB9W+cGkbtfRLwUE9ImoDj+0m8MuSgMJfGCn3a' +
    'tXEFCajjN3/PdMGJJbMR3eHpk5Xqa5Kb/mY3e4H82sFxJFk4JIV5A3CDoR08OstDjx/3CCCWwa+uWqccAYPuen2yGEFXiYRQ1zZE' +
    'PGcg8jZT78eNpCJZCUi9sT6xeqfbCKhWk2xVd4auVsPgpIqtbFLVDvUilIqgpDW4dji+wohmCBhT4QQTGrsL1U72oYFsbhZ4FK+r' +
    'JyWps02uZM9YBe2SiXuPbJZ3g/v07FnJEPSYHTormmGWTK6szToBvTbANQJOcya8JbbDeMCm5FMr2R5fXpaBfG1wCgklWx+cjI8W' +
    'CcYvuXYqUGvWekuvOSdxao+/VXEvDsY5W4RtmvCUNs1teNNPZL0/cpFBnLVlmkTCOikAWVWlco1zqzb6ieCFs/14NjstvGFMj4tP' +
    't9fGjB0yvpkdPDGNB9FIpEKTeJGuyBdbVTgbsp5/HKeiLW+Lr+U6q1Dq8YC9IuKd+FdlP59sg0UQ+Wx9pUCEjO+Dp6/ZLGh0rrqN' +
    '2mq1/DqmKlq5QhKe9EgXGsg6b9Ici1KBhR8fBXwkDUCC4JX/xgXvkxfXT3ZeuG7YSDFIt7o19cbFWkOcZYsPksgHRSBe61efeQux' +
    'mJzmmjy9Tysrl6zqv58Ham0cekb9H1rmDYnWcz2+S/xRJua3WZsXi49x/0PtCMPFR/T8aRUJos4etcmc9H0NwyS7mqXk/R0Gx42P' +
    'Kobw6EIQyk3EWiebHWg2mxBcnIRBkj2txBulOG1/dFQXmc+f1dOwUNcYhjzcd6pnr5kkXquiUcLrwwxPrO8mzPp72vGPmsUE3P7X' +
    'gwltzZ93zZknQePG9MvhnNXFtzobyeAHDHSuq8nyBrWEh7TPBprO10YODZ7Mzm6we+L6lmI/bm7ChQthooZnVADn4Z8w1uowbrF9' +
    'koII7tuspginEcjNhDLWmyJNTlvxmNDxDfFhWnJjzVstGFn5aNPdzcY9dVOBZ6e6/HW0dkjoK9/A3l9jSav578UsFVaF/2htvKFF' +
    'mCnHL4aaT9P/ZDHzuBkwOyx6tzZkWBsahPSHMvH+JtXcIuh+rAeaWf95vDulWwzM05mpQlNsRv51sUCFVFo3TpFIqi/CRPs5OfVg' +
    'c8nXf4V2H1diCsWoMdqz/KgJrtzOfa9/d9JddA6y8Q+bKjiOzQ+tTZJW7cN6b1f7MxV9pQnvPi7Z4IbS4UjCSYutfHNwT+1RD+G9' +
    'kuWdUr3BwBydcf4Uv80xdb7aXimDWS+QSV5g83f/1DlAO53tvetBSt1AYyS4oB5rZoWSTAJwroH2tZ6Q57YCuGHRuxMzRC11W51U' +
    'w7TnmbisVqCJ1E3QmSMJ/I/oYhJs5q7WTrM0u4el7KB5LE2l7un9BN4MPqSYCfnNzrAZ86kuAwHVPGY+FZVoqL7/WP6tNp81PGG5' +
    'JOBsxmYbEeTzbkfgP7QAbSR3uXQdckQCp5SCaE/DU31sTWAX/ncFnCj1YSuDf075waOTbafWO02xCf8zVJWWgCynkzClLduAj+tq' +
    'HaCA/2MFPFRmr8aBu2qVXFqy1rtj8jJ9ZC3wfxFwbSJeV+yYa0hqWw3Z9N1xxihUL/ALjv+LZWS6wi6e8xvjfwb+UzCXyrZxpCmA' +
    'wpj6Q7vBcWPfVHPoobtlQhbwX2vhqXxQ+07BOAseYTqgLAO9cnarpeCNkyCUGeUiTDWgLAPFakFqIxPBP6A8BU2sDloyLA1wE6iY' +
    'QsSVtUNbDsQfcIsI7P5L2+FsbCzu/6+XhBxYuf/qkQHgz8vC/34VmJBShCYwE8IbqMM5Fx28aaqi75ojwv/s4uJN78Ps4vUPh+sl' +
    'dqD+TSn5YoJE0w6oYgZ78xRylnAn3fdwGrstiez8K8BMN4gmKBVTzquKHCaKOOeCg14M6Q7HdOv1Q00DTn/xxdHjTVvYao68ab5v' +
    'f1PR6N3OI2ZNr6NrpyUEV+mHvdjZVWg79KY9SAR4GG0C0phZFYbyy3LZ0F1t/X4C1bU30/moOR9tWW53cV9mNYXB7TXt+mEzrura' +
    '0MNhz9Pdhjn7ttu7O1ZRLL9o8WPTfNgi7/UG+deNI2xKtuUaAZueAtY0EwR94LQbXKBm3feB/KtZJClpJ6TZcKCZjjSehxK4naDH' +
    'VDB8gzWzglh3wWAkku0mxbTHjAU/d7abRxcQljUiuf4w2nOehx4b8QOzSs0bE9j8OI228UrXP3er21jToqntaP7ZBNKmIWDSAG+q' +
    'RmjETjfDXTS93Z7il2N9iQwqTcgwXlsGclr281PBv4JBhhUsBWC0PjywAaME7MQO0269hYZ3E0mHmW0kJGDKN6zFatfRH94y68bL' +
    'DxcMToZn/edNILtrCdj2PzaloNOPRTf2KDZbaxt/hSFdFLIBj0N4qL3U9n8TVAitxy77EHZE98cZi8TKNOYdBOyHaq7aUe0hEdKz' +
    'unxeNIMfa5A10elaQoU73g4A08OftT9Vd9Tw7Zd6RzHbTvC1rpIILUYdcYKZXUG4qHqCvwne9ow7N9vUcdMZpc9SmXW8mqi05M/4' +
    '9LPJqWcw/u7MYZDRAiCyTwK2U8zsWgKddG7KpOoDAib7D4ntTnrj7eOzCKPbi3PfpiP9GCzhD/eZCCicPyWFNQOxnBVRp2kaUHtq' +
    'kWcDeK1H2pGmWyGot2rTcdJSIDwDSRmKRz2DMWIhAeVZAgYnSKxIQOFZb4cI2PZuhyXqPrkWBDS/GAEHG7AloP/o/Xnq82dnOo6l' +
    'nAvkWy/ShhFZf0tXFw/CRNwBssMJGURgottFjC5DTynfBmQJFdzRtTb0BPN55qng3uybXgRLyVLstrqeDG9UeK5K55qjV+dh0H6w' +
    'MSGbBHSHCdiZZq0wEIHTSmyVjsDJ1jQlHYl5IHFZd8Ha/vSOJNPjBIrAOekI2P94djAGibj6wO3qvQ24tRtGFTshAV3yKAY1TMJh' +
    'i7CdSlYD0D5yTEICNjZad7fNxFwRxqdZ7+zM4j1tHLvJfPiD8jjrHxIS8HEK1g6nlbxtSaDBJC96nYBdfJgxOWv22pSArfWn698U' +
    'JpgV1d1td0HtM7hp6FHtUzgTRrxtbRk350Mbz1mSzqr2IgaG2vNK2IwToUkyDOMik/1NmoBDztXNzH1Sua3xE6KfJ+FCO42awdsM' +
    'w9/TrHE9P1qmc1CDmVCyO1rFQQO/Qga2FeJWB+6stGaevrcyosDnH1t8RDaVv7Np7T+i7Wb3a3esvdWzaEV9t3Zxt61Wbc6Vss1Q' +
    '8uBAxS4QMj8AhrWHUGnw7yUUpMvRDQsLLRpX2BFsILFJ4tu/R/o53zFqruSQYz9fDYg0z4ydf5c/cuYDJ22oy0EysvIjcuQGYQAC' +
    'r37lAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAgL+Lf1yGQcnSJXX0AAAAAElFTkSuQmCC',
};
const APP_ICON_BUF = {};
function appIcon(name) {
  if (!Object.prototype.hasOwnProperty.call(APP_ICONS, name)) return null;
  if (!APP_ICON_BUF[name]) APP_ICON_BUF[name] = Buffer.from(APP_ICONS[name], 'base64');
  return APP_ICON_BUF[name];
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  // CORS (so the storefront can be hosted separately if needed)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const rel = url.pathname.replace(/^\/admin\/?/, '') || 'index.html';
      return serveStatic(res, ADMIN_DIR, rel, req.method);
    }
    if (url.pathname === '/investor' || url.pathname === '/investor/') {
      return serveStatic(res, PUBLIC_DIR, 'investor.html', req.method);
    }
    // App icons: the file on disk wins, and the built-in copy covers an upload that lost the
    // folder. Without an icon a phone refuses to install the app and offers a bookmark.
    if (url.pathname.startsWith('/icons/')) {
      const name = decodeURIComponent(url.pathname.slice('/icons/'.length));
      if (!/^[a-z0-9._-]+$/i.test(name)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      if (fs.existsSync(path.join(PUBLIC_DIR, 'icons', name))) {
        return serveStatic(res, PUBLIC_DIR, 'icons/' + name, req.method);
      }
      const buf = appIcon(name);
      if (!buf) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
      if (String(req.method).toUpperCase() === 'HEAD') return res.end();
      return res.end(buf);
    }
    // Serve uploaded product images from the (possibly volume-backed) upload dir.
    if (url.pathname.startsWith('/uploads/')) {
      return serveStatic(res, UPLOAD_DIR, decodeURIComponent(url.pathname.replace(/^\/uploads\/?/, '')), req.method);
    }
    // The catalogue Facebook, Instagram and Google read on a schedule. Public on purpose:
    // their crawlers sign in to nothing, and every figure in it is already on the shop.
    if (url.pathname === '/catalog.csv' || url.pathname === '/catalog.xml') {
      const base = siteBase(req);
      const xml = url.pathname.endsWith('.xml');
      let body;
      try { body = xml ? feedXml(base) : feedCsv(base); }
      catch (e) { console.error('feed error:', e); return send(res, 500, { error: 'feed unavailable' }); }
      res.writeHead(200, {
        'Content-Type': xml ? 'application/xml; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `inline; filename="catalog.${xml ? 'xml' : 'csv'}"`,
        'Cache-Control': 'public, max-age=900',
      });
      return res.end(body);
    }
    // Shareable product link: /p/<id> (an optional trailing slug is ignored, so
    // /p/12/ajwa-dates reads the same). Unknown or switched-off products still open
    // the shop rather than a dead end, so an old shared link never breaks.
    const share = /^\/p\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (share) {
      let p = null;
      try {
        const found = queries.productById(Number(share[1]));
        if (found && found.active && found.status !== 'archived' && found.status !== 'draft') p = found;
      } catch { p = null; }
      return serveShell(req, res, p);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return serveShell(req, res, null);
    const rel = url.pathname.slice(1);
    return serveStatic(res, PUBLIC_DIR, decodeURIComponent(rel), req.method);
  } catch (e) {
    console.error('Server error:', e);
    send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('\n  🌙  Jeddah Trading backend running');
  console.log('  ───────────────────────────────────');
  console.log(`  Storefront : http://localhost:${PORT}`);
  console.log(`  Admin      : http://localhost:${PORT}/admin`);
  console.log('  Sign in with your owner account (set the password on the Settings page).\n');
});
