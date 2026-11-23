// Service Worker: офлайн-кэш интерфейса (PWA)
// Стратегия: сеть — всегда первая (свежий код гарантированно),
// кэш используется только когда интернета нет.
const VERSION = 'mspgram-v24';
const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './css/v18.css',
  './css/v19.css',
  './css/v20.css',
  './css/v21.css',
  './css/v22.css',
  './css/v23.css',
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

// ---------- клик по системному уведомлению ----------
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
      if (data.chatId) client.postMessage({ type: 'open-chat', chatId: data.chatId });
    } else if (self.clients.openWindow) {
      // приложение было закрыто: чат передаём в адресе — app откроет его после загрузки
      const url = data.chatId ? './?chat=' + encodeURIComponent(data.chatId) : (data.url || './');
      try { await self.clients.openWindow(url); } catch { /* */ }
    }
  })());
});

// ---------- v22: настоящий Web Push (приходит с сервера, приложение может быть закрыто) ----------
// Сервер: supabase/functions/send-push. Формат: { kind, title, body, tag, chatId, callId }
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'MSPgram', body: event.data ? event.data.text() : '' }; }
  const isCall = d.kind === 'call';

  event.waitUntil((async () => {
    // Приложение открыто и на экране — оно само покажет плашку и сыграет звук, дубль не нужен
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible' && c.focused) && d.kind !== 'test') return;

    const tag = d.tag || (isCall ? 'msp-call' : undefined);
    await self.registration.showNotification(d.title || 'MSPgram', {
      body: d.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag,
      renotify: !!tag,            // v23: каждое новое сообщение в чате снова звенит/вибрирует, а не подменяет старое молча
      requireInteraction: isCall,
      vibrate: isCall ? [600, 300, 600, 300, 600] : [200, 100, 200],
      data: { chatId: d.chatId || null, callId: d.callId || null, kind: d.kind || 'message', url: './' },
    });

    // звонок «звонит» недолго: убираем уведомление, чтобы не висело как живое
    if (isCall && tag) {
      await new Promise((r) => setTimeout(r, 45000));
      const old = await self.registration.getNotifications({ tag });
      old.forEach((n) => n.close());
    }
  })());
});

// Подписка устарела/обновилась: приложение пересоздаст её при следующем запуске (syncPushSilently)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((c) => c.postMessage({ type: 'push-resubscribe' }));
  })());
});
