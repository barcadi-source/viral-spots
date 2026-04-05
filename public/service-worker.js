const CACHE_NAME = 'viral-spots-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
];

// 安裝：快取靜態資源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// 啟動：清除舊快取
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 攔截請求：靜態資源用快取，API 請求永遠打網路
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API 請求直接打網路，不快取
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 靜態資源：優先用快取，失敗再打網路
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
