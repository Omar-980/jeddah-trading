'use strict';
/* =========================================================
   Jeddah Trading — Data layer (zero-dependency, node:sqlite)
   ========================================================= */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// DATA_DIR can be overridden by an env var so a host's persistent volume can be used.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'store.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ---------- Schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  icon TEXT DEFAULT 'grid',
  grad TEXT DEFAULT 'linear-gradient(135deg,#10502f,#1c7d4a)',
  image TEXT,
  parent_id INTEGER,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_slug TEXT NOT NULL,
  icon TEXT DEFAULT 'grid',
  image TEXT,
  images TEXT DEFAULT '[]',
  sku TEXT,
  barcode TEXT,
  brand TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  discount_price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  wholesale_price REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  batch_no TEXT DEFAULT '',
  expiry_date TEXT DEFAULT '',
  supplier_id INTEGER,
  status TEXT DEFAULT 'active',
  is_featured INTEGER DEFAULT 0,
  is_bestseller INTEGER DEFAULT 0,
  is_new INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  name_en TEXT NOT NULL,
  name_ar TEXT DEFAULT '',
  desc_en TEXT DEFAULT '',
  desc_ar TEXT DEFAULT '',
  use_en TEXT DEFAULT '',
  use_ar TEXT DEFAULT '',
  benefits_en TEXT DEFAULT '[]',
  benefits_ar TEXT DEFAULT '[]',
  ingredients_en TEXT DEFAULT '',
  ingredients_ar TEXT DEFAULT '',
  warnings_en TEXT DEFAULT '',
  warnings_ar TEXT DEFAULT '',
  weight TEXT DEFAULT '',
  dimensions TEXT DEFAULT '',
  video_url TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delivery_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_ar TEXT DEFAULT '',
  fee REAL NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  product_name TEXT DEFAULT '',
  qty_change INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  reason TEXT NOT NULL,            -- order | sale | purchase | adjustment | damaged | expired | count | manual | return
  ref TEXT DEFAULT '',             -- order number / PO number / free note
  by_user TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moves_product ON stock_moves(product_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT UNIQUE NOT NULL,
  supplier_id INTEGER,
  supplier_name TEXT DEFAULT '',
  status TEXT DEFAULT 'ordered',   -- ordered | partial | received | cancelled
  expected_date TEXT DEFAULT '',
  shipment_ref TEXT DEFAULT '',    -- container / shipment tracking reference
  notes TEXT DEFAULT '',
  total_cost REAL DEFAULT 0,
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  received_at TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS po_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  product_name TEXT DEFAULT '',
  qty_ordered INTEGER NOT NULL DEFAULT 0,
  qty_received INTEGER NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,        -- digits only; the customer's login ID
  email TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,
  address TEXT DEFAULT '',
  zone_id INTEGER,
  points INTEGER NOT NULL DEFAULT 0,
  referral_code TEXT UNIQUE,
  referred_by INTEGER,               -- customer id of the referrer
  referral_paid INTEGER DEFAULT 0,   -- referrer bonus granted after first delivered order
  notes TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  token TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_wishlist (
  customer_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,            -- digits only
  customer_email TEXT DEFAULT '',
  customer_id INTEGER,                     -- linked account, when signed in
  product_id INTEGER,                      -- "ask about this product"
  order_id INTEGER,                        -- "ask about this order"
  assigned_staff_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',     -- open | pending | resolved | closed
  source TEXT NOT NULL DEFAULT 'website',  -- website | product_page | order_page | checkout_page
  staff_notes TEXT DEFAULT '',             -- internal only, never sent to the customer
  cust_token TEXT UNIQUE,                  -- secret; only the holder can read this thread
  account_nudge INTEGER DEFAULT 0,         -- 1 after we've suggested creating an account
  investor_id INTEGER,                     -- set when this thread belongs to an investor (portal enquiries)
  last_message TEXT DEFAULT '',
  last_message_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ===== Investor profit tracking =====
CREATE TABLE IF NOT EXISTS investors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,        -- digits only; the investor's login ID
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active | inactive
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS investor_sessions (
  token TEXT PRIMARY KEY,
  investor_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS investments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  batch_no TEXT DEFAULT '',
  purchase_order_id INTEGER,               -- optional link to a PO / supplier order / shipment
  qty_funded INTEGER NOT NULL,
  cost_per_unit REAL NOT NULL,
  amount REAL NOT NULL,                    -- total investment = qty_funded × cost_per_unit
  sell_price_ref REAL DEFAULT 0,           -- selling price at the time of investment (for expectations)
  investor_pct REAL NOT NULL DEFAULT 50,   -- share of PROFIT, not revenue
  status TEXT NOT NULL DEFAULT 'active',   -- active | completed | settled | cancelled
  invested_at TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS investor_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investment_id INTEGER NOT NULL,
  investor_id INTEGER NOT NULL,
  order_id INTEGER,
  order_number TEXT DEFAULT '',
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,                    -- negative rows are reversals (cancelled / returned orders)
  unit_price REAL NOT NULL,                -- ACTUAL selling price from the order (discounts included)
  revenue REAL NOT NULL,
  cost REAL NOT NULL,
  gross_profit REAL NOT NULL,
  investor_profit REAL NOT NULL,
  business_profit REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invsales_investment ON investor_sales(investment_id);
CREATE INDEX IF NOT EXISTS idx_invsales_order ON investor_sales(order_id);

CREATE TABLE IF NOT EXISTS investor_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_id INTEGER NOT NULL,
  investment_id INTEGER,                   -- optional: payout against a specific investment
  amount REAL NOT NULL,
  method TEXT DEFAULT 'cash',
  reference TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  paid_at TEXT NOT NULL,
  by_user TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL DEFAULT 'given',  -- given: customer/friend owes the store | taken: the store owes (e.g. supplier)
  party_name TEXT NOT NULL,
  party_phone TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'cash',        -- cash | product
  product_id INTEGER,
  product_name TEXT DEFAULT '',
  qty INTEGER DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,           -- cash amount, or the value of the loaned goods
  paid_amount REAL NOT NULL DEFAULT 0,
  date_taken TEXT NOT NULL,
  date_due TEXT,
  status TEXT NOT NULL DEFAULT 'active',    -- active | paid | returned
  settle_mode TEXT DEFAULT '',              -- how it was closed: cash | returned
  notes TEXT DEFAULT '',
  by_user TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL,               -- customer | staff | system
  sender_id INTEGER,
  sender_name TEXT DEFAULT '',
  message_text TEXT DEFAULT '',
  attachment_url TEXT DEFAULT '',
  attachment_type TEXT DEFAULT '',         -- image
  read_at TEXT,                            -- staff msg: when customer saw it; customer msg: when staff saw it
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_conv ON chat_messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  kind TEXT DEFAULT 'percent',       -- percent | fixed
  value REAL NOT NULL DEFAULT 0,
  min_subtotal REAL DEFAULT 0,
  max_uses INTEGER DEFAULT 0,        -- 0 = unlimited
  used_count INTEGER DEFAULT 0,
  expires TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image TEXT NOT NULL,
  title_en TEXT DEFAULT '',
  title_ar TEXT DEFAULT '',
  link TEXT DEFAULT '',              -- e.g. #product=5 or #shop
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  po_id INTEGER,
  amount REAL NOT NULL DEFAULT 0,
  method TEXT DEFAULT 'cash',
  note TEXT DEFAULT '',
  paid_on TEXT DEFAULT (date('now')),
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  delivery_method TEXT DEFAULT 'home',
  delivery_address TEXT DEFAULT '',
  delivery_area TEXT DEFAULT '',
  payment_method TEXT DEFAULT 'cod',
  payment_status TEXT DEFAULT 'unpaid',
  status TEXT DEFAULT 'new',
  subtotal REAL DEFAULT 0,
  delivery_fee REAL DEFAULT 0,
  total REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  language TEXT DEFAULT 'en',
  channel TEXT DEFAULT 'online',
  staff TEXT DEFAULT '',
  items_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spent_on TEXT DEFAULT (date('now')),
  category TEXT DEFAULT 'General',
  description TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,
  role TEXT DEFAULT 'staff',
  permissions TEXT DEFAULT '[]',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  q_en TEXT NOT NULL,
  a_en TEXT NOT NULL,
  q_ar TEXT DEFAULT '',
  a_ar TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  location TEXT DEFAULT '',
  rating INTEGER DEFAULT 5,
  text_en TEXT NOT NULL,
  product_id INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS newsletter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

/* ---------- Lightweight migrations (for databases created before these columns existed) ---------- */
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!columnExists('products', 'cost')) db.exec('ALTER TABLE products ADD COLUMN cost REAL NOT NULL DEFAULT 0');
if (!columnExists('sessions', 'user_id')) db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER');
if (!columnExists('orders', 'channel')) db.exec("ALTER TABLE orders ADD COLUMN channel TEXT DEFAULT 'online'");
if (!columnExists('orders', 'staff')) db.exec("ALTER TABLE orders ADD COLUMN staff TEXT DEFAULT ''");
if (!columnExists('categories', 'image')) db.exec('ALTER TABLE categories ADD COLUMN image TEXT');
if (!columnExists('categories', 'parent_id')) db.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER'); // scalability: subcategories
if (!columnExists('products', 'sku')) db.exec('ALTER TABLE products ADD COLUMN sku TEXT');                  // scalability: inventory/accounting
/* Phase 2 — inventory & product management (additive; safe on the live database) */
if (!columnExists('products', 'images'))          db.exec("ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'");
if (!columnExists('products', 'barcode'))         db.exec('ALTER TABLE products ADD COLUMN barcode TEXT');
if (!columnExists('products', 'wholesale_price')) db.exec('ALTER TABLE products ADD COLUMN wholesale_price REAL NOT NULL DEFAULT 0');
if (!columnExists('products', 'min_stock'))       db.exec('ALTER TABLE products ADD COLUMN min_stock INTEGER NOT NULL DEFAULT 0');
if (!columnExists('products', 'batch_no'))        db.exec("ALTER TABLE products ADD COLUMN batch_no TEXT DEFAULT ''");
if (!columnExists('products', 'expiry_date'))     db.exec("ALTER TABLE products ADD COLUMN expiry_date TEXT DEFAULT ''");
if (!columnExists('products', 'supplier_id'))     db.exec('ALTER TABLE products ADD COLUMN supplier_id INTEGER');
if (!columnExists('products', 'status'))          db.exec("ALTER TABLE products ADD COLUMN status TEXT DEFAULT 'active'");
if (!columnExists('products', 'is_bestseller'))   db.exec('ALTER TABLE products ADD COLUMN is_bestseller INTEGER DEFAULT 0');
if (!columnExists('products', 'is_new'))          db.exec('ALTER TABLE products ADD COLUMN is_new INTEGER DEFAULT 0');
/* Phase 3 — orders, checkout & payments (additive) */
if (!columnExists('orders', 'payment_proof'))     db.exec("ALTER TABLE orders ADD COLUMN payment_proof TEXT DEFAULT ''");
if (!columnExists('orders', 'delivery_zone'))     db.exec("ALTER TABLE orders ADD COLUMN delivery_zone TEXT DEFAULT ''");
/* delivery role — assign an order to a courier */
if (!columnExists('orders', 'courier_id'))        db.exec('ALTER TABLE orders ADD COLUMN courier_id INTEGER');
if (!columnExists('orders', 'courier_name'))      db.exec("ALTER TABLE orders ADD COLUMN courier_name TEXT DEFAULT ''");
/* CRM & marketing phase (additive) */
if (!columnExists('orders', 'customer_id'))    db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER');
if (!columnExists('orders', 'coupon_code'))    db.exec("ALTER TABLE orders ADD COLUMN coupon_code TEXT DEFAULT ''");
if (!columnExists('orders', 'discount'))       db.exec('ALTER TABLE orders ADD COLUMN discount REAL NOT NULL DEFAULT 0');
if (!columnExists('orders', 'points_awarded')) db.exec('ALTER TABLE orders ADD COLUMN points_awarded INTEGER DEFAULT 0');
if (!columnExists('conversations', 'account_nudge')) db.exec('ALTER TABLE conversations ADD COLUMN account_nudge INTEGER DEFAULT 0');
if (!columnExists('conversations', 'investor_id')) db.exec('ALTER TABLE conversations ADD COLUMN investor_id INTEGER');
/* Storefront & catalog phase (additive) */
if (!columnExists('products', 'brand'))           db.exec("ALTER TABLE products ADD COLUMN brand TEXT DEFAULT ''");
if (!columnExists('products', 'discount_price'))  db.exec('ALTER TABLE products ADD COLUMN discount_price REAL NOT NULL DEFAULT 0');
if (!columnExists('products', 'ingredients_en'))  db.exec("ALTER TABLE products ADD COLUMN ingredients_en TEXT DEFAULT ''");
if (!columnExists('products', 'ingredients_ar'))  db.exec("ALTER TABLE products ADD COLUMN ingredients_ar TEXT DEFAULT ''");
if (!columnExists('products', 'warnings_en'))     db.exec("ALTER TABLE products ADD COLUMN warnings_en TEXT DEFAULT ''");
if (!columnExists('products', 'warnings_ar'))     db.exec("ALTER TABLE products ADD COLUMN warnings_ar TEXT DEFAULT ''");
if (!columnExists('products', 'weight'))          db.exec("ALTER TABLE products ADD COLUMN weight TEXT DEFAULT ''");
if (!columnExists('products', 'dimensions'))      db.exec("ALTER TABLE products ADD COLUMN dimensions TEXT DEFAULT ''");
if (!columnExists('products', 'video_url'))       db.exec("ALTER TABLE products ADD COLUMN video_url TEXT DEFAULT ''");
if (!columnExists('reviews', 'product_id'))       db.exec('ALTER TABLE reviews ADD COLUMN product_id INTEGER');

/* ---------- Default settings ---------- */
function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}
const DEFAULT_SETTINGS = {
  whatsapp_number: '2207093900',
  store_name: 'Jeddah Trading',
  admin_password: 'jeddah2026',          // legacy owner password (used to seed the owner user)
  free_delivery_over: '2500',
  delivery_fee: '150',
  low_stock_threshold: '5',
  contact_address_en: 'Bundungka Kunda, Near Jammeh Foundation Hospital, The Gambia',
  contact_address_ar: 'بوندونغكا كوندا، بالقرب من مستشفى مؤسسة جامع، غامبيا',
  contact_hours_en: 'Mon – Sat: 9am – 10pm · Sun: 9am – 8pm',
  contact_hours_ar: 'الاثنين–السبت: ٩ص – ١٠م · الأحد: ٩ص – ٨م',
  announce_en: '🌙 Free delivery in Greater Banjul on orders over D2,500 · Order on WhatsApp anytime',
  announce_ar: '🌙 توصيل مجاني في منطقة بانجول الكبرى للطلبات فوق ٢٬٥٠٠ دلاسي · اطلب عبر واتساب في أي وقت',
  // Phase 3 — payment account details shown to customers at checkout
  pay_account_name: 'Jeddah Trading',
  pay_wave_number: '2207093900',
  pay_afri_number: '2207093900',
  pay_qmoney_number: '2207093900',
  pay_bank_name: '',
  pay_bank_account: '',
  pay_note_en: 'Send the exact total to the number above, then upload your payment screenshot. We confirm every order on WhatsApp.',
  pay_note_ar: 'أرسل المبلغ الإجمالي بالضبط إلى الرقم أعلاه، ثم ارفع صورة إثبات الدفع. نؤكد كل طلب عبر واتساب.',
  // Storefront & catalog phase
  // CRM & marketing
  loyalty_earn_per: '100',        // customer earns 1 point per D100 spent (on delivered orders)
  loyalty_point_value: '1',       // 1 point = D1 discount at checkout
  loyalty_max_redeem_pct: '30',   // points can cover at most 30% of the subtotal
  referral_bonus_points: '50',    // referrer bonus after the referred friend's first delivered order
  est_delivery_en: 'Greater Banjul: same or next day · Other regions: 1–3 days',
  est_delivery_ar: 'بانجول الكبرى: نفس اليوم أو اليوم التالي · المناطق الأخرى: ١–٣ أيام',
  // ---- built-in live chat ----
  chat_online: 'auto',            // auto = online while staff are active | on | off
  chat_welcome_en: 'Salaam! 👋 Welcome to Jeddah Trading — how can we help you today?',
  chat_welcome_ar: 'السلام عليكم! 👋 أهلاً بك في جدة تريدنغ — كيف نستطيع مساعدتك؟',
  chat_offline_en: 'Thanks for your message! We are away right now but we reply to every message — usually within a few hours (9:00–20:00, Sat–Thu).',
  chat_offline_ar: 'شكراً لرسالتك! نحن غير متواجدين حالياً لكننا نرد على كل الرسائل — عادةً خلال ساعات قليلة (٩:٠٠–٢٠:٠٠، السبت–الخميس).',
  chat_hours: '9:00–20:00 Sat–Thu',
  chat_upload: '1',               // allow image / payment-proof attachments
  chat_maxmb: '4',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (getSetting(k, null) === null) setSetting(k, v);
}

/* ---------- Password hashing (scrypt) ---------- */
const crypto = require('node:crypto');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- All permission keys (owner always has every one) ---------- */
const ALL_PERMS = ['products', 'orders', 'sales', 'expenses', 'reviews', 'faqs', 'profit', 'users', 'settings', 'delivery', 'chat'];

/* ---------- Seed the owner user (once) ---------- */
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  db.prepare('INSERT INTO users(username,name,pass_hash,role,permissions,is_active) VALUES(?,?,?,?,?,1)')
    .run('owner', 'Store Owner', hashPassword(getSetting('admin_password', 'jeddah2026')), 'owner', JSON.stringify(ALL_PERMS));
}

