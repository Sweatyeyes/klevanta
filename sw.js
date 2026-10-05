// Клеванты — сервис-воркер: игра ставится на телефон как приложение и запускается без сети (вместе с музыкой).
// Сначала всегда сеть (обновления приходят сразу), без сети — сохранённая копия. При изменении файла — поменять версию V.
const V='klevanty-v2',FILES=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','music.mp3'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(V).then(c=>Promise.all(FILES.map(f=>c.add(f).catch(()=>{})))))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
 const rng=r.headers.has('range');
 e.respondWith(fetch(r).then(res=>{if(res.ok&&res.status===200&&!rng){const c=res.clone();caches.open(V).then(ca=>ca.put(r,c))}return res})
  .catch(()=>caches.match(r.url,{ignoreSearch:true}).then(m=>m||(r.mode==='navigate'?caches.match('index.html'):undefined))))});
