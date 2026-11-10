/**
 * ============================================================================
 * sw.js — Service Worker untuk NWD Offline & Cloud Web Viewer
 * ============================================================================
 * Tugas Utama:
 * 1. Offline App Shell & Autodesk Viewer v7 SDK Caching (viewer3D.min.js,
 *    style.min.css, lmvworker.min.js, dan seluruh ekstensi CAD/BIM) agar
 *    tetap berjalan saat laptop 100% tidak memiliki koneksi internet.
 * 2. Virtual Local SVF Server (/local-svf/{modelId}/{path}): Meng-intercept
 *    seluruh request HTTP fetch/XHR dari GuiViewer3D & lmvworker.min.js dan
 *    melayani binary blob SVF (.svf, .pf, .pack, .bin, .json.gz, .sdb, png)
 *    langsung dari IndexedDB (NWDViewerOfflineDB).
 */

const CACHE_SHELL = 'nwd-viewer-shell-v2';
const CACHE_SDK = 'nwd-viewer-sdk-v2';

const DB_NAME = 'NWDViewerOfflineDB';
const DB_VERSION = 1;
const STORE_MODELS = 'models';
const STORE_FILES = 'files';

// Daftar file inti aplikasi lokal
const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './assets/icon.svg',
  './css/styles.css',
  './js/app.js',
  './js/aps-client.js',
  './js/local-loaders.js',
  './js/storage.js',
  './js/viewer.js'
];

// Daftar file inti SDK Autodesk Viewer v7 & JSZip yang di-cache untuk mode 100% Offline
const VIEWER_SDK_BASE = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*';
const EXTERNAL_SDK_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  `${VIEWER_SDK_BASE}/style.min.css`,
  `${VIEWER_SDK_BASE}/viewer3D.min.js`,
  `${VIEWER_SDK_BASE}/lmvworker.min.js`,
  `${VIEWER_SDK_BASE}/res/locales/en/allstrings.json`,
  `${VIEWER_SDK_BASE}/extensions/Measure/Measure.min.js`,
  `${VIEWER_SDK_BASE}/extensions/Section/Section.min.js`,
  `${VIEWER_SDK_BASE}/extensions/BimWalk/BimWalk.min.js`,
  `${VIEWER_SDK_BASE}/extensions/Explode/Explode.min.js`,
  `${VIEWER_SDK_BASE}/extensions/Snapping/Snapping.min.js`,
  `${VIEWER_SDK_BASE}/extensions/SceneBuilder/SceneBuilder.min.js`
];

/**
 * Normalisasi path relatif SVF.
 * @param {string} rawPath
 * @returns {string}
 */
function normalizeSvfPath(rawPath) {
  if (!rawPath) return '';
  const cleaned = String(rawPath)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('?')[0]
    .split('#')[0];

  const segments = cleaned.split('/');
  const resolved = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  return resolved.join('/');
}

/**
 * Menentukan MIME type dari ekstensi file.
 * @param {string} filePath
 * @returns {string}
 */
function inferMimeType(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * Membuka IndexedDB dari dalam Service Worker.
 * @returns {Promise<IDBDatabase>}
 */
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_MODELS)) {
        const modelStore = db.createObjectStore(STORE_MODELS, { keyPath: 'id' });
        modelStore.createIndex('by_createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const fileStore = db.createObjectStore(STORE_FILES, { keyPath: 'key' });
        fileStore.createIndex('by_modelId', 'modelId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Mengambil file SVF dari IndexedDB berdasarkan modelId dan path.
 * @param {string} modelId
 * @param {string} rawPath
 * @returns {Promise<Object|null>}
 */
async function getFileFromIndexedDB(modelId, rawPath) {
  const db = await openIndexedDB();
  const normPath = normalizeSvfPath(rawPath);
  const exactKey = `${modelId}/${normPath}`;

  // 1. Coba exact key
  const exactRecord = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILES], 'readonly');
    const store = tx.objectStore(STORE_FILES);
    const req = store.get(exactKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (exactRecord) {
    db.close();
    return exactRecord;
  }

  // 2. Coba dengan/tanpa prefix "output/"
  const altPath = normPath.startsWith('output/')
    ? normPath.slice('output/'.length)
    : `output/${normPath}`;
  const altKey = `${modelId}/${altPath}`;

  const altRecord = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILES], 'readonly');
    const store = tx.objectStore(STORE_FILES);
    const req = store.get(altKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (altRecord) {
    db.close();
    return altRecord;
  }

  // 3. Fallback case-insensitive / suffix match di dalam modelId yang sama
  const fallbackRecord = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILES], 'readonly');
    const store = tx.objectStore(STORE_FILES);
    const index = store.index('by_modelId');
    const req = index.openCursor(IDBKeyRange.only(modelId));
    const lowerTarget = normPath.toLowerCase();

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(null);
        return;
      }
      const rec = cursor.value;
      const recLower = String(rec.path || '').toLowerCase();
      if (
        recLower === lowerTarget ||
        recLower.endsWith('/' + lowerTarget) ||
        lowerTarget.endsWith('/' + recLower)
      ) {
        resolve(rec);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  db.close();
  return fallbackRecord;
}

