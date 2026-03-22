// EnglishGen Service Worker — v1.0.0
const CACHE_NAME = 'englishgen-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/generator.html',
  '/export.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network first for API calls
  if (event.request.url.includes('api.anthropic.com') || 
      event.request.url.includes('fonts.googleapis.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache first for app shell
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone);
        });
        return response;
      });
    }).catch(() => {
      return caches.match('/index.html');
    })
  );
});
