/**
 * ============================================================================
 * js/viewer.js — Autodesk Viewer v7 (GuiViewer3D) Controller
 * ============================================================================
 * Menangani:
 * 1. Inisialisasi Autodesk.Viewing.GuiViewer3D dalam mode Local/Offline maupun Cloud
 * 2. Load model .svf dari Virtual Service Worker URL (/local-svf/{modelId}/...)
 * 3. Load model langsung dari Cloud URN (urn:...)
 * 4. Generator Model 3D Demo Industrial Plant (SceneBuilder) untuk uji coba
 *    100% Offline instan tanpa perlu kredensial APS
 * 5. Fitur CAD/BIM Navisworks: Search & Isolate, First-Person Walk (WASD),
 *    Measure, Section Box/Plane, Explode, Ghosting, Theme Switcher,
 *    dan Saved Viewpoints (localStorage).
 */

import { normalizeSvfPath } from './storage.js';

const VIEWPOINTS_STORAGE_PREFIX = 'nwd_viewer_viewpoints_';

let viewerInstance = null;
let isInitializerDone = false;
let currentLoadedModelId = null;
let currentGhostingState = true;
let customDemoMetadataMap = new Map(); // dbId -> object metadata untuk Demo Model

/**
 * Memastikan Autodesk.Viewing.Initializer sudah dijalankan (Mode Local / Offline-first).
 * @returns {Promise<void>}
 */
function ensureViewingInitialized() {
  if (isInitializerDone) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (!window.Autodesk || !window.Autodesk.Viewing) {
      reject(
        new Error(
          'Engine Autodesk Viewer (viewer3D.min.js) belum termuat. Pastikan koneksi internet aktif saat pertama kali membuka aplikasi agar Service Worker dapat meng-cache SDK.'
        )
      );
      return;
    }

    const options = {
      env: 'Local',
      useADP: false,
      useConsolidation: true
    };

    window.Autodesk.Viewing.Initializer(options, () => {
      isInitializerDone = true;
      resolve();
    });
  });
}

/**
 * Menginisialisasi atau mengambil instance GuiViewer3D pada elemen #forgeViewer.
 * @param {HTMLElement} container
 * @param {(selectionInfo: {dbIds: number[], name: string, props?: Object}) => void} [onSelectionChanged]
 * @returns {Promise<any>}
 */
export async function initViewer(container, onSelectionChanged) {
  await ensureViewingInitialized();

  if (viewerInstance && viewerInstance.started) {
    return viewerInstance;
  }

  const config3d = {
    extensions: [
      'Autodesk.Measure',
      'Autodesk.Section',
      'Autodesk.BimWalk',
      'Autodesk.Explode',
      'Autodesk.Snapping'
    ]
  };

  viewerInstance = new window.Autodesk.Viewing.GuiViewer3D(container, config3d);
  const startedCode = viewerInstance.start();
  if (startedCode > 0) {
    throw new Error('Gagal menginisialisasi WebGL Canvas untuk Autodesk GuiViewer3D.');
  }

  // Konfigurasi default tampilan ala Navisworks Dark CAD Studio
  applyViewerTheme('dark');
  viewerInstance.setGhosting(true);
  viewerInstance.setQualityLevel(true, true);
  viewerInstance.setGroundShadow(true);
  viewerInstance.setGroundReflection(false);
  viewerInstance.setEnvMapBackground(false);

  // Event Listener saat objek 3D diklik / dipilih
  const Av = window.Autodesk.Viewing;
  viewerInstance.addEventListener(Av.SELECTION_CHANGED_EVENT, (event) => {
    const dbIds = event.dbIdArray || [];
    if (!onSelectionChanged) return;

    if (dbIds.length === 0) {
      onSelectionChanged({ dbIds: [], name: 'Tidak ada objek dipilih' });
      return;
    }

    const primaryDbId = dbIds[0];

    // Cek apakah objek berasal dari Demo Model dengan metadata BIM khusus
    if (customDemoMetadataMap.has(primaryDbId)) {
      const meta = customDemoMetadataMap.get(primaryDbId);
      onSelectionChanged({
        dbIds,
        name: `${meta.name} [dbId: ${primaryDbId}]`,
        props: meta
      });
      return;
    }

    // Ambil nama dari InstanceTree / getProperties untuk SVF asli
    const tree = viewerInstance.model?.getInstanceTree?.();
    const nodeName = tree ? tree.getNodeName(primaryDbId) : `Element #${primaryDbId}`;

    viewerInstance.getProperties(
      primaryDbId,
      (propResult) => {
        onSelectionChanged({
          dbIds,
          name: `${propResult?.name || nodeName} ${
            dbIds.length > 1 ? `(+${dbIds.length - 1} lainnya)` : `[dbId: ${primaryDbId}]`
          }`,
          props: propResult
        });
      },
      () => {
        onSelectionChanged({
          dbIds,
          name: `${nodeName} [dbId: ${primaryDbId}]`
        });
      }
    );
  });

  return viewerInstance;
}

