const CACHE_NAME = 'g2m-cache-v1';
const ASSETS_TO_CACHE = [
  '/pages/g2m.html',
  '/src/styles.css',
  '/rustacean.webp',
  '/pkg/wasm_g2m/wasm_g2m.js',
  '/pkg/wasm_g2m/wasm_g2m_bg.wasm'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((cacheName) => {
          return cacheName !== CACHE_NAME;
        }).map((cacheName) => {
          return caches.delete(cacheName);
        })
      );
    })
  );
});
