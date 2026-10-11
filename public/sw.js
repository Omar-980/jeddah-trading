/* Jeddah Trading — service worker.
   This is what turns the shop into an app that opens from the home screen, starts instantly
   and still shows something useful on a weak signal.

   The rules it follows, in order of importance:

   1. Nothing signed in is ever stored. Only the handful of public endpoints listed in
      PUBLIC_DATA below are kept, and only as an offline fallback. An admin reply, an
      investor's statement, a customer's orders, a chat thread, a coupon check — those go
      straight to the network every time and are never written to a cache, because this
      phone may be shared and because stale money is worse than no money.
   2. Writes are never touched. Anything that is not a GET is passed through untouched, so
      an order, a payout or a photo upload can never be served from a cache or replayed.
   3. The network always wins when it answers. Caches are a fallback for when it does not,
      never a shortcut past fresh prices or stock.

   To push a new version of the shop to everyone, raise V by one. */
const V = 'jt-v1';
const SHELL = `${V}-shell`;
const ASSETS = `${V}-assets`;
const DATA = `${V}-data`;
const KEEP = [SHELL, ASSETS, DATA];

/* The shop's own frame: enough to open the app with no connection at all. */
const PRECACHE = [
  '/',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/logo.png',
];

/* The only API answers allowed anywhere near a cache. Every one of these is already public
   on the shop front — no customer, order, investor or staff data among them. */
const PUBLIC_DATA = new Set([
  '/api/products', '/api/categories', '/api/settings',
  '/api/faqs', '/api/reviews', '/api/zones', '/api/banners',
]);

const ASSET_RE = /\.(?:png|jpe?g|webp|gif|svg|ico|css|woff2?)$/i;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // One bad URL must not fail the whole install, so each is added on its own.
    await Promise.all(PRECACHE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    // Take a copy of the shelf straight away. The very first page load has already fired its
    // own requests before this worker exists, so without this a shopper who installs the app
    // and then loses signal would open it to an empty shop.
    const d = await caches.open(DATA);
    await Promise.all([...PUBLIC_DATA].map(u => d.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('jt-') && !KEEP.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function keep(cacheName, req, res) {
  // Opaque and error responses are never worth keeping.
  if (res && res.ok && res.type === 'basic') {
    const c = await caches.open(cacheName);
    c.put(req, res.clone()).catch(() => {});
  }
  return res;
}

/* Pages: always try the network, so a deploy reaches everyone on their next open. Only when
   there is no network do we fall back to the copy we already have. */
async function pageFirst(req) {
  try {
    return await fetch(req);
  } catch {
    return (await caches.match(req)) || (await caches.match('/')) ||
           (await caches.match('/offline.html')) ||
           new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

/* Public shop data: network first, last known copy if the network is gone. */
async function dataFirst(req) {
  try {
    const res = await fetch(req);
    return await keep(DATA, req, res);
  } catch {
    const hit = await caches.match(req);
    if (hit) {
      // Tell the page this came out of the cupboard, so it can say so to the shopper.
      const h = new Headers(hit.headers);
      h.set('X-JT-Offline', '1');
      return new Response(await hit.blob(), { status: 200, statusText: 'OK (cached)', headers: h });
    }
    return new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

/* Photos, icons, fonts: show the copy we have at once, and quietly fetch a fresher one for
   next time. Product photos change rarely and a shopper on a slow line feels this most. */
async function assetFirst(req) {
  const hit = await caches.match(req);
  const live = fetch(req).then(res => keep(ASSETS, req, res)).catch(() => null);
  return hit || (await live) ||
         new Response('', { status: 504, headers: { 'Content-Type': 'text/plain' } });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                                  // never touch a write
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;                   // someone else's server
  if (req.headers.get('accept') === 'text/event-stream') return;     // the live chat stream

  if (url.pathname.startsWith('/api/')) {
    if (!PUBLIC_DATA.has(url.pathname)) return;                      // signed-in: hands off
    return e.respondWith(dataFirst(req));
  }
  if (req.mode === 'navigate') {
    // The admin and the investor portal are no use without a connection and may be opened
    // on a shared phone, so their pages are never kept.
    if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/investor')) return;
    return e.respondWith(pageFirst(req));
  }
  if (url.pathname.startsWith('/uploads/') || ASSET_RE.test(url.pathname)) {
    return e.respondWith(assetFirst(req));
  }
});
