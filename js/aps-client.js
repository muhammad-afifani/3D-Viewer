/**
 * ============================================================================
 * js/aps-client.js — Autodesk Platform Services (APS / Forge) Cloud Client
 *                    & Recursive SVF Bubble Offline Downloader
 * ============================================================================
 * Menangani seluruh komunikasi langsung dari browser (Client-Side REST API):
 * 1. OAuth 2.0 (2-Legged Authentication v2)
 * 2. OSS Bucket Management & Direct-to-S3 Signed Multi-part Upload
 * 3. Model Derivative SVF Translation Job & Real-time Manifest Polling
 * 4. Recursive SVF Bubble Extractor (mem-parsing top-level manifest +
 *    membongkar 0.svf via JSZip untuk mengekstrak seluruh asset .pf, .pack,
 *    .bin, Materials.json.gz, textures, dan PropertyDB objects_*.json.gz
 *    langsung ke IndexedDB).
 */

import {
  normalizeSvfPath,
  resolveRelativeSvfPath,
  inferMimeType,
  saveModelMetadata,
  saveModelFilesBatch
} from './storage.js';

const APS_BASE_URL = 'https://developer.api.autodesk.com';
const STORAGE_CREDS_KEY = 'nwd_viewer_aps_credentials';

// Cache token di memori selama sesi aktif
let cachedAuth = {
  clientId: '',
  accessToken: '',
  expiresAt: 0
};

/**
 * Mengambil kredensial APS yang tersimpan di localStorage (jika ada).
 * @returns {{clientId: string, clientSecret: string, remember: boolean}}
 */
export function getSavedCredentials() {
  try {
    const raw = localStorage.getItem(STORAGE_CREDS_KEY);
    if (!raw) return { clientId: '', clientSecret: '', remember: true };
    const parsed = JSON.parse(raw);
    return {
      clientId: parsed.clientId || '',
      clientSecret: parsed.clientSecret || '',
      remember: parsed.remember !== false
    };
  } catch {
    return { clientId: '', clientSecret: '', remember: true };
  }
}

/**
 * Menyimpan atau menghapus kredensial APS di localStorage browser.
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {boolean} remember
 */
export function saveCredentials(clientId, clientSecret, remember = true) {
  cachedAuth = { clientId: '', accessToken: '', expiresAt: 0 };
  if (remember) {
    localStorage.setItem(
      STORAGE_CREDS_KEY,
      JSON.stringify({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        remember: true
      })
    );
  } else {
    localStorage.removeItem(STORAGE_CREDS_KEY);
  }
}

/**
 * Mengonversi Object ID OSS menjadi URL-safe Base64 URN (tanpa padding '=').
 * @param {string} objectId
 * @returns {string}
 */
