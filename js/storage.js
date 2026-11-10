/**
 * ============================================================================
 * js/storage.js — IndexedDB Offline SVF Storage & JSZip (.nwdpack.zip) Engine
 * ============================================================================
 * Menyimpan metadata model (.nwd) dan seluruh file binary SVF bubble
 * (.svf, .pf, .pack, .bin, .json.gz, .sdb, textures) di IndexedDB browser
 * agar dapat disajikan oleh Service Worker (/local-svf/:modelId/*) secara
 * 100% Offline, serta mendukung Export & Import paket .nwdpack.zip.
 */

export const DB_NAME = 'NWDViewerOfflineDB';
export const DB_VERSION = 1;
export const STORE_MODELS = 'models';
export const STORE_FILES = 'files';

let dbInstancePromise = null;

/**
 * Normalisasi path relatif di dalam SVF bubble.
 * Menghapus leading slash, mengubah backslash menjadi slash, dan menyelesaikan '.' serta '..'
 * Contoh: "output/0/../Resource/objects_attrs.json.gz" -> "output/Resource/objects_attrs.json.gz"
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizeSvfPath(rawPath) {
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
      if (resolved.length > 0) {
        resolved.pop();
      }
    } else {
      resolved.push(seg);
    }
  }
  return resolved.join('/');
}

/**
 * Menggabungkan direktori base (misal lokasi 0.svf: "output/0") dengan URI relatif
 * dari manifest.json internal SVF (misal "../Resource/objects_attrs.json.gz" atau "0.pf").
 * @param {string} baseFileOrDirPath
 * @param {string} relativeUri
 * @param {boolean} isBaseFile - true jika parameter pertama adalah path file (bukan folder)
 * @returns {string}
 */
export function resolveRelativeSvfPath(baseFileOrDirPath, relativeUri, isBaseFile = true) {
  const normBase = normalizeSvfPath(baseFileOrDirPath);
  const baseParts = normBase.split('/').filter(Boolean);
  if (isBaseFile && baseParts.length > 0) {
    baseParts.pop(); // Hapus nama file (misal "0.svf") sehingga tersisa foldernya
  }
  const combined = [...baseParts, String(relativeUri).replace(/\\/g, '/')].join('/');
  return normalizeSvfPath(combined);
}

/**
 * Menentukan MIME type berdasarkan ekstensi file SVF bubble.
 * @param {string} filePath
 * @returns {string}
 */
export function inferMimeType(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.txt') || lower.endsWith('.xml')) return 'text/plain; charset=utf-8';
  // Untuk .svf, .pf, .pack, .bin, .gz, .sdb gunakan application/octet-stream
  return 'application/octet-stream';
}

/**
 * Membuka koneksi IndexedDB (Singleton Promise).
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  if (dbInstancePromise) return dbInstancePromise;

  dbInstancePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
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

    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onversionchange = () => {
        db.close();
        dbInstancePromise = null;
      };
      resolve(db);
    };

    request.onerror = (event) => {
      dbInstancePromise = null;
      reject(new Error(`Gagal membuka IndexedDB: ${event.target.error?.message || 'Unknown error'}`));
    };
  });

  return dbInstancePromise;
}

/**
 * Menyimpan atau memperbarui metadata model di IndexedDB.
 * @param {Object} modelMeta
 * @returns {Promise<Object>}
 */
export async function saveModelMetadata(modelMeta) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MODELS], 'readwrite');
    const store = tx.objectStore(STORE_MODELS);

    const record = {
      id: modelMeta.id,
      name: modelMeta.name || 'Untitled.nwd',
      urn: modelMeta.urn || '',
      svfPath: normalizeSvfPath(modelMeta.svfPath || 'output/0/0.svf'),
      viewables: Array.isArray(modelMeta.viewables) ? modelMeta.viewables : [],
      fileCount: Number(modelMeta.fileCount || 0),
      totalSize: Number(modelMeta.totalSize || 0),
      createdAt: modelMeta.createdAt || new Date().toISOString(),
      source: modelMeta.source || 'cloud',
      isDemo: Boolean(modelMeta.isDemo),
      demoConfig: modelMeta.demoConfig || null
    };

    store.put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Menyimpan satu file asset SVF ke IndexedDB.
 * @param {string} modelId
 * @param {string} rawPath
 * @param {ArrayBuffer|Uint8Array} binaryData
 * @param {string} [mime]
 * @returns {Promise<void>}
 */
