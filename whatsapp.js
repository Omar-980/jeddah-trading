'use strict';
/* =====================================================================================
   WhatsApp assistant — Jeddah Trading
   -------------------------------------------------------------------------------------
   A shop assistant that lives on the store's WhatsApp number. A customer can browse the
   catalogue, build a basket, check out and track an order without anyone at the shop
   touching a phone; when they want a person, the conversation moves into the admin Chat
   inbox and staff reply from there.

   How it fits the rest of the system:
     · Products, sizes, prices, stock and delivery zones are read live from the same
       database as the website. Nothing is copied, so nothing drifts.
     · Orders go through placeOrder() in server.js — the exact path the website checkout
       uses — so totals, delivery fees, stock, investor profit and online payment are
       computed by the server in one place. The bot never decides a price.
     · Messages arrive from Meta's WhatsApp Cloud API at /api/webhooks/whatsapp (signed,
       de-duplicated) and replies go back through the Graph API.
     · The admin simulator drives the very same engine with a test phone whose replies are
       drawn on screen instead of being sent, so every flow can be tried before going live.

   Zero dependencies: node:crypto and the global fetch() only.
   ===================================================================================== */
const crypto = require('node:crypto');

module.exports = function createWhatsApp(deps) {
  const { db, queries, getSetting, setSetting, placeOrder, addChatMessage, newToken,
          ADMIN_STREAMS, sseSend, saveImage, modemOn } = deps;

  /* ---------------------------------------------------------------- settings */
  function cfg() {
    return {
      enabled: getSetting('wa_enabled') === '1',
      phoneId: String(process.env.WA_PHONE_NUMBER_ID || getSetting('wa_phone_number_id') || '').trim(),
      token: String(process.env.WA_ACCESS_TOKEN || getSetting('wa_access_token') || '').trim(),
      appSecret: String(process.env.WA_APP_SECRET || getSetting('wa_app_secret') || '').trim(),
      version: String(getSetting('wa_graph_version') || 'v21.0').trim() || 'v21.0',
    };
  }
  function verifyToken() {
    let t = getSetting('wa_verify_token');
    if (!t) { t = 'jt-' + crypto.randomBytes(12).toString('hex'); setSetting('wa_verify_token', t); }
    return t;
  }
  const live = () => { const c = cfg(); return c.enabled && !!c.phoneId && !!c.token; };
  const storeName = () => getSetting('store_name') || 'Jeddah Trading';

  /* ---------------------------------------------------------------- helpers */
  const digits = s => String(s || '').replace(/[^0-9]/g, '');
  const money = n => 'D' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const unit = p => p.sale || p.price;

  /* Message builders. The shapes follow WhatsApp's own limits so that whatever the bot
     composes is valid on a real phone: 3 reply buttons of ≤20 characters, lists of ≤10
     rows with titles ≤24 and descriptions ≤72, interactive bodies ≤1024 characters. */
  const T = text => ({ kind: 'text', text: cut2(text, 4000) });
  const B = (text, buttons) => ({ kind: 'buttons', text: cut2(text, 1000),
    buttons: buttons.slice(0, 3).map(b => ({ id: b[0], title: cut(b[1], 20) })) });
  const L = (text, button, rows, section) => ({ kind: 'list', text: cut2(text, 1000), button: cut(button, 20),
    section: cut(section || 'Options', 24),
    rows: rows.slice(0, 10).map(r => ({ id: r[0], title: cut(r[1], 24), description: r[2] ? cut(r[2], 72) : '' })) });
  const IMG = (url, caption) => ({ kind: 'image', url, text: cut2(caption, 1000) });
  function cut2(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /* ---------------------------------------------------------------- sessions */
  function getSession(phone, name, simulated) {
    let s = db.prepare('SELECT * FROM wa_sessions WHERE phone=?').get(phone);
    if (!s) {
      db.prepare('INSERT INTO wa_sessions(phone,name,simulated) VALUES(?,?,?)').run(phone, String(name || '').slice(0, 80), simulated ? 1 : 0);
      s = db.prepare('SELECT * FROM wa_sessions WHERE phone=?').get(phone);
      s.isNew = true;
    } else if (name && !s.name) {
      db.prepare('UPDATE wa_sessions SET name=? WHERE phone=?').run(String(name).slice(0, 80), phone);
      s.name = name;
    }
    try { s.data = JSON.parse(s.data_json || '{}'); } catch { s.data = {}; }
    if (!Array.isArray(s.data.cart)) s.data.cart = [];
    return s;
  }
  function saveSession(s) {
    db.prepare("UPDATE wa_sessions SET state=?, data_json=?, mode=?, conversation_id=?, name=?, updated_at=datetime('now') WHERE phone=?")
      .run(s.state, JSON.stringify(s.data), s.mode, s.conversation_id || null, s.name || '', s.phone);
  }

  /* ---------------------------------------------------------------- catalogue */
  const PAGE = 9;   // nine rows + a "More…" row keeps every list within WhatsApp's 10
  function inStock(p) { return p.hasSizes ? (p.variants || []).some(v => v.active && v.stock > 0) : p.stock > 0; }
  function priceLabel(p) {
    if (p.hasSizes && p.priceFrom !== p.priceTo) return 'from ' + money(p.priceFrom);
    return money(unit(p)) + (p.sale ? ' (was ' + money(p.price) + ')' : '');
  }
  function catalog() { return queries.activeProducts(); }
  function categoriesWithProducts() {
    const prods = catalog();
    const counts = {};
    prods.forEach(p => { counts[p.cat] = (counts[p.cat] || 0) + 1; });
    return queries.activeCategories().filter(c => counts[c.slug]).map(c => ({ ...c, count: counts[c.slug] }));
  }
  function searchProducts(q) {
    const words = String(q || '').toLowerCase().split(/[^a-z0-9؀-ۿ]+/).filter(w => w.length >= 3);
    if (!words.length) return [];
    const scored = [];
    for (const p of catalog()) {
      const hay = (p.en.name + ' ' + p.ar.name + ' ' + (p.brand || '') + ' ' + p.cat).toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      if (score) scored.push({ p, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, PAGE).map(x => x.p);
  }
  function imageUrl(p, base) {
    const u = p.image || (p.images || [])[0];
    if (!u || u.startsWith('data:')) return '';
    if (/^https?:\/\//.test(u)) return u;
    return base ? base.replace(/\/$/, '') + '/' + u.replace(/^\//, '') : '';
  }

  /* ---------------------------------------------------------------- screens */
  function menu(s, intro) {
    const cartN = s.data.cart.reduce((n, it) => n + it.qty, 0);
    const rows = [
      ['m:shop', '🛍️ Shop products', 'Browse by category'],
      ['m:cart', '🛒 My basket' + (cartN ? ' (' + cartN + ')' : ''), cartN ? 'Review and check out' : 'Your basket is empty'],
      ['m:track', '📦 Track my order', 'See where your order is'],
      ['m:pay', '💳 How to pay', 'Wave, AfriMoney, QMoney, cash'],
      ['m:info', '📍 Location & hours', 'Find our shop'],
      ['m:human', '🙋 Talk to a person', 'Chat with our team'],
    ];
    s.state = 'menu';
    return [L((intro ? intro + '\n\n' : '') + 'What would you like to do? You can also just type what you are looking for, e.g. *dates* or *perfume*.',
      'Open menu', rows, 'Main menu')];
  }

  function categoriesScreen(s, page) {
    const cats = categoriesWithProducts();
    if (!cats.length) return [T('Our catalogue is being updated — please check back soon, or type *PERSON* to chat with our team.')];
    page = Math.max(0, page | 0);
    const slice = cats.slice(page * PAGE, page * PAGE + PAGE);
    const rows = slice.map(c => ['cat:' + c.slug + ':0', c.en, c.count + ' product' + (c.count === 1 ? '' : 's')]);
    if (cats.length > (page + 1) * PAGE) rows.push(['catp:' + (page + 1), '➡️ More categories', '']);
    s.state = 'browse';
    return [L('🛍️ *Shop by category*\nPick a category to see what we have.', 'Categories', rows, 'Categories')];
  }

  function productListScreen(s, slug, page, list, title) {
    const prods = list || catalog().filter(p => p.cat === slug);
    if (!prods.length) return [T('Nothing in that category right now.'), ...categoriesScreen(s, 0)];
    page = Math.max(0, page | 0);
    const slice = prods.slice(page * PAGE, page * PAGE + PAGE);
    const rows = slice.map(p => ['p:' + p.id, p.en.name, priceLabel(p) + (inStock(p) ? '' : ' · sold out')]);
    if (!list && prods.length > (page + 1) * PAGE) rows.push(['cat:' + slug + ':' + (page + 1), '➡️ More products', '']);
    const cat = queries.activeCategories().find(c => c.slug === slug);
    s.state = 'browse';
    return [L(title || ('*' + (cat ? cat.en : 'Products') + '*\nTap a product to see details.'), 'See products', rows, 'Products')];
  }

  function productScreen(s, id, base) {
    const p = queries.productById(Number(id));
    if (!p || !p.active || ['archived', 'draft'].includes(p.status)) return [T('Sorry, that product is no longer available.'), ...categoriesScreen(s, 0)];
    const lines = ['*' + p.en.name + '*', priceLabel(p)];
    if (p.en.desc) lines.push('', cut(p.en.desc, 300));
    if (!inStock(p)) lines.push('', '⚠️ Sold out at the moment.');
    const out = [];
    const img = imageUrl(p, base);
    if (img) out.push(IMG(img, lines.join('\n')));
    else out.push(T(lines.join('\n')));
    s.data.product = p.id;
    s.state = 'product';
    if (!inStock(p)) {
      out.push(B('Would you like something else?', [['m:shop', 'Other products'], ['m:human', 'Ask our team'], ['m:menu', 'Main menu']]));
    } else if (p.hasSizes) {
      const sizes = p.variants.filter(v => v.active);
      out.push(L('Which size would you like?', 'Choose size',
        sizes.map(v => ['sz:' + v.id, v.label_en || 'Size', money(v.sale || v.price) + (v.stock > 0 ? '' : ' · sold out')]), 'Sizes'));
    } else {
      out.push(B('Add it to your basket?', [['add:' + p.id, '🛒 Add to basket'], ['cat:' + p.cat + ':0', '⬅️ Back'], ['m:cart', 'View basket']]));
    }
    return out;
  }

  function askQty(s, productId, variantId) {
    const p = queries.productById(Number(productId));
    if (!p) return menu(s);
    let label = p.en.name, stock = p.stock;
    if (variantId) {
      const v = (p.variants || []).find(x => x.id === Number(variantId) && x.active);
      if (!v) return [T('That size is not available.'), ...productScreen(s, p.id)];
      if (v.stock <= 0) return [T('Sorry, ' + (v.label_en || 'that size') + ' is sold out.'), ...productScreen(s, p.id)];
      label += ' — ' + v.label_en; stock = v.stock;
    }
    s.data.pending = { id: p.id, variant_id: variantId ? Number(variantId) : null };
    s.state = 'qty';
    return [B('How many of *' + label + '*?\n(Or type a number.)' + (stock < 10 ? '\nOnly ' + stock + ' left.' : ''),
      [['q:1', '1'], ['q:2', '2'], ['q:3', '3']])];
  }

  function addToCart(s, qty) {
    const pend = s.data.pending;
    if (!pend) return menu(s);
    qty = Math.trunc(Number(qty));
    if (!(qty >= 1 && qty <= 99)) return [T('Please send a number between 1 and 99.')];
    const p = queries.productById(pend.id);
    if (!p) return menu(s);
    let stock = p.stock, label = p.en.name;
    if (pend.variant_id) { const v = (p.variants || []).find(x => x.id === pend.variant_id); stock = v ? v.stock : 0; label += ' — ' + (v ? v.label_en : ''); }
    const already = s.data.cart.filter(it => it.id === pend.id && (it.variant_id || null) === (pend.variant_id || null)).reduce((n, it) => n + it.qty, 0);
    if (qty + already > stock) return [T('Sorry, we only have ' + stock + ' of that' + (already ? ' (you already have ' + already + ' in your basket)' : '') + '. Please choose a smaller number.')];
    const line = s.data.cart.find(it => it.id === pend.id && (it.variant_id || null) === (pend.variant_id || null));
    if (line) line.qty += qty; else s.data.cart.push({ id: pend.id, variant_id: pend.variant_id || null, qty });
    delete s.data.pending;
    s.state = 'menu';
    return [B('✅ Added ' + qty + ' × ' + label + ' to your basket.', [['m:cart', '🛒 Check out'], ['m:shop', '🛍️ Keep shopping']])];
  }

  /* The basket is always priced by the server's own quote (placeOrder in dry-run mode),
     so what the customer sees is exactly what the order will charge. */
  async function quote(s, extra) {
    const items = s.data.cart.map(it => ({ id: it.id, qty: it.qty, variant_id: it.variant_id || undefined }));
    const out = await placeOrder(Object.assign({ customer_name: s.name || 'WhatsApp customer', customer_phone: '+' + s.phone, items }, extra || {}),
      { channel: 'whatsapp', dryRun: true });
    return out.status === 200 ? out.body : null;
  }
  function itemLines(items) {
    return items.map(it => '• ' + it.qty + ' × ' + it.name + (it.variant_label ? ' (' + it.variant_label + ')' : '') + ' — ' + money(it.line)).join('\n');
  }
  async function cartScreen(s) {
    if (!s.data.cart.length) {
      s.state = 'menu';
      return [B('Your basket is empty.', [['m:shop', '🛍️ Shop now'], ['m:menu', 'Main menu']])];
    }
    const q = await quote(s);
    if (!q || !q.items.length) {
      s.data.cart = [];
      return [B('The items in your basket are no longer available, so I have emptied it.', [['m:shop', '🛍️ Shop now'], ['m:menu', 'Main menu']])];
    }
    // drop anything the server would not sell (sold-out size, removed product)
    if (q.items.length !== s.data.cart.length) s.data.cart = q.items.map(it => ({ id: it.id, variant_id: it.variantId || null, qty: it.qty }));
    s.state = 'cart';
    const free = Number(getSetting('free_delivery_over')) || 0;
    const hint = free > 0 && q.subtotal < free ? '\n🚚 Free delivery on orders over ' + money(free) + ' — add ' + money(free - q.subtotal) + ' more.' : '';
    return [B('🛒 *Your basket*\n' + itemLines(q.items) + '\n\n*Subtotal: ' + money(q.subtotal) + '*' + hint,
      [['co:start', '✅ Check out'], ['m:shop', '🛍️ Add more'], ['cart:clear', '🗑️ Empty basket']])];
  }

  /* ---------------------------------------------------------------- checkout */
  function payMethods() {
    const enabled = String(getSetting('pay_methods') || 'wave,afri,qmoney,bank,cod').split(',').map(x => x.trim());
    const all = [
      ['cod', '💵 Cash on delivery', 'Pay when it arrives'],
      ['wave', '🌊 Wave', 'Send to ' + (getSetting('pay_wave_number') || '')],
      ['afri', '📱 AfriMoney', 'Send to ' + (getSetting('pay_afri_number') || '')],
      ['qmoney', '📱 QMoney', 'Send to ' + (getSetting('pay_qmoney_number') || '')],
      ['bank', '🏦 Bank transfer', getSetting('pay_bank_name') || 'Bank details after ordering'],
    ].filter(m => enabled.includes(m[0]) && (m[0] !== 'bank' || getSetting('pay_bank_account')));
    if (modemOn && modemOn()) all.unshift(['online', '💳 Pay online now', 'Card / mobile money, secure link']);
    return all;
  }
  function payInstructions(method, total, orderNumber) {
    const acct = getSetting('pay_account_name') || storeName();
    const send = (who, num) => 'Please send *' + money(total) + '* by ' + who + ' to *' + num + '* (' + acct + '), reference *' + orderNumber + '*.\nThen send the payment screenshot here and we will confirm. 📸';
    if (method === 'wave') return send('Wave', getSetting('pay_wave_number'));
    if (method === 'afri') return send('AfriMoney', getSetting('pay_afri_number'));
    if (method === 'qmoney') return send('QMoney', getSetting('pay_qmoney_number'));
    if (method === 'bank') return 'Please transfer *' + money(total) + '* to ' + (getSetting('pay_bank_name') || 'our bank') + ', account *' + (getSetting('pay_bank_account') || '') + '* (' + acct + '), reference *' + orderNumber + '*. Then send the receipt here. 📸';
    return '💵 Please have *' + money(total) + '* ready in cash when your order arrives.';
  }

  function startCheckout(s) {
    if (!s.data.cart.length) return cartScreen(s);
    s.data.co = {};
    if (s.name && s.name.length >= 2) {
      s.state = 'co_name';
      return [B('Great! Should I put the order under the name *' + s.name + '*?', [['co:name:ok', '✅ Yes'], ['co:name:edit', '✏️ Another name']])];
    }
    s.state = 'co_name_type';
    return [T('Great! What name should I put on the order?')];
  }
  function askDelivery(s) {
    if (getSetting('wa_offer_pickup') === '0') { s.data.co.delivery = 'home'; return askZone(s, 0); }
    s.state = 'co_delivery';
    return [B('How would you like to receive it?', [['dl:home', '🚚 Deliver to me'], ['dl:pickup', '🏪 Pick up at shop']])];
  }
  function askZone(s, page) {
    const zones = queries.activeZones();
    if (!zones.length) { s.data.co.zone = null; s.state = 'co_address'; return [T('Please type your delivery address (area, street, a landmark).')]; }
    page = Math.max(0, page | 0);
    const rows = zones.slice(page * PAGE, page * PAGE + PAGE).map(z => ['z:' + z.id, z.name_en, 'Delivery ' + money(z.fee)]);
    if (zones.length > (page + 1) * PAGE) rows.push(['zp:' + (page + 1), '➡️ More areas', '']);
    s.state = 'co_zone';
    return [L('📍 Which area should we deliver to?', 'Choose area', rows, 'Delivery areas')];
  }
  function askPayment(s) {
    const methods = payMethods();
    s.state = 'co_pay';
    if (!methods.length) { s.data.co.pay = 'cod'; return summary(s); }
    return [L('💳 How would you like to pay?', 'Payment options', methods.map(m => ['pay:' + m[0], m[1], m[2]]), 'Payment')];
  }
  async function summary(s) {
    const co = s.data.co;
    const q = await quote(s, { delivery_method: co.delivery === 'pickup' ? 'pickup' : 'home', delivery_zone_id: co.zone || undefined });
    if (!q || !q.items.length) return cartScreen(s);
    const pm = payMethods().find(m => m[0] === co.pay);
    const lines = ['🧾 *Please confirm your order*', '', itemLines(q.items), '',
      'Subtotal: ' + money(q.subtotal),
      co.delivery === 'pickup' ? 'Pickup at our shop: free' : 'Delivery' + (q.zone ? ' (' + q.zone + ')' : '') + ': ' + (q.delivery_fee ? money(q.delivery_fee) : 'FREE 🎉'),
      '*Total: ' + money(q.total) + '*', '',
      '👤 ' + co.name,
      co.delivery === 'pickup' ? '🏪 Pick up at the shop' : '📍 ' + (co.address || ''),
      '💳 ' + (pm ? pm[1].replace(/^\S+\s/, '') : 'Cash on delivery')];
    s.state = 'co_confirm';
    return [B(lines.join('\n'), [['co:confirm', '✅ Confirm order'], ['m:cart', '✏️ Change'], ['co:cancel', '✖️ Cancel']])];
  }
  async function confirmOrder(s, base) {
    const co = s.data.co || {};
    if (!s.data.cart.length) return cartScreen(s);
    const b = {
      customer_name: co.name || s.name || 'WhatsApp customer',
      customer_phone: '+' + s.phone,
      items: s.data.cart.map(it => ({ id: it.id, qty: it.qty, variant_id: it.variant_id || undefined })),
      delivery_method: co.delivery === 'pickup' ? 'pickup' : 'home',
      delivery_zone_id: co.zone || undefined,
      delivery_address: co.delivery === 'pickup' ? '' : (co.address || ''),
      payment_method: co.pay || 'cod',
      notes: (s.simulated ? '🧪 TEST ORDER from the WhatsApp simulator — safe to cancel. ' : '') + 'Ordered through the WhatsApp assistant.',
      language: 'en',
    };
    // stock check right before ordering: someone else may have bought the last one meanwhile
    const q = await quote(s, { delivery_method: b.delivery_method, delivery_zone_id: b.delivery_zone_id });
    for (const it of (q ? q.items : [])) {
      const p = queries.productById(it.id);
      const stock = it.variantId ? ((p.variants || []).find(v => v.id === it.variantId) || {}).stock || 0 : p.stock;
      if (it.qty > stock) {
        return [T('Sorry — while you were checking out, ' + it.name + ' dropped to ' + stock + ' in stock. Please adjust your basket.'), ...(await cartScreen(s))];
      }
    }
    const out = await placeOrder(b, { channel: 'whatsapp', base });
    if (out.status !== 201) return [T('Sorry, I could not place the order: ' + (out.body.error || 'unknown error') + '. Type *PERSON* and our team will help.')];
    const o = out.body;
    s.data.cart = [];
    s.data.lastOrder = o.order_number;
    s.data.co = {};
    s.state = 'menu';
    const msgs = [T('✅ *Order ' + o.order_number + ' received!* Thank you, ' + b.customer_name.split(' ')[0] + '.\n\nTotal: *' + money(o.total) + '*'
      + (o.delivery_fee ? ' (includes ' + money(o.delivery_fee) + ' delivery)' : '') + '\n\n'
      + (o.payment_link ? '💳 Pay securely here: ' + o.payment_link : (o.payment_error ? o.payment_error + '\n\n' + payInstructions('cod', o.total, o.order_number) : payInstructions(b.payment_method, o.total, o.order_number)))
      + (base ? '\n\n📦 Track it any time: ' + base.replace(/\/$/, '') + '/#track=' + encodeURIComponent(o.order_number) : '')
      + '\n\nWe will message you when it is on the way. 🤝')];
    msgs.push(B('Anything else?', [['m:shop', '🛍️ Keep shopping'], ['m:track', '📦 Track order'], ['m:menu', 'Main menu']]));
    return msgs;
  }

  /* ---------------------------------------------------------------- tracking */
  const STATUS = { new: '🆕 Received — we are preparing it', confirmed: '✅ Confirmed', paid: '✅ Paid — being prepared',
    packed: '📦 Packed', out_for_delivery: '🚚 Out for delivery', delivered: '🎉 Delivered',
    cancelled: '✖️ Cancelled', returned: '↩️ Returned', refunded: '↩️ Refunded' };
  /* Website orders are often typed as a local 7-digit number (7093900) while WhatsApp always
     gives the full international one (2207093900). Both forms of the same number count; a
     shorter suffix match does not, because it could show one customer another's order. */
  function samePhone(orderPhone, waPhone) {
    const d = digits(orderPhone);
    return d === waPhone || ('220' + d) === waPhone;
  }
  function trackScreen(s) {
    const local = s.phone.startsWith('220') ? s.phone.slice(3) : s.phone;
    const mine = db.prepare(`SELECT order_number,status,total,created_at,customer_phone FROM orders
      WHERE replace(replace(replace(customer_phone,' ',''),'+',''),'-','') IN (?,?) ORDER BY id DESC LIMIT 5`).all(s.phone, local)
      .filter(o => samePhone(o.customer_phone, s.phone));
    if (!mine.length) { s.state = 'track_type'; return [T('I could not find orders for this number. Please type your order number (e.g. JT-2026-0042).')]; }
    if (mine.length === 1) return trackOne(s, mine[0].order_number);
    s.state = 'menu';
    return [L('📦 Your recent orders — tap one to see its status.', 'My orders',
      mine.map(o => ['trk:' + o.order_number, o.order_number, (STATUS[o.status] || o.status).replace(/^\S+\s/, '') + ' · ' + money(o.total)]), 'Orders')];
  }
  function trackOne(s, ref) {
    const o = db.prepare('SELECT * FROM orders WHERE upper(order_number)=upper(?)').get(String(ref).trim());
    // Only the phone that placed the order may see it — an order number alone is not proof.
    if (!o || !samePhone(o.customer_phone, s.phone)) { s.state = 'track_type'; return [T('I could not find order *' + cut(ref, 30) + '* for this WhatsApp number. Please check the number, or type *PERSON* for help.')]; }
    s.state = 'menu';
    const lines = ['📦 *' + o.order_number + '*', 'Status: ' + (STATUS[o.status] || o.status), 'Total: ' + money(o.total),
      'Payment: ' + (o.payment_status === 'paid' ? '✅ paid' : 'awaiting payment'), 'Placed: ' + String(o.created_at || '').slice(0, 16)];
    if (o.courier_name && !['delivered', 'cancelled'].includes(o.status)) lines.push('Courier: ' + o.courier_name);
    return [B(lines.join('\n'), [['m:human', '🙋 Ask about it'], ['m:shop', '🛍️ Shop'], ['m:menu', 'Main menu']])];
  }

  /* ---------------------------------------------------------------- staff hand-off */
  function ensureConversation(s, reasonText) {
    let conv = s.conversation_id ? db.prepare('SELECT * FROM conversations WHERE id=?').get(s.conversation_id) : null;
    if (!conv) {
      const info = db.prepare(`INSERT INTO conversations(customer_name,customer_phone,source,cust_token,status)
        VALUES(?,?,'whatsapp',?,'open')`).run(s.name || ('+' + s.phone), s.phone, newToken());
      conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(info.lastInsertRowid);
      s.conversation_id = conv.id;
      for (const r of ADMIN_STREAMS) sseSend(r, { type: 'new_conversation', conversation_id: conv.id });
    } else if (conv.status === 'resolved' || conv.status === 'closed') {
      db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(conv.id);
    }
    if (reasonText) addChatMessage(conv.id, 'system', null, '', reasonText, '', '');
    return conv;
  }
  function recentTranscript(phone, n) {
    return db.prepare("SELECT direction, body FROM wa_messages WHERE phone=? ORDER BY id DESC LIMIT ?").all(phone, n)
      .reverse().map(m => (m.direction === 'in' ? '👤 ' : '🤖 ') + cut(m.body, 140)).join('\n');
  }
  async function handOff(s, why) {
    const basket = s.data.cart.length ? '\nBasket: ' + s.data.cart.map(it => { const p = queries.productById(it.id); return it.qty + '× ' + (p ? p.en.name : '#' + it.id); }).join(', ') : '';
    ensureConversation(s, '🤖 WhatsApp assistant: ' + (why || 'customer asked to talk to a person') + '.' + basket + '\n\nRecent messages:\n' + recentTranscript(s.phone, 6));
    s.mode = 'human';
    s.state = 'menu';
    const hours = getSetting('contact_hours_en');
    return [T('🙋 I have passed you to our team — someone will reply right here shortly' + (hours ? ' (' + hours + ')' : '') + '.\n\nYou can type your question now. Type *MENU* at any time to go back to the shop assistant.')];
  }

  /* ---------------------------------------------------------------- the engine */
  const GREET = /^(hi+|hello+|hey+|hai|salaam|salam|salaam alaikum|as+alamu? ?alaikum|assalam.*|good (morning|afternoon|evening)|menu|start|home|0|main menu)[\s!.]*$/i;
  const THANKS = /^(thanks?( you)?|thank u|thx|ok(ay)?|alright|jerejef|abaraka|shukran|jazak ?allah( khair)?|great|perfect|👍|🙏)[\s!.]*$/i;
  const HUMAN = /^(person|human|agent|staff|operator|talk to (a )?(person|human|someone)|customer (care|service))[\s!.]*$/i;

  async function respond(s, input, base) {
    const id = input.id || '';
    const text = String(input.text || '').trim();
    const low = text.toLowerCase();

    // A customer already talking to staff: their words go to the inbox, the bot stays quiet,
    // unless they ask for the menu.
    if (s.mode === 'human') {
      if (id === 'm:menu' || /^(menu|bot|0)$/i.test(low)) {
        s.mode = 'bot';
        if (s.conversation_id) addChatMessage(s.conversation_id, 'system', null, '', '🤖 Customer went back to the WhatsApp assistant.', '', '');
        return menu(s, 'Welcome back to the shop assistant!');
      }
      const conv = ensureConversation(s, '');
      if (input.media) addChatMessage(conv.id, 'customer', null, s.name, text || '', input.media.url || '', input.media.url ? 'image' : '');
      else addChatMessage(conv.id, 'customer', null, s.name, text || input.title || '[message]', '', '');
      return [];
    }

    // Photos while in bot mode: the usual reason is a payment screenshot for the order they
    // just placed, so it goes onto that order and to the team.
    if (input.media) {
      const ref = s.data.lastOrder;
      if (ref && input.media.url) {
        const o = db.prepare('SELECT id, payment_proof FROM orders WHERE order_number=?').get(ref);
        if (o && !o.payment_proof) db.prepare('UPDATE orders SET payment_proof=? WHERE id=?').run(input.media.url, o.id);
        const conv = ensureConversation(s, '📸 Payment screenshot received for order ' + ref + ' — please check and mark it paid.');
        addChatMessage(conv.id, 'customer', null, s.name, text || 'Payment screenshot', input.media.url, 'image');
        s.mode = 'human';
        return [T('📸 Thank you! I have sent your screenshot for order *' + ref + '* to our team. They will confirm your payment here shortly.')];
      }
      return [T('Thanks! I can only read text and buttons. If you need help with a photo, type *PERSON* to reach our team.'), ...menu(s)];
    }

    // ---- buttons and list choices ----
    if (id) {
      const [k, a, b2] = id.split(':');
      if (id === 'm:menu') return menu(s);
      if (id === 'm:shop') return categoriesScreen(s, 0);
      if (id === 'm:cart') return cartScreen(s);
      if (id === 'm:track') return trackScreen(s);
      if (id === 'm:human') return handOff(s);
      if (id === 'm:pay') {
        const methods = payMethods();
        return [B('💳 *Ways to pay*\n' + methods.map(m => '• ' + m[1].replace(/^\S+\s/, '') + ' — ' + m[2]).join('\n')
          + '\n\nYou choose when you check out. ' + (getSetting('pay_note_en') || ''), [['m:shop', '🛍️ Shop'], ['m:menu', 'Main menu']])];
      }
      if (id === 'm:info') {
        return [B('📍 *' + storeName() + '*\n' + (getSetting('contact_address_en') || '') + '\n🕘 ' + (getSetting('contact_hours_en') || '')
          + (base ? '\n🌐 ' + base : ''), [['m:shop', '🛍️ Shop'], ['m:human', '🙋 Talk to us'], ['m:menu', 'Main menu']])];
      }
      if (k === 'catp') return categoriesScreen(s, Number(a));
      if (k === 'cat') return productListScreen(s, a, Number(b2) || 0);
      if (k === 'p') return productScreen(s, a, base);
      if (k === 'sz') { const v = queries.variantById(Number(a)); return v ? askQty(s, v.productId, v.id) : menu(s); }
      if (k === 'add') return askQty(s, a, null);
      if (k === 'q') return addToCart(s, a);
      if (id === 'cart:clear') { s.data.cart = []; return menu(s, '🗑️ Your basket is now empty.'); }
      if (id === 'co:start') return startCheckout(s);
      if (id === 'co:name:ok') { s.data.co = s.data.co || {}; s.data.co.name = s.name; return askDelivery(s); }
      if (id === 'co:name:edit') { s.state = 'co_name_type'; return [T('What name should I put on the order?')]; }
      if (id === 'dl:home') { s.data.co.delivery = 'home'; return askZone(s, 0); }
      if (id === 'dl:pickup') { s.data.co.delivery = 'pickup'; s.data.co.zone = null; return askPayment(s); }
      if (k === 'zp') return askZone(s, Number(a));
      if (k === 'z') {
        const z = queries.zoneById(Number(a));
        if (!z || !z.is_active) return askZone(s, 0);
        s.data.co.zone = z.id; s.state = 'co_address';
        return [T('📍 ' + z.name_en + ' — got it. Please type your exact address (street, compound, a landmark) so the rider can find you.')];
      }
      if (k === 'pay') {
        if (!payMethods().some(m => m[0] === a)) return askPayment(s);
        s.data.co.pay = a; return summary(s);
      }
      if (id === 'co:confirm') { if (s.state !== 'co_confirm') return cartScreen(s); return confirmOrder(s, base); }
      if (id === 'co:cancel') { s.data.co = {}; return menu(s, 'No problem — your basket is saved for later.'); }
      if (k === 'trk') return trackOne(s, a);
      return menu(s);   // a stale button from an old message
    }

    // ---- typed text ----
    if (!text) return menu(s);
    if (HUMAN.test(low)) return handOff(s);
    if (GREET.test(low)) return menu(s, s.isNew ? (getSetting('wa_welcome_en') || ('Welcome to ' + storeName() + '!')) : 'Welcome back! 👋');
    if (THANKS.test(low)) return [B('You are welcome! 🤝 Anything else I can help with?', [['m:shop', '🛍️ Shop'], ['m:track', '📦 Track order'], ['m:menu', 'Main menu']])];
    if (/^(basket|cart|my cart|my basket|checkout|check out)$/i.test(low)) return /check/.test(low) ? startCheckout(s) : cartScreen(s);
    if (/^(track|track order|my order|where is my order)\??$/i.test(low)) return trackScreen(s);
    if (/^(cancel|stop)$/i.test(low)) { s.data.co = {}; delete s.data.pending; return menu(s, 'Okay, cancelled.'); }

    switch (s.state) {
      case 'qty':
        if (/^\d{1,3}$/.test(low)) return addToCart(s, Number(low));
        return [T('Please send just a number, like *2*.')];
      case 'co_name_type':
        if (text.length < 2 || text.length > 80) return [T('Please type a name between 2 and 80 characters.')];
        s.data.co = s.data.co || {}; s.data.co.name = text; s.name = s.name || text;
        return askDelivery(s);
      case 'co_address':
        if (text.length < 4) return [T('Please type a little more detail so our rider can find you.')];
        s.data.co.address = text.slice(0, 300);
        return askPayment(s);
      case 'track_type':
        if (/^[a-z]{2,4}-?\d{2,4}-?\d{1,6}$/i.test(text.replace(/\s/g, ''))) return trackOne(s, text.replace(/\s/g, ''));
        break;
    }
    if (/^jt-\d{4}-\d+$/i.test(text.replace(/\s/g, ''))) return trackOne(s, text.replace(/\s/g, ''));

    // Anything else: treat it as a search of the catalogue.
    const found = searchProducts(text);
    if (found.length === 1) return productScreen(s, found[0].id, base);
    if (found.length) return productListScreen(s, null, 0, found, '🔎 Here is what I found for *' + cut(text, 40) + '*:');
    return menu(s, "Sorry, I didn't find anything for *" + cut(text, 40) + '*. Try another word, or type *PERSON* to ask our team.');
  }

  /* ---------------------------------------------------------------- logging & sending */
  function summaryOf(m) {
    if (m.kind === 'buttons') return m.text + '\n[' + m.buttons.map(b => b.title).join(' | ') + ']';
    if (m.kind === 'list') return m.text + '\n[' + m.button + ': ' + m.rows.map(r => r.title).join(', ') + ']';
    if (m.kind === 'image') return '🖼️ ' + m.text;
    return m.text;
  }
  function toCloud(m, to) {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
    if (m.kind === 'image') return { ...base, type: 'image', image: { link: m.url, caption: m.text } };
    if (m.kind === 'buttons') return { ...base, type: 'interactive', interactive: { type: 'button', body: { text: m.text },
      action: { buttons: m.buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } };
    if (m.kind === 'list') return { ...base, type: 'interactive', interactive: { type: 'list', body: { text: m.text },
      action: { button: m.button, sections: [{ title: m.section, rows: m.rows.map(r => r.description ? r : { id: r.id, title: r.title }) }] } } };
    return { ...base, type: 'text', text: { body: m.text, preview_url: true } };
  }
  async function graph(pathPart, opt) {
    const c = cfg();
    const r = await fetch('https://graph.facebook.com/' + c.version + '/' + pathPart, Object.assign({
      headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' } }, opt || {}));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && (d.error.error_user_msg || d.error.message)) || ('HTTP ' + r.status));
    return d;
  }
  async function deliver(phone, msgs, simulated) {
    for (const m of msgs) {
      const info = db.prepare("INSERT INTO wa_messages(phone,direction,kind,body,payload_json,status) VALUES(?,'out',?,?,?,?)")
        .run(phone, m.kind, summaryOf(m), JSON.stringify(m), simulated ? 'simulated' : 'queued');
      if (simulated) continue;
      if (!live()) { db.prepare("UPDATE wa_messages SET status='failed', error=? WHERE id=?").run('WhatsApp is not connected', info.lastInsertRowid); continue; }
      try {
        const d = await graph(cfg().phoneId + '/messages', { method: 'POST', body: JSON.stringify(toCloud(m, phone)) });
        const wid = d.messages && d.messages[0] && d.messages[0].id || '';
        db.prepare("UPDATE wa_messages SET status='sent', wa_id=? WHERE id=?").run(wid, info.lastInsertRowid);
      } catch (e) {
        db.prepare("UPDATE wa_messages SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), info.lastInsertRowid);
        console.error('WhatsApp send:', e.message);
        return { ok: false, error: e.message };
      }
    }
    return { ok: true };
  }

  /* One incoming message, from Meta or from the simulator, start to finish.
     Messages for the same phone are handled one after another so two quick taps
     can never race each other over the same basket. */
  const QUEUES = new Map();
  const RATE = new Map();
  function handleIncoming(input) {
    const prev = QUEUES.get(input.phone) || Promise.resolve();
    const next = prev.then(() => process1(input)).catch(e => { console.error('WhatsApp bot:', e); });
    QUEUES.set(input.phone, next);
    next.finally(() => { if (QUEUES.get(input.phone) === next) QUEUES.delete(input.phone); });
    return next;
  }
  async function process1(input) {
    const phone = digits(input.phone);
    if (phone.length < 7 || phone.length > 15) return;
    // flood guard: 25 messages a minute from one number is not a person typing
    const now = Date.now(), rl = RATE.get(phone) || { n: 0, t: now };
    if (now - rl.t > 60000) { rl.n = 0; rl.t = now; }
    rl.n++; RATE.set(phone, rl);
    if (rl.n > 25) return;

    const body = input.text || input.title || (input.media ? '📷 Photo' : (input.id ? '[' + input.id + ']' : ''));
    if (input.waId) {
      try {
        db.prepare("INSERT INTO wa_messages(phone,direction,kind,body,payload_json,wa_id,status) VALUES(?,'in',?,?,?,?,'received')")
          .run(phone, input.id ? 'reply' : (input.media ? 'media' : 'text'), body, JSON.stringify({ id: input.id || '' }), input.waId);
      } catch { return; }   // already seen this message id — Meta retried; answer once only
    } else {
      db.prepare("INSERT INTO wa_messages(phone,direction,kind,body,payload_json,status) VALUES(?,'in',?,?,?,?)")
        .run(phone, input.id ? 'reply' : 'text', body, JSON.stringify({ id: input.id || '' }), input.simulated ? 'simulated' : 'received');
    }
    const s = getSession(phone, input.name, input.simulated);
    db.prepare("UPDATE wa_sessions SET last_in_at=datetime('now') WHERE phone=?").run(phone);
    let out;
    try {
      out = await respond(s, input, input.base || siteUrl());
      // A first-time customer whose opening message was not a greeting still gets the welcome.
      if (s.isNew && s.mode === 'bot' && !(input.text && GREET.test(String(input.text).trim())))
        out.unshift(T(getSetting('wa_welcome_en') || ('Welcome to ' + storeName() + '!')));
    }
    catch (e) { console.error('WhatsApp bot error:', e); out = [T('Sorry, something went wrong on our side. Type *MENU* to start again or *PERSON* to reach our team.')]; }
    saveSession(s);
    if (out && out.length) await deliver(phone, out, !!s.simulated);
  }
  function siteUrl() { return String(getSetting('site_url') || '').replace(/\/$/, ''); }

  /* ---------------------------------------------------------------- webhook */
  function verifySignature(raw, header) {
    const secret = cfg().appSecret;
    if (!secret) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(header || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  async function downloadMedia(mediaId) {
    try {
      const meta = await graph(encodeURIComponent(mediaId), { method: 'GET' });
      if (!meta.url || !/^image\/(jpeg|png|webp)$/.test(meta.mime_type || '')) return '';
      if (Number(meta.file_size) > 5 * 1024 * 1024) return '';
      const r = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + cfg().token } });
      if (!r.ok) return '';
      const buf = Buffer.from(await r.arrayBuffer());
      return saveImage('data:' + meta.mime_type + ';base64,' + buf.toString('base64')) || '';
    } catch (e) { console.error('WhatsApp media:', e.message); return ''; }
  }
  // Meta's payload → the engine's simple input. Statuses update delivery ticks on our log.
  async function ingest(payload, base) {
    for (const entry of payload.entry || []) {
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        if (v.metadata && cfg().phoneId && String(v.metadata.phone_number_id) !== cfg().phoneId) continue;
        for (const st of v.statuses || []) {
          if (st.id && st.status) db.prepare('UPDATE wa_messages SET status=?, error=? WHERE wa_id=?')
            .run(st.status, st.errors && st.errors[0] ? String(st.errors[0].title || st.errors[0].message || '').slice(0, 300) : '', st.id);
        }
        const names = {};
        (v.contacts || []).forEach(c => { names[c.wa_id] = c.profile && c.profile.name || ''; });
        for (const m of v.messages || []) {
          // ignore anything older than a day (a redelivery after downtime should not reply out of the blue)
          if (m.timestamp && Date.now() / 1000 - Number(m.timestamp) > 86400) continue;
          const input = { phone: m.from, name: names[m.from] || '', waId: m.id, base };
          if (m.type === 'text') input.text = m.text && m.text.body || '';
          else if (m.type === 'interactive') {
            const r = m.interactive.button_reply || m.interactive.list_reply || {};
            input.id = r.id; input.title = r.title;
          } else if (m.type === 'button') { input.text = m.button && (m.button.text || m.button.payload) || ''; }
          else if (m.type === 'image') {
            input.text = m.image && m.image.caption || '';
            input.media = { url: m.image && m.image.id ? await downloadMedia(m.image.id) : '' };
          } else { input.text = ''; input.media = { url: '' }; }
          handleIncoming(input);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- hooks used by the inbox */
  // Staff typed a reply in the Chat inbox on a WhatsApp conversation: send it to the customer.
  async function staffReply(conv, text, attachUrl, base) {
    const phone = digits(conv.customer_phone);
    const s = getSession(phone, conv.customer_name, false);
    s.mode = 'human'; s.conversation_id = conv.id; saveSession(s);
    const msgs = [];
    if (attachUrl) {
      const url = /^https?:/.test(attachUrl) ? attachUrl : (base || siteUrl()) + '/' + attachUrl.replace(/^\//, '');
      msgs.push(IMG(url, text || ''));
    } else msgs.push(T(text));
    const r = await deliver(phone, msgs, !!s.simulated);
    if (!r.ok) {
      const hint = /24|re-engagement|131047/i.test(r.error) ? ' WhatsApp only allows free replies within 24 hours of the customer\'s last message.' : '';
      addChatMessage(conv.id, 'system', null, '', '⚠️ Not delivered on WhatsApp: ' + r.error + hint, '', '');
    }
    return r;
  }
  // Conversation resolved/closed by staff: the assistant takes over again.
  function conversationClosed(conv) {
    db.prepare("UPDATE wa_sessions SET mode='bot', state='menu' WHERE conversation_id=?").run(conv.id);
  }
  function setMode(phone, mode, staffName) {
    const s = db.prepare('SELECT * FROM wa_sessions WHERE phone=?').get(digits(phone));
    if (!s) return null;
    const sess = getSession(s.phone);
    if (mode === 'human') {
      ensureConversation(sess, '👤 ' + (staffName || 'Staff') + ' took over this WhatsApp chat from the assistant.\n\nRecent messages:\n' + recentTranscript(sess.phone, 6));
      sess.mode = 'human';
    } else {
      sess.mode = 'bot'; sess.state = 'menu';
      if (sess.conversation_id) addChatMessage(sess.conversation_id, 'system', null, '', '🤖 ' + (staffName || 'Staff') + ' handed this chat back to the assistant.', '', '');
    }
    saveSession(sess);
    return sess;
  }

  /* ---------------------------------------------------------------- admin data */
  function adminOverview() {
    const c = cfg();
    const mask = v => !v ? '' : v.length >= 16 ? '••••' + v.slice(-4) : '••••';
    const sessions = db.prepare(`SELECT s.*, (SELECT body FROM wa_messages m WHERE m.phone=s.phone ORDER BY id DESC LIMIT 1) last_body,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.phone=s.phone AND direction='in') msgs_in
      FROM wa_sessions s ORDER BY COALESCE(s.last_in_at, s.updated_at) DESC LIMIT 60`).all()
      .map(r => { let cart = 0; try { cart = (JSON.parse(r.data_json).cart || []).reduce((n, it) => n + it.qty, 0); } catch {}
        return { phone: r.phone, name: r.name, mode: r.mode, state: r.state, simulated: !!r.simulated, cart, conversation_id: r.conversation_id,
          last_in_at: r.last_in_at, last_body: r.last_body, msgs_in: r.msgs_in }; });
    const stats = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) value FROM orders WHERE channel='whatsapp'
      AND status NOT IN ('cancelled','returned','refunded') AND notes NOT LIKE '%TEST ORDER%'`).get();
    const today = db.prepare("SELECT COUNT(DISTINCT phone) n FROM wa_messages WHERE direction='in' AND created_at >= datetime('now','-1 day')").get().n;
    const failed = db.prepare("SELECT COUNT(*) n FROM wa_messages WHERE direction='out' AND status='failed' AND created_at >= datetime('now','-1 day')").get().n;
    return {
      settings: { enabled: c.enabled, phone_number_id: c.phoneId, graph_version: c.version, token_hint: mask(c.token), app_secret_hint: mask(c.appSecret),
        has_token: !!c.token, has_app_secret: !!c.appSecret, verify_token: verifyToken(),
        welcome: getSetting('wa_welcome_en') || '', offer_pickup: getSetting('wa_offer_pickup') !== '0',
        from_env: { phone: !!process.env.WA_PHONE_NUMBER_ID, token: !!process.env.WA_ACCESS_TOKEN, secret: !!process.env.WA_APP_SECRET } },
      live: live(),
      stats: { orders: stats.n, value: stats.value, chats_24h: today, failed_24h: failed },
      sessions,
    };
  }
  function saveSettings(b) {
    if (b.enabled !== undefined) setSetting('wa_enabled', b.enabled ? '1' : '0');
    if (b.phone_number_id !== undefined) setSetting('wa_phone_number_id', digits(b.phone_number_id).slice(0, 30));
    if (b.graph_version !== undefined && /^v\d{1,2}\.\d$/.test(String(b.graph_version))) setSetting('wa_graph_version', b.graph_version);
    if (b.access_token) setSetting('wa_access_token', String(b.access_token).trim().slice(0, 600));
    if (b.app_secret) setSetting('wa_app_secret', String(b.app_secret).trim().slice(0, 120));
    if (b.welcome !== undefined) setSetting('wa_welcome_en', String(b.welcome).slice(0, 600));
    if (b.offer_pickup !== undefined) setSetting('wa_offer_pickup', b.offer_pickup ? '1' : '0');
    if (b.regenerate_verify) setSetting('wa_verify_token', 'jt-' + crypto.randomBytes(12).toString('hex'));
  }
  async function testConnection() {
    const c = cfg();
    if (!c.phoneId || !c.token) return { ok: false, error: 'Add the Phone number ID and the access token first.' };
    try {
      const d = await graph(c.phoneId + '?fields=display_phone_number,verified_name,quality_rating', { method: 'GET' });
      return { ok: true, number: d.display_phone_number, name: d.verified_name, quality: d.quality_rating, app_secret_set: !!c.appSecret };
    } catch (e) { return { ok: false, error: String(e.message) }; }
  }
  function messages(phone, after) {
    return db.prepare('SELECT id,direction,kind,body,payload_json,status,error,created_at FROM wa_messages WHERE phone=? AND id>? ORDER BY id LIMIT 300')
      .all(digits(phone), Number(after) || 0)
      .map(m => { let p = null; try { p = m.payload_json ? JSON.parse(m.payload_json) : null; } catch {} return { ...m, payload: p, payload_json: undefined }; });
  }
  function resetSimulated(phone) {
    const s = db.prepare('SELECT * FROM wa_sessions WHERE phone=?').get(digits(phone));
    if (!s) return true;
    if (!s.simulated) return false;    // never wipe a real customer's history from the simulator
    db.prepare('DELETE FROM wa_messages WHERE phone=?').run(s.phone);
    db.prepare('DELETE FROM wa_sessions WHERE phone=?').run(s.phone);
    return true;
  }
  function isSimulatedOrNew(phone) {
    const s = db.prepare('SELECT simulated FROM wa_sessions WHERE phone=?').get(digits(phone));
    return !s || !!s.simulated;
  }

  return { cfg, live, verifyToken, verifySignature, ingest, handleIncoming, staffReply, conversationClosed, setMode,
           adminOverview, saveSettings, testConnection, messages, resetSimulated, isSimulatedOrNew,
           _respond: respond, _toCloud: toCloud };
};
