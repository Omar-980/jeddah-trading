# Jeddah Trading — Storefront + Admin Backend

A complete, **zero-dependency** e-commerce system for Jeddah Trading (The Gambia):
a customer storefront, a REST API, and an admin dashboard to **manage orders** and
**upload/edit products** — all powered by Node.js with its built-in SQLite database.

There is **nothing to `npm install`**. If you can run `node`, you can run this store.

---

## What's inside

```
jeddah-trading-backend/
├── server.js          ← the web server + API (run this)
├── db.js              ← database schema + seed data (32 demo products)
├── package.json
├── data/
│   └── store.db       ← SQLite database (created automatically on first run)
├── public/
│   ├── index.html     ← the customer storefront (loads products from the API)
│   └── uploads/       ← product images you upload land here
└── admin/
    └── index.html     ← the admin dashboard
```

---

## How to run it

You need **Node.js version 22.5 or newer** (for built-in SQLite). Check with `node --version`.
Download Node from https://nodejs.org if you don't have it.

1. Open a terminal in this folder.
2. Run:

   ```bash
   node server.js
   ```

3. You'll see:

   ```
   Storefront : http://localhost:3000
   Admin      : http://localhost:3000/admin
   ```

4. Open those links in your browser.

That's it. The database and demo products are created automatically the first time.

---

## Using the admin dashboard

Go to **http://localhost:3000/admin**

- **Default password:** `jeddah2026`
  → Change it immediately on the **Settings** page.

**What you can do:**

- **Overview** — today's new orders, total orders, revenue, low-stock and out-of-stock alerts, and a payment-method breakdown.
- **Products** — add a new product (with an **image upload**), edit price/stock/description/benefits in English *and* Arabic, mark items as *featured* or *hidden*, or delete them. Everything you change appears on the storefront instantly.
- **Orders** — every order placed on the storefront shows up here with the customer's details, items, totals and chosen payment method. Move each order through its pipeline (New → Confirmed → Paid → Packed → Out for delivery → Delivered), and tap **Message customer** to open WhatsApp to that customer.
- **Settings** — your WhatsApp number, store name, delivery fee, free-delivery threshold, the announcement bar text (EN + AR), and the admin password. These feed the whole storefront.

---

## How the pieces connect

```
Customer (storefront)                    You (admin)
   index.html                             admin/index.html
        │  GET /api/products                    │  login → token
        │  GET /api/categories                  │  GET/POST/PATCH/DELETE /api/admin/products
        │  POST /api/orders  ───────────────▶   │  GET /api/admin/orders, PATCH status
        ▼                                        ▼
                    server.js  +  data/store.db (SQLite)
```

- When a customer checks out, the order is **saved to the database** *and* a pre-filled
  WhatsApp message opens to your business number — so you get the order both ways.
- Product stock is **automatically reduced** when an order is placed.
- Prices and totals are recalculated **on the server**, so they can't be tampered with in the browser.

---

## Hosting it online (so customers can reach it)

`localhost` only works on your own computer. To put it on the internet, deploy to any host
that runs Node.js 22+. Good options:

- **Render.com** or **Railway.app** — free/cheap, connect the folder, set the start command to `node server.js`. They give you a public URL.
- **A VPS** (e.g. Contabo, Hetzner, DigitalOcean) — copy the folder, install Node 22, run `node server.js` (use `pm2` or a systemd service to keep it running).

The server reads the port from the `PORT` environment variable (most hosts set this for you),
defaulting to 3000.

**Keep your data:** the `data/store.db` file *is* your store — products, orders, settings.
Back it up. On hosts with ephemeral disks, attach a persistent volume to the `data/` folder.

---

## Common questions

**Can I run the storefront without the backend?**
Yes — `public/index.html` falls back to a built-in demo catalogue if it can't reach the API,
so it still looks complete. But to manage real products/orders, run `node server.js`.

**Where do uploaded images go?**
Into `public/uploads/`. They're served at `/uploads/...`. Keep this folder when you back up.

**How do I change the WhatsApp number?**
Admin → Settings → "WhatsApp number". It updates the storefront and order links everywhere.

**Is it secure enough?**
It uses password login + tokens and recalculates money server-side — fine for a small shop.
For higher security later: run it behind HTTPS (your host usually provides this), use a strong
admin password, and consider moving to a managed database as you grow. Customers never enter
card details on the site — payment is completed via mobile money / bank / cash / WhatsApp.

---

*Built for Jeddah Trading 🇬🇲 — herbs, Islamic products, perfumes, dates, clothing, electronics, household goods and more.*
