// Service Worker: офлайн-кэш интерфейса (PWA)
// Стратегия: сеть — всегда первая (свежий код гарантированно),
// кэш используется только когда интернета нет.
const VERSION = 'mspgram-v21';
const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './css/v18.css',
  './css/v19.css',
  './css/v20.css',
  './css/v21.css',
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

// ---------- v21: клик по системному уведомлению ----------
// Открываем приложение (или возвращаемся в него) и просим открыть нужный чат.
self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let client = list.find((c) => 'focus' in c) || null;
    if (client) {
      try { await client.focus(); } catch { /* */ }
    } else if (self.clients.openWindow) {
      client = await self.clients.openWindow(data.url || './');
    }
    if (client && data.chatId) {
      // небольшая задержка: если окно только что открылось — дать приложению загрузиться
      setTimeout(() => client.postMessage({ type: 'open-chat', chatId: data.chatId }), list.length ? 0 : 2500);
    }
  })());
});

// Задел под настоящий Web Push (когда появится серверная отправка)
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'MSPgram', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'MSPgram', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    tag: d.tag || undefined, data: { chatId: d.chatId || null, url: './' }, vibrate: [200, 100, 200],
  }));
});
