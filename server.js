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
const { db, queries, getSetting, setSetting } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
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
  };
}

/* ---------- auth ---------- */
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function isAuthed(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return false;
  return !!db.prepare('SELECT token FROM sessions WHERE token=?').get(token);
}
function requireAuth(req, res) { if (!isAuthed(req)) { send(res, 401, { error: 'unauthorized' }); return false; } return true; }

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
      items.push({ id: p.id, name: p.en.name, name_ar: p.ar.name, price: p.price, qty, line });
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
    if (String(b.password || '') === String(getSetting('admin_password'))) {
      const token = newToken();
      db.prepare('INSERT INTO sessions(token) VALUES(?)').run(token);
      return send(res, 200, { ok: true, token });
    }
    return send(res, 401, { error: 'Wrong password' });
  }
  if (r[0] === 'admin' && r[1] === 'logout' && method === 'POST') {
    const h = req.headers['authorization'] || ''; const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    return send(res, 200, { ok: true });
  }

  /* ----- ADMIN (protected) ----- */
  if (r[0] === 'admin') {
    if (!requireAuth(req, res)) return;

    // overview stats
    if (r[1] === 'stats' && method === 'GET') {
      const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
      const newOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='new'").get().c;
      const revenue = db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status!='cancelled'").get().s;
      const products = db.prepare('SELECT COUNT(*) c FROM products').get().c;
      const lowStock = db.prepare('SELECT COUNT(*) c FROM products WHERE stock>0 AND stock<=5').get().c;
      const outStock = db.prepare('SELECT COUNT(*) c FROM products WHERE stock<=0').get().c;
      const byPay = db.prepare("SELECT payment_method m, COUNT(*) c FROM orders GROUP BY payment_method").all();
      return send(res, 200, { totalOrders, newOrders, revenue, products, lowStock, outStock, byPay });
    }

    // products
    if (r[1] === 'products' && method === 'GET') return send(res, 200, { products: queries.allProducts() });
    if (r[1] === 'categories' && method === 'GET') return send(res, 200, { categories: queries.allCategories() });

    if (r[1] === 'products' && method === 'POST') {
      const b = await readBody(req);
      let image = null;
      try { if (b.image_data) image = saveImage(b.image_data); } catch (e) { return send(res, 400, { error: e.message }); }
      const info = db.prepare(`INSERT INTO products
        (category_slug,icon,image,price,stock,is_featured,is_active,name_en,name_ar,desc_en,desc_ar,use_en,use_ar,benefits_en,benefits_ar)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        b.cat||'general', b.icon||'grid', image, Number(b.price)||0, Number(b.stock)||0,
        b.feat?1:0, b.active===false?0:1, b.name_en||'Untitled', b.name_ar||'',
        b.desc_en||'', b.desc_ar||'', b.use_en||'', b.use_ar||'',
        JSON.stringify(splitLines(b.benefits_en)), JSON.stringify(splitLines(b.benefits_ar)));
      return send(res, 201, { ok: true, id: info.lastInsertRowid });
    }

    const pmatch = r[1] === 'products' && r[2];
    if (pmatch && method === 'PATCH') {
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      let image = cur.image;
      try { if (b.image_data) image = saveImage(b.image_data); } catch (e) { return send(res, 400, { error: e.message }); }
      db.prepare(`UPDATE products SET category_slug=?,icon=?,image=?,price=?,stock=?,is_featured=?,is_active=?,
        name_en=?,name_ar=?,desc_en=?,desc_ar=?,use_en=?,use_ar=?,benefits_en=?,benefits_ar=?,updated_at=datetime('now') WHERE id=?`).run(
        b.cat??cur.category_slug, b.icon??cur.icon, image,
        b.price!=null?Number(b.price):cur.price, b.stock!=null?Number(b.stock):cur.stock,
        b.feat!=null?(b.feat?1:0):cur.is_featured, b.active!=null?(b.active?1:0):cur.is_active,
        b.name_en??cur.name_en, b.name_ar??cur.name_ar, b.desc_en??cur.desc_en, b.desc_ar??cur.desc_ar,
        b.use_en??cur.use_en, b.use_ar??cur.use_ar,
        b.benefits_en!=null?JSON.stringify(splitLines(b.benefits_en)):cur.benefits_en,
        b.benefits_ar!=null?JSON.stringify(splitLines(b.benefits_ar)):cur.benefits_ar, id);
      return send(res, 200, { ok: true });
    }
    if (pmatch && method === 'DELETE') {
      db.prepare('DELETE FROM products WHERE id=?').run(Number(r[2]));
      return send(res, 200, { ok: true });
    }

    // orders
    if (r[1] === 'orders' && method === 'GET') {
      const status = url.searchParams.get('status');
      const rows = status
        ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY id DESC').all(status)
        : db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
      rows.forEach(o => { o.items = (() => { try { return JSON.parse(o.items_json); } catch { return []; } })(); delete o.items_json; });
      return send(res, 200, { orders: rows });
    }
    if (r[1] === 'orders' && r[2] && method === 'PATCH') {
      const id = Number(r[2]); const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (!cur) return send(res, 404, { error: 'not found' });
      db.prepare('UPDATE orders SET status=?, payment_status=? WHERE id=?').run(
        b.status||cur.status, b.payment_status||cur.payment_status, id);
      return send(res, 200, { ok: true });
    }

    // settings
    if (r[1] === 'settings' && method === 'GET') {
      return send(res, 200, {
        whatsapp_number: getSetting('whatsapp_number'), store_name: getSetting('store_name'),
        free_delivery_over: getSetting('free_delivery_over'), delivery_fee: getSetting('delivery_fee'),
        announce_en: getSetting('announce_en'), announce_ar: getSetting('announce_ar'),
      });
    }
    if (r[1] === 'settings' && method === 'POST') {
      const b = await readBody(req);
      ['whatsapp_number','store_name','free_delivery_over','delivery_fee','announce_en','announce_ar'].forEach(k => {
        if (b[k] !== undefined) setSetting(k, b[k]);
      });
      if (b.admin_password) setSetting('admin_password', b.admin_password);
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
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    return serveStatic(res, PUBLIC_DIR, decodeURIComponent(rel));
  } catch (e) {
    console.error('Server error:', e);
    send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => {
  console.log('\n  🌙  Jeddah Trading backend running');
  console.log('  ───────────────────────────────────');
  console.log(`  Storefront : http://localhost:${PORT}`);
  console.log(`  Admin      : http://localhost:${PORT}/admin`);
  console.log(`  Admin password (default): ${getSetting('admin_password')}`);
  console.log('  (change it on the admin Settings page)\n');
});
