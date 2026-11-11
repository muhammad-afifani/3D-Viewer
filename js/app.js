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
  fitToViewAll,
  focusOnDbIds,
  selectPartById,
  setPartsVisibility,
  getModelHierarchyTree,
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
  isBusy: false,
  collapsedCategories: new Set(),
  expandedFullCategories: new Set(),
  allCategoriesCollapsed: false
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
  dom.badgeTreeCount = document.getElementById('badgeTreeCount');
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

  // Tab 1B: Selection Tree (Model Hierarchy)
  dom.btnTreeExpandAll = document.getElementById('btnTreeExpandAll');
  dom.btnTreeShowAll = document.getElementById('btnTreeShowAll');
  dom.inputFilterTree = document.getElementById('inputFilterTree');
  dom.selectionTreeContainer = document.getElementById('selectionTreeContainer');
  dom.treeSelectionInspectorBox = document.getElementById('treeSelectionInspectorBox');

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
  dom.btnFocusSelected = document.getElementById('btnFocusSelected');
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

  // 3D Stage, Floating Quick Action Bar, & Overlays
  dom.forgeViewer = document.getElementById('forgeViewer');
  dom.floatingQuickBar = document.getElementById('floatingQuickBar');
  dom.quickBarSelectedLabel = document.getElementById('quickBarSelectedLabel');
  dom.btnQuickFitAll = document.getElementById('btnQuickFitAll');
  dom.btnQuickFocusPart = document.getElementById('btnQuickFocusPart');
  dom.btnQuickHidePart = document.getElementById('btnQuickHidePart');
  dom.btnQuickIsolatePart = document.getElementById('btnQuickIsolatePart');
  dom.btnQuickShowAll = document.getElementById('btnQuickShowAll');
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

    appState.collapsedCategories.clear();
    appState.expandedFullCategories.clear();

    await loadOfflineModel(
      target,
      dom.forgeViewer,
      handleViewerSelectionChanged,
      renderSelectionTreeUI
    );

    appState.activeModel = target;
    dom.floatingQuickBar?.classList.remove('hidden');
    dom.statusActiveModel.innerHTML = `Model: <strong>${escapeHtml(target.name)}</strong>`;
    dom.statusRenderMode.innerHTML = `Mode: <strong>${
      target.isDemo ? 'OFFLINE DEMO BIM' : '100% OFFLINE (IndexedDB / SW)'
    }</strong>`;

    await refreshOfflineLibraryUI();
    renderSelectionTreeUI();
    refreshViewpointsUI();
    showToast(`Model "${target.name}" berhasil dimuat utuh. Klik 1x untuk pilih & set pivot, Klik 2x untuk zoom part.`, 'success');
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
    switchSidebarTab('tabTree');
  } catch (err) {
    showToast(`Gagal memuat model demo: ${err.message}`, 'error');
  }
}

/**
 * Me-render hirarki Selection Tree (Kategori -> Daftar Part) lengkap dengan tombol
 * Focus (🎯) dan Toggle Hide/Unhide (👁️).
 */