/* ---------- Seed FAQs (once) ---------- */
const FAQ_SEED = [
  ['How do I place an order?', 'You can add items to your cart and checkout, or tap "Order on WhatsApp" on any product. We confirm every order on WhatsApp before delivery.',
   'كيف أقدّم طلباً؟', 'يمكنك إضافة المنتجات إلى السلة وإتمام الطلب، أو الضغط على "اطلب عبر واتساب" على أي منتج. نؤكد كل طلب عبر واتساب قبل التوصيل.'],
  ['What payment methods do you accept?', 'We accept WAVE, AfriMoney, QMoney, bank transfer, and cash on delivery. You confirm payment details with us on WhatsApp.',
   'ما طرق الدفع المتاحة؟', 'نقبل WAVE و AfriMoney و QMoney والتحويل البنكي والدفع عند الاستلام. تؤكد تفاصيل الدفع معنا عبر واتساب.'],
  ['Do you deliver across The Gambia?', 'Yes. Delivery in Greater Banjul is fast and free over D2,500. We also ship to other regions — delivery fees vary by location.',
   'هل توصلون إلى كل غامبيا؟', 'نعم. التوصيل في بانجول الكبرى سريع ومجاني للطلبات فوق ٢٬٥٠٠ دلاسي. نوصل أيضاً لباقي المناطق برسوم تختلف حسب الموقع.'],
  ['Are your products authentic?', 'Absolutely. We source genuine, quality products and stand behind everything we sell.',
   'هل منتجاتكم أصلية؟', 'بالتأكيد. نوفر منتجات أصلية وعالية الجودة ونضمن كل ما نبيعه.'],
  ['Can I return an item?', "If an item arrives damaged or incorrect, contact us within 48 hours on WhatsApp and we'll make it right.",
   'هل يمكنني إرجاع منتج؟', 'إذا وصل المنتج تالفاً أو خاطئاً، تواصل معنا خلال ٤٨ ساعة عبر واتساب وسنصلح الأمر.'],
];
if (db.prepare('SELECT COUNT(*) c FROM faqs').get().c === 0) {
  const ins = db.prepare('INSERT INTO faqs(q_en,a_en,q_ar,a_ar,sort_order) VALUES(?,?,?,?,?)');
  FAQ_SEED.forEach((f, i) => ins.run(f[0], f[1], f[2], f[3], i));
}

