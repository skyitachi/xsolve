// xsolve Service Worker —— PWA 离线外壳
// 策略：
//   app shell（HTML/CSS/JS/字体/图标）  → 预缓存 + cache-first
//   GET /api/*、/healthz、/diagrams/*   → network-only（绝不缓存，含对话/评估数据）
//   POST 等非 GET 请求                  → 直接放行（SSE 流式对话走这里）
//   导航请求                            → network-first，离线回退到缓存的 index.html
const CACHE = 'xsolve-shell-v1';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/js/state.js',
  '/js/dom-utils.js',
  '/js/markdown.js',
  '/js/scratch.js',
  '/js/problem.js',
  '/js/chat.js',
  '/js/dialogs.js',
  '/js/upload.js',
  '/js/voice.js',
  '/js/panel-resizer.js',
  '/js/pwa.js',
  '/vendor/katex/katex.min.css',
  '/vendor/katex/katex.min.js',
  '/vendor/katex/contrib/auto-render.min.js',
  '/vendor/marked/marked.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐个添加，单个失败不影响整体安装
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => null),
        ),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// 这些前缀一律不缓存，直接走网络
const NETWORK_ONLY = ['/api/', '/healthz', '/diagrams/'];

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源 GET
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 接口 / 健康检查 / 生成的图表 → 不缓存
  if (NETWORK_ONLY.some((p) => url.pathname.startsWith(p))) return;

  // 导航请求：network-first，离线回退到外壳
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match('/index.html')) ||
            (await cache.match('/')) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // 其余静态资源：cache-first + 后台更新
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) {
        // 后台静默更新
        fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
          })
          .catch(() => {});
        return cached;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch {
        return cached || Response.error();
      }
    })(),
  );
});