/**
 * Handler untuk Virtual Route `/local-svf/{modelId}/{filePath}`
 * @param {Request} request
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleLocalSvfRequest(request, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      }
    });
  }

  const marker = '/local-svf/';
  const markerIdx = url.pathname.indexOf(marker);
  if (markerIdx === -1) {
    return new Response('Invalid virtual SVF route', { status: 400 });
  }

  const afterMarker = decodeURIComponent(url.pathname.slice(markerIdx + marker.length));
  const firstSlash = afterMarker.indexOf('/');
  if (firstSlash === -1) {
    return new Response('Missing file path in virtual SVF route', { status: 400 });
  }

  const modelId = afterMarker.slice(0, firstSlash);
  const relativeFilePath = normalizeSvfPath(afterMarker.slice(firstSlash + 1));

  try {
    const record = await getFileFromIndexedDB(modelId, relativeFilePath);
    if (!record || !record.data) {
      return new Response(`Offline SVF asset not found: ${modelId}/${relativeFilePath}`, {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    let bodyBuffer = record.data;

    // Jika diminta dekompresi eksplisit via query ?decompress=1
    if (url.searchParams.get('decompress') === '1' && typeof DecompressionStream !== 'undefined') {
      const bytes = new Uint8Array(bodyBuffer);
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        bodyBuffer = await new Response(ds.readable).arrayBuffer();
      }
    }

    const mimeType = record.mime || inferMimeType(relativeFilePath);

    return new Response(bodyBuffer, {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(bodyBuffer.byteLength),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    return new Response(`IndexedDB Virtual Server Error: ${err.message}`, {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

/**
 * Meng-cache daftar URL SDK eksternal secara aman (tidak gagal total jika satu file gagal).
 */
async function cacheExternalSdkAssets() {
  const sdkCache = await caches.open(CACHE_SDK);
  const results = await Promise.allSettled(
    EXTERNAL_SDK_URLS.map(async (sdkUrl) => {
      const existing = await sdkCache.match(sdkUrl);
      if (existing) return true;
      const resp = await fetch(sdkUrl, { mode: 'cors' });
      if (resp.ok) {
        await sdkCache.put(sdkUrl, resp.clone());
        return true;
      }
      return false;
    })
  );
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}

// Event: INSTALL
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(CACHE_SHELL);
      await Promise.all(
        APP_SHELL_FILES.map(async (path) => {
          try {
            const resp = await fetch(path, { cache: 'reload' });
            if (resp.ok) {
              await shellCache.put(path, resp);
            }
          } catch {
            await shellCache.add(path);
          }
        })
      );
      try {
        await cacheExternalSdkAssets();
      } catch (err) {
        console.warn('[SW] Pre-cache SDK akan dilanjutkan saat runtime:', err);
      }
      await self.skipWaiting();
    })()
  );
});

// Event: ACTIVATE
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_SHELL && key !== CACHE_SDK) {
            return caches.delete(key);
          }
          return null;
        })
      );
      await self.clients.claim();
    })()
  );
});

// Event: MESSAGE (Komunikasi dengan UI utama)
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'PRECACHE_VIEWER_SDK') {
    event.waitUntil(
      (async () => {
        const count = await cacheExternalSdkAssets();
        if (event.source) {
          event.source.postMessage({
            type: 'PRECACHE_VIEWER_SDK_DONE',
            cachedCount: count,
            totalCount: EXTERNAL_SDK_URLS.length
          });
        }
      })()
    );
  }
});

// Event: FETCH
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Intercept Virtual Local SVF Server (/local-svf/{modelId}/{path})
  if (url.pathname.includes('/local-svf/')) {
    event.respondWith(handleLocalSvfRequest(request, url));
    return;
  }

  // Hanya tangani GET request untuk caching
  if (request.method !== 'GET') return;

  // Jangan pernah meng-cache panggilan REST API transaksi APS (OAuth, OSS Upload, Derivative Job)
  // KECUALI file viewer SDK di `/modelderivative/v2/viewers/`
  if (
    url.hostname === 'developer.api.autodesk.com' &&
    !url.pathname.includes('/modelderivative/v2/viewers/')
  ) {
    return;
  }

  // 2. Strategi Cache-First + Auto-Cache untuk Autodesk Viewer v7 SDK, CDN JSZip, dan Fonts
  const isViewerSdkOrCdn =
    (url.hostname === 'developer.api.autodesk.com' &&
      url.pathname.includes('/modelderivative/v2/viewers/')) ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com');

  if (isViewerSdkOrCdn) {
    event.respondWith(
      (async () => {
        const sdkCache = await caches.open(CACHE_SDK);
        const cachedResp = await sdkCache.match(request, { ignoreVary: true });
        if (cachedResp) {
          return cachedResp;
        }
        try {
          const networkResp = await fetch(request);
          if (networkResp && (networkResp.ok || networkResp.type === 'opaque')) {
            sdkCache.put(request, networkResp.clone());
          }
          return networkResp;
        } catch (err) {
          const fallbackResp = await sdkCache.match(url.origin + url.pathname, {
            ignoreSearch: true
          });
          if (fallbackResp) return fallbackResp;
          throw err;
        }
      })()
    );
    return;
  }

  // 3. Strategi Network-First dengan Fallback Offline Cache Penuh untuk App Shell lokal
  //    (Agar saat Online selalu mendapat update terbaru, dan saat Offline tetap jalan 100% dari Cache)
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const shellCache = await caches.open(CACHE_SHELL);
        try {
          const netResp = await fetch(request);
          if (netResp && netResp.ok) {
            shellCache.put(request, netResp.clone());
            return netResp;
          }
        } catch {
          // Sedang Offline -> ambil dari Cache
        }

        const cached = await shellCache.match(request, { ignoreSearch: true });
        if (cached) {
          return cached;
        }

        if (request.mode === 'navigate') {
          const indexFallback = await shellCache.match('./index.html');
          if (indexFallback) return indexFallback;
        }

        return new Response('Offline — Resource not cached', { status: 503 });
      })()
    );
  }
});
