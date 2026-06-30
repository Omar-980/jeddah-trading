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
const { db, queries, getSetting, setSetting, hashPassword, verifyPassword, ALL_PERMS } = require('./db');

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
  if (r[0] === 'reviews' && method === 'GET') return send(res, 200, { reviews: queries.approvedReviews() });
  if (r[0] === 'reviews' && method === 'POST') {
    const b = await readBody(req);
    if (!b.name || !b.text) return send(res, 400, { error: 'Please add your name and review' });
    const rating = Math.min(5, Math.max(1, Number(b.rating) || 5));
    db.prepare("INSERT INTO reviews(name,location,rating,text_en,status) VALUES(?,?,?,?,'pending')")
      .run(String(b.name).slice(0,80), String(b.location||'').slice(0,80), rating, String(b.text).slice(0,600));
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
      const line = p.price * qty;
      subtotal += line;
      // snapshot cost so profit stays accurate even if cost changes later
      items.push({ id: p.id, name: p.en.name, name_ar: p.ar.name, price: p.price, cost: p.cost || 0, qty, line });
    }
    if (!items.length) return send(res, 400, { error: 'No valid items' });
    const freeOver = Number(getSetting('free_delivery_over'));
    const fee = (b.delivery_method === 'pickup') ? 0 : (subtotal >= freeOver ? 0 : Number(getSetting('delivery_fee')));
    const total = subtotal + fee;
    const orderNumber = nextOrderNumber();
    const info = db.prepare(`INSERT INTO orders
      (order_number,customer_name,customer_phone,delivery_method,delivery_address,delivery_area,payment_method,subtotal,delivery_fee,total,notes,language,items_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        orderNumber, String(b.customer_name).slice(0,120), String(b.customer_phone).slice(0,40),
        b.delivery_method === 'pickup' ? 'pickup' : 'home', String(b.delivery_address||'').slice(0,300),
        String(b.delivery_area||'').slice(0,120), String(b.payment_method||'cod').slice(0,30),
        subtotal, fee, total, String(b.notes||'').slice(0,500), b.language === 'ar' ? 'ar' : 'en', JSON.stringify(items));
    // decrement stock for confirmed inventory
    const dec = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?');
    items.forEach(it => dec.run(it.qty, it.id));
    return send(res, 201, { ok: true, order_number: orderNumber, id: info.lastInsertRowid, subtotal, delivery_fee: fee, total });
  }

  /* ----- ADMIN AUTH ----- */
  if (r[0] === 'admin' && r[1] === 'login' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim().toLowerCase();
    const password = String(b.password || '');
    let user;
    if (username) {
      user = db.prepare('SELECT * FROM users WHERE lower(username)=? AND is_active=1').get(username);
    } else {
      // legacy: password-only logs in the owner
      user = db.prepare("SELECT * FROM users WHERE role='owner' AND is_active=1").get();
    }
    if (!user || !verifyPassword(password, user.pass_hash)) return send(res, 401, { error: 'Wrong username or password' });
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
  if (r[0] === 'admin') {
    const me = requireAuth(req, res); if (!me) return;

    // who am I (used by the dashboard to gate the UI)
    if (r[1] === 'me' && method === 'GET') return send(res, 200, { user: me, allPerms: ALL_PERMS });

    // overview stats
    if (r[1] === 'stats' && method === 'GET') {
      const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
      const newOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='new'").get().c;
      const revenue = db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status!='cancelled'").get().s;
      const products = db.prepare('SELECT COUNT(*) c FROM products').get().c;
      const threshold = Number(getSetting('low_stock_threshold')) || 5;
      const lowStockItems = db.prepare('SELECT name_en, stock FROM products WHERE stock>0 AND stock<=? ORDER BY stock ASC').all(threshold);
      const outItems = db.prepare('SELECT name_en, stock FROM products WHERE stock<=0').all();
      const byPay = db.prepare("SELECT payment_method m, COUNT(*) c FROM orders GROUP BY payment_method").all();
      const onlineCount = db.prepare("SELECT COUNT(*) c FROM orders WHERE channel='online'").get().c;
      const onsiteCount = db.prepare("SELECT COUNT(*) c FROM orders WHERE channel='onsite'").get().c;
      // top selling products (by units sold)
      const sold = {};
      const allItems = db.prepare("SELECT items_json FROM orders WHERE status!='cancelled'").all();
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
      let image = null;
      try { if (b.image_data) image = saveImage(b.image_data); } catch (e) { return send(res, 400, { error: e.message }); }
      const info = db.prepare(`INSERT INTO products
        (category_slug,icon,image,price,cost,stock,is_featured,is_active,name_en,name_ar,desc_en,desc_ar,use_en,use_ar,benefits_en,benefits_ar)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        b.cat||'general', b.icon||'grid', image, Number(b.price)||0, Number(b.cost)||0, Number(b.stock)||0,
        b.feat?1:0, b.active===false?0:1, b.name_en||'Untitled', b.name_ar||'',
        b.desc_en||'', b.desc_ar||'', b.use_en||'', b.use_ar||'',
        JSON.stringify(splitLines(b.benefits_en)), JSON.stringify(splitLines(b.benefits_ar)));
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }

    const pmatch = r[1] === 'products' && r[2];
    if (pmatch && method === 'PATCH') {
      if (!requirePerm(req, res, 'products')) return;
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      let image = cur.image;
      try { if (b.image_data) image = saveImage(b.image_data); } catch (e) { return send(res, 400, { error: e.message }); }
      db.prepare(`UPDATE products SET category_slug=?,icon=?,image=?,price=?,cost=?,stock=?,is_featured=?,is_active=?,
        name_en=?,name_ar=?,desc_en=?,desc_ar=?,use_en=?,use_ar=?,benefits_en=?,benefits_ar=?,updated_at=datetime('now') WHERE id=?`).run(
        b.cat??cur.category_slug, b.icon??cur.icon, image,
        b.price!=null?Number(b.price):cur.price, b.cost!=null?Number(b.cost):cur.cost, b.stock!=null?Number(b.stock):cur.stock,
        b.feat!=null?(b.feat?1:0):cur.is_featured, b.active!=null?(b.active?1:0):cur.is_active,
        b.name_en??cur.name_en, b.name_ar??cur.name_ar, b.desc_en??cur.desc_en, b.desc_ar??cur.desc_ar,
        b.use_en??cur.use_en, b.use_ar??cur.use_ar,
        b.benefits_en!=null?JSON.stringify(splitLines(b.benefits_en)):cur.benefits_en,
        b.benefits_ar!=null?JSON.stringify(splitLines(b.benefits_ar)):cur.benefits_ar, id);
      return send(res, 200, { ok: true });
    }
    if (pmatch && method === 'DELETE') {
      if (!requirePerm(req, res, 'products')) return;
      db.prepare('DELETE FROM products WHERE id=?').run(Number(r[2]));
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
      db.prepare('UPDATE orders SET status=?, payment_status=? WHERE id=?').run(
        b.status||cur.status, b.payment_status||cur.payment_status, id);
      return send(res, 200, { ok: true });
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
        const line = p.price * qty;
        subtotal += line;
        items.push({ id: p.id, name: p.en.name, name_ar: p.ar.name, price: p.price, cost: p.cost || 0, qty, line });
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
      items.forEach(it => dec.run(it.qty, it.id));
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
      const info = db.prepare('INSERT INTO categories(slug,name_en,name_ar,icon,grad,image,sort_order,is_active) VALUES(?,?,?,?,?,?,?,1)')
        .run(slug, String(b.name_en||'Untitled').slice(0,60), String(b.name_ar||'').slice(0,60), b.icon||'grid',
             b.grad||'linear-gradient(135deg,#10502f,#1c7d4a)', image, sort);
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
      'announce_en','announce_ar','contact_address_en','contact_address_ar','contact_hours_en','contact_hours_ar'];
    if (r[1] === 'settings' && method === 'GET') {
      const out = {}; SETTING_KEYS.forEach(k => out[k] = getSetting(k)); return send(res, 200, out);
    }
    if (r[1] === 'settings' && method === 'POST') {
      if (!requirePerm(req, res, 'settings')) return;
      const b = await readBody(req);
      SETTING_KEYS.forEach(k => { if (b[k] !== undefined) setSetting(k, b[k]); });
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
  console.log(`  Admin password (default): ${getSetting('admin_password')}`);
  console.log('  (change it on the admin Settings page)\n');
});
