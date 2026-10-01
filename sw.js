/* 离线缓存（PWA）。只在 https/http 下由 pwa.js 注册，扩展页不会用到。
   改了 index.html / app.css / app.js / layout.js 之后：
   1) 把下面的 CACHE 版本号 +1；
   2) 把 PRECACHE 里带 ?v= 的条目和 index.html 里的 ?v= 改成同一个新版本号（tools/verify_banks.mjs 会检查两者是否一致）。 */
const CACHE = "yxa-v7";

const PRECACHE = [
  "./index.html",
  "./app.css?v=1.8",
  "./app.js?v=1.8",
  "./pwa.js?v=1.8",
  "./layout.js?v=1.8",
  "./manifest.webmanifest?v=1.8",
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

/* 应用外壳（html/css/js/json）走网络时不使用 HTTP 缓存，避免拿到旧版本；
   离线时再回落到下面缓存好的副本。 */
function isShell(url) {
  return /\.(html|css|js|json|webmanifest)$/i.test(url.pathname) &&
    !/\/banks\//.test(url.pathname) &&
    !/\/vendor\//.test(url.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const resp = await fetch(url, { cache: "no-store" });
        if (resp && resp.ok) await cache.put(url, resp);
      } catch (err) {
        // 单个文件失败不影响整体安装，下次访问会由 fetch 兜底
      }
    }));
    await self.skipWaiting();
  })());
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
  const url = new URL(req.url);
  const opts = isShell(url) ? { cache: "no-store" } : {};
  try {
    const resp = await fetch(req, opts);
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
