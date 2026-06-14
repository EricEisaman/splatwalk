// Service Worker Registration
//
// In production: registers /sw.js and keeps clients up to date automatically.
// A new build produces a new SW (its CACHE_NAME is derived from the wasm hash),
// which we tell to activate immediately and then reload the page once. Integrators
// never have to manually discard cache.
//
// In development: never registers a SW, and proactively unregisters any existing
// SW plus clears caches so a previously-poisoned localhost browser self-heals.

function isProduction(): boolean {
  const hostname = window.location.hostname;
  return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]';
}

function isServiceWorkerSupported(): boolean {
  return 'serviceWorker' in navigator;
}

function getServiceWorkerPath(): string {
  return '/sw.js';
}

// Guard so the controllerchange handler reloads at most once.
let hasReloaded = false;

async function unregisterAllAndClearCaches(): Promise<void> {
  try {
    if (isServiceWorkerSupported()) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`Service worker dev cleanup failed: ${message}`);
  }
}

export async function registerServiceWorker(): Promise<void> {
  if (!isServiceWorkerSupported()) {
    return;
  }

  // In dev, ensure no stale service worker or cache survives from a prior session.
  if (!isProduction()) {
    // If a worker is still controlling this page, it will keep re-caching the
    // shell until a reload drops it. Unregister, clear caches, then reload once
    // (guarded via sessionStorage) so the next load is uncontrolled and clean.
    const wasControlled = !!navigator.serviceWorker.controller;
    await unregisterAllAndClearCaches();
    const DEV_HEAL_FLAG = 'splatwalk_sw_dev_healed';
    if (wasControlled && !sessionStorage.getItem(DEV_HEAL_FLAG)) {
      sessionStorage.setItem(DEV_HEAL_FLAG, '1');
      window.location.reload();
    }
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register(getServiceWorkerPath(), {
      scope: '/',
    });

    // Proactively check for a newer worker on load.
    registration.update().catch(() => { });

    // A new worker was found: once installed alongside an existing controller,
    // ask it to skip waiting so it activates without a manual refresh.
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) {
        return;
      }

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          newWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });

    // When the new worker takes control, reload once to pick up fresh assets.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hasReloaded) {
        return;
      }
      hasReloaded = true;
      window.location.reload();
    });

    console.log('Service worker registered successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Service worker registration failed:', errorMessage);
  }
}

// Handle online/offline state changes
export function setupOfflineHandling(): void {
  if (!isProduction()) {
    return;
  }

  window.addEventListener('online', () => {
    console.log('Application is online');
  });

  window.addEventListener('offline', () => {
    console.log('Application is offline');
  });
}