export function toBase64Urn(objectId) {
  const utf8Bytes = new TextEncoder().encode(objectId);
  let binary = '';
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 1. Autentikasi 2-Legged OAuth2 ke Autodesk Platform Services (APS v2).
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
export async function authenticateAPS(clientId, clientSecret, forceRefresh = false) {
  const cleanId = (clientId || '').trim();
  const cleanSecret = (clientSecret || '').trim();

  if (!cleanId || !cleanSecret) {
    throw new Error('APS Client ID dan Client Secret wajib diisi pada menu Settings.');
  }

  const now = Date.now();
  if (
    !forceRefresh &&
    cachedAuth.accessToken &&
    cachedAuth.clientId === cleanId &&
    cachedAuth.expiresAt > now + 60_000
  ) {
    return {
      access_token: cachedAuth.accessToken,
      expires_in: Math.round((cachedAuth.expiresAt - now) / 1000)
    };
  }

  const scope = 'data:read data:write data:create bucket:create bucket:read viewables:read';
  const basicCredentials = btoa(`${cleanId}:${cleanSecret}`);

  let response = await fetch(`${APS_BASE_URL}/authentication/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${basicCredentials}`
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope
    }).toString()
  });

  // Fallback apabila environment memerlukan client_id & client_secret di form body
  if (!response.ok && response.status === 400) {
    response = await fetch(`${APS_BASE_URL}/authentication/v2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        client_id: cleanId,
        client_secret: cleanSecret,
        grant_type: 'client_credentials',
        scope
      }).toString()
    });
  }

  if (!response.ok) {
    let errDetail = '';
    try {
      const errJson = await response.json();
      errDetail = errJson.developerMessage || errJson.error_description || errJson.error || '';
    } catch {
      errDetail = await response.text();
    }
    throw new Error(
      `Autentikasi APS gagal (HTTP ${response.status}): ${errDetail || 'Periksa kembali Client ID & Client Secret Anda.'}`
    );
  }

  const data = await response.json();
  cachedAuth = {
    clientId: cleanId,
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3599) * 1000
  };

  return data;
}

/**
 * 2. Memastikan OSS Bucket tersedia (membuat bucket baru jika belum ada).
 * @param {string} accessToken
 * @param {string} clientId
 * @returns {Promise<string>} bucketKey
 */
export async function ensureBucketExists(accessToken, clientId) {
  const sanitizedId = clientId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 22);
  const bucketKey = `nwd_offline_${sanitizedId}_bucket`;

  // Cek apakah bucket sudah ada
  const checkResp = await fetch(
    `${APS_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/details`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (checkResp.ok) {
    return bucketKey;
  }

  if (checkResp.status !== 404) {
    const errText = await checkResp.text();
    throw new Error(`Gagal memeriksa OSS Bucket (${checkResp.status}): ${errText}`);
  }

  // Buat bucket baru dengan policy 'transient' (otomatis bersih setelah 24 jam di cloud)
  const createResp = await fetch(`${APS_BASE_URL}/oss/v2/buckets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-ads-region': 'US'
    },
    body: JSON.stringify({
      bucketKey,
      policyKey: 'transient'
    })
  });

  if (!createResp.ok && createResp.status !== 409) {
    const errText = await createResp.text();
    throw new Error(`Gagal membuat OSS Bucket (${createResp.status}): ${errText}`);
  }

  return bucketKey;
}

/**
 * Helper mengunggah satu chunk binary ke Signed S3 URL menggunakan XMLHttpRequest
 * agar mendapatkan progress byte-level secara akurat.
 * @param {string} signedUrl
 * @param {Blob} chunkBlob
 * @param {(loadedBytes: number) => void} onChunkProgress
 * @returns {Promise<void>}
 */
function uploadChunkToSignedS3Url(signedUrl, chunkBlob, onChunkProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl, true);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onChunkProgress) {
        onChunkProgress(event.loaded);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload chunk ke S3 gagal dengan status HTTP ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error saat mengunggah chunk ke S3.'));
    xhr.onabort = () => reject(new Error('Upload dibatalkan.'));
    xhr.send(chunkBlob);
  });
}

/**
 * 3. Mengunggah file .nwd ke OSS Bucket menggunakan Direct-to-S3 Signed Upload
 * (mendukung file besar dengan multi-part chunking).
 * @param {string} accessToken
 * @param {string} bucketKey
 * @param {File} file
 * @param {(progress: {percent: number, message: string}) => void} [onProgress]
 * @returns {Promise<{objectId: string, urn: string, objectKey: string}>}
 */