/**
 * Mengembalikan instance GuiViewer3D yang sedang aktif.
 */
export function getViewer() {
  return viewerInstance;
}

/**
 * Membersihkan model yang sedang dimuat di Viewer sebelum me-load model baru.
 */
function unloadCurrentModels() {
  if (!viewerInstance) return;
  customDemoMetadataMap.clear();

  try {
    const models = viewerInstance.impl?.modelQueue?.()?.getModels?.() || [];
    for (const m of models.slice()) {
      viewerInstance.unloadModel(m);
    }
    if (viewerInstance.model) {
      viewerInstance.unloadModel(viewerInstance.model);
    }
  } catch (err) {
    console.warn('Unload model warning:', err);
  }
}

/**
 * Me-load model SVF secara 100% OFFLINE dari IndexedDB melalui Virtual Route
 * Service Worker (`/local-svf/{modelId}/{svfPath}`).
 *
 * @param {Object} modelRecord - Metadata model dari IndexedDB
 * @param {HTMLElement} container - Container DOM #forgeViewer
 * @param {(selectionInfo: Object) => void} [onSelectionChanged]
 * @returns {Promise<any>}
 */
export async function loadOfflineModel(modelRecord, container, onSelectionChanged) {
  const viewer = await initViewer(container, onSelectionChanged);
  unloadCurrentModels();
  currentLoadedModelId = modelRecord.id;

  // Jika model adalah Built-in Industrial Plant Demo
  if (modelRecord.isDemo || String(modelRecord.svfPath).startsWith('demo://')) {
    return buildIndustrialPlantDemoScene(viewer, modelRecord);
  }

  const cleanSvfPath = normalizeSvfPath(modelRecord.svfPath);
  // Gunakan URL relatif terhadap lokasi aplikasi agar tetap berada di bawah scope Service Worker
  // baik di localhost maupun di GitHub Pages (https://username.github.io/repo-name/)
  const virtualUrl = new URL(
    `./local-svf/${encodeURIComponent(modelRecord.id)}/${cleanSvfPath}`,
    window.location.href
  ).href;

  return new Promise((resolve, reject) => {
    const Av = window.Autodesk.Viewing;

    const onGeometryLoaded = (evt) => {
      viewer.removeEventListener(Av.GEOMETRY_LOADED_EVENT, onGeometryLoaded);
      viewer.fitToView();
      resolve(evt.model);
    };

    viewer.addEventListener(Av.GEOMETRY_LOADED_EVENT, onGeometryLoaded);

    viewer.loadModel(
      virtualUrl,
      {},
      (loadedModel) => {
        // loadModel success callback (manifest & header SVF berhasil dibaca)
        setTimeout(() => {
          viewer.fitToView();
        }, 350);
        // Jika GEOMETRY_LOADED_EVENT sudah terpanggil atau segera terpanggil
        setTimeout(() => resolve(loadedModel), 900);
      },
      (errorCode, errorMessage) => {
        viewer.removeEventListener(Av.GEOMETRY_LOADED_EVENT, onGeometryLoaded);
        reject(
          new Error(
            `Gagal memuat model SVF Offline (${errorCode}): ${
              errorMessage || 'Pastikan Service Worker aktif dan paket SVF lengkap.'
            }`
          )
        );
      }
    );
  });
}

/**
 * Me-load model langsung dari Autodesk Cloud URN (Mode Online).
 * @param {string} urn - Base64 URN
 * @param {string} accessToken - Token OAuth2 APS
 * @param {HTMLElement} container
 * @param {(selectionInfo: Object) => void} [onSelectionChanged]
 * @returns {Promise<any>}
 */
