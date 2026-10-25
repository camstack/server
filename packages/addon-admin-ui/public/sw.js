// Tombstone service worker — drains stale registrations from pre-8a24e179 builds.
// New sessions never register a SW (registration removed from index.html).
// Existing profiles poll this file via updateViaCache:'none'; this SW installs,
// clears all caches, unregisters itself, then navigates all open tabs so they
// reload against the fresh network-only shell.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
      await self.registration.unregister()
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const c of clients) c.navigate(c.url)
    })(),
  ),
)
