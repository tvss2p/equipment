/* 備品購入 PWA service worker — Web Push 受信用 */
self.addEventListener('push', function (event) {
  var d = { title: '備品購入', body: 'お知らせがあります', url: './' };
  try {
    if (event.data) { d = Object.assign(d, event.data.json()); }
  } catch (e) {
    if (event.data) { try { d.body = event.data.text(); } catch (_) {} }
  }
  event.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: d.tag || 'bihin-deadline',
      data: { url: d.url || './' },
      requireInteraction: false
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) { return list[i].focus(); }
      }
      if (self.clients.openWindow) { return self.clients.openWindow(url); }
    })
  );
});

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
