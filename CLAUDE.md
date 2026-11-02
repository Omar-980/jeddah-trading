# Jeddah Trading — notes for Claude Code

Live shop, admin and investor portal for Jeddah Trading (The Gambia), at
**shopjeddahtrading.com**. Real customers, real money, real investors. Render deploys
automatically from `main` on GitHub (`Omar-980/jeddah-trading`), with the database on a
persistent disk at `/var/data` (see `render.yaml`).

The owner is not a developer. Explain changes in plain language, say what to check after a
deploy, and never assume a step on his side has happened — check the live site.

## Shape

| File | What it is |
|---|---|
| `server.js` | HTTP server, every API route, payments, share previews, catalogue feed |
| `db.js` | SQLite schema, migrations, queries, investor profit, customer deletion |
| `whatsapp.js` | WhatsApp assistant — see `WHATSAPP-SETUP.md` |
| `public/index.html` | The shop, one file (EN/AR, RTL) |
| `public/investor.html` | Investor portal |
| `admin/index.html` | Admin dashboard, one file |
| `public/sw.js`, `*.webmanifest` | Installable app (PWA) |
| `public/privacy.html`, `delete-account.html`, `payment-done.html` | Standalone pages |
| `tests/` | End-to-end tests — run them before every change ships |

## Rules that are not negotiable

1. **No runtime dependencies.** `node:http`, `node:sqlite`, `node:crypto`, global `fetch` only.
   Node ≥ 22.13. Never add an npm package to make something easier.
2. **Migrations are additive only.** `CREATE TABLE IF NOT EXISTS`, and `columnExists()` before
   every `ALTER TABLE … ADD COLUMN`. Never drop, rename or rebuild a table — the live database
   holds every customer and order. Run `tests/test_migration.py` after any schema change.
3. **The server owns all money.** Prices, totals, delivery fees and discounts are recomputed
   from the database on every order. A number from the browser is a hint at most.
4. **Two currencies never mix.** UK orders are in GBP (`market='uk'`). Every dalasi report,
   every investor figure and the Profit & Loss filter on `market='gm'`.
5. **Investor profit is per product line**: (selling price − stock cost) × the investor's
   share. Delivery fees are the shop's alone and never enter it. So do UK sales.
6. **Bilingual.** Every customer-facing string goes in both `I18N.en` and `I18N.ar` in
   `public/index.html`. Arabic flips the page to RTL — check layouts both ways.
7. **Deleting a customer erases the person, keeps the transaction** (`deleteCustomerData`
   in `db.js`). Orders stay, with name, phone and address blanked, because takings, stock and
   investor shares hang off them.

## Payments — Modem Pay

Learned the hard way; each line here was a bug on the live shop.

- Create: `POST https://api.modempay.com/v1/payments`, body **wrapped in `{"data": {…}}`**,
  `Authorization: Bearer <secret>`. Amount in GMD, minimum 10. Response gives
  `data.payment_link` and `data.intent_secret`; the intent's id is the last part of the link.
- Webhook: `POST /api/webhooks/modempay`. Body is **`{"event": …, "payload": {…}}`** — not
  `data`. `payload.metadata` can arrive **empty**, so orders are matched by
  `payload.payment_intent_id` against `orders.payment_intent_id`. Signature is
  `x-modem-signature`: HMAC-SHA512, hex, over the **raw** body, compared timing-safe.
- Verify: `GET /v1/payments/verify?intent_secret=…`. The return page (`/payment/done`) polls
  `/api/payment-status`, which calls verify — so paid shows in seconds without waiting on the
  webhook. Throttled per order.
- **Only two things may mark an order paid**: a correctly signed webhook, or our own verify
  call. Both go through `markOrderPaid()`. Coming back to the return URL proves nothing.
- Keys come from `MODEMPAY_SECRET_KEY` / `MODEMPAY_WEBHOOK_SECRET` env vars or admin
  Settings. They are stripped from `/api/settings` and masked in the admin. Keep it that way.
- Settings → **Test the connection** asks Modem Pay for a real link and shows their reply.

Payment methods are switches (`pay_methods` setting), not deleted code. A blank value means all
of them; with everything off and online payment not ready, cash on delivery comes back.

## Deploying

Merging to `main` deploys. Until recently the owner uploaded files by dragging them into
GitHub's web page, and twice the root files (`server.js`, `db.js`) were left out while the
folders went up — so after any deploy, **check the live site** rather than assuming:

- `/api/settings` shows `pay_online` and `pay_methods` when the payment code is live
- `/api/appcheck` lists every installable-app file and where it is served from
- `/privacy` and `/delete-account` should open

`public/icons/` has never been in the repository. The app icons are built into `server.js`
(`APP_ICONS`) and served from there when the folder is missing. That is deliberate.

## Testing

```bash
pip install playwright && python -m playwright install chromium
cd tests
python test_payments.py          # one file at a time; each boots its own server
```

Every test starts the shop on a throw-away `DATA_DIR` and its own port, so none of them can
touch real data. `test_payments.py` runs a stand-in Modem Pay that signs webhooks exactly like
theirs and rejects a request that is not wrapped in `data`. `test_migration.py` seeds the
previous commit's database and boots this version on it — set `JT_BASE_REF` to compare against
a specific release.

## Never

- Commit `data/`, any `*.db`, or `public/uploads/` (`.gitignore` covers them). The database
  holds every customer's details and password hash.
- Put a payment key, password or token in a file, a commit, or a chat message.
- Run anything against the live database. Use a local `DATA_DIR`.
- Remove a payment method's code to hide it — switch it off in Settings.
