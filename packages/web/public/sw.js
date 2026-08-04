/**
 * los console — minimal offline shell service worker (G9).
 *
 * Strategy: network-first for same-origin GET requests, falling back to the
 * cache when offline; navigation requests fall back to the cached index.html.
 * API paths are never cached so the gateway (same-origin when statically
 * hosted) always sees fresh requests. Registered only in production builds.
 */
'use strict';

const CACHE = 'los-console-v1';

// Same-origin API prefixes that must bypass the cache (mirrors the dev proxy
// list in vite.config.ts). Everything else same-origin GET is cacheable.
const API_PREFIXES = [
  '/agent-graphs', '/artifacts', '/chat', '/communication', '/daily-agent-quality',
  '/health', '/inbox', '/logs', '/mcp-servers', '/memory', '/node-commands',
  '/nodes', '/onboarding', '/projects', '/providers', '/run-evals', '/rules',
  '/runs', '/scheduled-work-items', '/scheduled-work-item-runs', '/runtimes',
  '/services', '/sessions', '/settings', '/skills', '/tasks', '/todos',
  '/workspace', '/work-items',
];

function isApiRequest(url) {
  return API_PREFIXES.some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApiRequest(url)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(hit =>
          hit ?? (request.mode === 'navigate' ? caches.match('/') : undefined),
        ),
      ),
  );
});
