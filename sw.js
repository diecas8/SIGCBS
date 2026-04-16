// ============================================================
//  sw.js — Service Worker · Geoportal APS · SIGCBS
//  Estrategia: Cache-first para recursos estáticos
//              Network-first para datos de Supabase
// ============================================================

const CACHE_NAME = 'aps-cache-v1';

// Recursos que se guardan offline al instalar la app
const PRECACHE = [
  './',
  './index.html',
  './app.html',
  './campo.html',
  './reporte.html',

  // Leaflet
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js',

  // Turf y Supabase
  'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',

  // Fuentes
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap'
];

// ── INSTALACIÓN: guarda los recursos en caché ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[APS SW] Error en precache:', err))
  );
});

// ── ACTIVACIÓN: limpia cachés viejas ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: estrategia según tipo de request ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Peticiones a Supabase → Network-first (datos en tiempo real)
  //    Si no hay red, falla silenciosamente (la app maneja el error)
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(
          JSON.stringify({ error: 'Sin conexión — datos no disponibles offline' }),
          { headers: { 'Content-Type': 'application/json' }, status: 503 }
        ))
    );
    return;
  }

  // 2. Tiles del mapa (OpenStreetMap, Satellite) → Cache-first
  //    Guarda los tiles visitados para verlos offline
  if (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('tiles.stadiamaps.com') ||
    url.hostname.includes('mt0.google.com') ||
    url.hostname.includes('mt1.google.com')
  ) {
    event.respondWith(
      caches.open('aps-tiles-v1').then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached || new Response('', { status: 503 }));
        })
      )
    );
    return;
  }

  // 3. Todo lo demás → Cache-first con fallback a red
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Guarda en caché solo respuestas válidas
        if (response && response.status === 200 && response.type !== 'opaque') {
          caches.open(CACHE_NAME).then(cache =>
            cache.put(event.request, response.clone())
          );
        }
        return response;
      }).catch(() =>
        // Si todo falla y es navegación, muestra campo.html
        event.request.mode === 'navigate'
          ? caches.match('./campo.html')
          : new Response('', { status: 503 })
      );
    })
  );
});

// ── SYNC EN SEGUNDO PLANO (cuando vuelve la conexión) ──
self.addEventListener('sync', event => {
  if (event.tag === 'sync-reportes') {
    event.waitUntil(syncReportesOffline());
  }
});

async function syncReportesOffline() {
  // Esta función la llama campo.html cuando recupera conexión
  // para enviar a Supabase los reportes guardados localmente
  const clients = await self.clients.matchAll();
  clients.forEach(client =>
    client.postMessage({ type: 'SYNC_READY' })
  );
}
