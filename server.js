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
const { db, queries, getSetting, setSetting, hashPassword, verifyPassword, ALL_PERMS, logMove, nextPoNumber, logAct, newReferralCode, recordInvestorSalesForOrder, reverseInvestorSalesForOrder } = require('./db');

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
  '.webp':'image/webp', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

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
    const revenue = investments.reduce((s, i) => s + i.revenue, 0);
    const profit = investments.reduce((s, i) => s + i.investor_profit, 0);
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM investor_payouts WHERE investor_id=?').get(v.id).a;
    // profit over the last 30 days for the chart
    const series = db.prepare(`SELECT date(created_at) d, COALESCE(SUM(investor_profit),0) p FROM investor_sales
      WHERE investor_id=? AND created_at >= datetime('now','-30 days') GROUP BY date(created_at) ORDER BY d`).all(v.id);
    return send(res, 200, { investor: { name: v.name, phone: v.phone, email: v.email },
      totals: { invested: totalInvested, revenue, profit, paid, balance: Math.round((profit - paid) * 100) / 100 },
      investments: investments.map(i => ({ id: i.id, product_name: i.product_name, batch_no: i.batch_no,
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
    // recompute totals server-side from live prices
    let subtotal = 0; const items = [];
    for (const it of b.items) {
      const p = queries.productById(Number(it.id));
      if (!p) continue;
      const qty = Math.max(1, Number(it.qty) || 1);
      const unit = p.sale || p.price;            // active flash-deal price is charged, server-side
      const line = unit * qty;
      subtotal += line;
      // snapshot cost so profit stays accurate even if cost changes later
      items.push({ id: p.id, name: p.en.name, name_ar: p.ar.name, price: unit, cost: p.cost || 0, qty, line });
    }
    if (!items.length) return send(res, 400, { error: 'No valid items' });
    const isPickup = b.delivery_method === 'pickup';
    // Delivery fee comes from the chosen zone (authoritative, server-side); free over the threshold.
    const freeOver = Number(getSetting('free_delivery_over'));
    let zoneName = '', zoneFee = Number(getSetting('delivery_fee')) || 0;
    if (!isPickup && b.delivery_zone_id) {
      const z = queries.zoneById(Number(b.delivery_zone_id));
      if (z) { zoneName = z.name_en; zoneFee = Number(z.fee) || 0; }
    }
    // ---- discounts: coupon + loyalty points (all validated server-side) ----
    let discount = 0, couponCode = '';
    if (b.coupon) {
      const coupon = queries.couponByCode(String(b.coupon));
      const chk = couponDiscount(coupon, subtotal);
      if (!chk.ok) return send(res, 400, { error: chk.err });
      discount += chk.discount; couponCode = coupon.code;
      db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id=?').run(coupon.id);
    }
    const cust = currentCustomer(req);
    let redeemed = 0;
    if (cust && Number(b.redeem_points) > 0) {
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
      (order_number,customer_name,customer_phone,delivery_method,delivery_address,delivery_area,delivery_zone,payment_method,payment_proof,subtotal,discount,coupon_code,customer_id,delivery_fee,total,notes,language,items_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        orderNumber, String(b.customer_name).slice(0,120), String(b.customer_phone).slice(0,40),
        isPickup ? 'pickup' : 'home', String(b.delivery_address||'').slice(0,300),
        String(b.delivery_area||'').slice(0,120), String(zoneName).slice(0,120), String(b.payment_method||'cod').slice(0,30),
        proof, subtotal, discount, couponCode, cust ? cust.id : null, fee, total, String(b.notes||'').slice(0,500), b.language === 'ar' ? 'ar' : 'en', JSON.stringify(items));
    // decrement stock for confirmed inventory + record in the stock ledger
    const dec = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?');
    items.forEach(it => { dec.run(it.qty, it.id); logMove(it.id, -it.qty, 'order', orderNumber, ''); });
    recordInvestorSalesForOrder(info.lastInsertRowid, orderNumber, items);   // investor profit share, at actual prices
    return send(res, 201, { ok: true, order_number: orderNumber, id: info.lastInsertRowid, subtotal, discount, redeemed, delivery_fee: fee, total });
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
    if (r[1] === 'me' && method === 'GET') return send(res, 200, { user: me, allPerms: ALL_PERMS });

    // overview stats
    if (r[1] === 'stats' && method === 'GET') {
      const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
      const newOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='new'").get().c;
      const revenue = db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status NOT IN ('cancelled','returned','refunded')").get().s;
      const products = db.prepare('SELECT COUNT(*) c FROM products').get().c;
      const threshold = Number(getSetting('low_stock_threshold')) || 5;
      // Low-stock uses each product's own minimum where set, otherwise the global threshold.
      const lowStockItems = db.prepare("SELECT name_en, stock, min_stock FROM products WHERE is_active=1 AND stock>0 AND stock <= (CASE WHEN min_stock>0 THEN min_stock ELSE ? END) ORDER BY stock ASC").all(threshold)
        .map(p => ({ name_en: p.name_en, stock: p.stock, min: p.min_stock>0?p.min_stock:threshold }));
      const outItems = db.prepare('SELECT name_en, stock FROM products WHERE is_active=1 AND stock<=0').all();
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
         ingredients_en,ingredients_ar,warnings_en,warnings_ar,weight,dimensions,video_url)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
        String(b.weight||'').slice(0,60), String(b.dims||'').slice(0,80), String(b.video||'').slice(0,300));
      if ((Number(b.stock)||0) > 0) logMove(info.lastInsertRowid, Number(b.stock), 'manual', 'initial stock', me.username);
      logAct(me.username, 'product_add', b.name_en || '');
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
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
        ingredients_en=?,ingredients_ar=?,warnings_en=?,warnings_ar=?,weight=?,dimensions=?,video_url=?,updated_at=datetime('now') WHERE id=?`).run(
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
        b.video!=null?String(b.video).slice(0,300):cur.video_url, id);
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
            db.prepare('UPDATE products SET stock = stock + ? WHERE id=?').run(it.qty || 0, it.id);
            logMove(it.id, it.qty || 0, nextStatus === 'returned' ? 'return' : nextStatus, cur.order_number, me.username);
          });
        } catch {}
      }
      // Delivered: award loyalty points once, plus the referral bonus on a first delivered order
      if (nextStatus === 'delivered' && cur.status !== 'delivered' && cur.customer_id && !cur.points_awarded) {
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
      if (TERMINAL.includes(nextStatus) && !TERMINAL.includes(cur.status))
        reverseInvestorSalesForOrder(id);
      db.prepare('UPDATE orders SET status=?, payment_status=?, courier_id=?, courier_name=? WHERE id=?').run(
        nextStatus, payStatus, courierId, courierName, id);
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
      const qty = Math.max(1, Math.trunc(Number(b.qty_funded) || 0));
      const cost = Number(b.cost_per_unit) || p.cost || 0;
      if (cost <= 0) return send(res, 400, { error: 'Enter the cost price per unit' });
      const pct = Math.min(95, Math.max(5, Number(b.investor_pct) || 50));
      const info = db.prepare(`INSERT INTO investments(investor_id,product_id,batch_no,purchase_order_id,qty_funded,cost_per_unit,amount,sell_price_ref,investor_pct,invested_at,notes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(v.id, p.id, String(b.batch_no || p.batchNo || '').slice(0, 60), Number(b.purchase_order_id) || null,
             qty, cost, Math.round(qty * cost * 100) / 100, p.sale || p.price, pct,
             /^\d{4}-\d{2}-\d{2}$/.test(b.invested_at || '') ? b.invested_at : new Date().toISOString().slice(0, 10),
             String(b.notes || '').slice(0, 300));
      logAct(me.username, 'investment_create', `${v.name} → ${p.en.name} ×${qty} (D${qty * cost})`);
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }
    if (r[1] === 'investments' && r[2] && method === 'PATCH') {
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
      let subtotal = 0; const items = [];
      for (const it of b.items) {
        const p = queries.productById(Number(it.id));
        if (!p) continue;
        const qty = Math.max(1, Number(it.qty) || 1);
        const unit = p.sale || p.price;          // POS also honours an active flash-deal price
        const line = unit * qty;
        subtotal += line;
        items.push({ id: p.id, name: p.en.name, name_ar: p.ar.name, price: unit, cost: p.cost || 0, qty, line });
      }
      if (!items.length) return send(res, 400, { error: 'No valid products in the sale' });
      const orderNumber = nextOrderNumber();
      const info = db.prepare(`INSERT INTO orders
        (order_number,customer_name,customer_phone,delivery_method,payment_method,status,payment_status,subtotal,delivery_fee,total,notes,channel,staff,items_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          orderNumber, String(b.customer_name||'Walk-in customer').slice(0,120), String(b.customer_phone||'').slice(0,40),
          'pickup', String(b.payment_method||'cash').slice(0,30), 'delivered', 'paid',
          subtotal, 0, subtotal, String(b.notes||'').slice(0,300), 'onsite', me.username, JSON.stringify(items));
      const dec = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?');
      items.forEach(it => { dec.run(it.qty, it.id); logMove(it.id, -it.qty, 'sale', orderNumber, me.username); });
      recordInvestorSalesForOrder(info.lastInsertRowid, orderNumber, items);   // investor profit share
      return send(res, 201, { ok: true, order_number: orderNumber, total: subtotal });
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
    const SETTING_KEYS = ['whatsapp_number','store_name','free_delivery_over','delivery_fee','low_stock_threshold',
      'announce_en','announce_ar','contact_address_en','contact_address_ar','contact_hours_en','contact_hours_ar',
      'pay_account_name','pay_wave_number','pay_afri_number','pay_qmoney_number','pay_bank_name','pay_bank_account','pay_note_en','pay_note_ar',
      'est_delivery_en','est_delivery_ar','loyalty_earn_per','loyalty_point_value','loyalty_max_redeem_pct','referral_bonus_points',
      'chat_online','chat_welcome_en','chat_welcome_ar','chat_offline_en','chat_offline_ar','chat_upload','chat_hours'];
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

/* ---------- static files ---------- */
function serveStatic(res, baseDir, relPath) {
  let fp = path.join(baseDir, relPath);
  if (!fp.startsWith(baseDir)) return send(res, 403, { error: 'forbidden' });
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(fp).pipe(res);
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
      return serveStatic(res, ADMIN_DIR, rel);
    }
    if (url.pathname === '/investor' || url.pathname === '/investor/') {
      return serveStatic(res, PUBLIC_DIR, 'investor.html');
    }
    // Serve uploaded product images from the (possibly volume-backed) upload dir.
    if (url.pathname.startsWith('/uploads/')) {
      return serveStatic(res, UPLOAD_DIR, decodeURIComponent(url.pathname.replace(/^\/uploads\/?/, '')));
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    return serveStatic(res, PUBLIC_DIR, decodeURIComponent(rel));
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
