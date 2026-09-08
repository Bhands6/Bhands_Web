/**
 * BhandsMusic Web Service Worker
 * 策略（遵循迁移计划 #69：绝不缓存音乐/API 数据）：
 * - /api/*：完全放行，不做任何拦截（音源、登录态必须实时）
 * - 导航请求：network-first，离线回退缓存的 index.html，再回退 offline.html
 * - 同源静态资源（js/css/图片/字体）：stale-while-revalidate
 * - 跨域请求（CDN 字体、封面图）：不拦截
 */
const CACHE_NAME = 'bhandsmusic-v1';
const PRECACHE = ['/', '/index.html', '/manifest.json', '/offline.html'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API 与音频流代理：必须实时，绝不缓存
  if (url.pathname.startsWith('/api/')) return;
  // 跨域资源交给浏览器默认行为
  if (url.origin !== self.location.origin) return;
  // 非基础请求（如 Range 音频分片）不拦截
  if (request.method !== 'GET') return;

  // 页面导航：网络优先，离线回退
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return res;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // 同源静态资源：stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const refresh = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
