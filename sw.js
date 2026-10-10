/* Helper — offline cache */
/* Меняйте версию кэша при каждом изменении index.html или словарей i18n/*.js */
const CACHE = 'helper-v15';
const FONTS = 'helper-fonts-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './i18n/ru.js', './i18n/ro.js', './i18n/en.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    /* кабинет партнёра (/partner/) — отдельное приложение: не кэшируем и не подменяем им офлайн-копию приложения */
    const root = new URL(self.registration.scope).pathname;
    if (url.pathname.startsWith(root + 'partner/') || url.pathname === root + 'partner') return;
    /* config.json (адрес API, меняется вместе с туннелем) — не перехватываем и не кэшируем: только сеть.
       Без сети приложение берёт последний проверенный config из своего localStorage */
    if (url.pathname.endsWith('/config.json')) return;
    /* словари интерфейса (i18n/*.js) меняются вместе с index.html — из сети, из кэша только без интернета */
    if (url.pathname.startsWith(root + 'i18n/')) {
      e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })
        .catch(() => caches.match(req, {ignoreSearch: true})));
      return;
    }
    if (req.mode === 'navigate') {
      const own = url.pathname === root || url.pathname === root + 'index.html';
      e.respondWith(fetch(req).then(r => { if (own && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); } return r; })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./'))));
      return;
    }
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
  }
});
