/* Service worker: offline-capable app shell + last-known data cache + web push.
   Bump VERSION (and the ?v= on assets in index.html) on every deploy so old
   caches are dropped and clients can never pair stale code with new data. */
const VERSION = "v155";
const SHELL = "shell-" + VERSION;
const DATA = "briefing-public-data-v1";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css?v=155",
  "./js/app.js?v=155",
  "./js/data-client.js?v=155",
  "./js/briefing-core.js?v=155",
  "./js/research-identities.js?v=155",
  "./js/overlay-focus.js?v=155",
  "./js/profile-store.js?v=155",
  "./manifest.webmanifest?v=155",
  "./icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Import compatible public reads from the previous version before removing it.
    const cache = await caches.open(DATA);
    const keys = await caches.keys();
    for (const name of keys.filter(k => /^data-v\d+$/.test(k))) {
      const old = await caches.open(name);
      for (const req of await old.keys()) {
        if (!publicData(new URL(req.url)) || await cache.match(req)) continue;
        const res = await old.match(req);
        if (res?.ok) await cache.put(req, res);
      }
      await caches.delete(name);
    }
    await Promise.all(keys.filter(k => /^shell-v\d+$/.test(k) && k !== SHELL).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function publicData(url) {
  return url.hostname.endsWith('.supabase.co') &&
    /^\/rest\/v1\/(days|days_light|weeks|players|terms|threads|campaigns|events|metrics|rates_cache|market_pulse|app_config|app_status)$/.test(url.pathname);
}

// An upgraded paginated query can still use the previous version's complete
// collection snapshot offline. Never mix queries, projects or partial pages.
async function legacyCollection(cache, request) {
  const target = new URL(request.url);
  if (!target.searchParams.has('limit') || !target.searchParams.has('offset')) return null;
  const offset = Number(target.searchParams.get('offset')), limit = Number(target.searchParams.get('limit'));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) return null;
  const orders = (target.searchParams.get('order') || '').split(',').filter(Boolean);
  if (orders.some(order => !/^[a-zA-Z_][a-zA-Z0-9_]*\.(asc|desc)$/.test(order))) return null;
  const signature = url => JSON.stringify([...url.searchParams.entries()]
    .filter(([key]) => !['order','limit','offset'].includes(key))
    .sort(([ak,av],[bk,bv]) => ak.localeCompare(bk) || av.localeCompare(bv)));
  const candidates = (await cache.keys()).filter(req => {
    const url = new URL(req.url);
    return publicData(url) && url.origin === target.origin && url.pathname === target.pathname &&
      !url.searchParams.has('limit') && !url.searchParams.has('offset') && signature(url) === signature(target);
  });
  if (candidates.length !== 1) return null;
  const response = await cache.match(candidates[0]);
  if (!response?.ok) return null;
  let rows;
  try { rows = await response.json(); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  for (const row of rows) if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const complete = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (complete && Number(complete[1]) !== rows.length) return null;
  if (orders.some(order => rows.some(row => !(order.split('.')[0] in row)))) return null;
  rows.sort((a,b) => {
    for (const order of orders) {
      const [field,direction] = order.split('.'), av = a[field], bv = b[field];
      // Postgres default: ascending NULLS LAST, descending NULLS FIRST.
      const diff = av === bv ? 0 : av == null ? 1 : bv == null ? -1 : av < bv ? -1 : 1;
      if (diff) return direction === 'desc' ? -diff : diff;
    }
    return 0;
  });
  const page = rows.slice(offset, offset + limit);
  return new Response(JSON.stringify(page), {status:200,headers:{
    'Content-Type':'application/json',
    'Content-Range': page.length ? `${offset}-${offset+page.length-1}/${rows.length}` : `*/${rows.length}`,
  }});
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try { const res = await fetch(req); if (res.ok) return res; }
      catch { /* use last installed shell */ }
      return (await caches.match('./index.html')) || Response.error();
    })());
    return;
  }
  if (publicData(url)) {
    const task = (async () => {
      const cache = await caches.open(DATA);
      try {
        const res = await fetch(req);
        if (res.ok) {
          try { await cache.put(req, res.clone()); } catch { /* storage full */ }
          return res;
        }
        // Authentication and validation errors must remain visible.
        if (res.status < 500 && res.status !== 429) return res;
        return (await cache.match(req)) || (res.status >= 500 ? await legacyCollection(cache, req) : null) || res;
      } catch { return (await cache.match(req)) || (await legacyCollection(cache, req)) || Response.error(); }
    })();
    e.respondWith(task);
    e.waitUntil(task.then(() => {}, () => {}));
    return;
  }
  // Private API calls and publisher images are never stored in shell caches.
  const ownAsset = url.origin === self.location?.origin && /\.(js|css|svg|webmanifest)$/.test(url.pathname);
  if (!ownAsset) return;
  const task = (async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok) { try { await (await caches.open(SHELL)).put(req, res.clone()); } catch {} }
    return res;
  })();
  e.respondWith(task);
  e.waitUntil(task.then(() => {}, () => {}));
});