/* ---------- Seed a few approved reviews (once) ---------- */
const REVIEW_SEED = [
  ['Aminata Ceesay', 'Serrekunda', 5, 'The Ajwa dates and oud perfume were excellent quality. Delivery was fast and WhatsApp ordering is so easy!'],
  ['Modou Njie', 'Banjul', 5, 'I bought a thobe and prayer mat for Eid. Beautiful items and great prices. My go-to shop now.'],
  ['Fatou Bah', 'Brikama', 5, 'Paid easily with AfriMoney and chose cash on delivery for my second order. Trustworthy and professional.'],
];
if (db.prepare('SELECT COUNT(*) c FROM reviews').get().c === 0) {
  const ins = db.prepare("INSERT INTO reviews(name,location,rating,text_en,status) VALUES(?,?,?,?,'approved')");
  REVIEW_SEED.forEach(r => ins.run(r[0], r[1], r[2], r[3]));
}

/* ---------- Seed delivery zones (once) — editable in admin Settings ---------- */
const ZONE_SEED = [
  ['Serrekunda', 'سيريكوندا', 100],
  ['Bakau / Fajara', 'باكاو / فجارا', 150],
  ['Kanifing / Bundung', 'كانيفينغ / بوندونغ', 150],
  ['Banjul', 'بانجول', 200],
  ['Sukuta / Farato', 'سوكوتا / فاراتو', 200],
  ['Brusubi / Brufut', 'بروسوبي / بروفوت', 250],
  ['Brikama', 'بريكاما', 300],
  ['Other (Greater Banjul)', 'أخرى (بانجول الكبرى)', 250],
  ['Upcountry / Other regions', 'المناطق الأخرى', 500],
];
if (db.prepare('SELECT COUNT(*) c FROM delivery_zones').get().c === 0) {
  const ins = db.prepare('INSERT INTO delivery_zones(name_en,name_ar,fee,sort_order,is_active) VALUES(?,?,?,?,1)');
  ZONE_SEED.forEach((z, i) => ins.run(z[0], z[1], z[2], i));
}

/* ---------- Seed (only when empty) ---------- */
const CATS = [
  ['herbs','Herbs & Natural','الأعشاب والطبيعية','leaf','linear-gradient(135deg,#10502f,#1c7d4a)'],
  ['islamic','Islamic Products','منتجات إسلامية','book','linear-gradient(135deg,#072617,#10502f)'],
  ['perfumes','Perfumes & Oud','العطور والعود','perfume','linear-gradient(135deg,#9a7b1f,#d4af37)'],
  ['dates','Dates & Foods','التمور والأطعمة','date','linear-gradient(135deg,#7a4a12,#bd9526)'],
  ['men',"Men's Clothing",'ملابس رجالية','shirt','linear-gradient(135deg,#0c3b22,#16653c)'],
  ['women',"Women's Clothing",'ملابس نسائية','dress','linear-gradient(135deg,#5a3b6b,#8a5fa3)'],
  ['electronics','Electronics','الإلكترونيات','device','linear-gradient(135deg,#1d3a5f,#2f6db0)'],
  ['household','Household Items','أدوات منزلية','home','linear-gradient(135deg,#10502f,#3ca06b)'],
  ['hajj','Hajj & Umrah Gifts','هدايا الحج والعمرة','gift','linear-gradient(135deg,#072617,#9a7b1f)'],
  ['packaging','Packaging Materials','مواد التغليف','box','linear-gradient(135deg,#5c4326,#9a7b1f)'],
  ['general','General Goods','بضائع عامة','grid','linear-gradient(135deg,#3a4a40,#6b7a70)'],
];