export async function loadCloudModelByUrn(urn, accessToken, container, onSelectionChanged) {
  const viewer = await initViewer(container, onSelectionChanged);
  unloadCurrentModels();
  currentLoadedModelId = `cloud_${urn.slice(0, 16)}`;

  const Av = window.Autodesk.Viewing;
  if (Av.endpoint && Av.endpoint.setEndpointAndApi) {
    Av.endpoint.setEndpointAndApi('https://developer.api.autodesk.com', 'modelDerivativeV2');
    Av.endpoint.HTTP_REQUEST_HEADERS['Authorization'] = `Bearer ${accessToken}`;
  }

  const documentId = urn.startsWith('urn:') ? urn : `urn:${urn}`;

  return new Promise((resolve, reject) => {
    Av.Document.load(
      documentId,
      (doc) => {
        const defaultGeometry = doc.getRoot().getDefaultGeometry();
        if (!defaultGeometry) {
          reject(new Error('Dokumen Cloud URN tidak memiliki viewable 3D default.'));
          return;
        }
        viewer.loadDocumentNode(doc, defaultGeometry).then((model) => {
          viewer.fitToView();
          resolve(model);
        });
      },
      (errCode, errMsg) => {
        reject(new Error(`Gagal memuat Cloud URN (${errCode}): ${errMsg}`));
      }
    );
  });
}

/**
 * Membangun Model 3D Industrial Process Plant / MEP BIM interaktif menggunakan
 * `Autodesk.Viewing.SceneBuilder` + Custom PropertyPanel agar user dapat langsung
 * menguji seluruh fitur Navisworks (Orbit, Pan, Zoom, BimWalk WASD, Measure,
 * Section Box/Plane, Explode, Search, Isolate, Properties, Viewpoints) secara
 * 100% Offline tanpa memerlukan file .nwd atau kredensial APS terlebih dahulu.
 */