/* ---------- web push (Phase 4 alerts) ----------
   Payloads come from the push-send / push-dispatch edge functions as JSON:
   { title, body, url, tag }. Each one is shown as a notification, added to the
   device-local alerts inbox (IndexedDB, read by the app's Alerts page), and
   bumps the app-icon badge. Tapping deep-links into the app. */

const INBOX_DB = "briefing-alerts";
const INBOX_STORE = "inbox";
const INBOX_MAX = 30;

function inboxDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(INBOX_DB, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(INBOX_STORE, { keyPath: "at" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function inboxAdd(entry) {
  const db = await inboxDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(INBOX_STORE, "readwrite");
    tx.objectStore(INBOX_STORE).put(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  // trim to the newest INBOX_MAX
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction(INBOX_STORE, "readonly");
    const r = tx.objectStore(INBOX_STORE).getAllKeys();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (keys.length > INBOX_MAX) {
    const drop = keys.sort().slice(0, keys.length - INBOX_MAX);
    const tx = db.transaction(INBOX_STORE, "readwrite");
    for (const k of drop) tx.objectStore(INBOX_STORE).delete(k);
  }
}

// Device observations use a fixed endpoint and a private per-delivery proof.
// They never delay showing the alert, and never mean that a person read it.
async function observeDelivery(receipt, stage) {
  if (!receipt || !/^[1-9][0-9]{0,18}$/.test(String(receipt.id || "")) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(receipt.token || "")) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch("https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/delivery-receipt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: String(receipt.id), token: receipt.token, stage }),
      signal: controller.signal, credentials: "omit", cache: "no-store",
    });
  } catch { /* observations are best-effort; notification delivery comes first */ }
  finally { clearTimeout(timer); }
}

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Real Estate Briefing" }; }
  e.waitUntil(observeDelivery(d.receipt, "received"));
  e.waitUntil((async () => {
    try {
      await inboxAdd({
        at: new Date().toISOString(),
        title: d.title || "Real Estate Briefing",
        body: d.body || "",
        url: d.url || "./",
      });
    } catch { /* inbox is a nicety, never block the notification */ }
    try { await self.navigator.setAppBadge?.(1); } catch { /* unsupported */ }
    await self.registration.showNotification(d.title || "Real Estate Briefing", {
      body: d.body || "",
      tag: d.tag || undefined,
      icon: "./icon.svg",
      data: { url: d.url || "./" },
    });
    await observeDelivery(d.receipt, "displayed");
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "./";
  e.waitUntil((async () => {
    try { await self.navigator.clearAppBadge?.(); } catch { /* unsupported */ }
    const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (list.length) {
      const c = list[0];
      try { await c.navigate(url); } catch { /* cross-origin edge */ }
      return c.focus();
    }
    return clients.openWindow(url);
  })());
});