// [cat, icon, price, stock, feat, name_en, name_ar, desc_en, desc_ar, use_en, use_ar, ben_en[], ben_ar[]]
const PRODS = [
  ['herbs','leaf',350,40,1,'Pure Moringa Powder 250g','مسحوق المورينجا النقي ٢٥٠غ','Nutrient-rich moringa leaf powder, locally sourced and sun-dried.','مسحوق أوراق المورينجا الغني بالعناصر الغذائية، مجفف بالشمس.','Mix 1 teaspoon into water, juice, or porridge daily.','اخلط ملعقة صغيرة في الماء أو العصير يومياً.',['Boosts energy & immunity','Rich in iron, calcium & vitamins','100% natural, no additives'],['يعزز الطاقة والمناعة','غني بالحديد والكالسيوم والفيتامينات','طبيعي ١٠٠٪ بدون إضافات']],
  ['herbs','oil',500,25,1,'Black Seed Oil (Habbatus Sauda) 100ml','زيت الحبة السوداء ١٠٠مل','Cold-pressed black seed oil, prized in prophetic medicine.','زيت حبة البركة المعصور على البارد، من الطب النبوي.','Take 1 teaspoon daily or apply to skin and hair.','تناول ملعقة صغيرة يومياً أو ادهن البشرة والشعر.',['Supports immune system','Good for skin & hair','Traditional remedy'],['يدعم جهاز المناعة','مفيد للبشرة والشعر','علاج تقليدي']],
  ['herbs','leaf',280,0,0,'Dried Hibiscus (Wonjo) 200g','الكركديه المجفف ٢٠٠غ','Premium dried hibiscus flowers for refreshing wonjo juice.','أزهار الكركديه المجففة الفاخرة لعصير منعش.','Boil with water and sugar, chill and serve.','اغلِ مع الماء والسكر، ثم برّد وقدّم.',['Rich in antioxidants','Supports healthy blood pressure','Refreshing & natural'],['غني بمضادات الأكسدة','يدعم ضغط الدم الصحي','منعش وطبيعي']],
  ['herbs','oil',420,18,0,'Pure Honey 500g','عسل نقي ٥٠٠غ','Raw, unfiltered honey from local beekeepers.','عسل خام غير مصفى من النحالين المحليين.','Take a spoonful daily or sweeten drinks naturally.','تناول ملعقة يومياً أو حلِّ المشروبات طبيعياً.',['Natural energy source','Soothes throat & cough','No added sugar'],['مصدر طاقة طبيعي','يهدئ الحلق والسعال','بدون سكر مضاف']],
  ['islamic','book',650,30,1,'The Holy Quran (Hardcover, Uthmani)','المصحف الشريف (غلاف صلب، عثماني)','Beautifully printed mushaf with clear Uthmani script.','مصحف مطبوع بخط عثماني واضح وجميل.','Keep in a clean, respectful place for daily recitation.','احفظه في مكان نظيف للتلاوة اليومية.',['Clear, large print','Durable hardcover','Ideal gift'],['طباعة واضحة وكبيرة','غلاف صلب متين','هدية مثالية']],
  ['islamic','beads',120,60,0,'Tasbih Prayer Beads (99 beads)','مسبحة (٩٩ حبة)','Elegant 99-bead misbaha for dhikr, in assorted colours.','مسبحة أنيقة من ٩٩ حبة للذكر بألوان متنوعة.','Use for counting dhikr after prayers.','تُستخدم لعدّ الأذكار بعد الصلاة.',['Smooth, quality beads','Helps focus in dhikr','Comes in a gift pouch'],['حبات ناعمة وعالية الجودة','تساعد على التركيز في الذكر','تأتي في كيس هدية']],
  ['islamic','home',900,12,1,'Premium Prayer Mat (Padded)','سجادة صلاة فاخرة (مبطنة)','Thick, padded prayer mat with Islamic arch design.','سجادة صلاة سميكة مبطنة بتصميم المحراب الإسلامي.','Roll out on a clean surface for comfortable salah.','افرشها على سطح نظيف لصلاة مريحة.',['Extra cushioning for knees','Non-slip backing','Elegant design'],['بطانة إضافية للركبتين','ظهر مانع للانزلاق','تصميم أنيق']],
  ['islamic','oil',180,45,0,'Bakhoor Incense (Assorted)','بخور (متنوع)','Fragrant bakhoor chips to perfume your home and clothes.','رقائق بخور عطرية لتعطير المنزل والملابس.','Burn a small piece on charcoal in a burner.','احرق قطعة صغيرة على الفحم في المبخرة.',['Long-lasting aroma','Traditional fragrance','Great for gatherings'],['رائحة تدوم طويلاً','عبق تقليدي','مثالي للمناسبات']],
  ['perfumes','perfume',1200,20,1,'Royal Oud Perfume 50ml','عطر العود الملكي ٥٠مل','Long-lasting alcohol-free attar with rich oud notes.','عطر زيتي خالٍ من الكحول يدوم طويلاً بنفحات العود.','Apply to wrists and neck; a little goes a long way.','ضعه على المعصمين والرقبة؛ القليل يكفي.',['Alcohol-free (halal)','Rich, premium scent','Lasts all day'],['خالٍ من الكحول (حلال)','رائحة فاخرة وغنية','يدوم طوال اليوم']],
  ['perfumes','oil',450,35,0,'Musk Al Tahara Roll-on 10ml','مسك الطهارة رول ١٠مل','Clean, pure white musk roll-on, gentle on skin.','مسك أبيض نقي لطيف على البشرة.','Roll lightly onto pulse points.','مرره بخفة على مواضع النبض.',['Subtle, clean fragrance','Skin-friendly','Pocket size'],['رائحة نظيفة وخفيفة','لطيف على البشرة','حجم صغير للجيب']],
  ['perfumes','perfume',800,0,0,'Arabian Body Spray Gift Set','طقم بخاخ معطر عربي','Set of 3 long-lasting Arabian-inspired body sprays.','مجموعة من ٣ بخاخات معطرة عربية تدوم طويلاً.','Spray onto clothes and body after dressing.','رشها على الملابس والجسم بعد ارتداء الثياب.',['Great value gift set','Three signature scents','Elegant packaging'],['طقم هدية بقيمة ممتازة','ثلاث روائح مميزة','تغليف أنيق']],
  ['dates','date',600,50,1,'Premium Ajwa Dates 500g','تمر العجوة الفاخر ٥٠٠غ','Soft, sweet Ajwa dates — a Sunnah favourite.','تمر العجوة الطري والحلو — من السنة.','Enjoy daily, especially to break your fast.','تناوله يومياً، خاصة عند الإفطار.',['Naturally sweet & nutritious','Loved in Sunnah','Perfect for Ramadan'],['حلو ومغذٍ طبيعياً','محبوب في السنة','مثالي لرمضان']],
  ['dates','date',400,40,0,'Medjool Dates 1kg','تمر المجدول ١كغ','Large, juicy Medjool dates packed with energy.','تمر مجدول كبير وعصيري مليء بالطاقة.','A wholesome snack any time of day.','وجبة خفيفة صحية في أي وقت.',['Big and soft','High in fibre & energy','Family pack'],['كبير وطري','غني بالألياف والطاقة','عبوة عائلية']],
  ['dates','box',750,22,0,'Mixed Dates & Nuts Gift Box','علبة هدايا تمر ومكسرات','Assorted premium dates with almonds — ideal for gifting.','تشكيلة تمور فاخرة مع اللوز — مثالية للإهداء.','Present at gatherings or gift to loved ones.','قدمها في المناسبات أو أهدها لأحبابك.',['Elegant gift box','Variety of flavours','Ready to gift'],['علبة هدية أنيقة','تشكيلة نكهات','جاهزة للإهداء']],
  ['men','shirt',850,28,1,'Premium Cotton Thobe (Jubba)','ثوب قطني فاخر (جبة)','Classic men\'s thobe in breathable cotton, multiple sizes.','ثوب رجالي كلاسيكي من القطن المسامي، بمقاسات متعددة.','Wear for prayers, Jumu\'ah and special occasions.','يُلبس للصلاة والجمعة والمناسبات.',['Breathable cotton','Smart, modest fit','Available in many sizes'],['قطن مسامي','قصة محتشمة وأنيقة','متوفر بمقاسات عديدة']],
  ['men','shirt',300,55,0,'Cotton Kufi Prayer Cap','طاقية قطنية مطرزة','Comfortable embroidered kufi cap for daily wear.','طاقية مريحة مطرزة للاستخدام اليومي.','Wear during prayer and everyday.','تُلبس أثناء الصلاة وكل يوم.',['Soft & breathable','Elegant embroidery','One size fits most'],['ناعمة ومريحة','تطريز أنيق','مقاس واحد يناسب الجميع']],
  ['men','perfume',550,30,0,'Men\'s Ghutra & Agal Set','طقم غترة وعقال رجالي','Premium white ghutra headscarf with black agal.','غترة بيضاء فاخرة مع عقال أسود.','Wear for formal and religious occasions.','تُلبس في المناسبات الرسمية والدينية.',['Crisp premium fabric','Complete set','Classic style'],['قماش فاخر','طقم كامل','أناقة كلاسيكية']],
  ['women','dress',1100,24,1,'Elegant Abaya (Embroidered)','عباءة أنيقة (مطرزة)','Flowing black abaya with subtle gold embroidery.','عباءة سوداء انسيابية بتطريز ذهبي راقٍ.','Wear over clothing for modest, elegant style.','تُلبس فوق الملابس لإطلالة محتشمة وأنيقة.',['Premium flowing fabric','Tasteful gold detail','Comfortable & modest'],['قماش انسيابي فاخر','تفاصيل ذهبية راقية','مريحة ومحتشمة']],
  ['women','dress',350,48,0,'Soft Jersey Hijab (Set of 3)','حجاب جيرسيه ناعم (٣ قطع)','Breathable jersey hijabs in neutral everyday tones.','حجابات جيرسيه مسامية بألوان يومية هادئة.','Style for daily wear and occasions.','للاستخدام اليومي والمناسبات.',['Stretchy & non-slip','Three colours included','All-day comfort'],['مطاطي وغير منزلق','ثلاثة ألوان','راحة طوال اليوم']],
  ['women','dress',650,20,0,'Two-Piece Prayer Khimar','خمار صلاة قطعتين','Comfortable one-piece prayer garment for women.','ثوب صلاة مريح للنساء.','Slip on quickly for salah at home or travel.','ارتديه بسرعة للصلاة في البيت أو السفر.',['Quick & easy to wear','Full coverage','Soft fabric'],['سهل وسريع الارتداء','تغطية كاملة','قماش ناعم']],
  ['electronics','device',2800,15,1,'Digital Azan Clock','ساعة أذان رقمية','Auto prayer-time clock with Azan for The Gambia.','ساعة مواقيت الصلاة مع الأذان لغامبيا.','Set your city; it calls the Azan automatically.','اضبط مدينتك؛ تؤذن تلقائياً.',['Automatic prayer alerts','Clear Azan audio','Wall or desk mount'],['تنبيهات صلاة تلقائية','صوت أذان واضح','تعليق على الحائط أو المكتب']],
  ['electronics','device',1500,18,0,'Bluetooth Speaker (Portable)','مكبر صوت بلوتوث (محمول)','Powerful portable speaker with deep bass.','مكبر صوت محمول قوي بصوت جهير عميق.','Pair via Bluetooth and play for hours.','اقرنه عبر البلوتوث واستمع لساعات.',['Long battery life','Rich sound','Compact & portable'],['بطارية تدوم طويلاً','صوت غني','صغير ومحمول']],
  ['electronics','device',450,0,0,'Fast USB-C Charger + Cable','شاحن USB-C سريع + كابل','20W fast charger with durable braided cable.','شاحن سريع ٢٠ واط مع كابل مجدول متين.','Plug in for rapid, safe charging.','وصّله لشحن سريع وآمن.',['20W fast charging','Durable braided cable','Universal USB-C'],['شحن سريع ٢٠ واط','كابل مجدول متين','USB-C عالمي']],
  ['household','home',1800,16,1,'Stainless Steel Cookware Set','طقم أواني طهي ستانلس','5-piece non-stick stainless cookware for the family kitchen.','طقم من ٥ قطع غير لاصق لمطبخ العائلة.','Use for daily cooking; easy to clean.','للطهي اليومي؛ سهل التنظيف.',['Durable stainless steel','Non-stick coating','Family size set'],['ستانلس متين','طلاء غير لاصق','حجم عائلي']],
  ['household','home',650,30,0,'Insulated Water Flask 1.5L','ترمس ماء معزول ١.٥ل','Keeps water cold or hot for hours — great for travel.','يحافظ على الماء بارداً أو ساخناً لساعات.','Fill and seal; ideal for journeys and the mosque.','املأه وأحكم إغلاقه؛ مثالي للسفر والمسجد.',['Keeps temperature for hours','Leak-proof seal','Large capacity'],['يحافظ على الحرارة لساعات','إغلاق مانع للتسرب','سعة كبيرة']],
  ['household','box',280,40,0,'Microfibre Cleaning Set','طقم تنظيف ميكروفايبر','Pack of 6 absorbent microfibre cloths for home cleaning.','عبوة من ٦ قطع ماصة لتنظيف المنزل.','Use dry or damp on any surface.','استخدمها جافة أو مبللة على أي سطح.',['Highly absorbent','Lint-free shine','Reusable & washable'],['ماص للغاية','لمعان بلا وبر','قابل لإعادة الاستخدام']],
  ['hajj','gift',2200,14,1,'Complete Hajj & Umrah Kit','طقم الحج والعمرة الكامل','Ihram, belt, travel mat, mini Quran & toiletries in one bag.','إحرام، حزام، سجادة سفر، مصحف صغير ومستلزمات في حقيبة.','Everything a pilgrim needs for the journey.','كل ما يحتاجه الحاج للرحلة.',['All essentials in one bag','Lightweight for travel','Thoughtful pilgrim gift'],['كل الأساسيات في حقيبة','خفيف للسفر','هدية مثالية للحاج']],
  ['hajj','perfume',950,20,0,'Zamzam-Style Gift Hamper','سلة هدايا فاخرة','Elegant hamper with dates, attar, tasbih and a card.','سلة أنيقة بها تمر وعطر ومسبحة وبطاقة.','Present to returning pilgrims or loved ones.','قدمها للحجاج العائدين أو للأحباب.',['Ready-to-give hamper','Premium contents','Personalised card'],['سلة جاهزة للإهداء','محتويات فاخرة','بطاقة شخصية']],
  ['packaging','box',150,200,0,'Kraft Gift Boxes (Pack of 10)','علب كرافت للهدايا (١٠ قطع)','Sturdy brown kraft boxes for gifts and small business.','علب كرافت بنية متينة للهدايا والأعمال الصغيرة.','Assemble and fill for products or gifts.','ركّبها واملأها بالمنتجات أو الهدايا.',['Eco-friendly kraft','Bulk pack value','Perfect for resellers'],['كرافت صديق للبيئة','عبوة بالجملة','مثالية للتجار']],
  ['packaging','box',200,150,0,'Clear Gift Bags & Ribbon Set','أكياس هدايا شفافة وشريط','50 clear bags with gold ribbon for packaging treats.','٥٠ كيساً شفافاً مع شريط ذهبي للتغليف.','Fill, tie with ribbon and gift.','املأها واربطها بالشريط وأهدها.',['Clear, food-safe bags','Includes gold ribbon','Great for small business'],['أكياس شفافة آمنة للطعام','يشمل شريطاً ذهبياً','رائع للأعمال الصغيرة']],
  ['general','grid',900,26,1,'Solar LED Lantern','فانوس LED يعمل بالطاقة الشمسية','Rechargeable solar lantern — reliable light during outages.','فانوس شمسي قابل للشحن — إضاءة موثوقة عند انقطاع الكهرباء.','Charge in sun or by USB; use anywhere.','اشحنه بالشمس أو USB؛ استخدمه في أي مكان.',['Solar + USB charging','Bright, long runtime','Ideal for power cuts'],['شحن شمسي و USB','إضاءة ساطعة تدوم','مثالي لانقطاع الكهرباء']],
  ['general','grid',350,60,0,'School Stationery Bundle','حزمة قرطاسية مدرسية','Notebooks, pens and essentials for students.','دفاتر وأقلام ومستلزمات للطلاب.','Ready for the school term.','جاهزة للفصل الدراسي.',['Great back-to-school value','Quality notebooks & pens','Everything in one pack'],['قيمة ممتازة للعودة للمدرسة','دفاتر وأقلام جيدة','كل شيء في حزمة']],
];

