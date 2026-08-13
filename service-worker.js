const CACHE="dcastilho-v4-pwa-ios";
const ASSETS=["./","./index.html","./styles.css","./app.js","./manifest.json","./assets/logo.png","./assets/apple-touch-icon.png","./assets/icon-192.png","./assets/icon-512.png"];
self.addEventListener("install",e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  e.respondWith(caches.open(CACHE).then(c=>c.match(e.request).then(r=>r||fetch(e.request).then(resp=>{if(resp.ok&&new URL(e.request.url).origin===self.location.origin)c.put(e.request,resp.clone());return resp;}))));
});