async function buildIndustrialPlantDemoScene(viewer, modelRecord) {
  const ext = await viewer.loadExtension('Autodesk.Viewing.SceneBuilder');
  const modelBuilder = await ext.addNewModel({
    conserveMemory: false,
    modelNameOverride: modelRecord.name || 'Industrial_Process_Plant_Area01.nwd'
  });

  const THREE = window.THREE;
  customDemoMetadataMap.clear();

  function addBimComponent({ name, category, system, materialName, colorHex, geometry, position, rotation, specs }) {
    const mat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(colorHex),
      specular: new THREE.Color(0x334155),
      shininess: 42
    });
    modelBuilder.addMaterial(materialName + '_' + name, mat);

    const mesh = new THREE.Mesh(geometry, mat);
    mesh.matrixAutoUpdate = false;
    mesh.position.set(position[0], position[1], position[2]);
    if (rotation) {
      mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    }
    mesh.updateMatrix();

    const dbId = modelBuilder.addMesh(mesh);
    customDemoMetadataMap.set(dbId, {
      dbId,
      name,
      category,
      system,
      material: materialName,
      specs: specs || {}
    });
    return dbId;
  }

  // 1. Concrete Foundation Pad & Base Skid
  addBimComponent({
    name: 'FDN-101 Concrete Equipment Foundation Pad',
    category: 'Structural Foundations',
    system: 'Civil / Structural',
    materialName: 'Reinforced Concrete C35',
    colorHex: 0x475569,
    geometry: new THREE.BoxGeometry(28, 0.8, 18),
    position: [0, -0.4, 0],
    specs: {
      'Item Name': 'FDN-101 Foundation Slab',
      'Concrete Grade': 'C35/45 Structural',
      Dimensions: '28000 x 18000 x 800 mm',
      Elevation: 'EL +100.000 m',
      Area: 'Unit 100 - Hydrotreating'
    }
  });

  // 2. Structural Steel Pipe Rack Columns & Beams
  const colPositions = [
    [-10, 4.5, -5],
    [-10, 4.5, 5],
    [0, 4.5, -5],
    [0, 4.5, 5],
    [10, 4.5, -5],
    [10, 4.5, 5]
  ];
  colPositions.forEach((pos, idx) => {
    addBimComponent({
      name: `STL-COL-0${idx + 1} Pipe Rack Column W250x73`,
      category: 'Structural Columns',
      system: 'Main Pipe Rack Steel',
      materialName: 'ASTM A992 Structural Steel',
      colorHex: 0x64748b,
      geometry: new THREE.BoxGeometry(0.45, 9.0, 0.45),
      position: pos,
      specs: {
        Section: 'W250x73 Wide Flange',
        Material: 'ASTM A992 Gr.50',
        Fireproofing: '2 Hr Cementitious',
        Height: '9000 mm'
      }
    });
  });

  // Transverse & Longitudinal Steel Beams
  [-10, 0, 10].forEach((xVal, idx) => {
    addBimComponent({
      name: `STL-BM-10${idx + 1} Transverse Pipe Rack Beam`,
      category: 'Structural Framing',
      system: 'Main Pipe Rack Steel',
      materialName: 'ASTM A992 Structural Steel',
      colorHex: 0x94a3b8,
      geometry: new THREE.BoxGeometry(0.4, 0.45, 10.5),
      position: [xVal, 6.8, 0],
      specs: {
        Section: 'W310x60',
        Elevation: 'TOS EL +106.800 m',
        LoadCapacity: '45 kN/m'
      }
    });
  });

  [-4.8, 4.8].forEach((zVal, idx) => {
    addBimComponent({
      name: `STL-STR-20${idx + 1} Longitudinal Tie Beam`,
      category: 'Structural Framing',
      system: 'Main Pipe Rack Steel',
      materialName: 'ASTM A992 Structural Steel',
      colorHex: 0x94a3b8,
      geometry: new THREE.BoxGeometry(20.6, 0.4, 0.35),
      position: [0, 8.7, zVal],
      specs: {
        Section: 'W250x49',
        Elevation: 'TOS EL +108.700 m'
      }
    });
  });

  // 3. Vertical High-Pressure Reactor Vessel (V-1001)
  addBimComponent({
    name: 'V-1001 High-Pressure Hydrotreater Reactor Vessel',
    category: 'Mechanical Equipment',
    system: 'Process Reaction System',
    materialName: 'SA-387 Gr.22 Cl.2 Cr-Mo Alloy',
    colorHex: 0x0ea5e9,
    geometry: new THREE.CylinderGeometry(2.1, 2.1, 8.5, 28),
    position: [-6.5, 4.8, -1.2],
    specs: {
      Tag: 'V-1001',
      Service: 'Diesel Hydrotreating Reactor',
      'Design Pressure': '85.0 barg',
      'Design Temperature': '425 °C',
      Diameter: '4200 mm ID',
      'Tan-to-Tan Height': '8500 mm',
      Weight: '64,500 kg',
      Manufacturer: 'Heavy Process Vessels Corp.'
    }
  });

  // Reactor Top Dome & Bottom Skirt
  addBimComponent({
    name: 'V-1001-HEAD Top Hemispherical Head',
    category: 'Mechanical Equipment',
    system: 'Process Reaction System',
    materialName: 'SA-387 Gr.22 Cl.2',
    colorHex: 0x38bdf8,
    geometry: new THREE.SphereGeometry(2.1, 28, 16),
    position: [-6.5, 9.0, -1.2],
    specs: {
      Tag: 'V-1001-HEAD',
      Thickness: '68 mm + 3 mm SS347L Clad'
    }
  });

  // 4. Horizontal Shell & Tube Heat Exchanger (E-1002)
  addBimComponent({
    name: 'E-1002 Feed/Effluent Shell & Tube Heat Exchanger',
    category: 'Heat Exchangers',
    system: 'Heat Recovery System',
    materialName: 'Carbon Steel SA-516 Gr.70',
    colorHex: 0x10b981,
    geometry: new THREE.CylinderGeometry(1.15, 1.15, 7.6, 24),
    position: [3.5, 2.2, -2.0],
    rotation: [0, 0, Math.PI / 2],
    specs: {
      Tag: 'E-1002',
      TEMA_Type: 'AES Floating Head',
      'Heat Duty': '14.8 MW',
      'Shell Side Pressure': '72 barg',
      'Tube Material': 'Duplex UNS S31803',
      Length: '7600 mm'
    }
  });

  // 5. Horizontal Separator Drum (D-1003)
  addBimComponent({
    name: 'D-1003 High-Pressure Three-Phase Separator Drum',
    category: 'Mechanical Equipment',
    system: 'Separation System',
    materialName: 'SA-516 Gr.70 HIC Tested',
    colorHex: 0x14b8a6,
    geometry: new THREE.CylinderGeometry(1.4, 1.4, 6.8, 24),
    position: [5.5, 2.6, 3.8],
    rotation: [0, 0, Math.PI / 2],
    specs: {
      Tag: 'D-1003',
      Service: 'HP Cold Separator',
      'Operating Pressure': '65.0 barg',
      'Operating Temp': '55 °C',
      Volume: '41.8 m³'
    }
  });

  // 6. Centrifugal Process Pumps (P-1004A & P-1004B Standby)
  [
    { tag: 'P-1004A', z: 2.2, status: 'Operating (Duty)' },
    { tag: 'P-1004B', z: 5.2, status: 'Standby (Auto-Start)' }
  ].forEach((p) => {
    addBimComponent({
      name: `${p.tag} API-610 Multistage Centrifugal Charge Pump`,
      category: 'Rotating Equipment',
      system: 'Feed Pumping System',
      materialName: 'Cast Steel A216 WCB',
      colorHex: 0xf59e0b,
      geometry: new THREE.BoxGeometry(2.6, 1.2, 1.2),
      position: [-2.0, 0.6, p.z],
      specs: {
        Tag: p.tag,
        Standard: 'API 610 BB2 Radial Split',
        'Flow Rate': '285 m³/h',
        'Differential Head': '780 m',
        'Motor Power': '750 kW @ 2980 RPM',
        Status: p.status
      }
    });
  });

  // 7. Process Piping Lines (12" Main Header, 8" Reactor Feed, 6" Recycle Gas)
  addBimComponent({
    name: 'PIPE-12"-P-1001-CS1500 Main Process Header',
    category: 'Piping Systems',
    system: 'Hydrocarbon Process Line',
    materialName: 'ASTM A106 Gr.B Sch 80',
    colorHex: 0xef4444,
    geometry: new THREE.CylinderGeometry(0.24, 0.24, 21.0, 18),
    position: [0, 7.35, -1.2],
    rotation: [0, 0, Math.PI / 2],
    specs: {
      'Line Number': '12"-P-1001-CS1500-IH',
      'Nominal Diameter': '12 inch (DN300)',
      'Piping Class': 'CS1500 ASME B16.5 #1500',
      Fluid: 'Reactor Effluent Two-Phase',
      Insulation: '75 mm Mineral Wool (Hot)'
    }
  });

  addBimComponent({
    name: 'PIPE-8"-G-1004-SS600 Hydrogen Recycle Header',
    category: 'Piping Systems',
    system: 'Hydrogen Gas System',
    materialName: 'ASTM A312 TP316L',
    colorHex: 0xeab308,
    geometry: new THREE.CylinderGeometry(0.18, 0.18, 21.0, 18),
    position: [0, 7.35, 1.6],
    rotation: [0, 0, Math.PI / 2],
    specs: {
      'Line Number': '8"-G-1004-SS600',
      'Nominal Diameter': '8 inch (DN200)',
      Fluid: 'Rich Hydrogen Recycle Gas',
      'Design Pressure': '82 barg'
    }
  });

  // Vertical Riser Pipe from Reactor to Header
  addBimComponent({
    name: 'PIPE-10"-P-1002 Reactor Overhead Riser',
    category: 'Piping Systems',
    system: 'Hydrocarbon Process Line',
    materialName: 'ASTM A335 P22 Alloy',
    colorHex: 0xf97316,
    geometry: new THREE.CylinderGeometry(0.2, 0.2, 4.2, 16),
    position: [-3.5, 5.2, -1.2],
    specs: {
      'Line Number': '10"-P-1002-A1500',
      'Nominal Diameter': '10 inch (DN250)',
      Service: 'Reactor Overhead Vapor'
    }
  });

  // 8. Control Valves (FV-1001 & PCV-1002)
  addBimComponent({
    name: 'FV-1001 Pneumatic Globe Flow Control Valve',
    category: 'Pipe Accessories / Valves',
    system: 'Instrumentation & Control',
    materialName: 'Forged Alloy F22 / SS316 Trim',
    colorHex: 0xec4899,
    geometry: new THREE.SphereGeometry(0.52, 18, 18),
    position: [-1.5, 7.35, -1.2],
    specs: {
      Tag: 'FV-1001',
      Type: 'Pneumatic Diaphragm Globe Valve',
      Size: '8" x 12" ANSI #1500',
      'Fail Position': 'Fail Closed (FC)',
      Cv: '420'
    }
  });

  viewer.fitToView();
  return modelBuilder.model;
}

