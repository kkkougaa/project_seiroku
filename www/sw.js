// 오프라인 캐시. 파일을 고치면 VERSION 숫자를 올려 주세요.
// 인터넷이 되면 항상 새 파일을 먼저 받고, 안 되면 저장해 둔 파일을 보여줘요.
const VERSION = 'booth-pos-v17';
importScripts('config.js');
const IMAGES = Object.values(self.BOOTH_CONFIG.booths).flatMap(b => b.products).map(p => p.image).filter(Boolean);
const FILES = ['./', 'index.html', 'monitor.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'fonts/PretendardVariable.woff2', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(async c => {
    await c.addAll(FILES.map(u => new Request(u, { cache: 'reload' })));
    await Promise.all([...IMAGES, 'sounds/pay.mp3'].map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isAsset = /\.(png|jpe?g|webp|woff2|mp3)$/i.test(new URL(req.url).pathname);
  e.respondWith(caches.open(VERSION).then(async c => {
    // 사진과 글꼴은 저장해 둔 것 먼저 (빠르게), 코드는 인터넷 먼저 (항상 최신)
    if (isAsset) {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
    }
    try {
      // 인터넷이 느리거나 안 되면 3초 뒤 저장해 둔 파일로 넘어가요
      const r = await Promise.race([fetch(req, { cache: 'no-cache' }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3000))]);
      if (r && r.ok) c.put(req, r.clone());
      return r;
    } catch {
      return (await c.match(req, { ignoreSearch: true })) || (await c.match('index.html')) ||
        new Response('오프라인이에요', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }));
});