export async function uploadFileToOSS(accessToken, bucketKey, file, onProgress) {
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectKey = `${Date.now()}_${safeFileName}`;
  const encodedBucket = encodeURIComponent(bucketKey);
  const encodedObject = encodeURIComponent(objectKey);

  // Ukuran chunk 5 MB (batas minimum S3 multi-part adalah 5 MB kecuali part terakhir)
  const CHUNK_SIZE = 5 * 1024 * 1024;
  const totalParts = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const MAX_URLS_PER_BATCH = 25;

  let uploadKey = null;
  let uploadedBytesCompleted = 0;

  let currentPart = 1;
  while (currentPart <= totalParts) {
    const partsInBatch = Math.min(MAX_URLS_PER_BATCH, totalParts - currentPart + 1);
    const query = new URLSearchParams({
      parts: String(partsInBatch),
      firstPart: String(currentPart),
      minutesExpiration: '60'
    });
    if (uploadKey) {
      query.set('uploadKey', uploadKey);
    }

    const signedResp = await fetch(
      `${APS_BASE_URL}/oss/v2/buckets/${encodedBucket}/objects/${encodedObject}/signeds3upload?${query.toString()}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!signedResp.ok) {
      const errText = await signedResp.text();
      throw new Error(`Gagal meminta Signed S3 URL (${signedResp.status}): ${errText}`);
    }

    const signedData = await signedResp.json();
    uploadKey = signedData.uploadKey;
    const urls = signedData.urls || [];

    for (let i = 0; i < urls.length; i++) {
      const partNumber = currentPart + i;
      const startByte = (partNumber - 1) * CHUNK_SIZE;
      const endByte = Math.min(startByte + CHUNK_SIZE, file.size);
      const chunkBlob = file.slice(startByte, endByte);

      await uploadChunkToSignedS3Url(urls[i], chunkBlob, (chunkLoaded) => {
        if (onProgress) {
          const totalLoaded = uploadedBytesCompleted + chunkLoaded;
          const pct = Math.min(99, Math.round((totalLoaded / Math.max(1, file.size)) * 100));
          onProgress({
            percent: pct,
            message: `Mengunggah ke OSS S3 (Part ${partNumber}/${totalParts}) — ${pct}%`
          });
        }
      });

      uploadedBytesCompleted += chunkBlob.size;
    }

    currentPart += partsInBatch;
  }

  // Finalisasi Signed S3 Upload
  if (onProgress) {
    onProgress({ percent: 99, message: 'Memfinalisasi objek di Autodesk OSS...' });
  }

  const completeResp = await fetch(
    `${APS_BASE_URL}/oss/v2/buckets/${encodedBucket}/objects/${encodedObject}/signeds3upload`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uploadKey })
    }
  );

  if (!completeResp.ok) {
    const errText = await completeResp.text();
    throw new Error(`Gagal memfinalisasi upload S3 (${completeResp.status}): ${errText}`);
  }

  const completeData = await completeResp.json();
  const objectId = completeData.objectId;
  const urn = toBase64Urn(objectId);

  if (onProgress) {
    onProgress({ percent: 100, message: 'Upload file .nwd ke OSS selesai.' });
  }

  return { objectId, urn, objectKey };
}

/**
 * 4. Menjalankan Model Derivative Job untuk menerjemahkan .nwd ke format .svf.
 * @param {string} accessToken
 * @param {string} urn - Base64 URN (tanpa prefix "urn:")
 * @returns {Promise<Object>}
 */
export async function startSvfTranslationJob(accessToken, urn) {
  const response = await fetch(`${APS_BASE_URL}/modelderivative/v2/designdata/job`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-ads-force': 'true'
    },
    body: JSON.stringify({
      input: {
        urn
      },
      output: {
        destination: {
          region: 'us'
        },
        formats: [
          {
            type: 'svf',
            views: ['3d', '2d']
          }
        ]
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gagal memulai Model Derivative Job (${response.status}): ${errText}`);
  }

  return response.json();
}

/**
 * 5. Melakukan polling status translasi Model Derivative hingga 100% ('success').
 * @param {string} accessToken
 * @param {string} urn
 * @param {(progress: {percent: number, status: string, message: string}) => void} [onProgress]
 * @returns {Promise<Object>} Manifest JSON yang telah selesai
 */
export async function pollTranslationManifest(accessToken, urn, onProgress) {
  const encodedUrn = encodeURIComponent(urn);
  const maxAttempts = 600; // Maksimum ~30 menit untuk file NWD raksasa

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(
      `${APS_BASE_URL}/modelderivative/v2/designdata/${encodedUrn}/manifest`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (response.status === 202 || response.ok) {
      const manifest = await response.json();
      const status = manifest.status || 'inprogress';
      const rawProgress = String(manifest.progress || '0%');
      const numericMatch = rawProgress.match(/(\d+)/);
      const percent = status === 'success' ? 100 : numericMatch ? Number(numericMatch[1]) : 10;

      if (onProgress) {
        onProgress({
          percent,
          status,
          message: `Translasi Cloud NWD -> SVF: ${status.toUpperCase()} (${rawProgress})`
        });
      }

      if (status === 'success') {
        return manifest;
      }

      if (status === 'failed' || status === 'timeout') {
        throw new Error(
          `Translasi Model Derivative gagal dengan status "${status}". Pastikan file .nwd tidak korup atau terproteksi password.`
        );
      }
    } else if (response.status !== 404) {
      const errText = await response.text();
      throw new Error(`Gagal memeriksa manifest translasi (${response.status}): ${errText}`);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  throw new Error('Waktu tunggu translasi Model Derivative habis (timeout).');
}

/**
 * Helper mendekompresi ArrayBuffer GZIP jika memiliki magic header 0x1f 0x8b
 * menggunakan native DecompressionStream browser.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<ArrayBuffer>}
 */
async function gunzipIfCompressed(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      return new Response(ds.readable).arrayBuffer();
    }
  }
  return buffer;
}

