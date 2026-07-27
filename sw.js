importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSy" + "AvnzYiPbSoY0HN6WWLTa1Ge2yB0sGm02I",
    authDomain: "b-talk-login.firebaseapp.com",
    databaseURL: "https://b-talk-login-default-rtdb.firebaseio.com/",
    projectId: "b-talk-login",
    storageBucket: "b-talk-login.appspot.com",
    messagingSenderId: "1041735787374",
    appId: "1:1041735787374:web:b32df90d336d69fba7577f"
});

const messaging = firebase.messaging();

// 캐시 (기존 로직 유지)
const CACHE = 'btalk-v4';
const STATIC = ['/icon.svg', '/manifest.json', '/logo-transparent.png', '/icon-192.png', '/icon-512.png'];

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
    if (
        url.origin !== self.location.origin ||
        url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname === '/admin.html' ||
        url.hostname.includes('firebase') ||
        url.hostname.includes('googleapis') ||
        url.hostname.includes('netlify')
    ) {
        e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
        return;
    }
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});

// 백그라운드 FCM 푸시 수신
messaging.onBackgroundMessage(payload => {
    const { title, body } = payload.notification || {};
    // 포그라운드 핸들러(index.html)와 같은 tag를 써서, 혹시 둘 다 발생해도 중복이 아니라 하나로 합쳐지게 함
    const tag = payload.messageId || payload.fcmMessageId || (payload.data && payload.data.id) || 'btalk-notify';
    self.registration.showNotification(title || '딩동! 🌌', {
        body: body || '',
        icon: '/icon192.png',
        badge: '/icon192.png',
        tag,
        data: payload.data || {}
    });
});

// 알림 클릭 → 앱 열고 해당 토픽으로 자동 입장
self.addEventListener('notificationclick', e => {
    e.notification.close();
    const data = e.notification.data || {};
    const topic = data.topic;
    const style = data.style;
    const pp = data.pp;
    let url = topic ? `/?join=${encodeURIComponent(topic)}` : '/';
    if (topic && style) url += `&style=${encodeURIComponent(style)}`;
    if (topic && pp) url += `&pp=${encodeURIComponent(pp)}`;
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            for (const c of list) {
                if (c.url.includes(self.location.origin)) {
                    c.focus();
                    c.postMessage({ type: 'PUSH_JOIN', topic, style, pp });
                    return;
                }
            }
            return clients.openWindow(url);
        })
    );
});
