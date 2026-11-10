/**
 * ============================================================================
 * js/app.js — Main Application Controller & UI Orchestrator
 * ============================================================================
 * Mengintegrasikan:
 * - Service Worker Registration & Pre-caching Autodesk Viewer SDK
 * - APS Credentials Manager (Settings Modal & Test Connection)
 * - NWD Cloud Translator & Recursive SVF Bubble Downloader Pipeline
 * - Offline Model Library (IndexedDB) & .nwdpack.zip Import/Export
 * - Custom CAD Toolbar (Search + Isolate, Walk Mode, Explode, Theme, Viewpoints)
 */

import {
  listOfflineModels,
  deleteOfflineModel,
  exportModelAsZip,
  importModelFromZip,
  importDirectLocal3DFile,
  saveModelMetadata,
  getStorageQuotaInfo,
  formatBytes
} from './storage.js';

import { getFreeAutodeskViewerExtractorScript } from './local-loaders.js';

import {
  getSavedCredentials,
  saveCredentials,
  authenticateAPS,
  ensureBucketExists,
  uploadFileToOSS,
  startSvfTranslationJob,
  pollTranslationManifest,
  downloadSvfBubbleToIndexedDB
} from './aps-client.js';

import {
  loadOfflineModel,
  loadCloudModelByUrn,
  searchObjectsInModel,
  isolateAndFocusDbIds,
  fitToView,
  isolateSelected,
  hideSelected,
  showAllObjects,
  toggleGhosting,
  toggleFirstPersonWalk,
  setExplodeScale,
  toggleCameraProjection,
  applyViewerTheme,
  getSavedViewpoints,
  saveCurrentViewpoint,
  restoreSavedViewpoint,
  deleteSavedViewpoint
} from './viewer.js';

// State Global Aplikasi
const appState = {
  activeModel: null,
  sessionClientId: '',
  sessionClientSecret: '',
  searchMatches: [],
  searchCursor: -1,
  deferredInstallPrompt: null,
  isBusy: false
};

// Referensi Elemen DOM
const dom = {};

function cacheDomElements() {
  // Header & Status
  dom.btnToggleSidebar = document.getElementById('btnToggleSidebar');
  dom.sidebar = document.getElementById('appSidebar');
  dom.networkStatusPill = document.getElementById('networkStatusPill');
  dom.networkStatusText = document.getElementById('networkStatusText');
  dom.swStatusPill = document.getElementById('swStatusPill');
  dom.swStatusText = document.getElementById('swStatusText');
  dom.apsStatusPill = document.getElementById('apsStatusPill');
  dom.apsStatusText = document.getElementById('apsStatusText');
  dom.btnInstallPwa = document.getElementById('btnInstallPwa');
  dom.btnCacheEngine = document.getElementById('btnCacheEngine');
  dom.btnOpenSettings = document.getElementById('btnOpenSettings');
  dom.btnOpenHelp = document.getElementById('btnOpenHelp');

  // Sidebar Tabs
  dom.tabButtons = document.querySelectorAll('.sidebar-tab');
  dom.tabPanes = document.querySelectorAll('.tab-pane');
  dom.badgeModelCount = document.getElementById('badgeModelCount');
  dom.badgeViewpointCount = document.getElementById('badgeViewpointCount');

  // Tab 1: Offline Library & ZIP/Local 3D Importer
  dom.dropzoneZip = document.getElementById('dropzoneZip');
  dom.inputZipFile = document.getElementById('inputZipFile');
  dom.zipProgressBox = document.getElementById('zipProgressBox');
  dom.zipProgressText = document.getElementById('zipProgressText');
  dom.zipProgressFill = document.getElementById('zipProgressFill');
  dom.offlineModelList = document.getElementById('offlineModelList');
  dom.btnCreateDemoModel = document.getElementById('btnCreateDemoModel');
  dom.storageQuotaLabel = document.getElementById('storageQuotaLabel');

  // Tab 2: Free NWD Extractor & Cloud NWD Converter (APS)
  dom.btnCopyFreeExtractor = document.getElementById('btnCopyFreeExtractor');
  dom.bookmarkletFreeExtractor = document.getElementById('bookmarkletFreeExtractor');
  dom.dropzoneNwd = document.getElementById('dropzoneNwd');
  dom.inputNwdFile = document.getElementById('inputNwdFile');
  dom.pipelineCard = document.getElementById('pipelineCard');
  dom.pipelineFilename = document.getElementById('pipelineFilename');
  dom.pipelinePercent = document.getElementById('pipelinePercent');
  dom.pipelineProgressFill = document.getElementById('pipelineProgressFill');
  dom.step1 = document.getElementById('pipelineStep1');
  dom.step2 = document.getElementById('pipelineStep2');
  dom.step3 = document.getElementById('pipelineStep3');
  dom.step4 = document.getElementById('pipelineStep4');
  dom.pipelineLog = document.getElementById('pipelineLog');
  dom.inputCloudUrn = document.getElementById('inputCloudUrn');
  dom.btnDownloadUrnOffline = document.getElementById('btnDownloadUrnOffline');
  dom.btnOpenUrnCloud = document.getElementById('btnOpenUrnCloud');

  // Tab 3: Saved Viewpoints & BIM Selection Inspector
  dom.inputViewpointName = document.getElementById('inputViewpointName');
  dom.btnAddViewpointSidebar = document.getElementById('btnAddViewpointSidebar');
  dom.viewpointsList = document.getElementById('viewpointsList');
  dom.selectionInspectorBox = document.getElementById('selectionInspectorBox');

  // CAD Top Toolbar
  dom.inputSearchModel = document.getElementById('inputSearchModel');
  dom.btnSearchModel = document.getElementById('btnSearchModel');
  dom.searchMatchCount = document.getElementById('searchMatchCount');
  dom.btnSearchPrev = document.getElementById('btnSearchPrev');
  dom.btnSearchNext = document.getElementById('btnSearchNext');
  dom.btnFitView = document.getElementById('btnFitView');
  dom.btnIsolate = document.getElementById('btnIsolate');
  dom.btnHide = document.getElementById('btnHide');
  dom.btnShowAll = document.getElementById('btnShowAll');
  dom.btnGhosting = document.getElementById('btnGhosting');
  dom.btnWalkMode = document.getElementById('btnWalkMode');
  dom.btnProjection = document.getElementById('btnProjection');
  dom.rangeExplode = document.getElementById('rangeExplode');
  dom.explodeValueLabel = document.getElementById('explodeValueLabel');
  dom.selectTheme = document.getElementById('selectTheme');
  dom.btnQuickSaveViewpoint = document.getElementById('btnQuickSaveViewpoint');

  // 3D Stage & Overlays
  dom.forgeViewer = document.getElementById('forgeViewer');
  dom.viewerEmptyOverlay = document.getElementById('viewerEmptyOverlay');
  dom.btnEmptyImportZip = document.getElementById('btnEmptyImportZip');
  dom.btnEmptyConvertNwd = document.getElementById('btnEmptyConvertNwd');
  dom.btnEmptyLoadDemo = document.getElementById('btnEmptyLoadDemo');
  dom.walkHudBanner = document.getElementById('walkHudBanner');
  dom.btnExitWalkHud = document.getElementById('btnExitWalkHud');

  // Bottom Status Bar
  dom.statusActiveModel = document.getElementById('statusActiveModel');
  dom.statusRenderMode = document.getElementById('statusRenderMode');
  dom.statusSelectedElement = document.getElementById('statusSelectedElement');
  dom.statusStorageInfo = document.getElementById('statusStorageInfo');

  // Settings Modal
  dom.modalSettings = document.getElementById('modalSettings');
  dom.btnCloseSettings = document.getElementById('btnCloseSettings');
  dom.inputApsClientId = document.getElementById('inputApsClientId');
  dom.inputApsClientSecret = document.getElementById('inputApsClientSecret');
  dom.chkRememberAps = document.getElementById('chkRememberAps');
  dom.apsConnectionResult = document.getElementById('apsConnectionResult');
  dom.btnTestAps = document.getElementById('btnTestAps');
  dom.btnSaveAps = document.getElementById('btnSaveAps');

  // Help Modal
  dom.modalHelp = document.getElementById('modalHelp');
  dom.btnCloseHelp = document.getElementById('btnCloseHelp');
  dom.btnCloseHelpFooter = document.getElementById('btnCloseHelpFooter');

  // Toast Container
  dom.toastContainer = document.getElementById('toastContainer');
}

