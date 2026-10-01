/* 离线缓存（PWA）。只在 https/http 下由 pwa.js 注册，扩展页不会用到。
   改了 index.html / app.js / banks/* 之后，把 CACHE 版本号 +1，用户下次打开就会拿到新版。 */
const CACHE = "yxa-v3";

const PRECACHE = [
  "./index.html",
  "./app.css",
  "./app.js",
  "./pwa.js",
  "./manifest.webmanifest",
  "./icons/icon16.png",
  "./icons/icon48.png",
  "./icons/icon128.png",
  "./icons/icon192.png",
  "./icons/icon512.png",
  "./icons/icon512-maskable.png",
  "./banks/index.js",
  "./banks/wf.js",
  "./banks/cx.js",
  "./banks/rd-zj.js",
  "./banks/rd-gj.js",
  "./banks/rd-js.js",
  "./vendor/xlsx.full.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, "./index.html"));
    return;
  }
  if (/\.(png|ico|svg|webp)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp && resp.ok) {
    const cache = await caches.open(CACHE);
    cache.put(req, resp.clone());
  }
  return resp;
}

async function networkFirst(req, fallback) {
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (fallback) {
      const fb = await caches.match(fallback);
      if (fb) return fb;
    }
    return new Response("当前离线，且该资源未被缓存。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}