/**
 * Mencari elemen 3D berdasarkan kata kunci nama atau nilai properti BIM,
 * kemudian melakukan Isolate & Fit-to-View ke hasil pencarian.
 * @param {string} query
 * @returns {Promise<number[]>} Array dbId yang cocok
 */
export async function searchObjectsInModel(query) {
  if (!viewerInstance || !viewerInstance.model) {
    return [];
  }

  const cleanQuery = String(query || '').trim().toLowerCase();
  if (!cleanQuery) {
    showAllObjects();
    return [];
  }

  // 1. Jika model adalah Demo SceneBuilder, cari di customDemoMetadataMap
  if (customDemoMetadataMap.size > 0) {
    const matchedIds = [];
    for (const [dbId, meta] of customDemoMetadataMap.entries()) {
      const haystack = [
        meta.name,
        meta.category,
        meta.system,
        meta.material,
        ...Object.values(meta.specs || {})
      ]
        .join(' ')
        .toLowerCase();

      if (haystack.includes(cleanQuery)) {
        matchedIds.push(dbId);
      }
    }
    return matchedIds;
  }

  // 2. Untuk model SVF standar, gabungkan pencarian InstanceTree + viewer.search()
  const matchedSet = new Set();
  const tree = viewerInstance.model.getInstanceTree?.();

  if (tree) {
    tree.enumNodeChildren(
      tree.getRootId(),
      (dbId) => {
        const nodeName = String(tree.getNodeName(dbId) || '').toLowerCase();
        if (nodeName.includes(cleanQuery)) {
          matchedSet.add(dbId);
        }
      },
      true
    );
  }

  return new Promise((resolve) => {
    viewerInstance.search(
      cleanQuery,
      (dbIds) => {
        if (Array.isArray(dbIds)) {
          dbIds.forEach((id) => matchedSet.add(id));
        }
        resolve(Array.from(matchedSet));
      },
      () => {
        resolve(Array.from(matchedSet));
      }
    );
  });
}