/**
 * Mengunduh satu resource derivative dari APS Model Derivative API dengan retry otomatis.
 * @param {string} accessToken
 * @param {string} baseUrn
 * @param {string} derivativeUrn
 * @param {number} [retries=2]
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchDerivativeBinary(accessToken, baseUrn, derivativeUrn, retries = 2) {
  const url = `${APS_BASE_URL}/modelderivative/v2/designdata/${encodeURIComponent(
    baseUrn
  )}/manifest/${encodeURIComponent(derivativeUrn)}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (resp.ok) {
        return await resp.arrayBuffer();
      }

      if (resp.status === 404) {
        throw new Error(`HTTP 404 Not Found: ${derivativeUrn}`);
      }

      if (attempt === retries) {
        throw new Error(`HTTP ${resp.status} saat mengunduh ${derivativeUrn}`);
      }
    } catch (err) {
      if (attempt === retries || String(err.message).includes('404')) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new Error(`Gagal mengunduh ${derivativeUrn}`);
}

/**
 * Mengekstrak base prefix `urn:adsk.viewing:fs.file:{urn}/` dan path relatifnya.
 * @param {string} derivativeUrn
 * @param {string} fallbackBaseUrn
 * @returns {{fsPrefix: string, relativePath: string}}
 */
function parseDerivativeUrn(derivativeUrn, fallbackBaseUrn) {
  const match = String(derivativeUrn).match(/^(urn:adsk\.viewing:fs\.file:[^/]+)\/(.+)$/i);
  if (match) {
    return {
      fsPrefix: match[1],
      relativePath: normalizeSvfPath(match[2])
    };
  }
  return {
    fsPrefix: `urn:adsk.viewing:fs.file:${fallbackBaseUrn}`,
    relativePath: normalizeSvfPath(derivativeUrn)
  };
}

/**
 * 6. SVF BUBBLE RECURSIVE DOWNLOADER:
 * Mem-parsing manifest derivatif utama, mengunduh file .svf utama, membongkar
 * manifest.json di dalam .svf (menggunakan JSZip) untuk menemukan seluruh
 * asset dependen (.pf, .pack, .bin, Materials.json.gz, textures, dan PropertyDB
 * objects_attrs.json.gz, objects_vals.json.gz, objects_avs.json.gz,
 * objects_offs.json.gz, objects_ids.json.gz), lalu menyimpan semuanya ke IndexedDB!
 *
 * @param {Object} params
 * @param {string} params.accessToken
 * @param {string} params.urn
 * @param {Object} params.manifest
 * @param {string} params.fileName
 * @param {(progress: {percent: number, message: string, downloadedCount: number, totalCount: number}) => void} [params.onProgress]
 * @returns {Promise<Object>} Metadata model yang telah tersimpan di IndexedDB
 */
