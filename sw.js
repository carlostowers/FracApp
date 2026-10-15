// Frac service worker v6
// - App shell is precached so Frac opens offline (manual mode works with no signal).
// - Pages: network first, cached copy when offline.
// - Fonts, background image, html2canvas: cache first, refreshed in the background.
// - /api/ is never cached.
var VERSION = 'frac-v6';
var SHELL = ['/', '/index.html', '/manifest.json', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function putCopy(req, res) {
  if (!res || (res.status !== 200 && res.type !== 'opaque')) return;
  var copy = res.clone();
  caches.open(VERSION).then(function (c) { return c.put(req, copy); }).catch(function () {});
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/_vercel/') === 0) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) { putCopy('/', res); return res; })
      .catch(function () { return caches.match('/').then(function (r) { return r || caches.match('/index.html'); }); }));
    return;
  }

  var hosts = ['fonts.googleapis.com', 'fonts.gstatic.com', 'images.unsplash.com', 'cdnjs.cloudflare.com'];
  if (url.origin === self.location.origin || hosts.indexOf(url.hostname) >= 0) {
    e.respondWith(caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) { putCopy(req, res); return res; }).catch(function () { return hit || Response.error(); });
      return hit || net;
    }));
  }
});
