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
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_slug TEXT NOT NULL,
  icon TEXT DEFAULT 'grid',
  image TEXT,
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  name_en TEXT NOT NULL,
  name_ar TEXT DEFAULT '',
  desc_en TEXT DEFAULT '',
  desc_ar TEXT DEFAULT '',
  use_en TEXT DEFAULT '',
  use_ar TEXT DEFAULT '',
  benefits_en TEXT DEFAULT '[]',
  benefits_ar TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
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
  items_json TEXT DEFAULT '[]',
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
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

/* ---------- Lightweight migrations (for databases created before these columns existed) ---------- */
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!columnExists('products', 'cost')) db.exec('ALTER TABLE products ADD COLUMN cost REAL NOT NULL DEFAULT 0');
if (!columnExists('sessions', 'user_id')) db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER');

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
const ALL_PERMS = ['products', 'orders', 'reviews', 'faqs', 'profit', 'users', 'settings'];

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
  }
}
seedIfEmpty();

/* ---------- Helpers ---------- */
function rowToProduct(r, includeCost) {
  const p = {
    id: r.id, cat: r.category_slug, icon: r.icon, image: r.image || null,
    price: r.price, stock: r.stock, feat: !!r.is_featured, active: !!r.is_active,
    en: { name: r.name_en, desc: r.desc_en, use: r.use_en, benefits: safeArr(r.benefits_en) },
    ar: { name: r.name_ar, desc: r.desc_ar, use: r.use_ar, benefits: safeArr(r.benefits_ar) },
  };
  if (includeCost) p.cost = r.cost || 0;       // cost only exposed to the admin API
  return p;
}
function safeArr(s){ try { const a = JSON.parse(s||'[]'); return Array.isArray(a)?a:[]; } catch { return []; } }

const queries = {
  activeProducts: () => db.prepare('SELECT * FROM products WHERE is_active=1 ORDER BY is_featured DESC, id ASC').all().map(r => rowToProduct(r)),
  allProducts:    () => db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(r => rowToProduct(r, true)),
  productById:    (id) => { const r = db.prepare('SELECT * FROM products WHERE id=?').get(id); return r ? rowToProduct(r, true) : null; },
  activeCategories: () => db.prepare('SELECT * FROM categories WHERE is_active=1 ORDER BY sort_order ASC').all().map(c => ({ id:c.slug, slug:c.slug, en:c.name_en, ar:c.name_ar, icon:c.icon, grad:c.grad })),
  allCategories:  () => db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all(),
  // FAQs
  activeFaqs:  () => db.prepare('SELECT * FROM faqs WHERE is_active=1 ORDER BY sort_order ASC, id ASC').all(),
  allFaqs:     () => db.prepare('SELECT * FROM faqs ORDER BY sort_order ASC, id ASC').all(),
  // Reviews
  approvedReviews: () => db.prepare("SELECT id,name,location,rating,text_en,created_at FROM reviews WHERE status='approved' ORDER BY id DESC LIMIT 12").all(),
  allReviews:  () => db.prepare("SELECT * FROM reviews ORDER BY (status='pending') DESC, id DESC").all(),
  // Users (never return pass_hash)
  allUsers:    () => db.prepare('SELECT id,username,name,role,permissions,is_active,created_at FROM users ORDER BY id ASC').all(),
};

module.exports = { db, queries, getSetting, setSetting, rowToProduct, DEFAULT_SETTINGS, hashPassword, verifyPassword, ALL_PERMS };
