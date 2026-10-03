/* Offline support: the app shell is cached, issue data is fetched fresh when online. */
var SHELL = 'shell-v18';
var FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'fonts/archivo.woff', 'fonts/newsreader.woff', 'fonts/newsreader-italic.woff'];

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
  // 'no-cache' makes the browser check with the server every time, so a new version of the
  // app or the picks shows up on the next open and not up to ten minutes later.
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      var copy = res.clone();
      if (res.ok) caches.open(SHELL).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () { return caches.match(req, { ignoreSearch: true }); })
  );
});
