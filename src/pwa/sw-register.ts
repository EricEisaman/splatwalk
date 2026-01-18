// Service Worker Registration
// Only registers in production builds (not in dev mode)

function isProduction(): boolean {
  // Check if we're running on localhost (dev) or production
  const hostname = window.location.hostname;
  return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]';
}

function isServiceWorkerSupported(): boolean {
  return 'serviceWorker' in navigator;
}

function getServiceWorkerPath(): string {
  return '/sw.js';
}

export async function registerServiceWorker(): Promise<void> {
  // Only register in production
  if (!isProduction()) {
    return;
  }
  
  // Check if service workers are supported
  if (!isServiceWorkerSupported()) {
    return;
  }
  
  try {
    const registration = await navigator.serviceWorker.register(getServiceWorkerPath(), {
      scope: '/',
    });
    
    // Handle service worker updates
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) {
        return;
      }
      
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // New service worker is available
          // Optionally notify user or auto-reload
          console.log('New service worker available');
        }
      });
    });
    
    // Handle controller change (new service worker activated)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Optionally reload the page to use new service worker
      console.log('Service worker controller changed');
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

