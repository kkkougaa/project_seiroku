// 오프라인 캐시. 파일을 고치면 VERSION 숫자를 올려 주세요.
const VERSION = 'booth-pos-v6';
importScripts('config.js');
const IMAGES = Object.values(self.BOOTH_CONFIG.booths).flatMap(b => b.products).map(p => p.image).filter(Boolean);
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'fonts/PretendardVariable.woff2', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(async c => {
    await c.addAll(FILES);
    // 사진은 아직 없을 수도 있어서 하나씩 시도해요
    await Promise.all(IMAGES.map(u => c.add(u).catch(() => {})));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 캐시 먼저 보여주고, 인터넷이 되면 뒤에서 새 파일로 바꿔 둬요
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r && r.ok && new URL(e.request.url).origin === location.origin) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || new Response('오프라인이에요', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