function seedIfEmpty() {
  const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
  if (catCount === 0) {
    const ins = db.prepare('INSERT INTO categories(slug,name_en,name_ar,icon,grad,sort_order) VALUES(?,?,?,?,?,?)');
    CATS.forEach((c, i) => ins.run(c[0], c[1], c[2], c[3], c[4], i));
  }
  const prodCount = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (prodCount === 0) {
    const ins = db.prepare(`INSERT INTO products
      (category_slug,icon,price,cost,stock,is_featured,name_en,name_ar,desc_en,desc_ar,use_en,use_ar,benefits_en,benefits_ar)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // demo cost ≈ 60% of price so the profit feature shows real numbers; edit per product in admin.
    PRODS.forEach(p => ins.run(p[0],p[1],p[2],Math.round(p[2]*0.6),p[3],p[4],p[5],p[6],p[7],p[8],p[9],p[10],JSON.stringify(p[11]),JSON.stringify(p[12])));
    // a few demo flash deals (~20% off) so the storefront section has content; edit per product in admin.
    db.exec('UPDATE products SET discount_price = ROUND(price*0.8) WHERE id IN (1, 9, 12)');
  }
}
seedIfEmpty();

/* ---------- Helpers ---------- */
function rowToProduct(r, includeCost) {
  const gallery = safeArr(r.images);
  const dp = Number(r.discount_price) || 0;
  const p = {
    id: r.id, cat: r.category_slug, icon: r.icon, image: r.image || null,
    images: gallery,
    price: r.price, stock: r.stock, feat: !!r.is_featured, active: !!r.is_active,
    isNew: !!r.is_new,                       // "New Arrival" badge (public)
    status: r.status || 'active',
    brand: r.brand || '',
    sale: (dp > 0 && dp < r.price) ? dp : null,   // active discount price ("flash deal")
    weight: r.weight || '', dims: r.dimensions || '', video: r.video_url || '',
    en: { name: r.name_en, desc: r.desc_en, use: r.use_en, benefits: safeArr(r.benefits_en), ingredients: r.ingredients_en || '', warnings: r.warnings_en || '' },
    ar: { name: r.name_ar, desc: r.desc_ar, use: r.use_ar, benefits: safeArr(r.benefits_ar), ingredients: r.ingredients_ar || '', warnings: r.warnings_ar || '' },
  };
  if (includeCost) {   // admin-only inventory + costing fields
    p.cost = r.cost || 0;
    p.sku = r.sku || '';
    p.barcode = r.barcode || '';
    p.wholesale = r.wholesale_price || 0;
    p.minStock = r.min_stock || 0;
    p.batchNo = r.batch_no || '';
    p.expiry = r.expiry_date || '';
    p.supplierId = r.supplier_id || null;
    p.bestsellerManual = !!r.is_bestseller;
  }
  return p;
}
function safeArr(s){ try { const a = JSON.parse(s||'[]'); return Array.isArray(a)?a:[]; } catch { return []; } }

// Units sold per product across all non-cancelled orders (online + on-site shop sales).
function soldCounts() {
  const counts = {};
  for (const o of db.prepare("SELECT items_json FROM orders WHERE status NOT IN ('cancelled','returned','refunded')").all()) {
    try { JSON.parse(o.items_json).forEach(i => { counts[i.id] = (counts[i.id] || 0) + (i.qty || 0); }); } catch {}
  }
  return counts;
}
// Best sellers = products with the most units sold.
function bestSellerIds(limit = 8) {
  return Object.entries(soldCounts()).filter(([, q]) => q > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => Number(id));
}

// How many registered customers have each product on their wishlist.
function wishCounts() {
  const map = {};
  db.prepare('SELECT product_id pid, COUNT(*) c FROM customer_wishlist GROUP BY product_id').all().forEach(r => map[r.pid] = r.c);
  return map;
}

// Real star ratings per product, from approved customer reviews.
function productRatings() {
  const map = {};
  for (const row of db.prepare("SELECT product_id pid, COUNT(*) c, AVG(rating) a FROM reviews WHERE status='approved' AND product_id IS NOT NULL GROUP BY product_id").all()) {
    map[row.pid] = { avg: Math.round(row.a * 10) / 10, count: row.c };
  }
  return map;
}

/* ---------- Activity log (who did what, when) ---------- */
function logAct(user, action, detail) {
  db.prepare('INSERT INTO activity_logs(user,action,detail) VALUES(?,?,?)')
    .run(String(user || ''), String(action), String(detail || '').slice(0, 240));
  // keep the log bounded so it never bloats the database
  db.prepare("DELETE FROM activity_logs WHERE id <= (SELECT MAX(id) FROM activity_logs) - 5000").run();
}

/* ---------- Stock ledger: record every stock change with the resulting level ---------- */
const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

/* ===== Investor profit engine =====
   When investor-funded products sell, the sold quantity is allocated to open investments
   (oldest first) and profit is split on PROFIT ONLY, at the actual selling price of the order. */
function recordInvestorSalesForOrder(orderId, orderNumber, items, byRef = '') {
  for (const it of items) {
    let left = Number(it.qty) || 0;
    if (left <= 0) continue;
    const open = db.prepare(`SELECT i.*, COALESCE((SELECT SUM(qty) FROM investor_sales s WHERE s.investment_id=i.id),0) sold
      FROM investments i WHERE i.product_id=? AND i.status IN ('active','completed') ORDER BY i.id`).all(it.id);
    for (const inv of open) {
      if (left <= 0) break;
      const capacity = inv.qty_funded - inv.sold;
      if (capacity <= 0) continue;
      const q = Math.min(capacity, left); left -= q;
      const unit = Number(it.price) || 0;              // actual charged price (flash deals included)
      const revenue = r2(unit * q);
      const cost = r2(inv.cost_per_unit * q);
      const gross = r2(revenue - cost);
      const ip = r2(gross * inv.investor_pct / 100);
      db.prepare(`INSERT INTO investor_sales(investment_id,investor_id,order_id,order_number,product_id,qty,unit_price,revenue,cost,gross_profit,investor_profit,business_profit)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(inv.id, inv.investor_id, orderId, orderNumber || '', it.id, q, unit, revenue, cost, gross, ip, r2(gross - ip));
      if (inv.sold + q >= inv.qty_funded && inv.status === 'active')
        db.prepare("UPDATE investments SET status='completed' WHERE id=?").run(inv.id);
    }
  }
}
// Order cancelled / returned / refunded → reverse the profit rows exactly once.
function reverseInvestorSalesForOrder(orderId) {
  const already = db.prepare('SELECT COUNT(*) c FROM investor_sales WHERE order_id=? AND qty<0').get(orderId).c;
  if (already) return;
  const rows = db.prepare('SELECT * FROM investor_sales WHERE order_id=? AND qty>0').all(orderId);
  for (const s of rows) {
    db.prepare(`INSERT INTO investor_sales(investment_id,investor_id,order_id,order_number,product_id,qty,unit_price,revenue,cost,gross_profit,investor_profit,business_profit)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.investment_id, s.investor_id, s.order_id, s.order_number, s.product_id, -s.qty, s.unit_price,
           -s.revenue, -s.cost, -s.gross_profit, -s.investor_profit, -s.business_profit);
    db.prepare("UPDATE investments SET status='active' WHERE id=? AND status='completed'").run(s.investment_id);
  }
}

function logMove(productId, qtyChange, reason, ref, byUser) {
  const p = db.prepare('SELECT stock, name_en FROM products WHERE id=?').get(productId);
  if (!p) return;
  db.prepare('INSERT INTO stock_moves(product_id,product_name,qty_change,stock_after,reason,ref,by_user) VALUES(?,?,?,?,?,?,?)')
    .run(productId, p.name_en, qtyChange, p.stock, String(reason), String(ref || ''), String(byUser || ''));
}
function newReferralCode() {
  for (let i = 0; i < 20; i++) {
    const code = 'JT' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
    if (!db.prepare('SELECT id FROM customers WHERE referral_code=?').get(code)) return code;
  }
  return 'JT' + Date.now().toString(36).toUpperCase();
}
function nextPoNumber() {
  const n = (db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c + 1).toString().padStart(4, '0');
  return `PO-2026-${n}`;
}

const queries = {
  activeProducts: () => { const best = new Set(bestSellerIds(8)); const rt = productRatings(); const sold = soldCounts(); const wish = wishCounts(); return db.prepare("SELECT * FROM products WHERE is_active=1 AND status NOT IN ('archived','draft') ORDER BY is_featured DESC, id ASC").all().map(r => { const p = rowToProduct(r); p.bestseller = !!r.is_bestseller || best.has(r.id); p.rating = rt[r.id] || null; p.sold = sold[r.id] || 0; p.wishers = wish[r.id] || 0; return p; }); },
  allProducts:    () => { const best = new Set(bestSellerIds(8)); const wish = wishCounts(); return db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(r => { const p = rowToProduct(r, true); p.bestseller = !!r.is_bestseller || best.has(r.id); p.wishers = wish[r.id] || 0; return p; }); },
  productById:    (id) => { const r = db.prepare('SELECT * FROM products WHERE id=?').get(id); if(!r) return null; const p = rowToProduct(r, true); p.bestseller = !!r.is_bestseller || bestSellerIds(8).includes(r.id); const rt = productRatings(); p.rating = rt[r.id] || null; return p; },
  bestSellerIds,
  productReviews: (pid) => db.prepare("SELECT id,name,location,rating,text_en,created_at FROM reviews WHERE status='approved' AND product_id=? ORDER BY id DESC LIMIT 30").all(pid),
  // Newsletter
  addSubscriber: (email, name) => db.prepare('INSERT INTO newsletter(email,name) VALUES(?,?) ON CONFLICT(email) DO NOTHING').run(String(email).toLowerCase(), name || ''),
  allSubscribers: () => db.prepare('SELECT * FROM newsletter ORDER BY id DESC').all(),
  // Suppliers
  allSuppliers:    () => db.prepare('SELECT * FROM suppliers ORDER BY is_active DESC, name ASC').all(),
  activeSuppliers: () => db.prepare('SELECT id,name,phone FROM suppliers WHERE is_active=1 ORDER BY name ASC').all(),
  supplierById:    (id) => db.prepare('SELECT * FROM suppliers WHERE id=?').get(id),
  // Inventory alerts — low stock uses the per-product minimum, falling back to the global threshold.
  lowStockProducts: () => { const gt = Number(getSetting('low_stock_threshold', '5')) || 5; return db.prepare('SELECT * FROM products WHERE is_active=1').all().map(r => rowToProduct(r, true)).filter(p => p.stock <= (p.minStock > 0 ? p.minStock : gt)); },
  expiringProducts: (days = 60) => db.prepare("SELECT * FROM products WHERE is_active=1 AND expiry_date IS NOT NULL AND expiry_date!='' AND date(expiry_date) <= date('now', ?)").all(String('+' + (Number(days) || 60) + ' days')).map(r => rowToProduct(r, true)),
  activeCategories: () => db.prepare('SELECT * FROM categories WHERE is_active=1 ORDER BY sort_order ASC').all().map(c => ({ id:c.slug, slug:c.slug, en:c.name_en, ar:c.name_ar, icon:c.icon, grad:c.grad, image:c.image||null, parent_id:c.parent_id||null })),
  allCategories:  () => db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all(),
  allExpenses:    () => db.prepare('SELECT * FROM expenses ORDER BY spent_on DESC, id DESC').all(),
  totalExpenses:  () => db.prepare('SELECT COALESCE(SUM(amount),0) s FROM expenses').get().s,
  // FAQs
  activeFaqs:  () => db.prepare('SELECT * FROM faqs WHERE is_active=1 ORDER BY sort_order ASC, id ASC').all(),
  allFaqs:     () => db.prepare('SELECT * FROM faqs ORDER BY sort_order ASC, id ASC').all(),
  // Reviews
  approvedReviews: () => db.prepare("SELECT id,name,location,rating,text_en,created_at FROM reviews WHERE status='approved' ORDER BY id DESC LIMIT 12").all(),
  allReviews:  () => db.prepare("SELECT * FROM reviews ORDER BY (status='pending') DESC, id DESC").all(),
  // Users (never return pass_hash)
  allUsers:    () => db.prepare('SELECT id,username,name,role,permissions,is_active,created_at FROM users ORDER BY id ASC').all(),
  // Couriers = active users allowed to deliver
  couriers: () => db.prepare('SELECT id,username,name,role,permissions FROM users WHERE is_active=1').all()
    .filter(u => { if (u.role === 'owner') return true; try { return JSON.parse(u.permissions||'[]').includes('delivery'); } catch { return false; } })
    .map(u => ({ id: u.id, username: u.username, name: u.name || u.username })),
  // Active orders assigned to a specific courier (not yet delivered/cancelled/failed)
  deliveriesFor: (courierId) => {
    const rows = db.prepare("SELECT * FROM orders WHERE courier_id=? AND status NOT IN ('delivered','cancelled','failed') ORDER BY (status='out_for_delivery') DESC, id DESC").all(courierId);
    rows.forEach(o => { o.items = (() => { try { return JSON.parse(o.items_json); } catch { return []; } })(); delete o.items_json; });
    return rows;
  },
  // Inventory: ledger, purchase orders, supplier balances, valuation
  stockMoves: (productId, limit = 120) => productId
    ? db.prepare('SELECT * FROM stock_moves WHERE product_id=? ORDER BY id DESC LIMIT ?').all(productId, limit)
    : db.prepare('SELECT * FROM stock_moves ORDER BY id DESC LIMIT ?').all(limit),
  allPOs: () => {
    const pos = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').all();
    const items = db.prepare('SELECT * FROM po_items').all();
    pos.forEach(po => { po.items = items.filter(i => i.po_id === po.id); });
    return pos;
  },
  poById: (id) => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id);
    if (po) po.items = db.prepare('SELECT * FROM po_items WHERE po_id=?').all(id);
    return po;
  },
  supplierBalances: () => {
    const owed = {}, paid = {};
    db.prepare("SELECT supplier_id sid, COALESCE(SUM(total_cost),0) s FROM purchase_orders WHERE status!='cancelled' AND supplier_id IS NOT NULL GROUP BY supplier_id").all()
      .forEach(r => owed[r.sid] = r.s);
    db.prepare('SELECT supplier_id sid, COALESCE(SUM(amount),0) s FROM supplier_payments GROUP BY supplier_id').all()
      .forEach(r => paid[r.sid] = r.s);
    const out = {};
    for (const sid of new Set([...Object.keys(owed), ...Object.keys(paid)]))
      out[sid] = { purchased: owed[sid] || 0, paid: paid[sid] || 0, balance: (owed[sid] || 0) - (paid[sid] || 0) };
    return out;
  },
  supplierPayments: (sid) => sid
    ? db.prepare('SELECT * FROM supplier_payments WHERE supplier_id=? ORDER BY id DESC').all(sid)
    : db.prepare('SELECT * FROM supplier_payments ORDER BY id DESC').all(),
  inventoryReport: () => {
    const rows = db.prepare("SELECT id,name_en,category_slug,stock,cost,price,min_stock,expiry_date FROM products WHERE is_active=1 AND status!='archived'").all();
    // units sold in the last 30 days from the order ledger
    const sold30 = {};
    db.prepare("SELECT product_id pid, COALESCE(SUM(-qty_change),0) q FROM stock_moves WHERE reason IN ('order','sale') AND created_at >= datetime('now','-30 days') GROUP BY product_id").all()
      .forEach(r => sold30[r.pid] = r.q);
    const gt = Number(getSetting('low_stock_threshold', '5')) || 5;
    let costValue = 0, retailValue = 0, low = 0, out = 0;
    const items = rows.map(r => {
      costValue += r.stock * (r.cost || 0); retailValue += r.stock * (r.price || 0);
      const min = r.min_stock > 0 ? r.min_stock : gt;
      if (r.stock <= 0) out++; else if (r.stock <= min) low++;
      return { id: r.id, name: r.name_en, cat: r.category_slug, stock: r.stock, cost: r.cost || 0, price: r.price || 0,
               value_cost: r.stock * (r.cost || 0), value_retail: r.stock * (r.price || 0),
               sold30: sold30[r.id] || 0, min, expiry: r.expiry_date || '' };
    });
    return { items, totals: { products: rows.length, units: rows.reduce((s, r) => s + r.stock, 0), costValue, retailValue, low, out } };
  },
  // Customers (CRM)
  customerByPhone: (phone) => db.prepare('SELECT * FROM customers WHERE phone=?').get(String(phone).replace(/[^0-9]/g, '')),
  customerById: (id) => db.prepare('SELECT * FROM customers WHERE id=?').get(id),
  customerByToken: (token) => {
    const s = db.prepare('SELECT customer_id FROM customer_sessions WHERE token=?').get(token);
    return s ? db.prepare('SELECT * FROM customers WHERE id=? AND is_active=1').get(s.customer_id) : null;
  },
  customerOrders: (c) => {
    const rows = db.prepare("SELECT * FROM orders WHERE customer_id=? OR replace(replace(customer_phone,'+',''),' ','')=? ORDER BY id DESC LIMIT 40").all(c.id, c.phone);
    rows.forEach(o => { o.items = (() => { try { return JSON.parse(o.items_json); } catch { return []; } })(); delete o.items_json; });
    return rows;
  },
  allCustomers: () => {
    const custs = db.prepare('SELECT id,name,phone,email,points,referral_code,referred_by,notes,is_active,created_at FROM customers ORDER BY id DESC').all();
    const agg = {};
    db.prepare("SELECT customer_id cid, COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE customer_id IS NOT NULL AND status NOT IN ('cancelled','returned','refunded') GROUP BY customer_id").all()
      .forEach(r => agg[r.cid] = r);
    const refs = {};
    db.prepare('SELECT referred_by rb, COUNT(*) c FROM customers WHERE referred_by IS NOT NULL GROUP BY referred_by').all().forEach(r => refs[r.rb] = r.c);
    return custs.map(c => ({ ...c, orders: (agg[c.id] || {}).c || 0, spent: (agg[c.id] || {}).s || 0, referrals: refs[c.id] || 0 }));
  },
  // ---- Investor module ----
  investorByPhone: (phone) => db.prepare('SELECT * FROM investors WHERE phone=?').get(String(phone).replace(/[^0-9]/g, '')),
  investorById: (id) => db.prepare('SELECT * FROM investors WHERE id=?').get(id),
  investorByToken: (token) => {
    const s = db.prepare('SELECT investor_id FROM investor_sessions WHERE token=?').get(String(token || ''));
    return s ? db.prepare("SELECT * FROM investors WHERE id=? AND status='active'").get(s.investor_id) : null;
  },
  allInvestors: () => db.prepare('SELECT * FROM investors ORDER BY id DESC').all().map(v => {
    const inv = db.prepare('SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM investments WHERE investor_id=? AND status!=\'cancelled\'').get(v.id);
    const pr = db.prepare('SELECT COALESCE(SUM(investor_profit),0) p FROM investor_sales WHERE investor_id=?').get(v.id).p;
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM investor_payouts WHERE investor_id=?').get(v.id).a;
    return { id: v.id, name: v.name, phone: v.phone, email: v.email, address: v.address, status: v.status, created_at: v.created_at,
             invested: inv.a, investments: inv.n, profit_earned: r2(pr), paid_out: r2(paid), balance: r2(pr - paid) };
  }),
  investmentMetrics: (i) => {
    const agg = db.prepare(`SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(revenue),0) rev, COALESCE(SUM(cost),0) c,
      COALESCE(SUM(gross_profit),0) g, COALESCE(SUM(investor_profit),0) ip, COALESCE(SUM(business_profit),0) bp
      FROM investor_sales WHERE investment_id=?`).get(i.id);
    const expRevenue = (i.sell_price_ref || 0) * i.qty_funded;
    const expGross = expRevenue - i.amount;
    return { ...i,
      qty_sold: agg.q, qty_remaining: Math.max(0, i.qty_funded - agg.q),
      revenue: r2(agg.rev), actual_cost: r2(agg.c), gross_profit: r2(agg.g),
      investor_profit: r2(agg.ip), business_profit: r2(agg.bp),
      expected_revenue: r2(expRevenue), expected_gross: r2(expGross),
      expected_investor: r2(expGross * i.investor_pct / 100), expected_business: r2(expGross * (100 - i.investor_pct) / 100) };
  },
  allInvestments: () => db.prepare(`SELECT i.*, v.name investor_name, p.name_en product_name
      FROM investments i JOIN investors v ON v.id=i.investor_id JOIN products p ON p.id=i.product_id
      ORDER BY i.id DESC`).all().map(i => queries.investmentMetrics(i)),
  investorLedger: (investorId, limit = 60) => db.prepare(`
    SELECT * FROM (
      SELECT 'investment' type, i.created_at at, -0.0 amount, 'Invested D'||i.amount||' — '||p.name_en||' ×'||i.qty_funded descr, i.id ref
        FROM investments i JOIN products p ON p.id=i.product_id WHERE i.investor_id=? AND i.status!='cancelled'
      UNION ALL
      SELECT CASE WHEN s.qty>=0 THEN 'sale_profit' ELSE 'reversal' END, s.created_at, s.investor_profit,
        CASE WHEN s.qty>=0 THEN 'Profit share' ELSE 'Reversal' END||' — '||p.name_en||' ×'||abs(s.qty)||' @ D'||s.unit_price||CASE WHEN s.order_number!='' THEN ' ('||s.order_number||')' ELSE '' END, s.id
        FROM investor_sales s JOIN products p ON p.id=s.product_id WHERE s.investor_id=?
      UNION ALL
      SELECT 'payout', po.paid_at, -po.amount, 'Payout — '||po.method||CASE WHEN po.reference!='' THEN ' ('||po.reference||')' ELSE '' END, po.id
        FROM investor_payouts po WHERE po.investor_id=?
    ) ORDER BY at DESC LIMIT ?`).all(investorId, investorId, investorId, limit),
  // Loans (credit given to customers/friends, and credit the store takes from suppliers/lenders)
  allLoans: () => db.prepare('SELECT * FROM loans ORDER BY (status=\'active\') DESC, date_due ASC, id DESC').all()
    .map(l => ({ ...l, overdue: l.status === 'active' && l.date_due && l.date_due < new Date().toISOString().slice(0, 10) })),
  loanById: (id) => db.prepare('SELECT * FROM loans WHERE id=?').get(id),
  loansDue: (days = 3) => db.prepare(`SELECT * FROM loans WHERE status='active' AND date_due IS NOT NULL AND date_due!=''
    AND date(date_due) <= date('now', '+' || ? || ' days') ORDER BY date_due ASC`).all(days),
  // Coupons
  couponByCode: (code) => db.prepare('SELECT * FROM coupons WHERE upper(code)=upper(?)').get(String(code).trim()),
  allCoupons: () => db.prepare('SELECT * FROM coupons ORDER BY id DESC').all(),
  // Banners
  activeBanners: () => db.prepare('SELECT id,image,title_en,title_ar,link FROM banners WHERE is_active=1 ORDER BY sort_order ASC, id ASC').all(),
  allBanners: () => db.prepare('SELECT * FROM banners ORDER BY sort_order ASC, id ASC').all(),
  // Activity log
  activityLog: (limit = 100) => db.prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT ?').all(Math.min(300, limit)),
  // Dashboard metrics (single call feeds the redesigned Overview)
  dashboard: () => {
    const one = (sql, ...a) => db.prepare(sql).get(...a) || {};
    const today = one("SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE status NOT IN ('cancelled','returned','refunded') AND date(created_at)=date('now')");
    const month = one("SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE status NOT IN ('cancelled','returned','refunded') AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')");
    const pending = one("SELECT COUNT(*) c FROM orders WHERE status='new'").c;
    // last 30 days sales series
    const series = db.prepare(`SELECT date(created_at) d, COALESCE(SUM(total),0) s, COUNT(*) c FROM orders
      WHERE status NOT IN ('cancelled','returned','refunded') AND created_at >= datetime('now','-30 days') GROUP BY date(created_at) ORDER BY d ASC`).all();
    // customer growth: first order date per phone
    const firsts = db.prepare("SELECT MIN(date(created_at)) f FROM orders WHERE customer_phone!='' GROUP BY customer_phone").all().map(r => r.f);
    const newThisMonth = firsts.filter(f => f && f.slice(0, 7) === new Date().toISOString().slice(0, 7)).length;
    const totalCustomers = firsts.length;
    // profit month-to-date (from snapshotted item prices/costs)
    let profitMonth = 0;
    db.prepare("SELECT items_json FROM orders WHERE status NOT IN ('cancelled','returned','refunded') AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").all()
      .forEach(o => { try { JSON.parse(o.items_json).forEach(i => profitMonth += ((i.price || 0) - (i.cost || 0)) * (i.qty || 0)); } catch {} });
    const expMonth = one("SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE strftime('%Y-%m',spent_on)=strftime('%Y-%m','now')").s;
    const recent = db.prepare('SELECT id,order_number,customer_name,total,status,created_at FROM orders ORDER BY id DESC LIMIT 6').all();
    const pendingReviews = one("SELECT COUNT(*) c FROM reviews WHERE status='pending'").c;
    const loansDue = db.prepare(`SELECT id,direction,party_name,kind,amount,paid_amount,date_due FROM loans
      WHERE status='active' AND date_due IS NOT NULL AND date_due!='' AND date(date_due) <= date('now','+3 days')
      ORDER BY date_due ASC LIMIT 8`).all();
    return { today, month, pending, series, newThisMonth, totalCustomers, profitMonth, expMonth, recent, pendingReviews, loansDue };
  },
  // Reports with a date range (from/to inclusive, ISO dates)
  report: (type, from, to) => {
    const F = from || '2000-01-01', T = to || '2100-01-01';
    const ordersIn = () => db.prepare(`SELECT * FROM orders WHERE status NOT IN ('cancelled') AND date(created_at) BETWEEN ? AND ?`).all(F, T);
    if (type === 'sales') {
      const rows = db.prepare(`SELECT date(created_at) d, COUNT(*) orders, COALESCE(SUM(total),0) revenue,
        SUM(CASE WHEN channel='onsite' THEN 1 ELSE 0 END) shop, SUM(CASE WHEN channel!='onsite' THEN 1 ELSE 0 END) online
        FROM orders WHERE status NOT IN ('cancelled','returned','refunded') AND date(created_at) BETWEEN ? AND ?
        GROUP BY date(created_at) ORDER BY d DESC`).all(F, T);
      return { rows, totals: { orders: rows.reduce((s, r) => s + r.orders, 0), revenue: rows.reduce((s, r) => s + r.revenue, 0) } };
    }
    if (type === 'pl') {
      let revenue = 0, cogs = 0;
      db.prepare(`SELECT items_json,total,delivery_fee FROM orders WHERE status NOT IN ('cancelled','returned','refunded') AND date(created_at) BETWEEN ? AND ?`).all(F, T)
        .forEach(o => { revenue += o.total; try { JSON.parse(o.items_json).forEach(i => cogs += (i.cost || 0) * (i.qty || 0)); } catch {} });
      const expRows = db.prepare('SELECT category, COALESCE(SUM(amount),0) amount FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC').all(F, T);
      const expenses = expRows.reduce((s, r) => s + r.amount, 0);
      return { revenue, cogs, grossProfit: revenue - cogs, expRows, expenses, netProfit: revenue - cogs - expenses };
    }
    if (type === 'purchases') {
      const rows = db.prepare(`SELECT po_number, supplier_name, status, total_cost, created_at, received_at FROM purchase_orders
        WHERE status!='cancelled' AND date(created_at) BETWEEN ? AND ? ORDER BY id DESC`).all(F, T);
      return { rows, totals: { count: rows.length, cost: rows.reduce((s, r) => s + r.total_cost, 0) } };
    }
    if (type === 'expenses') {
      const rows = db.prepare('SELECT spent_on, category, description, amount, created_by FROM expenses WHERE spent_on BETWEEN ? AND ? ORDER BY spent_on DESC, id DESC').all(F, T);
      return { rows, totals: { count: rows.length, amount: rows.reduce((s, r) => s + r.amount, 0) } };
    }
    if (type === 'customers') {
      const map = {};
      ordersIn().forEach(o => {
        if (o.status === 'returned' || o.status === 'refunded') return;
        const k = (o.customer_phone || '').replace(/[^0-9]/g, '') || o.customer_name;
        if (!map[k]) map[k] = { name: o.customer_name, phone: o.customer_phone, orders: 0, spent: 0, last: '' };
        map[k].orders++; map[k].spent += o.total; if (o.created_at > map[k].last) { map[k].last = o.created_at; map[k].name = o.customer_name; }
      });
      const rows = Object.values(map).sort((a, b) => b.spent - a.spent).slice(0, 100);
      return { rows, totals: { customers: rows.length, spent: rows.reduce((s, r) => s + r.spent, 0) } };
    }
    if (type === 'suppliers') {
      const bal = {};
      db.prepare("SELECT supplier_id sid, COALESCE(SUM(total_cost),0) s, COUNT(*) c FROM purchase_orders WHERE status!='cancelled' AND supplier_id IS NOT NULL GROUP BY supplier_id").all().forEach(r => bal[r.sid] = { purchased: r.s, pos: r.c, paid: 0 });
      db.prepare('SELECT supplier_id sid, COALESCE(SUM(amount),0) s FROM supplier_payments GROUP BY supplier_id').all().forEach(r => { (bal[r.sid] = bal[r.sid] || { purchased: 0, pos: 0, paid: 0 }).paid = r.s; });
      const rows = db.prepare('SELECT id,name,phone FROM suppliers').all().map(su => ({ name: su.name, phone: su.phone,
        pos: (bal[su.id] || {}).pos || 0, purchased: (bal[su.id] || {}).purchased || 0, paid: (bal[su.id] || {}).paid || 0,
        balance: ((bal[su.id] || {}).purchased || 0) - ((bal[su.id] || {}).paid || 0) })).sort((a, b) => b.balance - a.balance);
      return { rows, totals: { purchased: rows.reduce((s, r) => s + r.purchased, 0), paid: rows.reduce((s, r) => s + r.paid, 0), balance: rows.reduce((s, r) => s + r.balance, 0) } };
    }
    if (type === 'payments') {
      const rows = db.prepare(`SELECT payment_method method, COUNT(*) orders, COALESCE(SUM(total),0) revenue,
        SUM(CASE WHEN payment_status='paid' THEN 1 ELSE 0 END) paid_count
        FROM orders WHERE status NOT IN ('cancelled','returned','refunded') AND date(created_at) BETWEEN ? AND ?
        GROUP BY payment_method ORDER BY revenue DESC`).all(F, T);
      return { rows, totals: { orders: rows.reduce((s, r) => s + r.orders, 0), revenue: rows.reduce((s, r) => s + r.revenue, 0) } };
    }
    return null;
  },
  // Delivery zones
  activeZones: () => db.prepare('SELECT id,name_en,name_ar,fee FROM delivery_zones WHERE is_active=1 ORDER BY sort_order ASC, id ASC').all(),
  allZones:    () => db.prepare('SELECT * FROM delivery_zones ORDER BY sort_order ASC, id ASC').all(),
  zoneById:    (id) => db.prepare('SELECT * FROM delivery_zones WHERE id=?').get(id),
};

module.exports = { db, DB_PATH, DATA_DIR, queries, getSetting, setSetting, rowToProduct, DEFAULT_SETTINGS, hashPassword, verifyPassword, ALL_PERMS, logMove, nextPoNumber, logAct, newReferralCode, recordInvestorSalesForOrder, reverseInvestorSalesForOrder };
