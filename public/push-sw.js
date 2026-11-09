// Chargé par le service worker principal (workbox importScripts) : réception et clic des notifications push.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { /* message non JSON : notification générique */ }
  event.waitUntil(self.registration.showNotification(d.title || 'Stock BdN', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: d.url || '#/mur' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '#/mur';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (open) { await open.focus(); open.postMessage({ nav: hash }); return; }   // l'appli est ouverte : elle change de page
    await self.clients.openWindow(self.registration.scope + hash);                // sinon on l'ouvre directement sur la bonne page
  })());
});
