/* Offline support: the app shell is cached, issue data is fetched fresh when online. */
var SHELL = 'shell-v1';
var FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SHELL; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Network first for everything on this site, falling back to the last copy when offline.
  event.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      if (res.ok) caches.open(SHELL).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () { return caches.match(req, { ignoreSearch: true }); })
  );
});
