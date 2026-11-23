// Service Worker: офлайн-кэш интерфейса (PWA)
// Стратегия: сеть — всегда первая (свежий код гарантированно),
// кэш используется только когда интернета нет.
const VERSION = 'mspgram-v17';
const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/vendor/supabase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // запросы к Supabase — мимо кэша

  // Всё своё отдаём «сначала сеть»: код всегда свежий, офлайн — из кэша
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      const cache = await caches.open(VERSION);
      return (await cache.match(req, { ignoreSearch: true }))
        || (await cache.match('./index.html'))
        || Response.error();
    }
  })());
});