/**
 * Menampilkan notifikasi Toast di pojok kanan bawah.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 * @param {number} [durationMs=4200]
 */
export function showToast(message, type = 'info', durationMs = 4200) {
  if (!dom.toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <button class="btn btn-icon btn-sm" style="height:20px;width:20px;border:none;background:transparent;" aria-label="Close">&times;</button>
  `;

  const closeBtn = toast.querySelector('button');
  closeBtn.addEventListener('click', () => toast.remove());
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, durationMs);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Pindah tab pada sidebar kiri.
 * @param {string} targetTabId
 */
function switchSidebarTab(targetTabId) {
  dom.tabButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === targetTabId);
  });
  dom.tabPanes.forEach((pane) => {
    pane.classList.toggle('active', pane.id === targetTabId);
  });
  if (dom.sidebar.classList.contains('collapsed')) {
    dom.sidebar.classList.remove('collapsed');
  }
}

/**
 * Memperbarui indikator status koneksi internet (Online vs 100% Offline).
 */
function updateNetworkStatusUI() {
  const isOnline = navigator.onLine;
  dom.networkStatusPill.classList.toggle('online', isOnline);
  dom.networkStatusPill.classList.toggle('offline', !isOnline);
  dom.networkStatusText.textContent = isOnline ? 'ONLINE (Cloud + Local)' : '100% OFFLINE MODE';
}

/**
 * Memperbarui indikator kredensial APS di Header.
 */
function updateApsStatusUI() {
  const creds = getActiveApsCredentials();
  const hasCreds = Boolean(creds.clientId && creds.clientSecret);
  dom.apsStatusPill.classList.toggle('aps-ready', hasCreds);
  dom.apsStatusText.textContent = hasCreds ? 'APS Key: Siap' : 'APS Key: Belum Diatur';
}

function getActiveApsCredentials() {
  if (appState.sessionClientId && appState.sessionClientSecret) {
    return {
      clientId: appState.sessionClientId,
      clientSecret: appState.sessionClientSecret
    };
  }
  return getSavedCredentials();
}

/**
 * Mendaftarkan Service Worker (`./sw.js`) untuk Virtual SVF Server & Offline Caching.
 */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    dom.swStatusText.textContent = 'SW: Tidak Didukung';
    return;
  }

  try {
    let refreshing = false;
    const hadController = Boolean(navigator.serviceWorker.controller);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });

    const registration = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
      updateViaCache: 'none'
    });

    if (navigator.onLine) {
      registration.update().catch(() => {});
    }

    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'PRECACHE_VIEWER_SDK_DONE') {
        dom.swStatusPill.classList.add('sw-ready');
        dom.swStatusText.textContent = `SW Virtual Server & SDK Cached (${data.cachedCount}/${data.totalCount})`;
        showToast(
          `Engine 3D Autodesk Viewer berhasil di-cache (${data.cachedCount} modul) untuk penggunaan 100% Offline.`,
          'success'
        );
      }
    });

    await navigator.serviceWorker.ready;
    dom.swStatusPill.classList.add('sw-ready');
    dom.swStatusText.textContent = 'SW Virtual Server: Aktif';

    // Jika sedang online, instruksikan Service Worker untuk memastikan SDK Viewer ter-cache
    if (navigator.onLine && registration.active) {
      registration.active.postMessage({ type: 'PRECACHE_VIEWER_SDK' });
    }
  } catch (err) {
    console.warn('Gagal mendaftarkan Service Worker:', err);
    dom.swStatusText.textContent = 'SW: Error';
  }
}

/**
 * Memuat dan me-render daftar model yang tersimpan di IndexedDB pada Sidebar.
 */
async function refreshOfflineLibraryUI() {
  const models = await listOfflineModels();
  dom.badgeModelCount.textContent = String(models.length);

  const quota = await getStorageQuotaInfo();
  const usageStr = formatBytes(quota.usageBytes);
  dom.storageQuotaLabel.textContent = `${models.length} Model • ${usageStr} Terpakai`;
  dom.statusStorageInfo.innerHTML = `IndexedDB: <strong>${usageStr}</strong> (${models.length} model)`;

  if (models.length === 0) {
    dom.offlineModelList.innerHTML = `
      <div class="empty-list-state">
        Belum ada model <strong>.nwd / .svf</strong> di penyimpanan lokal IndexedDB.<br/><br/>
        Silakan <strong>Import Paket .zip</strong> di atas, konversi file <strong>.nwd</strong> melalui tab <em>Cloud Convert</em>, atau klik tombol <strong>Muat Model Demo</strong> di bawah.
      </div>
    `;
    return;
  }

  dom.offlineModelList.innerHTML = models
    .map((m) => {
      const isCurrent = appState.activeModel && appState.activeModel.id === m.id;
      const dateFormatted = new Date(m.createdAt).toLocaleDateString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      let badgeClass = 'badge-offline';
      let badgeLabel = 'OFFLINE SVF';
      if (m.isDemo) {
        badgeClass = 'badge-demo';
        badgeLabel = 'DEMO BIM';
      } else if (m.source === 'zip') {
        badgeClass = 'badge-cloud';
        badgeLabel = 'ZIP PACKAGE';
      } else if (
        m.source === 'local3d' ||
        /\.(ifc|glb|gltf|obj|stl|nwdjson)$/i.test(String(m.name || ''))
      ) {
        badgeClass = 'badge-offline';
        badgeLabel = 'LOCAL 3D / BIM';
      }

      return `
        <div class="model-card ${isCurrent ? 'active-model' : ''}" data-model-id="${escapeHtml(m.id)}">
          <div class="model-card-top">
            <div class="model-title-group">
              <div class="model-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
              <div class="model-meta">
                <span>${formatBytes(m.totalSize)}</span>
                <span>•</span>
                <span>${m.fileCount || 1} files</span>
                <span>•</span>
                <span>${escapeHtml(dateFormatted)}</span>
              </div>
            </div>
            <span class="badge ${badgeClass}">${badgeLabel}</span>
          </div>
          <div class="model-actions">
            <button class="btn btn-primary btn-sm btn-open" data-action="open-offline" data-id="${escapeHtml(m.id)}">
              Buka 3D (Offline)
            </button>
            <button class="btn btn-sm" data-action="export-zip" data-id="${escapeHtml(m.id)}" title="Export menjadi satu file .nwdpack.zip untuk dipindah via Flashdisk">
              Export .zip
            </button>
            <button class="btn btn-danger btn-sm" data-action="delete-model" data-id="${escapeHtml(m.id)}" title="Hapus dari IndexedDB">
              Hapus
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

/**
 * Membuka model dari IndexedDB ke dalam 3D Viewer secara Offline.
 * @param {string} modelId
 */
async function handleOpenOfflineModel(modelId) {
  const models = await listOfflineModels();
  const target = models.find((m) => m.id === modelId);
  if (!target) {
    showToast('Model tidak ditemukan di IndexedDB.', 'error');
    return;
  }

  try {
    dom.viewerEmptyOverlay.classList.add('hidden');
    dom.statusActiveModel.innerHTML = `Model: <strong>Memuat ${escapeHtml(target.name)}...</strong>`;

    await loadOfflineModel(target, dom.forgeViewer, handleViewerSelectionChanged);

    appState.activeModel = target;
    dom.statusActiveModel.innerHTML = `Model: <strong>${escapeHtml(target.name)}</strong>`;
    dom.statusRenderMode.innerHTML = `Mode: <strong>${
      target.isDemo ? 'OFFLINE DEMO BIM' : '100% OFFLINE (IndexedDB / SW)'
    }</strong>`;

    await refreshOfflineLibraryUI();
    refreshViewpointsUI();
    showToast(`Model "${target.name}" berhasil dimuat dalam mode Offline.`, 'success');
  } catch (err) {
    console.error('Error loading offline model:', err);
    showToast(err.message || 'Gagal memuat model 3D Offline.', 'error', 6000);
  }
}

/**
 * Membuat & membuka Model 3D Demo Industrial Process Plant secara instan (100% Offline).
 */
async function handleCreateAndOpenDemoModel() {
  try {
    const existingModels = await listOfflineModels();
    let demoModel = existingModels.find((m) => m.isDemo);

    if (!demoModel) {
      demoModel = await saveModelMetadata({
        id: 'model_demo_industrial_plant',
        name: 'Plant_Hydrotreater_Unit100.nwd',
        urn: '',
        svfPath: 'demo://industrial-plant',
        viewables: [{ name: '3D Master Equipment & Piping View', path: 'demo://industrial-plant', role: '3d' }],
        fileCount: 16,
        totalSize: 4825600,
        createdAt: new Date().toISOString(),
        source: 'demo',
        isDemo: true
      });
    }

    await handleOpenOfflineModel(demoModel.id);
    switchSidebarTab('tabLibrary');
  } catch (err) {
    showToast(`Gagal memuat model demo: ${err.message}`, 'error');
  }
}

/**
 * Callback ketika objek 3D diklik pada kanvas Autodesk Viewer.
 */
function handleViewerSelectionChanged(selectionInfo) {
  if (!selectionInfo || !selectionInfo.dbIds || selectionInfo.dbIds.length === 0) {
    dom.statusSelectedElement.innerHTML = `Seleksi: <strong>Tidak ada</strong>`;
    dom.selectionInspectorBox.innerHTML = `
      <div class="section-desc">
        Klik elemen peralatan, pipa, valve, atau struktur baja di 3D Viewport untuk menginspeksi metadata BIM.
      </div>
    `;
    return;
  }

  dom.statusSelectedElement.innerHTML = `Seleksi: <strong>${escapeHtml(selectionInfo.name)}</strong>`;

  const props = selectionInfo.props;
  if (props && props.specs) {
    // Metadata dari Industrial Plant Demo BIM
    const rowsHtml = Object.entries(props.specs)
      .map(
        ([k, v]) => `
        <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:11.5px;">
          <span style="color:var(--text-muted);">${escapeHtml(k)}</span>
          <span style="color:var(--text-primary);font-family:var(--font-mono);text-align:right;">${escapeHtml(v)}</span>
        </div>
      `
      )
      .join('');

    dom.selectionInspectorBox.innerHTML = `
      <div style="font-weight:600;color:var(--accent-primary);font-size:12px;margin-bottom:4px;">
        ${escapeHtml(props.name)}
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;">
        Kategori: <strong>${escapeHtml(props.category)}</strong> • Sistem: <strong>${escapeHtml(props.system)}</strong>
      </div>
      <div>${rowsHtml}</div>
    `;
  } else if (props && Array.isArray(props.properties)) {
    // Metadata standar dari SVF PropertyDatabase
    const topProps = props.properties.slice(0, 12);
    const rowsHtml = topProps
      .map(
        (p) => `
        <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:11.5px;">
          <span style="color:var(--text-muted);">${escapeHtml(p.displayName || p.attributeName)}</span>
          <span style="color:var(--text-primary);font-family:var(--font-mono);text-align:right;">${escapeHtml(p.displayValue)}</span>
        </div>
      `
      )
      .join('');

    dom.selectionInspectorBox.innerHTML = `
      <div style="font-weight:600;color:var(--accent-primary);font-size:12px;margin-bottom:6px;">
        ${escapeHtml(props.name || selectionInfo.name)}
      </div>
      <div>${rowsHtml || '<span class="section-desc">Buka panel Properties di toolbar bawah Viewer untuk detail lengkap.</span>'}</div>
    `;
  }
}

/**
 * Mengatur tampilan tahapan pada Pipeline Konversi Cloud NWD -> Offline SVF.
 */
function updatePipelineStepUI(activeStepNum, percent, logLine, isError = false) {
  dom.pipelineCard.style.display = 'flex';
  dom.pipelinePercent.textContent = `${Math.round(percent)}%`;
  dom.pipelineProgressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;

  const steps = [dom.step1, dom.step2, dom.step3, dom.step4];
  steps.forEach((stepEl, idx) => {
    const num = idx + 1;
    stepEl.classList.remove('active', 'done', 'error');
    if (num < activeStepNum) {
      stepEl.classList.add('done');
    } else if (num === activeStepNum) {
      stepEl.classList.add(isError ? 'error' : percent >= 100 && num === 4 ? 'done' : 'active');
    }
  });

  if (logLine) {
    const timePrefix = new Date().toLocaleTimeString('id-ID', { hour12: false });
    dom.pipelineLog.textContent += `[${timePrefix}] ${logLine}\n`;
    dom.pipelineLog.scrollTop = dom.pipelineLog.scrollHeight;
  }
}

/**
 * Menjalankan alur lengkap Konversi File .NWD di Cloud APS & Mengunduh seluruh
 * SVF Bubble ke IndexedDB agar siap digunakan 100% Offline.
 * @param {File} file
 */
async function handleNwdCloudToOfflinePipeline(file) {
  if (appState.isBusy) {
    showToast('Proses konversi/ekstraksi sedang berlangsung. Mohon tunggu.', 'warning');
    return;
  }

  // Jika file adalah format 3D lokal (.ifc, .glb, .gltf, .obj, .stl, .nwdjson, .zip),
  // proses langsung secara 100% Offline tanpa memerlukan kredensial APS!
  const lowerName = String(file.name || '').toLowerCase();
  if (/\.(ifc|glb|gltf|obj|stl|nwdjson|zip)$/i.test(lowerName)) {
    switchSidebarTab('tabLibrary');
    await handleImportZipPackage(file);
    return;
  }

  const creds = getActiveApsCredentials();

  if (!creds.clientId || !creds.clientSecret) {
    showToast(
      'Untuk file .NWD mentah tanpa APS Key, gunakan Opsi 1 (Ekstrak Gratis via viewer.autodesk.com) di atas, atau isi APS Key.',
      'warning',
      6000
    );
    switchSidebarTab('tabCloud');
    return;
  }

  appState.isBusy = true;
  dom.pipelineLog.textContent = '';
  dom.pipelineFilename.textContent = file.name;

  try {
    // TAHAP 1: Autentikasi 2-Legged OAuth2
    updatePipelineStepUI(1, 5, `Mengautentikasi ke Autodesk Platform Services (OAuth 2.0)...`);
    const tokenData = await authenticateAPS(creds.clientId, creds.clientSecret);
    const accessToken = tokenData.access_token;
    updatePipelineStepUI(1, 15, `Autentikasi berhasil. Memeriksa OSS Bucket...`);

    // TAHAP 2: Buat/Cek OSS Bucket & Upload File .NWD via Signed S3 Upload
    const bucketKey = await ensureBucketExists(accessToken, creds.clientId);
    updatePipelineStepUI(2, 18, `Bucket "${bucketKey}" siap. Mengunggah ${file.name} (${formatBytes(file.size)})...`);

    const uploadResult = await uploadFileToOSS(accessToken, bucketKey, file, (prog) => {
      const mappedPct = 18 + Math.round((prog.percent / 100) * 27); // 18% -> 45%
      updatePipelineStepUI(2, mappedPct, null);
      dom.pipelinePercent.textContent = `${mappedPct}%`;
    });

    updatePipelineStepUI(2, 45, `Upload selesai. URN: ${uploadResult.urn.slice(0, 28)}...`);
    dom.inputCloudUrn.value = uploadResult.urn;

    // TAHAP 3: Jalankan Model Derivative Job (Translate .nwd -> .svf) & Polling Manifest
    updatePipelineStepUI(3, 48, `Memulai Model Derivative Job (Translasi .nwd ke .svf)...`);
    await startSvfTranslationJob(accessToken, uploadResult.urn);

    let lastLoggedProgress = '';
    const finalManifest = await pollTranslationManifest(accessToken, uploadResult.urn, (poll) => {
      const mappedPct = 48 + Math.round((poll.percent / 100) * 24); // 48% -> 72%
      const logMsg = poll.message !== lastLoggedProgress ? poll.message : null;
      lastLoggedProgress = poll.message;
      updatePipelineStepUI(3, mappedPct, logMsg);
    });

    updatePipelineStepUI(3, 72, `Translasi SVF 100% selesai! Memulai pengunduhan SVF Bubble...`);

    // TAHAP 4: Unduh seluruh SVF Bubble + Asset Dependen (.pf, .pack, Materials, PropertyDB) ke IndexedDB
    let lastLoggedCount = -1;
    const savedModel = await downloadSvfBubbleToIndexedDB({
      accessToken,
      urn: uploadResult.urn,
      manifest: finalManifest,
      fileName: file.name,
      onProgress: (dlProg) => {
        const mappedPct = 72 + Math.round((dlProg.percent / 100) * 28); // 72% -> 100%
        const shouldLog =
          dlProg.downloadedCount !== lastLoggedCount &&
          (dlProg.downloadedCount % 5 === 0 || dlProg.percent === 100);
        if (shouldLog) {
          lastLoggedCount = dlProg.downloadedCount;
        }
        updatePipelineStepUI(4, mappedPct, shouldLog ? dlProg.message : null);
      }
    });

    updatePipelineStepUI(
      4,
      100,
      `SELESAI! ${savedModel.fileCount} file (${formatBytes(savedModel.totalSize)}) tersimpan di IndexedDB.`
    );

    await refreshOfflineLibraryUI();
    showToast(
      `Konversi & Ekstraksi Offline "${file.name}" selesai! Membuka model di 3D Viewer...`,
      'success',
      6000
    );

    // Otomatis buka model dari IndexedDB (Mode Offline)
    await handleOpenOfflineModel(savedModel.id);
  } catch (err) {
    console.error('Pipeline Error:', err);
    updatePipelineStepUI(1, 0, `ERROR: ${err.message}`, true);
    showToast(err.message || 'Terjadi kesalahan pada proses konversi NWD.', 'error', 6500);
  } finally {
    appState.isBusy = false;
  }
}

/**
 * Mengunduh SVF Bubble ke IndexedDB langsung dari Base64 URN yang sudah ada di Cloud.
 */
async function handleDownloadExistingUrnToOffline() {
  const rawUrn = dom.inputCloudUrn.value.trim().replace(/^urn:/i, '');
  if (!rawUrn) {
    showToast('Masukkan Base64 URN terlebih dahulu.', 'warning');
    return;
  }

  const creds = getActiveApsCredentials();
  if (!creds.clientId || !creds.clientSecret) {
    openSettingsModal();
    return;
  }

  appState.isBusy = true;
  dom.pipelineLog.textContent = '';
  dom.pipelineFilename.textContent = `URN: ${rawUrn.slice(0, 20)}...`;

  try {
    updatePipelineStepUI(1, 10, 'Mengautentikasi APS...');
    const tokenData = await authenticateAPS(creds.clientId, creds.clientSecret);
    const accessToken = tokenData.access_token;

    updatePipelineStepUI(3, 40, 'Mengambil manifest derivatif dari URN...');
    const manifest = await pollTranslationManifest(accessToken, rawUrn);

    updatePipelineStepUI(4, 60, 'Mengunduh seluruh file SVF Bubble ke IndexedDB...');
    const savedModel = await downloadSvfBubbleToIndexedDB({
      accessToken,
      urn: rawUrn,
      manifest,
      fileName: `CloudModel_${rawUrn.slice(-8)}.nwd`,
      onProgress: (p) => {
        const mapped = 60 + Math.round((p.percent / 100) * 40);
        updatePipelineStepUI(4, mapped, null);
      }
    });

    updatePipelineStepUI(4, 100, `Model berhasil disimpan ke IndexedDB (${savedModel.fileCount} files).`);
    await refreshOfflineLibraryUI();
    await handleOpenOfflineModel(savedModel.id);
  } catch (err) {
    updatePipelineStepUI(3, 0, `ERROR: ${err.message}`, true);
    showToast(err.message, 'error');
  } finally {
    appState.isBusy = false;
  }
}

/**
 * Meng-handle Import file `.nwdpack.zip` / `.zip` ATAU file 3D lokal langsung
 * (`.ifc`, `.glb`, `.gltf`, `.obj`, `.stl`, `.nwdjson`) ke IndexedDB untuk mode 100% Offline.
 * @param {File} inputFile
 */
async function handleImportZipPackage(inputFile) {
  if (!inputFile) return;
  const lower = String(inputFile.name || '').toLowerCase();

  try {
    dom.zipProgressBox.style.display = 'flex';
    dom.zipProgressFill.style.width = '5%';
    dom.zipProgressText.textContent = `Memproses ${inputFile.name}...`;

    let savedMeta;
    if (lower.endsWith('.zip')) {
      savedMeta = await importModelFromZip(inputFile, (prog) => {
        dom.zipProgressFill.style.width = `${prog.percent}%`;
        dom.zipProgressText.textContent = prog.message;
      });
    } else if (/\.(ifc|glb|gltf|obj|stl|nwdjson|json)$/i.test(lower)) {
      savedMeta = await importDirectLocal3DFile(inputFile, (prog) => {
        dom.zipProgressFill.style.width = `${prog.percent}%`;
        dom.zipProgressText.textContent = prog.message;
      });
    } else {
      throw new Error(
        `Format "${inputFile.name}" tidak dapat dibuka langsung. Untuk file .NWD tanpa kartu kredit, gunakan Opsi 1 pada tab Cloud .NWD.`
      );
    }

    await refreshOfflineLibraryUI();
    showToast(`Model "${savedMeta.name}" berhasil disimpan ke IndexedDB!`, 'success');
    await handleOpenOfflineModel(savedMeta.id);
  } catch (err) {
    console.error('Import Offline File error:', err);
    showToast(err.message || 'Gagal memproses file 3D.', 'error', 6000);
  } finally {
    setTimeout(() => {
      dom.zipProgressBox.style.display = 'none';
    }, 1200);
  }
}

/**
 * Meng-handle Export model dari IndexedDB menjadi file `.nwdpack.zip`.
 * @param {string} modelId
 */
async function handleExportModelZip(modelId) {
  try {
    showToast('Mempersiapkan paket .nwdpack.zip dari IndexedDB...', 'info');
    const { blob, filename } = await exportModelAsZip(modelId);

    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 10_000);

    showToast(`Paket "${filename}" berhasil diunduh! Siap dipindah via Flashdisk.`, 'success');
  } catch (err) {
    showToast(err.message || 'Gagal meng-export paket ZIP.', 'error');
  }
}

/**
 * Mencari elemen di dalam 3D Model dan melakukan Isolate + Zoom.
 */
async function handleExecuteSearch() {
  const query = dom.inputSearchModel.value.trim();
  if (!query) {
    appState.searchMatches = [];
    appState.searchCursor = -1;
    dom.searchMatchCount.textContent = '';
    showAllObjects();
    return;
  }

  const matchedIds = await searchObjectsInModel(query);
  appState.searchMatches = matchedIds;

  if (matchedIds.length === 0) {
    appState.searchCursor = -1;
    dom.searchMatchCount.textContent = '0 hasil';
    showToast(`Tidak ditemukan objek dengan kata kunci "${query}".`, 'warning');
    return;
  }

  appState.searchCursor = 0;
  dom.searchMatchCount.textContent = `1/${matchedIds.length}`;
  isolateAndFocusDbIds(matchedIds, matchedIds[0]);
}

function handleCycleSearchMatch(direction) {
  const matches = appState.searchMatches;
  if (!matches || matches.length === 0) return;

  appState.searchCursor = (appState.searchCursor + direction + matches.length) % matches.length;
  const targetDbId = matches[appState.searchCursor];
  dom.searchMatchCount.textContent = `${appState.searchCursor + 1}/${matches.length}`;
  isolateAndFocusDbIds(matches, targetDbId);
}

/**
 * Memperbarui daftar Saved Viewpoints pada Tab 3 Sidebar.
 */
function refreshViewpointsUI() {
  const viewpoints = getSavedViewpoints();
  dom.badgeViewpointCount.textContent = String(viewpoints.length);

  if (viewpoints.length === 0) {
    dom.viewpointsList.innerHTML = `
      <div class="empty-list-state">
        Belum ada Saved Viewpoint untuk model ini.<br/>
        Atur posisi kamera atau Section Plane lalu klik <strong>Simpan Viewpoint</strong>.
      </div>
    `;
    return;
  }

  dom.viewpointsList.innerHTML = viewpoints
    .map((vp) => {
      const timeStr = new Date(vp.createdAt).toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      return `
        <div class="viewpoint-item" data-vp-id="${escapeHtml(vp.id)}">
          <div class="viewpoint-info" data-action="restore-vp" data-id="${escapeHtml(vp.id)}">
            <div class="viewpoint-name">${escapeHtml(vp.name)}</div>
            <div class="viewpoint-time">Disimpan pukul ${escapeHtml(timeStr)}</div>
          </div>
          <button class="btn btn-danger btn-sm" data-action="delete-vp" data-id="${escapeHtml(vp.id)}" title="Hapus Viewpoint">
            &times;
          </button>
        </div>
      `;
    })
    .join('');
}

function handleSaveViewpoint(customName) {
  try {
    const vp = saveCurrentViewpoint(customName);
    dom.inputViewpointName.value = '';
    refreshViewpointsUI();
    showToast(`Viewpoint "${vp.name}" berhasil disimpan.`, 'success');
  } catch (err) {
    showToast(err.message, 'warning');
  }
}

/**
 * Membuka Modal Pengaturan Kredensial APS.
 */
function openSettingsModal() {
  const creds = getActiveApsCredentials();
  dom.inputApsClientId.value = creds.clientId || '';
  dom.inputApsClientSecret.value = creds.clientSecret || '';
  dom.apsConnectionResult.className = 'connection-result';
  dom.apsConnectionResult.textContent = '';
  dom.modalSettings.classList.remove('hidden');
}

function closeSettingsModal() {
  dom.modalSettings.classList.add('hidden');
}

/**
 * Menguji koneksi 2-Legged OAuth ke APS di dalam Modal Settings.
 */
async function handleTestApsConnection() {
  const clientId = dom.inputApsClientId.value.trim();
  const clientSecret = dom.inputApsClientSecret.value.trim();

  dom.apsConnectionResult.className = 'connection-result';
  dom.apsConnectionResult.style.display = 'block';
  dom.apsConnectionResult.textContent = 'Menguji autentikasi 2-Legged OAuth2 ke Autodesk APS...';

  try {
    const data = await authenticateAPS(clientId, clientSecret, true);
    dom.apsConnectionResult.className = 'connection-result success';
    dom.apsConnectionResult.textContent = `✓ Koneksi Berhasil! Token OAuth2 valid (berlaku ${data.expires_in} detik).`;
  } catch (err) {
    dom.apsConnectionResult.className = 'connection-result error';
    dom.apsConnectionResult.textContent = `✕ ${err.message}`;
  }
}

function handleSaveApsCredentials() {
  const clientId = dom.inputApsClientId.value.trim();
  const clientSecret = dom.inputApsClientSecret.value.trim();
  const remember = dom.chkRememberAps.checked;

  appState.sessionClientId = clientId;
  appState.sessionClientSecret = clientSecret;
  saveCredentials(clientId, clientSecret, remember);
  updateApsStatusUI();
  closeSettingsModal();
  showToast('Kredensial Autodesk Platform Services (APS) berhasil disimpan.', 'success');
}

/**
 * Mengikat seluruh Event Listeners aplikasi.
 */
function bindEventListeners() {
  // Online / Offline listeners
  window.addEventListener('online', updateNetworkStatusUI);
  window.addEventListener('offline', updateNetworkStatusUI);

  // PWA Install Prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    appState.deferredInstallPrompt = e;
    dom.btnInstallPwa.style.display = 'inline-flex';
  });

  dom.btnInstallPwa.addEventListener('click', async () => {
    if (!appState.deferredInstallPrompt) return;
    appState.deferredInstallPrompt.prompt();
    await appState.deferredInstallPrompt.userChoice;
    appState.deferredInstallPrompt = null;
    dom.btnInstallPwa.style.display = 'none';
  });

  // Pre-cache Engine 3D Button
  dom.btnCacheEngine.addEventListener('click', async () => {
    if (!navigator.serviceWorker?.controller) {
      showToast('Service Worker sedang diinisialisasi, silakan coba sesaat lagi.', 'info');
      return;
    }
    showToast('Memverifikasi & meng-cache seluruh file SDK Autodesk Viewer v7...', 'info');
    navigator.serviceWorker.controller.postMessage({ type: 'PRECACHE_VIEWER_SDK' });
  });

  // Toggle Sidebar
  dom.btnToggleSidebar.addEventListener('click', () => {
    dom.sidebar.classList.toggle('collapsed');
  });

  // Sidebar Tabs
  dom.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchSidebarTab(btn.dataset.tab));
  });

  // Drag & Drop helper
  function bindDropzone(dropzoneEl, fileInputEl, onFileSelected) {
    ['dragenter', 'dragover'].forEach((evtName) => {
      dropzoneEl.addEventListener(evtName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach((evtName) => {
      dropzoneEl.addEventListener(evtName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.remove('drag-over');
      });
    });
    dropzoneEl.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        onFileSelected(files[0]);
      }
    });
    fileInputEl.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        onFileSelected(files[0]);
        fileInputEl.value = '';
      }
    });
  }

  // Bind Dropzones
  bindDropzone(dom.dropzoneZip, dom.inputZipFile, handleImportZipPackage);
  bindDropzone(dom.dropzoneNwd, dom.inputNwdFile, handleNwdCloudToOfflinePipeline);

  // Offline Model List Delegation (Open, Export ZIP, Delete)
  dom.offlineModelList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const modelId = btn.dataset.id;

    if (action === 'open-offline') {
      await handleOpenOfflineModel(modelId);
    } else if (action === 'export-zip') {
      await handleExportModelZip(modelId);
    } else if (action === 'delete-model') {
      await deleteOfflineModel(modelId);
      await refreshOfflineLibraryUI();
      showToast('Model berhasil dihapus dari IndexedDB.', 'info');
    }
  });

  // Demo Model Buttons
  dom.btnCreateDemoModel.addEventListener('click', handleCreateAndOpenDemoModel);
  dom.btnEmptyLoadDemo.addEventListener('click', handleCreateAndOpenDemoModel);

  // Free .NWD Extractor (No Credit Card via viewer.autodesk.com)
  const extractorCode = getFreeAutodeskViewerExtractorScript();
  if (dom.bookmarkletFreeExtractor) {
    dom.bookmarkletFreeExtractor.href = `javascript:${encodeURIComponent(extractorCode)}`;
    dom.bookmarkletFreeExtractor.addEventListener('click', (e) => {
      e.preventDefault();
      showToast(
        'Tarik (Drag) tombol Bookmarklet ini ke Bookmarks Bar browser Anda, atau klik "Copy Script Ekstraktor .NWD" di sebelahnya!',
        'info',
        5000
      );
    });
  }

  if (dom.btnCopyFreeExtractor) {
    dom.btnCopyFreeExtractor.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(extractorCode);
        showToast(
          'Script Ekstraktor .NWD berhasil disalin! Buka viewer.autodesk.com, tekan F12 (Console), Paste, lalu tekan Enter.',
          'success',
          6500
        );
      } catch {
        // Fallback jika clipboard API diblokir
        const ta = document.createElement('textarea');
        ta.value = extractorCode;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('Script Ekstraktor .NWD berhasil disalin ke Clipboard!', 'success', 5000);
      }
    });
  }

  // Empty Overlay Quick Buttons
  dom.btnEmptyImportZip.addEventListener('click', () => {
    switchSidebarTab('tabLibrary');
    dom.inputZipFile.click();
  });
  dom.btnEmptyConvertNwd.addEventListener('click', () => {
    switchSidebarTab('tabCloud');
  });

  // Cloud URN Actions
  dom.btnDownloadUrnOffline.addEventListener('click', handleDownloadExistingUrnToOffline);
  dom.btnOpenUrnCloud.addEventListener('click', async () => {
    const rawUrn = dom.inputCloudUrn.value.trim().replace(/^urn:/i, '');
    if (!rawUrn) {
      showToast('Masukkan Base64 URN terlebih dahulu.', 'warning');
      return;
    }
    const creds = getActiveApsCredentials();
    if (!creds.clientId || !creds.clientSecret) {
      openSettingsModal();
      return;
    }
    try {
      const tokenData = await authenticateAPS(creds.clientId, creds.clientSecret);
      dom.viewerEmptyOverlay.classList.add('hidden');
      await loadCloudModelByUrn(rawUrn, tokenData.access_token, dom.forgeViewer, handleViewerSelectionChanged);
      dom.statusActiveModel.innerHTML = `Model: <strong>Cloud URN (${escapeHtml(rawUrn.slice(0, 14))}...)</strong>`;
      dom.statusRenderMode.innerHTML = `Mode: <strong>CLOUD STREAMING (APS)</strong>`;
      showToast('Model Cloud URN berhasil dimuat.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // CAD Top Toolbar Controls
  dom.btnSearchModel.addEventListener('click', handleExecuteSearch);
  dom.inputSearchModel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleExecuteSearch();
  });
  dom.btnSearchPrev.addEventListener('click', () => handleCycleSearchMatch(-1));
  dom.btnSearchNext.addEventListener('click', () => handleCycleSearchMatch(1));

  dom.btnFitView.addEventListener('click', fitToView);
  dom.btnIsolate.addEventListener('click', isolateSelected);
  dom.btnHide.addEventListener('click', hideSelected);
  dom.btnShowAll.addEventListener('click', showAllObjects);

  dom.btnGhosting.addEventListener('click', () => {
    const isGhost = toggleGhosting();
    dom.btnGhosting.classList.toggle('btn-primary', isGhost);
    showToast(`Efek Ghosting: ${isGhost ? 'AKTIF' : 'NONAKTIF'}`, 'info', 2000);
  });

  dom.btnWalkMode.addEventListener('click', async () => {
    const isWalking = await toggleFirstPersonWalk();
    dom.btnWalkMode.classList.toggle('btn-primary', isWalking);
    dom.walkHudBanner.classList.toggle('hidden', !isWalking);
  });

  dom.btnExitWalkHud.addEventListener('click', async () => {
    await toggleFirstPersonWalk();
    dom.btnWalkMode.classList.remove('btn-primary');
    dom.walkHudBanner.classList.add('hidden');
  });

  dom.btnProjection.addEventListener('click', () => {
    const mode = toggleCameraProjection();
    dom.btnProjection.textContent = mode === 'orthographic' ? 'Ortho' : 'Persp';
    showToast(`Proyeksi Kamera: ${mode.toUpperCase()}`, 'info', 2000);
  });

  dom.rangeExplode.addEventListener('input', (e) => {
    const scale = Number(e.target.value);
    setExplodeScale(scale);
    dom.explodeValueLabel.textContent = `${Math.round(scale * 100)}%`;
  });

  dom.selectTheme.addEventListener('change', (e) => {
    applyViewerTheme(e.target.value);
  });

  // Viewpoints Controls
  dom.btnQuickSaveViewpoint.addEventListener('click', () => {
    const defaultName = `Viewpoint ${new Date().toLocaleTimeString('id-ID', { hour12: false })}`;
    handleSaveViewpoint(defaultName);
    switchSidebarTab('tabViewpoints');
  });

  dom.btnAddViewpointSidebar.addEventListener('click', () => {
    handleSaveViewpoint(dom.inputViewpointName.value);
  });

  dom.viewpointsList.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const vpId = actionEl.dataset.id;

    if (action === 'restore-vp') {
      const vp = getSavedViewpoints().find((item) => item.id === vpId);
      if (vp) {
        restoreSavedViewpoint(vp);
        showToast(`Memulihkan Viewpoint "${vp.name}"`, 'info', 2200);
      }
    } else if (action === 'delete-vp') {
      deleteSavedViewpoint(vpId);
      refreshViewpointsUI();
    }
  });

  // Modals: Settings & Help
  dom.btnOpenSettings.addEventListener('click', openSettingsModal);
  dom.btnCloseSettings.addEventListener('click', closeSettingsModal);
  dom.btnTestAps.addEventListener('click', handleTestApsConnection);
  dom.btnSaveAps.addEventListener('click', handleSaveApsCredentials);

  dom.btnOpenHelp.addEventListener('click', () => dom.modalHelp.classList.remove('hidden'));
  dom.btnCloseHelp.addEventListener('click', () => dom.modalHelp.classList.add('hidden'));
  dom.btnCloseHelpFooter.addEventListener('click', () => dom.modalHelp.classList.add('hidden'));

  // Tutup modal saat klik backdrop
  [dom.modalSettings, dom.modalHelp].forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });
}

/**
 * Inisialisasi utama saat halaman selesai dimuat.
 */
async function bootstrapApp() {
  cacheDomElements();
  bindEventListeners();
  updateNetworkStatusUI();
  updateApsStatusUI();
  await registerServiceWorker();
  await refreshOfflineLibraryUI();
  refreshViewpointsUI();
}

document.addEventListener('DOMContentLoaded', bootstrapApp);