function renderSelectionTreeUI(treeDataInput = null) {
  if (!dom.selectionTreeContainer) return;
  const treeData = treeDataInput || getModelHierarchyTree();
  if (dom.badgeTreeCount) {
    dom.badgeTreeCount.textContent = String(treeData.totalCount || 0);
  }

  if (!treeData.categories || treeData.categories.length === 0) {
    dom.selectionTreeContainer.innerHTML = `
      <div class="empty-list-state">
        Muat model 3D (<code>.ifc</code>, <code>.glb</code>, <code>.nwdjson</code>, <code>.svf</code>, atau Demo) untuk menampilkan hirarki <strong>Selection Tree</strong>.
      </div>
    `;
    return;
  }

  const filterQuery = String(dom.inputFilterTree?.value || '')
    .trim()
    .toLowerCase();

  // Jika jumlah kategori banyak (>8) dan baru pertama kali dimuat, ciutkan secara default agar rapi
  if (
    treeData.totalCount > 120 &&
    appState.collapsedCategories.size === 0 &&
    !appState.allCategoriesCollapsed &&
    !filterQuery
  ) {
    treeData.categories.slice(2).forEach((c) => appState.collapsedCategories.add(c.category));
  }

  const htmlChunks = [];
  const MAX_ITEMS_PREVIEW = 150;

  for (const cat of treeData.categories) {
    const filteredParts = filterQuery
      ? cat.parts.filter(
          (p) =>
            p.name.toLowerCase().includes(filterQuery) ||
            cat.category.toLowerCase().includes(filterQuery)
        )
      : cat.parts;

    if (filteredParts.length === 0) continue;

    const isCollapsed = !filterQuery && appState.collapsedCategories.has(cat.category);
    const isFullExpanded = filterQuery || appState.expandedFullCategories.has(cat.category);
    const visibleSlice = isFullExpanded
      ? filteredParts
      : filteredParts.slice(0, MAX_ITEMS_PREVIEW);
    const remainingCount = filteredParts.length - visibleSlice.length;

    const catEyeIcon = cat.someVisible ? '👁️' : '🚫';
    const catHiddenClass = !cat.someVisible ? 'is-hidden' : '';

    const childrenHtml = visibleSlice
      .map((part) => {
        const selectedClass = part.selected ? 'is-selected' : '';
        const hiddenClass = !part.visible ? 'is-hidden' : '';
        const eyeBtnClass = !part.visible ? 'is-off' : '';
        const eyeIcon = part.visible ? '👁️' : '🚫';

        return `
          <div class="tree-node-row ${selectedClass} ${hiddenClass}" data-dbid="${part.dbId}" data-category="${escapeHtml(cat.category)}">
            <span class="tree-node-label" data-action="tree-select-part" data-dbid="${part.dbId}" title="${escapeHtml(part.name)} (Klik 1x: Pilih &amp; Set Pivot • Klik 2x: Focus Zoom)">
              ${escapeHtml(part.name)}
            </span>
            <div class="tree-node-actions">
              <button class="tree-action-btn" data-action="tree-focus-part" data-dbid="${part.dbId}" title="Focus &amp; Zoom ke Part ini (F)">
                🎯
              </button>
              <button class="tree-action-btn ${eyeBtnClass}" data-action="tree-toggle-part" data-dbid="${part.dbId}" title="${part.visible ? 'Sembunyikan (Hide) Part ini' : 'Tampilkan Kembali (Unhide) Part ini'}">
                ${eyeIcon}
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    const showMoreBtnHtml =
      remainingCount > 0
        ? `
          <button class="btn btn-sm" data-action="tree-expand-more" data-category="${escapeHtml(cat.category)}" style="margin: 4px 6px; height: 24px; font-size: 10.5px;">
            + Tampilkan ${remainingCount} part lainnya di ${escapeHtml(cat.category)}
          </button>
        `
        : '';

    htmlChunks.push(`
      <div class="tree-category-group ${isCollapsed ? 'collapsed' : ''} ${catHiddenClass}" data-category="${escapeHtml(cat.category)}">
        <div class="tree-category-header" data-action="tree-toggle-collapse" data-category="${escapeHtml(cat.category)}">
          <div class="tree-cat-left">
            <span class="tree-chevron">▾</span>
            <span class="tree-cat-title" title="${escapeHtml(cat.category)}">${escapeHtml(cat.category)}</span>
            <span class="tree-cat-count">${filteredParts.length}</span>
          </div>
          <div class="tree-node-actions">
            <button class="tree-action-btn" data-action="tree-focus-cat" data-category="${escapeHtml(cat.category)}" title="Focus &amp; Zoom ke Kategori ini">
              🎯
            </button>
            <button class="tree-action-btn ${!cat.someVisible ? 'is-off' : ''}" data-action="tree-toggle-cat" data-category="${escapeHtml(cat.category)}" title="${cat.someVisible ? 'Sembunyikan Seluruh Kategori ini' : 'Tampilkan Kembali Seluruh Kategori ini'}">
              ${catEyeIcon}
            </button>
          </div>
        </div>
        <div class="tree-category-children">
          ${childrenHtml}
          ${showMoreBtnHtml}
        </div>
      </div>
    `);
  }

  dom.selectionTreeContainer.innerHTML =
    htmlChunks.join('') ||
    `<div class="empty-list-state">Tidak ada part yang cocok dengan filter "${escapeHtml(filterQuery)}".</div>`;
}

/**
 * Callback ketika objek 3D diklik pada kanvas Autodesk Viewer atau di Selection Tree.
 */
function handleViewerSelectionChanged(selectionInfo) {
  if (!selectionInfo || !selectionInfo.dbIds || selectionInfo.dbIds.length === 0) {
    dom.statusSelectedElement.innerHTML = `Seleksi: <strong>Tidak ada</strong>`;
    if (dom.quickBarSelectedLabel) {
      dom.quickBarSelectedLabel.textContent =
        'Klik 1x Part: Pilih & Set Pivot • Klik 2x / F: Zoom Part';
    }
    const emptyHtml = `
      <div class="section-desc">
        Klik 1x elemen di 3D Viewport atau di Selection Tree untuk menginspeksi metadata BIM &amp; mengatur pusat putaran (Orbit Pivot).
      </div>
    `;
    if (dom.selectionInspectorBox) dom.selectionInspectorBox.innerHTML = emptyHtml;
    if (dom.treeSelectionInspectorBox) dom.treeSelectionInspectorBox.innerHTML = emptyHtml;

    // Bersihkan highlight pada Selection Tree
    if (dom.selectionTreeContainer) {
      dom.selectionTreeContainer
        .querySelectorAll('.tree-node-row.is-selected')
        .forEach((el) => el.classList.remove('is-selected'));
    }
    return;
  }

  const primaryDbId = Number(selectionInfo.dbIds[0]);
  dom.statusSelectedElement.innerHTML = `Seleksi: <strong>${escapeHtml(selectionInfo.name)}</strong>`;
  if (dom.quickBarSelectedLabel) {
    dom.quickBarSelectedLabel.textContent = `Terpilih: ${selectionInfo.name} (Pivot Aktif)`;
  }

  // Sinkronkan & scroll otomatis ke item yang dipilih pada Selection Tree
  if (dom.selectionTreeContainer) {
    dom.selectionTreeContainer
      .querySelectorAll('.tree-node-row.is-selected')
      .forEach((el) => el.classList.remove('is-selected'));

    let targetRow = dom.selectionTreeContainer.querySelector(
      `.tree-node-row[data-dbid="${primaryDbId}"]`
    );

    // Jika part berada di kategori yang sedang terpotong (>150 item), buka penuh kategorinya
    if (!targetRow && selectionInfo.props?.category) {
      appState.expandedFullCategories.add(selectionInfo.props.category);
      appState.collapsedCategories.delete(selectionInfo.props.category);
      renderSelectionTreeUI();
      targetRow = dom.selectionTreeContainer.querySelector(
        `.tree-node-row[data-dbid="${primaryDbId}"]`
      );
    }

    if (targetRow) {
      const parentGroup = targetRow.closest('.tree-category-group');
      if (parentGroup && parentGroup.classList.contains('collapsed')) {
        const catName = parentGroup.dataset.category;
        if (catName) appState.collapsedCategories.delete(catName);
        parentGroup.classList.remove('collapsed');
      }
      targetRow.classList.add('is-selected');
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  const props = selectionInfo.props;
  let inspectorHtml = '';

  if (props && props.specs) {
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

    inspectorHtml = `
      <div style="font-weight:600;color:var(--accent-primary);font-size:12px;margin-bottom:4px;">
        ${escapeHtml(props.name)}
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;">
        Kategori: <strong>${escapeHtml(props.category)}</strong> • Sistem: <strong>${escapeHtml(props.system)}</strong>
      </div>
      <div>${rowsHtml}</div>
    `;
  } else if (props && Array.isArray(props.properties)) {
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

    inspectorHtml = `
      <div style="font-weight:600;color:var(--accent-primary);font-size:12px;margin-bottom:6px;">
        ${escapeHtml(props.name || selectionInfo.name)}
      </div>
      <div>${rowsHtml || '<span class="section-desc">Buka panel Properties di toolbar bawah Viewer untuk detail lengkap.</span>'}</div>
    `;
  }

  if (inspectorHtml) {
    if (dom.selectionInspectorBox) dom.selectionInspectorBox.innerHTML = inspectorHtml;
    if (dom.treeSelectionInspectorBox) dom.treeSelectionInspectorBox.innerHTML = inspectorHtml;
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
      await loadCloudModelByUrn(
        rawUrn,
        tokenData.access_token,
        dom.forgeViewer,
        handleViewerSelectionChanged,
        renderSelectionTreeUI
      );
      if (dom.floatingQuickBar) {
        dom.floatingQuickBar.classList.remove('hidden');
      }
      dom.statusActiveModel.innerHTML = `Model: <strong>Cloud URN (${escapeHtml(rawUrn.slice(0, 14))}...)</strong>`;
      dom.statusRenderMode.innerHTML = `Mode: <strong>CLOUD STREAMING (APS)</strong>`;
      showToast('Model Cloud URN berhasil dimuat.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Selection Tree (Model Hierarchy) Event Delegation
  if (dom.selectionTreeContainer) {
    dom.selectionTreeContainer.addEventListener('click', (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;

      if (action === 'tree-select-part') {
        const dbId = Number(actionEl.dataset.dbid);
        if (!Number.isNaN(dbId)) {
          selectPartById(dbId, { setPivot: true, zoomToPart: false });
        }
      } else if (action === 'tree-focus-part') {
        e.stopPropagation();
        const dbId = Number(actionEl.dataset.dbid);
        if (!Number.isNaN(dbId)) {
          selectPartById(dbId, { setPivot: true, zoomToPart: true });
        }
      } else if (action === 'tree-toggle-part') {
        e.stopPropagation();
        const dbId = Number(actionEl.dataset.dbid);
        if (!Number.isNaN(dbId)) {
          const rowEl = actionEl.closest('.tree-node-row');
          const currentlyHidden = rowEl ? rowEl.classList.contains('is-hidden') : false;
          setPartsVisibility([dbId], currentlyHidden);
        }
      } else if (action === 'tree-toggle-collapse') {
        // Jangan collapse jika yang diklik tombol aksi di dalam header kategori
        if (e.target.closest('.tree-action-btn')) return;
        const catName = actionEl.dataset.category;
        if (!catName) return;
        const groupEl = actionEl.closest('.tree-category-group');
        if (appState.collapsedCategories.has(catName)) {
          appState.collapsedCategories.delete(catName);
          if (groupEl) groupEl.classList.remove('collapsed');
        } else {
          appState.collapsedCategories.add(catName);
          if (groupEl) groupEl.classList.add('collapsed');
        }
      } else if (action === 'tree-focus-cat') {
        e.stopPropagation();
        const catName = actionEl.dataset.category;
        const catGroup = getModelHierarchyTree().find((c) => c.category === catName);
        if (catGroup && catGroup.parts.length > 0) {
          const ids = catGroup.parts.map((p) => p.dbId);
          focusOnDbIds(ids);
        }
      } else if (action === 'tree-toggle-cat') {
        e.stopPropagation();
        const catName = actionEl.dataset.category;
        const catGroup = getModelHierarchyTree().find((c) => c.category === catName);
        if (catGroup && catGroup.parts.length > 0) {
          const ids = catGroup.parts.map((p) => p.dbId);
          const nextVisible = !catGroup.someVisible;
          setPartsVisibility(ids, nextVisible);
        }
      } else if (action === 'tree-expand-more') {
        const catName = actionEl.dataset.category;
        if (catName) {
          appState.expandedFullCategories.add(catName);
          renderSelectionTreeUI();
        }
      }
    });

    // Double-Click pada item di Selection Tree -> Focus & Zoom-to-Fit ke Part tersebut
    dom.selectionTreeContainer.addEventListener('dblclick', (e) => {
      const labelEl = e.target.closest('[data-action="tree-select-part"]');
      if (!labelEl) return;
      const dbId = Number(labelEl.dataset.dbid);
      if (!Number.isNaN(dbId)) {
        selectPartById(dbId, { setPivot: true, zoomToPart: true });
      }
    });
  }

  if (dom.inputFilterTree) {
    dom.inputFilterTree.addEventListener('input', () => {
      renderSelectionTreeUI();
    });
  }

  if (dom.btnTreeExpandAll) {
    dom.btnTreeExpandAll.addEventListener('click', () => {
      const hierarchy = getModelHierarchyTree();
      if (!appState.allCategoriesCollapsed) {
        hierarchy.forEach((c) => appState.collapsedCategories.add(c.category));
        appState.allCategoriesCollapsed = true;
      } else {
        appState.collapsedCategories.clear();
        appState.allCategoriesCollapsed = false;
      }
      renderSelectionTreeUI();
    });
  }

  if (dom.btnTreeShowAll) {
    dom.btnTreeShowAll.addEventListener('click', () => {
      showAllObjects();
      showToast('Seluruh part yang tersembunyi ditampilkan kembali.', 'info', 1800);
    });
  }

  // CAD Top Toolbar Controls
  dom.btnSearchModel.addEventListener('click', handleExecuteSearch);
  dom.inputSearchModel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleExecuteSearch();
  });
  dom.btnSearchPrev.addEventListener('click', () => handleCycleSearchMatch(-1));
  dom.btnSearchNext.addEventListener('click', () => handleCycleSearchMatch(1));

  dom.btnFitView.addEventListener('click', () => fitToViewAll(true));
  if (dom.btnFocusSelected) {
    dom.btnFocusSelected.addEventListener('click', () => focusOnDbIds());
  }
  dom.btnIsolate.addEventListener('click', isolateSelected);
  dom.btnHide.addEventListener('click', hideSelected);
  dom.btnShowAll.addEventListener('click', showAllObjects);

  // Floating Quick Action Bar (Bottom Center)
  if (dom.btnQuickFitAll) {
    dom.btnQuickFitAll.addEventListener('click', () => fitToViewAll(true));
  }
  if (dom.btnQuickFocusPart) {
    dom.btnQuickFocusPart.addEventListener('click', () => focusOnDbIds());
  }
  if (dom.btnQuickHidePart) {
    dom.btnQuickHidePart.addEventListener('click', hideSelected);
  }
  if (dom.btnQuickIsolatePart) {
    dom.btnQuickIsolatePart.addEventListener('click', isolateSelected);
  }
  if (dom.btnQuickShowAll) {
    dom.btnQuickShowAll.addEventListener('click', showAllObjects);
  }

  // Global CAD Keyboard Shortcuts (Home, F, H, I, U, Esc)
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) {
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key.toLowerCase();
    if (e.key === 'Home') {
      e.preventDefault();
      fitToViewAll(true);
    } else if (key === 'f') {
      e.preventDefault();
      focusOnDbIds();
    } else if (key === 'h') {
      e.preventDefault();
      hideSelected();
    } else if (key === 'i') {
      e.preventDefault();
      isolateSelected();
    } else if (key === 'u' || e.key === 'Escape') {
      showAllObjects();
    }
  });

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