/**
 * Meng-isolate dan memfokuskan kamera ke daftar dbIds tertentu.
 * @param {number[]} dbIds
 * @param {number} [focusSingleId]
 */
export function isolateAndFocusDbIds(dbIds, focusSingleId = null) {
  if (!viewerInstance || !viewerInstance.model) return;
  if (!dbIds || dbIds.length === 0) return;

  viewerInstance.isolate(dbIds);
  const targetFocus = focusSingleId !== null ? [focusSingleId] : dbIds;
  viewerInstance.select(targetFocus);
  viewerInstance.fitToView(targetFocus);
}

/**
 * Fit-to-View ke objek yang dipilih (atau seluruh model jika tidak ada seleksi).
 */
export function fitToView() {
  if (!viewerInstance) return;
  const selected = viewerInstance.getSelection();
  viewerInstance.fitToView(selected && selected.length > 0 ? selected : undefined);
}

/**
 * Meng-isolate objek yang sedang dipilih saat ini.
 */
export function isolateSelected() {
  if (!viewerInstance) return;
  const selected = viewerInstance.getSelection();
  if (selected && selected.length > 0) {
    viewerInstance.isolate(selected);
    viewerInstance.fitToView(selected);
  }
}

/**
 * Menyembunyikan (Hide) objek yang sedang dipilih.
 */
export function hideSelected() {
  if (!viewerInstance) return;
  const selected = viewerInstance.getSelection();
  if (selected && selected.length > 0) {
    viewerInstance.hide(selected);
    viewerInstance.clearSelection();
  }
}

/**
 * Menampilkan kembali seluruh objek 3D dan mereset filter Isolate/Hide.
 */
export function showAllObjects() {
  if (!viewerInstance) return;
  viewerInstance.isolate([]);
  viewerInstance.showAll();
  viewerInstance.clearSelection();
}

/**
 * Mengaktifkan/menonaktifkan efek Ghosting saat objek di-isolate.
 * @returns {boolean}
 */
export function toggleGhosting() {
  if (!viewerInstance) return currentGhostingState;
  currentGhostingState = !currentGhostingState;
  viewerInstance.setGhosting(currentGhostingState);
  return currentGhostingState;
}

/**
 * Mengaktifkan/menonaktifkan First-Person Walkthrough (BIM Walk WASD + Mouse).
 * @returns {Promise<boolean>} true jika BimWalk sedang aktif
 */
