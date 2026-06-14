// CACHE_NAME is derived from the wasm build hash at build time.
// The Vite plugin `injectServiceWorkerBuildId` replaces __SW_BUILD_ID__ in
// dist/sw.js with the hash of pkg/wasm_splatwalk/wasm_splatwalk_bg.wasm.
// Any new wasm build therefore produces a new CACHE_NAME, which clears every
// previous cache on activation so integrators never have to discard cache.
const CACHE_NAME = 'splatwalk-__SW_BUILD_ID__';

// Only precache stable shell assets that exist in both dev and prod.
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/rustacean.webp'
];

// Requests that must never be served from cache: application code, wasm glue and
// binaries, splat assets, workers, and anything with a query string (HMR, hashed
// builds). These always go straight to the network so stale code can't be served.
function shouldBypassCache(url) {
  if (url.search) {
    return true;
  }
  const path = url.pathname;
  if (
    path.startsWith('/pkg/') ||
    path.startsWith('/src/') ||
    path.startsWith('/assets/') ||
    path.startsWith('/@')
  ) {
    return true;
  }
  return /\.(wasm|ply|spz|mjs)$/i.test(path) || /worker/i.test(path);
}

self.addEventListener('install', (event) => {
  // Activate the new worker immediately instead of waiting for old clients.
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache what we can, don't fail if some assets are missing.
      return Promise.allSettled(
        ASSETS_TO_CACHE.map((url) =>
          cache.add(url).catch(() => {
            console.warn(`SW: Failed to cache ${url}`);
          })
        )
      );
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests.
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // Skip cross-origin requests.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never cache code/wasm/asset requests: pass straight through to the network
  // so a rebuilt module is always picked up without a manual cache clear.
  if (shouldBypassCache(url)) {
    return;
  }

  // Network-first for the shell: try network, cache the result, fall back to cache.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Take control of open clients immediately.
      self.clients.claim(),
      // Clear every cache that isn't the current build's cache.
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName))
        );
      })
    ])
  );
});

// Allow the page to tell a waiting worker to activate immediately.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