export async function saveModelFile(modelId, rawPath, binaryData, mime) {
  const db = await openDatabase();
  const normPath = normalizeSvfPath(rawPath);
  const buffer =
    binaryData instanceof ArrayBuffer
      ? binaryData
      : binaryData?.buffer
      ? binaryData.buffer.slice(binaryData.byteOffset, binaryData.byteOffset + binaryData.byteLength)
      : new ArrayBuffer(0);

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILES], 'readwrite');
    const store = tx.objectStore(STORE_FILES);
    store.put({
      key: `${modelId}/${normPath}`,
      modelId,
      path: normPath,
      data: buffer,
      mime: mime || inferMimeType(normPath),
      size: buffer.byteLength
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Menyimpan banyak file asset SVF sekaligus dalam satu transaksi IndexedDB.
 * @param {string} modelId
 * @param {Array<{path: string, data: ArrayBuffer, mime?: string}>} filesBatch
 * @returns {Promise<void>}
 */
export async function saveModelFilesBatch(modelId, filesBatch) {
  if (!filesBatch || filesBatch.length === 0) return;
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILES], 'readwrite');
    const store = tx.objectStore(STORE_FILES);

    for (const item of filesBatch) {
      const normPath = normalizeSvfPath(item.path);
      const buffer =
        item.data instanceof ArrayBuffer
          ? item.data
          : item.data?.buffer
          ? item.data.buffer.slice(item.data.byteOffset, item.data.byteOffset + item.data.byteLength)
          : new ArrayBuffer(0);

      store.put({
        key: `${modelId}/${normPath}`,
        modelId,
        path: normPath,
        data: buffer,
        mime: item.mime || inferMimeType(normPath),
        size: buffer.byteLength
      });
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Mengambil satu file SVF dari IndexedDB berdasarkan modelId dan path.
 * Memiliki mekanisme fallback pintar jika prefix 'output/' tidak cocok atau case-insensitive.
 * @param {string} modelId
 * @param {string} rawPath
 * @returns {Promise<{key: string, modelId: string, path: string, data: ArrayBuffer, mime: string, size: number}|null>}
 */
export async function getModelFile(modelId, rawPath) {
  const db = await openDatabase();
  const normPath = normalizeSvfPath(rawPath);
  const exactKey = `${modelId}/${normPath}`;

  // 1. Coba exact match terlebih dahulu
  const exactRecord = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILES], 'readonly');
    const store = tx.objectStore(STORE_FILES);
    const req = store.get(exactKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

  if (exactRecord) return exactRecord;

  // 2. Coba alternatif dengan atau tanpa prefix "output/"
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

  if (altRecord) return altRecord;

  // 3. Fallback case-insensitive atau suffix match pada modelId yang sama
  return new Promise((resolve, reject) => {
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
      const recPathLower = String(rec.path || '').toLowerCase();
      if (
        recPathLower === lowerTarget ||
        recPathLower.endsWith('/' + lowerTarget) ||
        lowerTarget.endsWith('/' + recPathLower)
      ) {
        resolve(rec);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Mengambil daftar semua model yang tersimpan di IndexedDB (diurutkan dari terbaru).
 * @returns {Promise<Array<Object>>}
 */
export async function listOfflineModels() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MODELS], 'readonly');
    const store = tx.objectStore(STORE_MODELS);
    const req = store.getAll();
    req.onsuccess = () => {
      const list = Array.isArray(req.result) ? req.result : [];
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Mengambil metadata satu model berdasarkan ID.
 * @param {string} modelId
 * @returns {Promise<Object|null>}
 */
export async function getModelMetadata(modelId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MODELS], 'readonly');
    const store = tx.objectStore(STORE_MODELS);
    const req = store.get(modelId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Mengambil seluruh file binary milik sebuah modelId.
 * @param {string} modelId
 * @returns {Promise<Array<{key: string, modelId: string, path: string, data: ArrayBuffer, mime: string, size: number}>>}
 */
export async function getAllFilesForModel(modelId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILES], 'readonly');
    const store = tx.objectStore(STORE_FILES);
    const index = store.index('by_modelId');
    const req = index.getAll(IDBKeyRange.only(modelId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Menghapus model beserta seluruh file SVF terkait dari IndexedDB.
 * @param {string} modelId
 * @returns {Promise<void>}
 */
export async function deleteOfflineModel(modelId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MODELS, STORE_FILES], 'readwrite');
    const modelStore = tx.objectStore(STORE_MODELS);
    const fileStore = tx.objectStore(STORE_FILES);
    const index = fileStore.index('by_modelId');

    modelStore.delete(modelId);

    const cursorReq = index.openKeyCursor(IDBKeyRange.only(modelId));
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        fileStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Menghitung penggunaan kuota penyimpanan IndexedDB browser.
 * @returns {Promise<{usageBytes: number, quotaBytes: number, modelCount: number}>}
 */
export async function getStorageQuotaInfo() {
  const models = await listOfflineModels();
  const totalModelBytes = models.reduce((acc, m) => acc + (Number(m.totalSize) || 0), 0);

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      return {
        usageBytes: estimate.usage || totalModelBytes,
        quotaBytes: estimate.quota || 0,
        modelCount: models.length
      };
    } catch {
      // Fallback jika estimate gagal
    }
  }

  return {
    usageBytes: totalModelBytes,
    quotaBytes: 0,
    modelCount: models.length
  };
}

/**
 * Meng-export model dari IndexedDB menjadi satu file paket `.nwdpack.zip`
 * menggunakan JSZip agar dapat dipindahkan via Flashdisk ke laptop offline.
 * @param {string} modelId
 * @param {(progress: {percent: number, message: string}) => void} [onProgress]
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function exportModelAsZip(modelId, onProgress) {
  if (!window.JSZip) {
    throw new Error('Library JSZip belum dimuat. Pastikan koneksi atau cache aplikasi aktif.');
  }

  const meta = await getModelMetadata(modelId);
  if (!meta) {
    throw new Error(`Model dengan ID "${modelId}" tidak ditemukan di IndexedDB.`);
  }

  const files = await getAllFilesForModel(modelId);
  if (files.length === 0 && !meta.isDemo) {
    throw new Error('Tidak ada file SVF yang tersimpan untuk model ini.');
  }

  const zip = new window.JSZip();

  // Simpan manifest metadata paket NWD Offline Viewer
  const packageManifest = {
    format: 'nwd-offline-package',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    model: {
      id: meta.id,
      name: meta.name,
      urn: meta.urn || '',
      svfPath: meta.svfPath,
      viewables: meta.viewables || [],
      fileCount: files.length,
      totalSize: meta.totalSize,
      createdAt: meta.createdAt,
      isDemo: Boolean(meta.isDemo),
      demoConfig: meta.demoConfig || null
    }
  };

  zip.file('nwdpack-manifest.json', JSON.stringify(packageManifest, null, 2));

  // Masukkan seluruh binary file SVF sesuai path relatifnya
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const cleanPath = normalizeSvfPath(f.path);
    // Karena sebagian besar file SVF (.pf, .pack, .gz, .svf) sudah terkompresi,
    // gunakan STORE untuk file .gz/.svf/.png/.jpg dan DEFLATE cepat untuk lainnya
    const isAlreadyCompressed = /\.(gz|svf|zip|png|jpg|jpeg|pf|pack)$/i.test(cleanPath);
    zip.file(cleanPath, f.data, {
      binary: true,
      compression: isAlreadyCompressed ? 'STORE' : 'DEFLATE',
      compressionOptions: { level: 3 }
    });
  }

  const blob = await zip.generateAsync(
    { type: 'blob', mimeType: 'application/zip' },
    (metadata) => {
      if (onProgress) {
        onProgress({
          percent: Math.round(metadata.percent),
          message: `Memaketkan ZIP: ${Math.round(metadata.percent)}% (${metadata.currentFile || 'memproses...'})`
        });
      }
    }
  );

  const safeBaseName = String(meta.name || 'model')
    .replace(/\.(nwd|nwc|rvt|ifc|zip)$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  return {
    blob,
    filename: `${safeBaseName}.nwdpack.zip`
  };
}

/**
 * Meng-import file `.nwdpack.zip` (atau `.zip` hasil ekstraksi SVF bubble standar)
 * langsung ke dalam IndexedDB secara 100% Offline.
 * @param {File|Blob} zipFile
 * @param {(progress: {percent: number, message: string}) => void} [onProgress]
 * @returns {Promise<Object>} Metadata model yang berhasil di-import
 */
export async function importModelFromZip(zipFile, onProgress) {
  if (!window.JSZip) {
    throw new Error('Library JSZip tidak ditemukan.');
  }

  if (onProgress) {
    onProgress({ percent: 5, message: 'Membaca struktur arsip .zip...' });
  }

  const zip = await window.JSZip.loadAsync(zipFile);
  let manifestData = null;

  // Cek apakah ada nwdpack-manifest.json
  const manifestEntry = zip.file('nwdpack-manifest.json');
  if (manifestEntry) {
    try {
      const text = await manifestEntry.async('string');
      manifestData = JSON.parse(text);
    } catch (err) {
      console.warn('Gagal mem-parsing nwdpack-manifest.json, melanjutkan auto-detect SVF:', err);
    }
  }

  const allEntries = [];
  const detectedSvfPaths = [];

  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return;
    const normPath = normalizeSvfPath(relativePath);
    if (!normPath || normPath === 'nwdpack-manifest.json') return;
    // Abaikan file metadata macOS
    if (normPath.startsWith('__MACOSX/') || normPath.endsWith('.DS_Store')) return;

    allEntries.push({ normPath, zipEntry });
    if (normPath.toLowerCase().endsWith('.svf')) {
      detectedSvfPaths.push(normPath);
    }
  });

  const isDemoModel = Boolean(manifestData?.model?.isDemo);

  if (allEntries.length === 0 && !isDemoModel) {
    throw new Error('File ZIP kosong atau tidak memiliki file model 3D.');
  }

  // Tentukan primary svfPath
  let primarySvfPath = manifestData?.model?.svfPath
    ? normalizeSvfPath(manifestData.model.svfPath)
    : '';

  if (!primarySvfPath && detectedSvfPaths.length > 0) {
    primarySvfPath = detectedSvfPaths[0];
  }

  if (!primarySvfPath && !isDemoModel) {
    throw new Error(
      'Tidak ditemukan file .svf di dalam arsip ZIP. Pastikan ZIP berasal dari Export NWD Offline Viewer atau ekstraksi SVF Bubble.'
    );
  }

  const modelId = `model_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const rawZipName = zipFile.name || 'Imported_Model.nwd';
  const cleanDisplayName =
    manifestData?.model?.name ||
    rawZipName.replace(/\.nwdpack\.zip$/i, '.nwd').replace(/\.zip$/i, '.nwd');

  let totalBytes = 0;
  const batchBuffer = [];
  const BATCH_SIZE = 25;

  for (let i = 0; i < allEntries.length; i++) {
    const { normPath, zipEntry } = allEntries[i];
    const arrayBuffer = await zipEntry.async('arraybuffer');
    totalBytes += arrayBuffer.byteLength;

    // Jika archive menyimpan di bawah folder 'files/', normalkan agar cocok dengan svfPath
    let targetPath = normPath;
    if (
      targetPath.startsWith('files/') &&
      primarySvfPath &&
      !primarySvfPath.startsWith('files/')
    ) {
      targetPath = normalizeSvfPath(targetPath.slice('files/'.length));
    }

    batchBuffer.push({
      path: targetPath,
      data: arrayBuffer,
      mime: inferMimeType(targetPath)
    });

    if (batchBuffer.length >= BATCH_SIZE || i === allEntries.length - 1) {
      await saveModelFilesBatch(modelId, batchBuffer);
      batchBuffer.length = 0;
    }

    if (onProgress) {
      const pct = Math.min(98, Math.round(((i + 1) / allEntries.length) * 90) + 8);
      onProgress({
        percent: pct,
        message: `Mengekstrak ke IndexedDB (${i + 1}/${allEntries.length}): ${targetPath}`
      });
    }
  }

  const viewables =
    manifestData?.model?.viewables?.length > 0
      ? manifestData.model.viewables
      : detectedSvfPaths.map((p, idx) => ({
          name: idx === 0 ? '3D Master View' : `3D View #${idx + 1}`,
          path: p,
          role: '3d'
        }));

  const savedMeta = await saveModelMetadata({
    id: modelId,
    name: cleanDisplayName,
    urn: manifestData?.model?.urn || '',
    svfPath: primarySvfPath || 'demo://industrial-plant',
    viewables,
    fileCount: allEntries.length,
    totalSize: totalBytes || manifestData?.model?.totalSize || 0,
    createdAt: new Date().toISOString(),
    source: isDemoModel ? 'demo' : 'zip',
    isDemo: isDemoModel,
    demoConfig: manifestData?.model?.demoConfig || null
  });

  if (onProgress) {
    onProgress({ percent: 100, message: 'Import paket offline selesai!' });
  }

  return savedMeta;
}

/**
 * Helper memformat ukuran byte menjadi KB / MB / GB yang mudah dibaca.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / Math.pow(1024, idx);
  return `${val.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}
