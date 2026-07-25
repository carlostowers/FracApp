const CACHE='frac-v2';
self.addEventListener('install',e=>{self.skipWaiting();});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener('fetch',e=>{
  if(e.request.url.includes('/api/'))return; // never cache OCR calls
  e.respondWith(
    fetch(e.request).then(r=>{
      const c=r.clone();
      caches.open(CACHE).then(ch=>ch.put(e.request,c)).catch(()=>{});
      return r;
    }).catch(()=>caches.match(e.request))
  );
});