export async function toggleFirstPersonWalk() {
  if (!viewerInstance) return false;
  let walkExt = viewerInstance.getExtension('Autodesk.BimWalk');
  if (!walkExt) {
    walkExt = await viewerInstance.loadExtension('Autodesk.BimWalk');
  }
  if (!walkExt) return false;

  if (walkExt.isActive()) {
    walkExt.deactivate();
    return false;
  } else {
    walkExt.activate();
    return true;
  }
}

/**
 * Mengatur skala Explode Model (0.0 - 1.0).
 * @param {number} scale
 */
export function setExplodeScale(scale) {
  if (!viewerInstance) return;
  const val = Math.max(0, Math.min(1, Number(scale || 0)));
  viewerInstance.explode(val);
}

/**
 * Mengganti proyeksi kamera antara Perspective dan Orthographic.
 * @returns {string} 'perspective' | 'orthographic'
 */
export function toggleCameraProjection() {
  if (!viewerInstance || !viewerInstance.navigation) return 'perspective';
  const camera = viewerInstance.navigation.getCamera();
  if (camera && camera.isPerspective) {
    viewerInstance.navigation.toOrthographic();
    return 'orthographic';
  } else {
    viewerInstance.navigation.toPerspective();
    return 'perspective';
  }
}

/**
 * Mengganti tema latar belakang & pencahayaan 3D Viewport.
 * @param {'dark' | 'light' | 'sky'} theme
 */
export function applyViewerTheme(theme) {
  if (!viewerInstance) return;

  if (theme === 'light') {
    viewerInstance.setBackgroundColor(238, 242, 246, 203, 213, 225);
    viewerInstance.setLightPreset(4);
  } else if (theme === 'sky') {
    viewerInstance.setBackgroundColor(135, 185, 228, 226, 236, 245);
    viewerInstance.setLightPreset(7);
  } else {
    // Default Dark CAD Studio
    viewerInstance.setBackgroundColor(16, 23, 36, 8, 12, 20);
    viewerInstance.setLightPreset(1);
  }
}

/**
 * ============================================================================
 * Fitur Saved Viewpoints (Menyimpan posisi kamera, section plane, & isolate)
 * ============================================================================
 */

export function getActiveModelIdForViewpoints() {
  return currentLoadedModelId || 'global_default';
}

/**
 * Mengambil daftar Saved Viewpoints dari localStorage untuk model saat ini.
 * @param {string} [modelId]
 * @returns {Array<Object>}
 */
export function getSavedViewpoints(modelId = getActiveModelIdForViewpoints()) {
  try {
    const raw = localStorage.getItem(VIEWPOINTS_STORAGE_PREFIX + modelId);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Menyimpan posisi kamera, potongan section plane, dan objek yang di-isolate saat ini.
 * @param {string} viewpointName
 * @param {string} [modelId]
 * @returns {Object} Viewpoint baru
 */
export function saveCurrentViewpoint(viewpointName, modelId = getActiveModelIdForViewpoints()) {
  if (!viewerInstance) {
    throw new Error('3D Viewer belum aktif.');
  }

  const viewerState = viewerInstance.getState({
    viewport: true,
    cutplanes: true,
    objectSet: true,
    renderOptions: false
  });

  const existing = getSavedViewpoints(modelId);
  const newVp = {
    id: `vp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: (viewpointName || '').trim() || `Viewpoint #${existing.length + 1}`,
    createdAt: new Date().toISOString(),
    state: viewerState
  };

  existing.unshift(newVp);
  localStorage.setItem(VIEWPOINTS_STORAGE_PREFIX + modelId, JSON.stringify(existing));
  return newVp;
}

/**
 * Me-restore posisi kamera dan potongan section plane dari sebuah Saved Viewpoint.
 * @param {Object} viewpoint
 */
export function restoreSavedViewpoint(viewpoint) {
  if (!viewerInstance || !viewpoint || !viewpoint.state) return;
  viewerInstance.restoreState(
    viewpoint.state,
    { viewport: true, cutplanes: true, objectSet: true },
    false
  );
}

/**
 * Menghapus satu Saved Viewpoint dari localStorage.
 * @param {string} viewpointId
 * @param {string} [modelId]
 */
export function deleteSavedViewpoint(viewpointId, modelId = getActiveModelIdForViewpoints()) {
  const list = getSavedViewpoints(modelId).filter((vp) => vp.id !== viewpointId);
  localStorage.setItem(VIEWPOINTS_STORAGE_PREFIX + modelId, JSON.stringify(list));
}