export async function downloadSvfBubbleToIndexedDB({
  accessToken,
  urn,
  manifest,
  fileName,
  onProgress
}) {
  const modelId = `model_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Map antrian download: relativePath -> { derivativeUrn, relativePath, optional: boolean }
  const downloadQueueMap = new Map();
  const svfItems = [];
  const f2dItems = [];
  const viewables = [];

  let detectedFsPrefix = `urn:adsk.viewing:fs.file:${urn}`;

  // Fungsi rekursif menelusuri pohon manifest Model Derivative
  function traverseManifestNodes(node, parentName = '') {
    if (!node || typeof node !== 'object') return;

    const currentName = node.name || parentName || '3D View';

    if (typeof node.urn === 'string' && node.urn.startsWith('urn:adsk.viewing:fs.file:')) {
      const { fsPrefix, relativePath } = parseDerivativeUrn(node.urn, urn);
      detectedFsPrefix = fsPrefix;
      const mime = String(node.mime || '').toLowerCase();

      if (mime === 'application/autodesk-svf' || relativePath.toLowerCase().endsWith('.svf')) {
        svfItems.push({
          derivativeUrn: node.urn,
          relativePath,
          name: currentName
        });
        viewables.push({
          name: currentName,
          path: relativePath,
          role: '3d'
        });
      } else if (
        mime === 'application/autodesk-f2d' ||
        relativePath.toLowerCase().endsWith('.f2d')
      ) {
        f2dItems.push({
          derivativeUrn: node.urn,
          relativePath,
          name: currentName
        });
      } else if (
        mime === 'application/autodesk-db' ||
        node.role === 'Autodesk.CloudPlatform.PropertyDatabase'
      ) {
        // Property Database: tambahkan 5 file JSON.gz standar yang dibutuhkan GuiViewer3D di browser
        const propDbFiles = [
          'objects_attrs.json.gz',
          'objects_vals.json.gz',
          'objects_avs.json.gz',
          'objects_offs.json.gz',
          'objects_ids.json.gz'
        ];
        for (const pf of propDbFiles) {
          const resolvedPropPath = resolveRelativeSvfPath(relativePath, pf, true);
          downloadQueueMap.set(resolvedPropPath, {
            derivativeUrn: `${fsPrefix}/${resolvedPropPath}`,
            relativePath: resolvedPropPath,
            optional: false
          });
        }
      } else {
        downloadQueueMap.set(relativePath, {
          derivativeUrn: node.urn,
          relativePath,
          optional: true
        });
      }
    }

    if (Array.isArray(node.derivatives)) {
      for (const child of node.derivatives) {
        traverseManifestNodes(child, currentName);
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        traverseManifestNodes(child, currentName);
      }
    }
  }

  traverseManifestNodes(manifest);

  if (svfItems.length === 0) {
    throw new Error(
      'Tidak ditemukan viewable 3D (.svf) di dalam manifest Model Derivative untuk file ini.'
    );
  }

  let totalBytesSaved = 0;
  let totalFilesSaved = 0;

  // Simpan top-level manifest.json terlebih dahulu
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2)).buffer;
  await saveModelFilesBatch(modelId, [
    {
      path: 'manifest.json',
      data: manifestBytes,
      mime: 'application/json'
    }
  ]);
  totalBytesSaved += manifestBytes.byteLength;
  totalFilesSaved += 1;

  // Tahap A: Unduh seluruh file .svf utama dan bongkar manifest.json internal di dalamnya
  for (let i = 0; i < svfItems.length; i++) {
    const svfItem = svfItems[i];
    if (onProgress) {
      onProgress({
        percent: 5,
        message: `Mengunduh & menganalisis struktur bubble ${svfItem.relativePath}...`,
        downloadedCount: totalFilesSaved,
        totalCount: svfItems.length + downloadQueueMap.size
      });
    }

    const svfBuffer = await fetchDerivativeBinary(accessToken, urn, svfItem.derivativeUrn);
    await saveModelFilesBatch(modelId, [
      {
        path: svfItem.relativePath,
        data: svfBuffer,
        mime: 'application/octet-stream'
      }
    ]);
    totalBytesSaved += svfBuffer.byteLength;
    totalFilesSaved += 1;

    // Ekstrak manifest.json di dalam file .svf (yang sebenarnya adalah arsip ZIP)
    try {
      const unzippedSvfBuf = await gunzipIfCompressed(svfBuffer);
      const svfZip = await window.JSZip.loadAsync(unzippedSvfBuf);
      const internalManifestEntry = svfZip.file('manifest.json');

      if (internalManifestEntry) {
        const internalManifestText = await internalManifestEntry.async('string');
        const internalManifest = JSON.parse(internalManifestText);
        const assets = Array.isArray(internalManifest.assets) ? internalManifest.assets : [];

        for (const asset of assets) {
          const uri = asset?.URI;
          if (!uri || typeof uri !== 'string') continue;
          // Abaikan asset yang sudah ter-embed di dalam .svf zip
          if (uri.startsWith('embed:') || uri.startsWith(' local:')) continue;

          const resolvedAssetPath = resolveRelativeSvfPath(svfItem.relativePath, uri, true);
          if (!resolvedAssetPath) continue;

          if (!downloadQueueMap.has(resolvedAssetPath)) {
            downloadQueueMap.set(resolvedAssetPath, {
              derivativeUrn: `${detectedFsPrefix}/${resolvedAssetPath}`,
              relativePath: resolvedAssetPath,
              optional: false
            });
          }
        }
      }
    } catch (zipErr) {
      console.warn(`Gagal mem-parsing manifest internal SVF (${svfItem.relativePath}):`, zipErr);
    }
  }

  // Tahap B: Jika terdapat 2D F2D viewables, periksa manifest.json.gz-nya secara opsional
  for (const f2dItem of f2dItems) {
    try {
      const f2dManifestPath = resolveRelativeSvfPath(
        f2dItem.relativePath,
        'manifest.json.gz',
        true
      );
      const f2dManifestUrn = `${detectedFsPrefix}/${f2dManifestPath}`;
      const f2dManifestBuf = await fetchDerivativeBinary(accessToken, urn, f2dManifestUrn, 1);

      await saveModelFilesBatch(modelId, [
        {
          path: f2dManifestPath,
          data: f2dManifestBuf,
          mime: 'application/octet-stream'
        }
      ]);
      totalBytesSaved += f2dManifestBuf.byteLength;
      totalFilesSaved += 1;

      const decompressedF2d = await gunzipIfCompressed(f2dManifestBuf);
      const f2dJson = JSON.parse(new TextDecoder().decode(decompressedF2d));
      const f2dAssets = Array.isArray(f2dJson.assets) ? f2dJson.assets : [];
      for (const asset of f2dAssets) {
        if (!asset?.URI || asset.URI.startsWith('embed:')) continue;
        const resolvedPath = resolveRelativeSvfPath(f2dItem.relativePath, asset.URI, true);
        if (resolvedPath && !downloadQueueMap.has(resolvedPath)) {
          downloadQueueMap.set(resolvedPath, {
            derivativeUrn: `${detectedFsPrefix}/${resolvedPath}`,
            relativePath: resolvedPath,
            optional: true
          });
        }
      }
    } catch {
      // 2D sheet bersifat opsional jika fokus utama adalah 3D NWD
    }
  }

  // Tahap C: Unduh seluruh asset dependen (.pf, .pack, .bin, Materials.json.gz, PropertyDB .gz, textures)
  // secara paralel terkontrol (concurrency pool = 6) dan simpan ke IndexedDB
  const queueArray = Array.from(downloadQueueMap.values());
  const totalAssetsToDownload = queueArray.length;
  let completedAssets = 0;

  const CONCURRENCY = 6;
  const BATCH_SAVE_LIMIT = 12;
  let pendingBatch = [];

  async function flushPendingBatch() {
    if (pendingBatch.length === 0) return;
    const toSave = pendingBatch.slice();
    pendingBatch = [];
    await saveModelFilesBatch(modelId, toSave);
  }

  let cursorIndex = 0;

  async function workerTask() {
    while (cursorIndex < totalAssetsToDownload) {
      const currentIdx = cursorIndex++;
      const item = queueArray[currentIdx];

      try {
        const binary = await fetchDerivativeBinary(
          accessToken,
          urn,
          item.derivativeUrn,
          item.optional ? 1 : 2
        );

        totalBytesSaved += binary.byteLength;
        totalFilesSaved += 1;

        pendingBatch.push({
          path: item.relativePath,
          data: binary,
          mime: inferMimeType(item.relativePath)
        });

        if (pendingBatch.length >= BATCH_SAVE_LIMIT) {
          await flushPendingBatch();
        }
      } catch (err) {
        if (!item.optional) {
          console.warn(`Asset tidak ditemukan / dilewati (${item.relativePath}):`, err.message);
        }
      } finally {
        completedAssets += 1;
        if (onProgress) {
          const pct = Math.min(
            99,
            Math.round((completedAssets / Math.max(1, totalAssetsToDownload)) * 90) + 8
          );
          onProgress({
            percent: pct,
            message: `Mengunduh asset SVF (${completedAssets}/${totalAssetsToDownload}): ${item.relativePath}`,
            downloadedCount: totalFilesSaved,
            totalCount: totalAssetsToDownload + svfItems.length
          });
        }
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, Math.max(1, totalAssetsToDownload)); w++) {
    workers.push(workerTask());
  }
  await Promise.all(workers);
  await flushPendingBatch();

  // Simpan metadata final ke IndexedDB
  const primarySvfPath = svfItems[0].relativePath;
  const savedModelMeta = await saveModelMetadata({
    id: modelId,
    name: fileName,
    urn,
    svfPath: primarySvfPath,
    viewables,
    fileCount: totalFilesSaved,
    totalSize: totalBytesSaved,
    createdAt: new Date().toISOString(),
    source: 'cloud',
    isDemo: false
  });

  if (onProgress) {
    onProgress({
      percent: 100,
      message: `Berhasil menyimpan ${totalFilesSaved} file SVF ke IndexedDB untuk mode 100% Offline!`,
      downloadedCount: totalFilesSaved,
      totalCount: totalFilesSaved
    });
  }

  return savedModelMeta;
}
