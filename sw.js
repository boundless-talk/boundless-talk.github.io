const CACHE = 'btalk-v3';
const STATIC = ['/B-Talk/icon.svg', '/B-Talk/manifest.json', '/B-Talk/logo-transparent.png', '/B-Talk/icon-192.png', '/B-Talk/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // index.html은 항상 네트워크에서 최신 버전 가져옴
  if (url.pathname === '/B-Talk/' || url.pathname === '/B-Talk/index.html') {
    e.respondWith(fetch(e.request));
    return;
  }
  // 정적 자산은 캐시 우선
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
