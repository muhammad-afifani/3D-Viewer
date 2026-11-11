/**
 * ============================================================================
 * js/viewer.js — Autodesk Viewer v7 + Precision CAD Navigation & Tree Engine
 * ============================================================================
 * Menangani:
 * 1. Inisialisasi Autodesk.Viewing.GuiViewer3D (Mode Offline & Cloud)
 * 2. Normalisasi Koordinat Georeferenced IFC/3D ke pusat (0,0,0) & Outlier Filtering
 * 3. Precision CAD OrbitControls Engine (Orbit, Pan, Dynamic Fast Zoom zoomSpeed=2.5
 *    yang mendorong target maju saat dekat objek sehingga tidak pernah macet/lambat)
 * 4. Pemisahan tegas Single-Click (Pilih + Set Orbit Pivot TANPA Auto-Zoom),
 *    Drag Orbit (>5px), dan Double-Click (Focus Zoom-to-Fit ke Part)
 * 5. Selection Tree (Model Hierarchy) dengan Hide / Unhide (👁️), Isolate (⚡),
 *    Focus Part (🎯), dan Show All (🔄).
 */

import { normalizeSvfPath, getModelFile } from './storage.js';
import { parseLocal3DFile, computeVertexNormals } from './local-loaders.js';

const VIEWPOINTS_STORAGE_PREFIX = 'nwd_viewer_viewpoints_';

let viewerInstance = null;
let isInitializerDone = false;
let currentLoadedModelId = null;
let currentGhostingState = true;
let activeSelectionCallback = null;
let activeHierarchyChangedCallback = null;

/**
 * Registry seluruh part/komponen 3D pada model yang sedang aktif:
 * dbId -> {
 *   dbId: number,
 *   name: string,
 *   category: string,
 *   system: string,
 *   material: string,
 *   colorHex: number,
 *   specs: Object,
 *   bbox: THREE.Box3,
 *   center: THREE.Vector3,
 *   size: THREE.Vector3,
 *   visible: boolean,
 *   selected: boolean,
 *   fragIds: number[],
 *   meshes: THREE.Mesh[],
 *   originalMaterial: THREE.Material,
 *   highlightMaterial: THREE.Material
 * }
 */
const partRegistry = new Map();
const fragIdToDbIdMap = new Map();
let selectedDbIdSet = new Set();
let globalNormalizedBox = null;

/**
 * State Precision CAD OrbitControls (Standar Autodesk Viewer / Navisworks)
 */
const controlsState = {
  attached: false,
  enableRotate: true,
  enablePan: true,
  enableZoom: true,
  enableDamping: true,
  dampingFactor: 0.08,
  rotateSpeed: 1.0,
  panSpeed: 1.2,
  zoomSpeed: 2.5,
  screenSpacePanning: true,
  minDistance: 0.1,
  target: null, // THREE.Vector3 (Pivot putaran kamera)
  modelMaxDim: 50,
  // Pointer tracking untuk membedakan Single-Click vs Drag Orbit (>5px)
  isPointerDown: false,
  activeButton: -1,
  downX: 0,
  downY: 0,
  lastX: 0,
  lastY: 0,
  dragDistance: 0,
  mode: 'none', // 'orbit' | 'pan' | 'none'
  // Damping velocity
  velTheta: 0,
  velPhi: 0,
  dampingRafId: null,
  transitionRafId: null,
  pivotHideTimer: null
};

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
      useConsolidation: false
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
 * @param {(selectionInfo: Object) => void} [onSelectionChanged]
 * @param {(treeData: Object) => void} [onHierarchyChanged]
 * @returns {Promise<any>}
 */
export async function initViewer(container, onSelectionChanged, onHierarchyChanged) {
  await ensureViewingInitialized();

  if (onSelectionChanged) activeSelectionCallback = onSelectionChanged;
  if (onHierarchyChanged) activeHierarchyChangedCallback = onHierarchyChanged;

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

  // Matikan perilaku auto-zoom bawaan LMV saat klik objek
  try {
    if (typeof viewerInstance.setClickToSetCOI === 'function') {
      viewerInstance.setClickToSetCOI(false, false);
    }
    if (typeof viewerInstance.setClickConfig === 'function') {
      viewerInstance.setClickConfig('click', 'onObject', ['selectOnly']);
      viewerInstance.setClickConfig('click', 'offObject', ['deselectAll']);
    }
  } catch {
    // Abaikan jika metode tidak tersedia
  }

  // Konfigurasi default tampilan ala Navisworks Dark CAD Studio
  applyViewerTheme('dark');
  viewerInstance.setGhosting(true);
  viewerInstance.setQualityLevel(true, true);
  viewerInstance.setGroundShadow(false);
  viewerInstance.setGroundReflection(false);
  viewerInstance.setEnvMapBackground(false);

  const THREE = window.THREE;
  controlsState.target = new THREE.Vector3(0, 0, 0);

  // Pasang Precision CAD Orbit/Pan/Zoom & Click Controller
  attachPrecisionCadControls(container);

  return viewerInstance;
}

/**
 * Mengecek apakah user sedang mengaktifkan tool khusus (BimWalk, Measure, Section)
 * sehingga event mouse harus diteruskan ke tool tersebut.
 */
function isSpecialViewerToolActive() {
  if (!viewerInstance) return false;
  try {
    const walkExt = viewerInstance.getExtension('Autodesk.BimWalk');
    if (walkExt && walkExt.isActive && walkExt.isActive()) return true;

    const measureExt = viewerInstance.getExtension('Autodesk.Measure');
    if (measureExt && measureExt.isActive && measureExt.isActive()) return true;

    const sectionExt = viewerInstance.getExtension('Autodesk.Section');
    if (sectionExt && sectionExt.isActive && sectionExt.isActive()) return true;
  } catch {
    // Abaikan
  }
  return false;
}

/**
 * Menampilkan indikator visual titik Pivot Orbit (hijau/biru) di layar 3D.
 * @param {THREE.Vector3} worldPoint
 * @param {number} [durationMs=900]
 */
function showOrbitPivotIndicator(worldPoint, durationMs = 900) {
  const indicator = document.getElementById('orbitPivotIndicator');
  if (!indicator || !viewerInstance || !worldPoint) return;

  try {
    const cam = viewerInstance.impl?.camera;
    const canvas = viewerInstance.canvas || viewerInstance.impl?.canvas;
    if (!cam || !canvas) return;

    const projected = worldPoint.clone().project(cam);
    if (projected.z < -1 || projected.z > 1) {
      indicator.classList.add('hidden');
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const screenX = (projected.x * 0.5 + 0.5) * rect.width;
    const screenY = (-projected.y * 0.5 + 0.5) * rect.height;

    indicator.style.left = `${screenX}px`;
    indicator.style.top = `${screenY}px`;
    indicator.classList.remove('hidden');

    if (controlsState.pivotHideTimer) {
      clearTimeout(controlsState.pivotHideTimer);
    }
    if (durationMs > 0) {
      controlsState.pivotHideTimer = setTimeout(() => {
        indicator.classList.add('hidden');
      }, durationMs);
    }
  } catch {
    // Abaikan
  }
}

/**
 * Menyinkronkan posisi kamera, target (pivot), up vector, dan near/far clipping plane
 * langsung ke WebGL Renderer Autodesk Viewer.
 */
function syncCameraStateToViewer(newPos, newTarget, customUp = null) {
  if (!viewerInstance || !viewerInstance.impl) return;
  const THREE = window.THREE;
  const cam = viewerInstance.impl.camera;
  if (!cam) return;

  const upVec = customUp || new THREE.Vector3(0, 1, 0);

  if (newTarget) {
    controlsState.target.copy(newTarget);
  }

  const dist = Math.max(0.01, newPos.distanceTo(controlsState.target));
  const maxDim = Math.max(10, controlsState.modelMaxDim || 50);

  // Dynamic Clipping Plane agar model besar tidak terpotong & zoom dekat tidak near-clip
  cam.near = Math.max(0.01, Math.min(dist * 0.02, maxDim / 1000));
  cam.far = Math.max(10000, maxDim * 100, dist * 20);

  cam.position.copy(newPos);
  if (cam.target) cam.target.copy(controlsState.target);
  cam.up.copy(upVec);
  cam.lookAt(controlsState.target);
  cam.dirty = true;
  if (typeof cam.updateProjectionMatrix === 'function') {
    cam.updateProjectionMatrix();
  }
  if (typeof cam.updateMatrixWorld === 'function') {
    cam.updateMatrixWorld(true);
  }

  try {
    if (viewerInstance.navigation) {
      viewerInstance.navigation.setView(newPos, controlsState.target);
      viewerInstance.navigation.setPivotPoint(controlsState.target);
      viewerInstance.navigation.setCameraUpVector(upVec);
    }
  } catch {
    // Abaikan
  }

  viewerInstance.impl.invalidate(true, true, true);
}

/**
 * Mengaplikasikan rotasi bola (Spherical Orbit) di sekitar `controlsState.target`.
 * @param {number} deltaTheta - Putaran horizontal (radian)
 * @param {number} deltaPhi - Putaran vertikal (radian)
 */
function applySphericalOrbitDelta(deltaTheta, deltaPhi) {
  if (!viewerInstance || !viewerInstance.impl?.camera) return;
  const THREE = window.THREE;
  const cam = viewerInstance.impl.camera;

  const offset = cam.position.clone().sub(controlsState.target);
  let radius = offset.length();
  if (!Number.isFinite(radius) || radius < controlsState.minDistance) {
    radius = Math.max(2.0, controlsState.modelMaxDim * 0.25);
    offset.set(radius, radius * 0.7, radius);
  }

  // Konversi ke koordinat bola dengan sumbu Y sebagai vertikal (Y-up)
  let theta = Math.atan2(offset.x, offset.z);
  let phi = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)));

  theta += deltaTheta;
  phi = Math.max(0.02, Math.min(Math.PI - 0.02, phi + deltaPhi));

  const sinPhiRadius = Math.sin(phi) * radius;
  offset.x = sinPhiRadius * Math.sin(theta);
  offset.y = Math.cos(phi) * radius;
  offset.z = sinPhiRadius * Math.cos(theta);

  const newPos = controlsState.target.clone().add(offset);
  syncCameraStateToViewer(newPos, controlsState.target, new THREE.Vector3(0, 1, 0));
}

/**
 * Mengaplikasikan pergeseran kamera (Screen-Space Pan).
 * @param {number} dxPixels
 * @param {number} dyPixels
 * @param {HTMLElement} domEl
 */
function applyScreenSpacePanDelta(dxPixels, dyPixels, domEl) {
  if (!viewerInstance || !viewerInstance.impl?.camera) return;
  const THREE = window.THREE;
  const cam = viewerInstance.impl.camera;

  const offset = cam.position.clone().sub(controlsState.target);
  const targetDistance = Math.max(offset.length(), controlsState.modelMaxDim * 0.04, 0.5);
  const fovRad = ((cam.fov || 45) * Math.PI) / 180;
  const viewHeight = 2 * Math.tan(fovRad / 2) * targetDistance;

  const clientH = Math.max(1, domEl.clientHeight || 600);
  const panScale = (viewHeight / clientH) * controlsState.panSpeed;

  const forward = controlsState.target.clone().sub(cam.position).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp);
  if (right.lengthSq() < 0.0001) {
    right.set(1, 0, 0);
  } else {
    right.normalize();
  }
  const cameraUp = new THREE.Vector3().crossVectors(right, forward).normalize();

  const panOffset = new THREE.Vector3()
    .addScaledVector(right, -dxPixels * panScale)
    .addScaledVector(cameraUp, dyPixels * panScale);

  const newPos = cam.position.clone().add(panOffset);
  const newTarget = controlsState.target.clone().add(panOffset);
  syncCameraStateToViewer(newPos, newTarget, worldUp);
}

/**
 * Mengaplikasikan animasi transisi kamera yang mulus (cubic ease-out).
 */
function animateCameraTransition(targetPos, targetCenter, durationMs = 260) {
  if (!viewerInstance || !viewerInstance.impl?.camera) return;
  if (controlsState.transitionRafId) {
    cancelAnimationFrame(controlsState.transitionRafId);
    controlsState.transitionRafId = null;
  }
  if (controlsState.dampingRafId) {
    cancelAnimationFrame(controlsState.dampingRafId);
    controlsState.dampingRafId = null;
  }

  const cam = viewerInstance.impl.camera;
  const startPos = cam.position.clone();
  const startTarget = controlsState.target.clone();
  const endPos = targetPos.clone();
  const endTarget = targetCenter.clone();

  if (durationMs <= 0) {
    syncCameraStateToViewer(endPos, endTarget);
    return;
  }

  const startTime = performance.now();
  const step = (now) => {
    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / durationMs);
    const ease = 1 - Math.pow(1 - t, 3); // Cubic ease-out

    const curPos = startPos.clone().lerp(endPos, ease);
    const curTarget = startTarget.clone().lerp(endTarget, ease);
    syncCameraStateToViewer(curPos, curTarget);

    if (t < 1) {
      controlsState.transitionRafId = requestAnimationFrame(step);
    } else {
      controlsState.transitionRafId = null;
    }
  };

  controlsState.transitionRafId = requestAnimationFrame(step);
}

/**
 * Memasang Precision CAD OrbitControls (Orbit, Pan, Dynamic Fast Zoom, Single-Click vs Drag, Double-Click)
 * langsung pada elemen container/canvas 3D Viewer.
 */
function attachPrecisionCadControls(container) {
  if (controlsState.attached) return;
  controlsState.attached = true;

  const stopOngoingAnimations = () => {
    if (controlsState.transitionRafId) {
      cancelAnimationFrame(controlsState.transitionRafId);
      controlsState.transitionRafId = null;
    }
    if (controlsState.dampingRafId) {
      cancelAnimationFrame(controlsState.dampingRafId);
      controlsState.dampingRafId = null;
    }
  };

  // Cek apakah target klik berada di atas toolbar/panel mengambang milik Autodesk Viewer
  const isEventOnUiOverlay = (e) => {
    const t = e.target;
    if (!t || !(t instanceof HTMLElement)) return false;
    if (t.tagName === 'CANVAS') return false;
    if (
      t.closest('.adsk-control') ||
      t.closest('.docking-panel') ||
      t.closest('.floating-quick-bar') ||
      t.closest('.walk-hud-banner') ||
      t.closest('.viewer-empty-overlay') ||
      t.closest('button') ||
      t.closest('input')
    ) {
      return true;
    }
    return false;
  };

  // 1. POINTER DOWN
  container.addEventListener(
    'pointerdown',
    (e) => {
      if (isEventOnUiOverlay(e) || isSpecialViewerToolActive()) return;

      stopOngoingAnimations();
      controlsState.isPointerDown = true;
      controlsState.activeButton = e.button;
      controlsState.downX = e.clientX;
      controlsState.downY = e.clientY;
      controlsState.lastX = e.clientX;
      controlsState.lastY = e.clientY;
      controlsState.dragDistance = 0;
      controlsState.velTheta = 0;
      controlsState.velPhi = 0;

      // Mapping tombol mouse standar Autodesk Viewer / Navisworks:
      // - Klik Kiri (button 0) tanpa Shift -> Orbit (ROTATE)
      // - Klik Tengah (button 1), Klik Kanan (button 2), atau Shift + Klik Kiri -> Pan (PAN)
      if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        controlsState.mode = controlsState.enableRotate ? 'orbit' : 'none';
      } else if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
        controlsState.mode = controlsState.enablePan ? 'pan' : 'none';
      } else {
        controlsState.mode = 'none';
      }

      try {
        if (e.target && e.target.setPointerCapture) {
          e.target.setPointerCapture(e.pointerId);
        }
      } catch {
        // Abaikan
      }

      e.stopImmediatePropagation();
    },
    { capture: true }
  );

  // 2. POINTER MOVE (Orbit / Pan)
  container.addEventListener(
    'pointermove',
    (e) => {
      if (!controlsState.isPointerDown) return;
      if (isSpecialViewerToolActive()) return;

      const dx = e.clientX - controlsState.lastX;
      const dy = e.clientY - controlsState.lastY;
      controlsState.lastX = e.clientX;
      controlsState.lastY = e.clientY;

      controlsState.dragDistance = Math.hypot(
        e.clientX - controlsState.downX,
        e.clientY - controlsState.downY
      );

      const width = Math.max(1, container.clientWidth || 800);
      const height = Math.max(1, container.clientHeight || 600);

      if (controlsState.mode === 'orbit' && controlsState.enableRotate) {
        const dTheta = -(dx / width) * Math.PI * 2.1 * controlsState.rotateSpeed;
        const dPhi = -(dy / height) * Math.PI * 1.8 * controlsState.rotateSpeed;
        controlsState.velTheta = dTheta;
        controlsState.velPhi = dPhi;
        applySphericalOrbitDelta(dTheta, dPhi);
        showOrbitPivotIndicator(controlsState.target, 500);
      } else if (controlsState.mode === 'pan' && controlsState.enablePan) {
        applyScreenSpacePanDelta(dx, dy, container);
        showOrbitPivotIndicator(controlsState.target, 500);
      }

      e.stopImmediatePropagation();
      e.preventDefault();
    },
    { capture: true }
  );

  // 3. POINTER UP (Pisahkan Drag Orbit >5px vs Single-Click Seleksi <=5px)
  container.addEventListener(
    'pointerup',
    (e) => {
      if (!controlsState.isPointerDown) return;
      if (isSpecialViewerToolActive()) return;

      try {
        if (e.target && e.target.releasePointerCapture) {
          e.target.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Abaikan
      }

      const totalDragDist = Math.hypot(
        e.clientX - controlsState.downX,
        e.clientY - controlsState.downY
      );
      const wasLeftClick = controlsState.activeButton === 0 && !e.shiftKey;
      const prevMode = controlsState.mode;

      controlsState.isPointerDown = false;
      controlsState.activeButton = -1;
      controlsState.mode = 'none';

      e.stopImmediatePropagation();

      // Jika geseran > 5px, ini adalah gerakan Orbit / Pan, BUKAN klik seleksi!
      if (totalDragDist > 5) {
        if (
          prevMode === 'orbit' &&
          controlsState.enableDamping &&
          (Math.abs(controlsState.velTheta) > 0.0005 || Math.abs(controlsState.velPhi) > 0.0005)
        ) {
          const runInertia = () => {
            controlsState.velTheta *= 1 - controlsState.dampingFactor * 2.2;
            controlsState.velPhi *= 1 - controlsState.dampingFactor * 2.2;
            if (
              Math.abs(controlsState.velTheta) > 0.00025 ||
              Math.abs(controlsState.velPhi) > 0.00025
            ) {
              applySphericalOrbitDelta(controlsState.velTheta, controlsState.velPhi);
              controlsState.dampingRafId = requestAnimationFrame(runInertia);
            } else {
              controlsState.dampingRafId = null;
            }
          };
          controlsState.dampingRafId = requestAnimationFrame(runInertia);
        }
        return;
      }

      // Jika geseran <= 5px dan Klik Kiri: Lakukan Single-Click Part Selection (TANPA Auto-Zoom!)
      if (wasLeftClick) {
        handleCanvasSingleClick(e.clientX, e.clientY, container);
      }
    },
    { capture: true }
  );

  // Blokir event 'click' bawaan LMV di atas canvas agar tidak terjadi double-trigger/auto-zoom
  container.addEventListener(
    'click',
    (e) => {
      if (isEventOnUiOverlay(e) || isSpecialViewerToolActive()) return;
      e.stopImmediatePropagation();
    },
    { capture: true }
  );

  // 4. DOUBLE CLICK (Focus & Zoom-to-Fit ke Part yang diklik 2x)
  container.addEventListener(
    'dblclick',
    (e) => {
      if (isEventOnUiOverlay(e) || isSpecialViewerToolActive()) return;
      e.stopImmediatePropagation();
      e.preventDefault();

      const hit = pickPartAtScreenCoords(e.clientX, e.clientY, container);
      if (hit && hit.dbId) {
        selectPartById(hit.dbId, {
          setPivot: true,
          zoomToFit: true,
          customPivotPoint: hit.point
        });
      } else {
        // Double click di ruang kosong -> Fit All
        fitToViewAll();
      }
    },
    { capture: true }
  );

  // 5. MOUSE WHEEL (Autodesk-Style Dynamic Fast Zoom — zoomSpeed = 2.5 & Anti-Macet)
  container.addEventListener(
    'wheel',
    (e) => {
      if (isEventOnUiOverlay(e) || isSpecialViewerToolActive() || !controlsState.enableZoom) return;
      e.preventDefault();
      e.stopImmediatePropagation();

      stopOngoingAnimations();

      if (!viewerInstance || !viewerInstance.impl?.camera) return;
      const THREE = window.THREE;
      const cam = viewerInstance.impl.camera;

      // Normalisasi delta scroll mouse / trackpad
      let rawDelta = e.deltaY;
      if (e.deltaMode === 1) rawDelta *= 32; // DOM_DELTA_LINE
      else if (e.deltaMode === 2) rawDelta *= 300; // DOM_DELTA_PAGE

      const clampedDelta = Math.max(-160, Math.min(160, rawDelta));
      const zoomIn = clampedDelta < 0;
      const intensity = Math.max(0.15, Math.min(1.6, Math.abs(clampedDelta) / 90));

      // Hitung arah ray menuju posisi kursor mouse di layar agar zoom mengarah ke kursor
      const rect = container.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;

      const cursorWorldDir = new THREE.Vector3(ndcX, ndcY, 0.5)
        .unproject(cam)
        .sub(cam.position)
        .normalize();

      const forwardToTarget = controlsState.target.clone().sub(cam.position);
      const currentDist = Math.max(0.05, forwardToTarget.length());
      const forwardDir =
        forwardToTarget.lengthSq() > 0.00001
          ? forwardToTarget.clone().normalize()
          : cursorWorldDir.clone();

      // Kecepatan zoom tinggi (zoomSpeed = 2.5 -> ~28% jarak per takik scroll)
      const stepFraction = Math.min(0.48, 0.12 * controlsState.zoomSpeed * intensity);
      const minStepDistance = Math.max(0.2, controlsState.modelMaxDim * 0.018 * intensity);

      if (zoomIn) {
        const proportionalMove = currentDist * stepFraction;
        const moveDist = Math.max(proportionalMove, minStepDistance);

        // Arah gerak menggabungkan arah target (70%) + arah kursor mouse (30%)
        const zoomDir = forwardDir.clone().lerp(cursorWorldDir, 0.3).normalize();
        const newPos = cam.position.clone().addScaledVector(zoomDir, moveDist);

        // KUNCI ANTI-MACET: Jika kamera mulai mendekati target (atau langkah proporsional < minStep),
        // dorong juga `controlsState.target` maju searah pandangan kamera!
        let newTarget = controlsState.target.clone();
        const remainingDist = currentDist - moveDist;
        const comfortableMinPivotDist = Math.max(
          controlsState.minDistance,
          controlsState.modelMaxDim * 0.03
        );

        if (remainingDist < comfortableMinPivotDist || proportionalMove < minStepDistance) {
          const pushDist = Math.max(0, comfortableMinPivotDist - remainingDist) + moveDist * 0.35;
          newTarget.addScaledVector(zoomDir, pushDist);
        }

        syncCameraStateToViewer(newPos, newTarget);
      } else {
        // Zoom Out
        const proportionalMove = currentDist * (stepFraction * 1.15);
        const moveDist = Math.max(proportionalMove, minStepDistance);
        const newPos = cam.position.clone().addScaledVector(forwardDir, -moveDist);
        syncCameraStateToViewer(newPos, controlsState.target);
      }

      showOrbitPivotIndicator(controlsState.target, 450);
    },
    { capture: true, passive: false }
  );

  // Matikan context menu bawaan browser saat Right-Click Drag Pan
  container.addEventListener('contextmenu', (e) => {
    if (!isEventOnUiOverlay(e)) {
      e.preventDefault();
    }
  });
}

/**
 * Melakukan Raycasting 3D presisi tinggi pada koordinat layar (clientX, clientY).
 * Mendukung model SceneBuilder (.IFC, .GLB, .OBJ, .STL, .NWDJSON, Demo) maupun .SVF.
 * @param {number} clientX
 * @param {number} clientY
 * @param {HTMLElement} container
 * @returns {{dbId: number, point: THREE.Vector3} | null}
 */
function pickPartAtScreenCoords(clientX, clientY, container) {
  if (!viewerInstance || !viewerInstance.impl?.camera) return null;
  const THREE = window.THREE;
  const cam = viewerInstance.impl.camera;
  const rect = container.getBoundingClientRect();

  const canvasX = clientX - rect.left;
  const canvasY = clientY - rect.top;

  // 1. Jika partRegistry memiliki mesh Three.js langsung (SceneBuilder: .IFC, .GLB, .OBJ, .STL, .NWDJSON, Demo)
  // Gunakan Raycaster Three.js dengan fast BoundingBox culling agar 100% akurat ke segitiga yang terlihat
  if (partRegistry.size > 0) {
    const ndcX = (canvasX / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = -(canvasY / Math.max(1, rect.height)) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    const rayOrigin = cam.position.clone();
    const rayTarget = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(cam);
    const rayDir = rayTarget.sub(rayOrigin).normalize();
    raycaster.ray.set(rayOrigin, rayDir);

    let closestDist = Infinity;
    let bestHit = null;
    const tmpBoxDist = new THREE.Vector3();

    // Tahap A: Filter kandidat part yang visible === true dan bounding box-nya tertembus ray
    const candidates = [];
    for (const part of partRegistry.values()) {
      if (!part.visible || !part.bbox || part.bbox.isEmpty()) continue;
      const boxHitPoint = raycaster.ray.intersectBox(part.bbox, tmpBoxDist);
      if (boxHitPoint) {
        const boxDist = rayOrigin.distanceTo(boxHitPoint);
        candidates.push({ part, boxDist });
      }
    }

    // Urutkan kandidat dari yang paling dekat dengan kamera
    candidates.sort((a, b) => a.boxDist - b.boxDist);

    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const intersectPt = new THREE.Vector3();
    const localRay = new THREE.Ray();
    const invMat = new THREE.Matrix4();

    for (const { part, boxDist } of candidates) {
      if (boxDist > closestDist) break; // Early exit jika kotak sudah lebih jauh dari hit segitiga terdekat

      if (part.meshes && part.meshes.length > 0) {
        for (const mesh of part.meshes) {
          const geom = mesh.geometry;
          const posAttr = geom?.attributes?.position;
          if (!posAttr || !posAttr.array) {
            const centerDist = rayOrigin.distanceTo(part.center);
            if (centerDist < closestDist) {
              closestDist = centerDist;
              bestHit = {
                dbId: part.dbId,
                point:
                  boxDist > 0
                    ? rayOrigin.clone().addScaledVector(rayDir, boxDist)
                    : part.center.clone()
              };
            }
            continue;
          }

          const isLocalSpace = Boolean(mesh.matrixWorld && !mesh.PositionIsWorld);
          if (isLocalSpace) {
            invMat.getInverse(mesh.matrixWorld);
            localRay.copy(raycaster.ray).applyMatrix4(invMat);
          } else {
            localRay.copy(raycaster.ray);
          }

          const arr = posAttr.array;
          const ib = geom.index?.array || geom.ib || null;

          if (ib && ib.length >= 3) {
            for (let t = 0; t <= ib.length - 3; t += 3) {
              const i0 = ib[t] * 3;
              const i1 = ib[t + 1] * 3;
              const i2 = ib[t + 2] * 3;
              vA.set(arr[i0], arr[i0 + 1], arr[i0 + 2]);
              vB.set(arr[i1], arr[i1 + 1], arr[i1 + 2]);
              vC.set(arr[i2], arr[i2 + 1], arr[i2 + 2]);

              const hitPt = localRay.intersectTriangle(vA, vB, vC, false, intersectPt);
              if (hitPt) {
                if (isLocalSpace) hitPt.applyMatrix4(mesh.matrixWorld);
                const d = rayOrigin.distanceTo(hitPt);
                if (d < closestDist) {
                  closestDist = d;
                  bestHit = { dbId: part.dbId, point: hitPt.clone() };
                }
              }
            }
          } else {
            for (let i = 0; i <= arr.length - 9; i += 9) {
              vA.set(arr[i], arr[i + 1], arr[i + 2]);
              vB.set(arr[i + 3], arr[i + 4], arr[i + 5]);
              vC.set(arr[i + 6], arr[i + 7], arr[i + 8]);

              const hitPt = localRay.intersectTriangle(vA, vB, vC, false, intersectPt);
              if (hitPt) {
                if (isLocalSpace) hitPt.applyMatrix4(mesh.matrixWorld);
                const d = rayOrigin.distanceTo(hitPt);
                if (d < closestDist) {
                  closestDist = d;
                  bestHit = { dbId: part.dbId, point: hitPt.clone() };
                }
              }
            }
          }
        }
      } else {
        // Kandidat SVF di dalam partRegistry
        const hitPt = rayOrigin.clone().addScaledVector(rayDir, boxDist);
        if (boxDist < closestDist) {
          closestDist = boxDist;
          bestHit = { dbId: part.dbId, point: hitPt };
        }
      }
    }

    if (bestHit) return bestHit;
  }

  // 2. Fallback ke hitTest bawaan LMV (untuk model SVF native)
  try {
    const lmvHit = viewerInstance.impl.hitTest(canvasX, canvasY, false);
    if (lmvHit) {
      let resolvedDbId = lmvHit.dbId;
      if (lmvHit.fragId !== undefined && fragIdToDbIdMap.has(lmvHit.fragId)) {
        resolvedDbId = fragIdToDbIdMap.get(lmvHit.fragId);
      }
      if (resolvedDbId) {
        return {
          dbId: resolvedDbId,
          point: lmvHit.intersectPoint
            ? new THREE.Vector3(lmvHit.intersectPoint.x, lmvHit.intersectPoint.y, lmvHit.intersectPoint.z)
            : partRegistry.get(resolvedDbId)?.center?.clone() || new THREE.Vector3()
        };
      }
    }
  } catch {
    // Abaikan
  }

  return null;
}

/**
 * Handler saat user melakukan Single-Click (geseran <= 5px) di kanvas 3D:
 * - JANGAN melakukan auto-zoom!
 * - Cukup seleksi & highlight part tersebut
 * - Set titik pusat putaran (Orbit Pivot / controlsState.target) ke part tersebut
 * - Sinkronkan dengan Selection Tree & panel Properties.
 */
function handleCanvasSingleClick(clientX, clientY, container) {
  const hit = pickPartAtScreenCoords(clientX, clientY, container);
  if (!hit || !hit.dbId) {
    clearPartSelection();
    return;
  }

  selectPartById(hit.dbId, {
    setPivot: true,
    zoomToFit: false,
    customPivotPoint: hit.point
  });
}

/**
 * Mengatur highlight visual (warna biru terang ala Autodesk Viewer) pada part yang dipilih,
 * dan mengembalikan material asli pada part yang tidak dipilih.
 * @param {number[]} dbIds
 */
function applyVisualSelectionHighlight(dbIds) {
  const nextSet = new Set(dbIds.map((id) => Number(id)));

  // 1. Kembalikan material asli untuk part yang sebelumnya dipilih
  for (const prevId of selectedDbIdSet) {
    if (!nextSet.has(prevId)) {
      const prevPart = partRegistry.get(prevId);
      if (prevPart) {
        prevPart.selected = false;
        restorePartOriginalMaterial(prevPart);
      }
    }
  }

  // 2. Terapkan material highlight biru terang pada part yang baru dipilih
  for (const nextId of nextSet) {
    const part = partRegistry.get(nextId);
    if (part) {
      part.selected = true;
      applyPartHighlightMaterial(part);
    }
  }

  selectedDbIdSet = nextSet;

  if (viewerInstance && viewerInstance.impl) {
    viewerInstance.impl.invalidate(true, true, true);
  }
}

let sharedHighlightMaterial = null;

function applyPartHighlightMaterial(part) {
  if (!part || !viewerInstance) return;
  const THREE = window.THREE;

  if (!part.highlightMaterial) {
    if (!sharedHighlightMaterial) {
      sharedHighlightMaterial = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0x00d8ff),
        emissive: new THREE.Color(0x004e66),
        specular: new THREE.Color(0xffffff),
        shininess: 75,
        side: THREE.DoubleSide
      });
    }
    if (part.modelBuilder && !sharedHighlightMaterial.materialManagerName) {
      part.modelBuilder.addMaterial('mat_global_highlight_cyan', sharedHighlightMaterial);
    }
    part.highlightMaterial = sharedHighlightMaterial;
  }

  const fragList = viewerInstance.model?.getFragmentList?.();
  if (fragList && part.fragIds) {
    for (const fragId of part.fragIds) {
      try {
        fragList.setMaterial(fragId, part.highlightMaterial);
      } catch {
        // Abaikan
      }
    }
  }
  if (part.meshes) {
    for (const m of part.meshes) {
      m.material = part.highlightMaterial;
    }
  }
}

function restorePartOriginalMaterial(part) {
  if (!part || !viewerInstance) return;
  if (!part.originalMaterial && (!part.originalMaterials || part.originalMaterials.length === 0)) {
    return;
  }

  const fragList = viewerInstance.model?.getFragmentList?.();
  if (fragList && part.fragIds) {
    for (let idx = 0; idx < part.fragIds.length; idx++) {
      const fragId = part.fragIds[idx];
      const origMat = part.originalMaterials?.[idx] || part.originalMaterial;
      if (!origMat) continue;
      try {
        fragList.setMaterial(fragId, origMat);
      } catch {
        // Abaikan
      }
    }
  }
  if (part.meshes) {
    for (let idx = 0; idx < part.meshes.length; idx++) {
      const origMat = part.originalMaterials?.[idx] || part.originalMaterial;
      if (origMat) {
        part.meshes[idx].material = origMat;
      }
    }
  }
}

/**
 * Menyeleksi sebuah part berdasarkan `dbId` (baik dari klik 3D maupun klik di Selection Tree).
 * @param {number} dbId
 * @param {{setPivot?: boolean, zoomToFit?: boolean, customPivotPoint?: THREE.Vector3}} [options]
 */
export function selectPartById(dbId, options = {}) {
  const numId = Number(dbId);
  const { setPivot = true, zoomToFit = false, customPivotPoint = null } = options;

  const part = partRegistry.get(numId);
  applyVisualSelectionHighlight([numId]);

  if (zoomToFit) {
    focusOnDbIds([numId]);
  } else if (setPivot && viewerInstance && viewerInstance.impl?.camera) {
    // PENTING: Hanya ubah pivot/target putaran ke part tersebut TANPA mengubah jarak zoom!
    const pivotPt = customPivotPoint || part?.center;
    if (pivotPt) {
      controlsState.target.copy(pivotPt);
      try {
        viewerInstance.navigation?.setPivotPoint?.(pivotPt);
      } catch {
        // Abaikan
      }
      showOrbitPivotIndicator(pivotPt, 1100);
      viewerInstance.impl.invalidate(false, false, true);
    }
  }

  notifySelectionChanged([numId]);
}

/**
 * Menghapus seleksi part saat ini dan mengembalikan warna asli.
 */
export function clearPartSelection() {
  applyVisualSelectionHighlight([]);
  try {
    viewerInstance?.clearSelection?.();
  } catch {
    // Abaikan
  }
  notifySelectionChanged([]);
}

function notifySelectionChanged(dbIds) {
  if (!activeSelectionCallback) return;

  if (!dbIds || dbIds.length === 0) {
    activeSelectionCallback({
      dbIds: [],
      name: 'Tidak ada objek dipilih',
      props: null
    });
    return;
  }

  const primaryId = Number(dbIds[0]);
  const part = partRegistry.get(primaryId);

  if (part) {
    activeSelectionCallback({
      dbIds,
      primaryDbId: primaryId,
      name: `${part.name}`,
      visible: part.visible,
      props: {
        dbId: part.dbId,
        name: part.name,
        category: part.category,
        system: part.system,
        material: part.material,
        specs: part.specs
      }
    });
    return;
  }

  // Fallback untuk SVF native
  const tree = viewerInstance?.model?.getInstanceTree?.();
  const nodeName = tree ? tree.getNodeName(primaryId) : `Element #${primaryId}`;
  viewerInstance?.getProperties?.(
    primaryId,
    (propResult) => {
      activeSelectionCallback({
        dbIds,
        primaryDbId: primaryId,
        name: propResult?.name || nodeName,
        visible: true,
        props: propResult
      });
    },
    () => {
      activeSelectionCallback({
        dbIds,
        primaryDbId: primaryId,
        name: nodeName,
        visible: true
      });
    }
  );
}

function notifyHierarchyChanged() {
  if (activeHierarchyChangedCallback) {
    activeHierarchyChangedCallback(getModelHierarchyTree());
  }
}

/**
 * Mengembalikan struktur hirarki Selection Tree (Kategori -> Daftar Part)
 * untuk ditampilkan di Sidebar Kiri.
 */
export function getModelHierarchyTree() {
  const categoryMap = new Map();
  let totalCount = 0;
  let visibleCount = 0;

  for (const part of partRegistry.values()) {
    totalCount++;
    if (part.visible) visibleCount++;

    const catName = part.category || 'Uncategorized Elements';
    if (!categoryMap.has(catName)) {
      categoryMap.set(catName, []);
    }
    categoryMap.get(catName).push({
      dbId: part.dbId,
      name: part.name,
      category: catName,
      visible: part.visible,
      selected: selectedDbIdSet.has(part.dbId)
    });
  }

  const categories = Array.from(categoryMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, parts]) => {
      const allVisible = parts.every((p) => p.visible);
      const someVisible = parts.some((p) => p.visible);
      return {
        category,
        count: parts.length,
        allVisible,
        someVisible,
        parts
      };
    });

  return {
    totalCount,
    visibleCount,
    selectedIds: Array.from(selectedDbIdSet),
    categories
  };
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
  partRegistry.clear();
  fragIdToDbIdMap.clear();
  selectedDbIdSet.clear();
  globalNormalizedBox = null;

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
 * Me-load model secara 100% OFFLINE dari IndexedDB:
 * - Mendukung model .SVF via Virtual Route Service Worker (`/local-svf/{modelId}/{svfPath}`)
 * - Mendukung model 3D/BIM lokal (`.IFC`, `.GLB`, `.GLTF`, `.OBJ`, `.STL`, `.NWDJSON`)
 *   tanpa kartu kredit / tanpa cloud menggunakan SceneBuilder
 * - Mendukung Built-in Industrial Plant Demo
 */
export async function loadOfflineModel(
  modelRecord,
  container,
  onSelectionChanged,
  onHierarchyChanged
) {
  const viewer = await initViewer(container, onSelectionChanged, onHierarchyChanged);
  unloadCurrentModels();
  currentLoadedModelId = modelRecord.id;

  // 1. Jika model adalah Built-in Industrial Plant Demo
  if (modelRecord.isDemo || String(modelRecord.svfPath).startsWith('demo://')) {
    return buildIndustrialPlantDemoScene(viewer, modelRecord);
  }

  // 2. Jika model adalah Direct Local 3D/BIM File (.IFC, .GLB, .GLTF, .OBJ, .STL, .NWDJSON)
  const isLocal3DByExt = /\.(ifc|glb|gltf|obj|stl|nwdjson)$/i.test(String(modelRecord.name || ''));
  if (
    modelRecord.source === 'local3d' ||
    String(modelRecord.svfPath || '').startsWith('local3d://') ||
    isLocal3DByExt
  ) {
    const storedFilePath = String(modelRecord.svfPath || modelRecord.name).replace(
      /^local3d:\/\//,
      ''
    );
    let fileRecord = await getModelFile(modelRecord.id, storedFilePath);
    if ((!fileRecord || !fileRecord.data) && modelRecord.name) {
      fileRecord = await getModelFile(modelRecord.id, modelRecord.name);
    }
    if (!fileRecord || !fileRecord.data) {
      throw new Error(`File 3D lokal "${storedFilePath}" tidak ditemukan di IndexedDB.`);
    }
    const meshItems = await parseLocal3DFile(fileRecord.data, modelRecord.name);
    return buildCustomParsedMeshScene(viewer, modelRecord.name, meshItems);
  }

  // 3. Model .SVF standar melalui Virtual Route Service Worker (/local-svf/...)
  const cleanSvfPath = normalizeSvfPath(modelRecord.svfPath);
  const virtualUrl = new URL(
    `./local-svf/${encodeURIComponent(modelRecord.id)}/${cleanSvfPath}`,
    window.location.href
  ).href;

  return new Promise((resolve, reject) => {
    const Av = window.Autodesk.Viewing;

    const onGeometryLoaded = (evt) => {
      viewer.removeEventListener(Av.GEOMETRY_LOADED_EVENT, onGeometryLoaded);
      populatePartRegistryFromSvfModel(evt.model || viewer.model);
      fitToViewAll({ resetIso: true, immediate: true });
      notifyHierarchyChanged();
      resolve(evt.model);
    };

    viewer.addEventListener(Av.GEOMETRY_LOADED_EVENT, onGeometryLoaded);

    viewer.loadModel(
      virtualUrl,
      {},
      (loadedModel) => {
        setTimeout(() => {
          populatePartRegistryFromSvfModel(loadedModel || viewer.model);
          fitToViewAll({ resetIso: true, immediate: true });
          notifyHierarchyChanged();
        }, 400);
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
 * Mengisi `partRegistry` dari model .SVF standar agar Selection Tree & FitToView
 * juga bekerja mulus pada model hasil konversi Cloud SVF.
 */
function populatePartRegistryFromSvfModel(model) {
  if (!model || partRegistry.size > 0) return;
  const THREE = window.THREE;
  const fragList = model.getFragmentList?.();
  const tree = model.getInstanceTree?.();
  if (!fragList) return;

  const fragCount = fragList.getCount ? fragList.getCount() : fragList.fragments?.length || 0;
  const tmpBox = new THREE.Box3();
  const overallBox = new THREE.Box3();

  for (let fragId = 0; fragId < fragCount; fragId++) {
    fragList.getWorldBounds(fragId, tmpBox);
    if (tmpBox.isEmpty()) continue;

    const dbId =
      fragList.fragments?.fragId2dbId?.[fragId] ||
      (typeof fragList.getDbIds === 'function' ? fragList.getDbIds(fragId) : fragId + 1) ||
      fragId + 1;

    fragIdToDbIdMap.set(fragId, dbId);
    overallBox.union(tmpBox);

    if (!partRegistry.has(dbId)) {
      let nodeName = `Component #${dbId}`;
      let parentCategory = 'SVF Model Elements';
      if (tree) {
        nodeName = tree.getNodeName(dbId) || nodeName;
        const parentId = tree.getNodeParentId?.(dbId);
        if (parentId) {
          parentCategory = tree.getNodeName(parentId) || parentCategory;
        }
      }

      const clonedBox = tmpBox.clone();
      partRegistry.set(dbId, {
        dbId,
        name: nodeName,
        category: parentCategory,
        system: 'SVF Derivative',
        material: 'SVF Material',
        colorHex: 0x38bdf8,
        specs: { 'Element Name': nodeName, dbId: String(dbId) },
        bbox: clonedBox,
        center: clonedBox.getCenter(new THREE.Vector3()),
        size: clonedBox.getSize(new THREE.Vector3()),
        visible: true,
        selected: false,
        fragIds: [fragId],
        meshes: []
      });
    } else {
      const existing = partRegistry.get(dbId);
      existing.fragIds.push(fragId);
      existing.bbox.union(tmpBox);
      existing.center = existing.bbox.getCenter(new THREE.Vector3());
      existing.size = existing.bbox.getSize(new THREE.Vector3());
    }
  }

  if (!overallBox.isEmpty()) {
    globalNormalizedBox = overallBox;
  }
}

/**
 * Membangun scene 3D di dalam Autodesk GuiViewer3D dari hasil parsing file lokal
 * (.IFC, .GLB, .GLTF, .OBJ, .STL, atau .NWDJSON).
 *
 * Fitur Utama:
 * 1. Georeferenced IFC Normalization: Menghitung median cluster center untuk mengabaikan
 *    titik helper/origin kosong di (0,0,0), lalu menggeser seluruh model tepat ke (0,0,0).
 * 2. 16-bit Vertex Chunking (<= 54.000 vertex per mesh) untuk mencegah garis pecah.
 * 3. Registrasi setiap part (`dbId`) ke `partRegistry` lengkap dengan `THREE.Box3` presisi.
 * 4. Full Model `fitToViewAll` otomatis selesai load.
 */
async function buildCustomParsedMeshScene(viewer, modelName, meshItems) {
  const THREE = window.THREE;
  partRegistry.clear();
  fragIdToDbIdMap.clear();
  selectedDbIdSet.clear();
  sharedHighlightMaterial = null;

  // ==========================================================================
  // JALUR CEPAT & HEMAT MEMORI: NWDB v2 INSTANCED SCENE (Shared BufferGeometry)
  // ==========================================================================
  if (meshItems && meshItems.isInstancedScene === true) {
    return buildInstancedSceneFromNwdbV2(viewer, modelName, meshItems);
  }

  // TAHAP 1: Validasi setiap mesh & hitung bounding box mentah masing-masing part
  const validItems = [];

  for (let i = 0; i < meshItems.length; i++) {
    const item = meshItems[i];
    if (!item.positions || item.positions.length < 9) continue;

    let posFloats = item.positions;
    let normFloats = item.normals;
    let indexU16 = null;
    const vertCount = Math.floor(posFloats.length / 3);

    if (item.indices && item.indices.length >= 3) {
      if (vertCount <= 65535) {
        // Pertahankan Indexed BufferGeometry (Uint16Array) — hemat RAM hingga 6x lipat!
        indexU16 =
          item.indices instanceof Uint16Array
            ? item.indices
            : new Uint16Array(item.indices);
      } else {
        // Hanya expand jika 1 mesh tunggal memiliki > 65.535 vertex
        const idxArr = item.indices;
        const expandedPos = new Float32Array(idxArr.length * 3);
        for (let k = 0; k < idxArr.length; k++) {
          const vi = idxArr[k] * 3;
          expandedPos[k * 3] = posFloats[vi] || 0;
          expandedPos[k * 3 + 1] = posFloats[vi + 1] || 0;
          expandedPos[k * 3 + 2] = posFloats[vi + 2] || 0;
        }
        posFloats = expandedPos;
        normFloats = null;
      }
    }

    const validFloatLen = indexU16
      ? Math.floor(posFloats.length / 3) * 3
      : Math.floor(posFloats.length / 9) * 9;
    if (validFloatLen < 9) continue;

    let pMinX = Infinity;
    let pMinY = Infinity;
    let pMinZ = Infinity;
    let pMaxX = -Infinity;
    let pMaxY = -Infinity;
    let pMaxZ = -Infinity;
    let validVertexCount = 0;

    for (let j = 0; j < validFloatLen; j += 3) {
      const x = posFloats[j];
      const y = posFloats[j + 1];
      const z = posFloats[j + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        posFloats[j] = 0;
        posFloats[j + 1] = 0;
        posFloats[j + 2] = 0;
        continue;
      }
      validVertexCount++;
      if (x < pMinX) pMinX = x;
      if (y < pMinY) pMinY = y;
      if (z < pMinZ) pMinZ = z;
      if (x > pMaxX) pMaxX = x;
      if (y > pMaxY) pMaxY = y;
      if (z > pMaxZ) pMaxZ = z;
    }

    if (validVertexCount < 3 || !Number.isFinite(pMinX)) continue;
    const spanX = pMaxX - pMinX;
    const spanY = pMaxY - pMinY;
    const spanZ = pMaxZ - pMinZ;
    if (spanX < 1e-6 && spanY < 1e-6 && spanZ < 1e-6) continue;

    validItems.push({
      item,
      posFloats:
        validFloatLen === posFloats.length ? posFloats : posFloats.subarray(0, validFloatLen),
      normFloats:
        normFloats && normFloats.length >= validFloatLen
          ? normFloats.subarray(0, validFloatLen)
          : null,
      indexU16,
      rawMin: new THREE.Vector3(pMinX, pMinY, pMinZ),
      rawMax: new THREE.Vector3(pMaxX, pMaxY, pMaxZ),
      rawCenter: new THREE.Vector3(
        (pMinX + pMaxX) * 0.5,
        (pMinY + pMaxY) * 0.5,
        (pMinZ + pMaxZ) * 0.5
      )
    });
  }

  if (validItems.length === 0) {
    throw new Error('Tidak ditemukan geometri 3D valid di dalam file.');
  }

  // TAHAP 2: Georeferenced IFC Fix (Gunakan Median Center & Cluster Box agar titik (0,0,0) kosong tidak merusak pusat)
  const xs = validItems.map((v) => v.rawCenter.x).sort((a, b) => a - b);
  const ys = validItems.map((v) => v.rawCenter.y).sort((a, b) => a - b);
  const zs = validItems.map((v) => v.rawCenter.z).sort((a, b) => a - b);
  const midIdx = Math.floor(validItems.length / 2);
  const medianCenter = new THREE.Vector3(xs[midIdx], ys[midIdx], zs[midIdx]);

  const dists = validItems
    .map((v) => v.rawCenter.distanceTo(medianCenter))
    .sort((a, b) => a - b);
  const p95Dist = dists[Math.floor(dists.length * 0.95)] || 100;
  const clusterRadiusThreshold = Math.max(p95Dist * 6, 500);

  const clusterBox = new THREE.Box3();
  for (const entry of validItems) {
    if (entry.rawCenter.distanceTo(medianCenter) <= clusterRadiusThreshold) {
      clusterBox.expandByPoint(entry.rawMin);
      clusterBox.expandByPoint(entry.rawMax);
    }
  }
  if (clusterBox.isEmpty()) {
    for (const entry of validItems) {
      clusterBox.expandByPoint(entry.rawMin);
      clusterBox.expandByPoint(entry.rawMax);
    }
  }

  const worldCenterOffset = clusterBox.getCenter(new THREE.Vector3());

  // Geser seluruh koordinat model agar tengah-tengah Bounding Box berada tepat di (0, 0, 0)
  const normalizedGlobalBox = new THREE.Box3();
  for (const entry of validItems) {
    const pos = entry.posFloats;
    for (let j = 0; j < pos.length; j += 3) {
      pos[j] -= worldCenterOffset.x;
      pos[j + 1] -= worldCenterOffset.y;
      pos[j + 2] -= worldCenterOffset.z;
    }
    entry.rawMin.sub(worldCenterOffset);
    entry.rawMax.sub(worldCenterOffset);
    entry.rawCenter.sub(worldCenterOffset);

    if (entry.rawCenter.length() <= clusterRadiusThreshold) {
      normalizedGlobalBox.expandByPoint(entry.rawMin);
      normalizedGlobalBox.expandByPoint(entry.rawMax);
    }
  }

  if (normalizedGlobalBox.isEmpty()) {
    normalizedGlobalBox.set(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
  }
  globalNormalizedBox = normalizedGlobalBox.clone();

  // TAHAP 3: Buat Model di SceneBuilder dengan bbox yang sudah dinormalisasi
  const ext = await viewer.loadExtension('Autodesk.Viewing.SceneBuilder');
  const modelBuilder = await ext.addNewModel({
    conserveMemory: false,
    modelNameOverride: modelName || 'Local_3D_Model',
    bbox: globalNormalizedBox.clone()
  });

  // Material Pooling berdasarkan warna (colorHex) untuk menghemat memori GPU/CPU
  const materialPool = new Map();
  function getPooledMaterial(colorHex) {
    const key = Number(colorHex || 0x38bdf8);
    let mat = materialPool.get(key);
    if (!mat) {
      mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(key),
        specular: new THREE.Color(0x334155),
        shininess: 38,
        side: THREE.DoubleSide
      });
      modelBuilder.addMaterial(`mat_color_${key.toString(16)}`, mat);
      materialPool.set(key, mat);
    }
    return mat;
  }

  const MAX_FLOATS_PER_CHUNK = 162000; // <= 54.000 vertex per chunk (aman untuk Uint16Array)

  for (let i = 0; i < validItems.length; i++) {
    const { item, posFloats, normFloats, indexU16, rawMin, rawMax } = validItems[i];
    const dbId = Number(item.dbId || i + 1);

    const finalNormals =
      normFloats && normFloats.length === posFloats.length
        ? normFloats
        : computeVertexNormals(posFloats, indexU16);

    const colorHex = item.colorHex || 0x38bdf8;
    const mat = getPooledMaterial(colorHex);

    const partBBox = new THREE.Box3(rawMin.clone(), rawMax.clone());
    const partMeshes = [];
    const partFragIds = [];
    const partOrigMats = [];

    if (indexU16) {
      const bufGeom = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(posFloats, 3);
      const normAttr = new THREE.BufferAttribute(finalNormals, 3);
      const idxAttr = new THREE.BufferAttribute(indexU16, 1);
      idxAttr.bytesPerItem = 2;

      if (typeof bufGeom.addAttribute === 'function') {
        bufGeom.addAttribute('position', posAttr);
        bufGeom.addAttribute('normal', normAttr);
      } else if (typeof bufGeom.setAttribute === 'function') {
        bufGeom.setAttribute('position', posAttr);
        bufGeom.setAttribute('normal', normAttr);
      }
      if (typeof bufGeom.setIndex === 'function') {
        bufGeom.setIndex(idxAttr);
      } else {
        bufGeom.index = idxAttr;
      }

      bufGeom.computeBoundingBox();
      bufGeom.computeBoundingSphere();

      const mesh = new THREE.Mesh(bufGeom, mat);
      mesh.dbId = dbId;
      mesh.PositionIsWorld = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);

      modelBuilder.addMesh(mesh);

      partMeshes.push(mesh);
      partOrigMats.push(mat);
      if (mesh.fragId !== undefined) {
        partFragIds.push(mesh.fragId);
        fragIdToDbIdMap.set(mesh.fragId, dbId);
      }
    } else {
      for (let offset = 0; offset < posFloats.length; offset += MAX_FLOATS_PER_CHUNK) {
        const end = Math.min(offset + MAX_FLOATS_PER_CHUNK, posFloats.length);
        const chunkPos =
          offset === 0 && end === posFloats.length
            ? posFloats
            : posFloats.slice(offset, end);
        const chunkNorm =
          offset === 0 && end === finalNormals.length
            ? finalNormals
            : finalNormals.slice(offset, end);

        const bufGeom = new THREE.BufferGeometry();
        const posAttr = new THREE.BufferAttribute(chunkPos, 3);
        const normAttr = new THREE.BufferAttribute(chunkNorm, 3);

        if (typeof bufGeom.addAttribute === 'function') {
          bufGeom.addAttribute('position', posAttr);
          bufGeom.addAttribute('normal', normAttr);
        } else if (typeof bufGeom.setAttribute === 'function') {
          bufGeom.setAttribute('position', posAttr);
          bufGeom.setAttribute('normal', normAttr);
        }

        bufGeom.computeBoundingBox();
        bufGeom.computeBoundingSphere();

        const mesh = new THREE.Mesh(bufGeom, mat);
        mesh.dbId = dbId;
        mesh.PositionIsWorld = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);

        modelBuilder.addMesh(mesh);

        partMeshes.push(mesh);
        partOrigMats.push(mat);
        if (mesh.fragId !== undefined) {
          partFragIds.push(mesh.fragId);
          fragIdToDbIdMap.set(mesh.fragId, dbId);
        }
      }
    }

    const existingPart = partRegistry.get(dbId);
    if (existingPart) {
      existingPart.bbox.union(partBBox);
      existingPart.center = existingPart.bbox.getCenter(new THREE.Vector3());
      existingPart.size = existingPart.bbox.getSize(new THREE.Vector3());
      existingPart.fragIds.push(...partFragIds);
      existingPart.meshes.push(...partMeshes);
      existingPart.originalMaterials.push(...partOrigMats);
    } else {
      partRegistry.set(dbId, {
        dbId,
        name: item.name || `Component #${dbId}`,
        category: item.category || '3D Elements',
        system: item.system || modelName,
        material: item.materialName || 'CAD Material',
        colorHex,
        specs: item.specs || {
          'Element Name': item.name || `Component #${dbId}`,
          Category: item.category || '3D Elements',
          Triangles: String(
            indexU16 ? Math.floor(indexU16.length / 3) : Math.floor(posFloats.length / 9)
          )
        },
        bbox: partBBox,
        center: partBBox.getCenter(new THREE.Vector3()),
        size: partBBox.getSize(new THREE.Vector3()),
        visible: true,
        selected: false,
        fragIds: partFragIds,
        meshes: partMeshes,
        originalMaterial: mat,
        originalMaterials: partOrigMats,
        highlightMaterial: null,
        modelBuilder
      });
    }
  }

  patchSceneBuilderInstanceTree(modelBuilder, modelName);
  fitToViewAll({ resetIso: true, immediate: true });
  notifyHierarchyChanged();

  return modelBuilder.model;
}

/**
 * Membangun Scene 3D dari paket `NWDB v2` (Instanced Geometry Table + Instance Matrix Table).
 * Menggunakan Shared `THREE.BufferGeometry` & Pooled `THREE.MeshPhongMaterial` sehingga
 * model .NWD raksasa (100.000+ komponen) dapat dibuka dalam hitungan detik tanpa "Aw, Snap!" (OOM).
 */
async function buildInstancedSceneFromNwdbV2(viewer, modelName, instancedData) {
  const THREE = window.THREE;
  const { sharedGeometries, instances } = instancedData;

  // TAHAP 1: Siapkan THREE.BufferGeometry untuk setiap geometri unik HANYA 1 KALI
  const builtGeoms = new Array(sharedGeometries.length).fill(null);
  const localBoxes = new Array(sharedGeometries.length).fill(null);

  for (let g = 0; g < sharedGeometries.length; g++) {
    const sg = sharedGeometries[g];
    if (!sg || !sg.positions || sg.positions.length < 9) continue;

    let posFloats = sg.positions;
    let idxU16 = null;
    const vCount = Math.floor(posFloats.length / 3);

    if (sg.indices && sg.indices.length >= 3) {
      if (vCount <= 65535) {
        idxU16 =
          sg.indices instanceof Uint16Array ? sg.indices : new Uint16Array(sg.indices);
      } else {
        // Jika geometri tunggal > 65.535 vertex, un-index dan potong <= 54.000 vertex
        const maxTriIndices = Math.min(sg.indices.length, 54000 * 3);
        const expandedPos = new Float32Array(maxTriIndices * 3);
        for (let k = 0; k < maxTriIndices; k++) {
          const vi = sg.indices[k] * 3;
          expandedPos[k * 3] = posFloats[vi] || 0;
          expandedPos[k * 3 + 1] = posFloats[vi + 1] || 0;
          expandedPos[k * 3 + 2] = posFloats[vi + 2] || 0;
        }
        posFloats = expandedPos;
      }
    }

    const normals = computeVertexNormals(posFloats, idxU16);
    const bufGeom = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(posFloats, 3);
    const normAttr = new THREE.BufferAttribute(normals, 3);

    if (typeof bufGeom.addAttribute === 'function') {
      bufGeom.addAttribute('position', posAttr);
      bufGeom.addAttribute('normal', normAttr);
    } else if (typeof bufGeom.setAttribute === 'function') {
      bufGeom.setAttribute('position', posAttr);
      bufGeom.setAttribute('normal', normAttr);
    }

    if (idxU16) {
      const idxAttr = new THREE.BufferAttribute(idxU16, 1);
      idxAttr.bytesPerItem = 2;
      if (typeof bufGeom.setIndex === 'function') {
        bufGeom.setIndex(idxAttr);
      } else {
        bufGeom.index = idxAttr;
      }
    }

    bufGeom.computeBoundingBox();
    bufGeom.computeBoundingSphere();

    if (!bufGeom.boundingBox || bufGeom.boundingBox.isEmpty()) continue;

    builtGeoms[g] = bufGeom;
    localBoxes[g] = bufGeom.boundingBox.clone();
  }

  // TAHAP 2: Hitung World Matrix & Bounding Box setiap instance untuk normalisasi pusat (0,0,0)
  const validInstances = [];

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const bufGeom = builtGeoms[inst.geomId];
    const localBox = localBoxes[inst.geomId];
    if (!bufGeom || !localBox) continue;

    const m = inst.mat12;
    const mat4 = new THREE.Matrix4();
    mat4.set(
      m[0], m[3], m[6], m[9],
      m[1], m[4], m[7], m[10],
      m[2], m[5], m[8], m[11],
      0, 0, 0, 1
    );

    const worldBox = localBox.clone().applyMatrix4(mat4);
    if (
      !Number.isFinite(worldBox.min.x) ||
      !Number.isFinite(worldBox.max.x) ||
      worldBox.isEmpty()
    ) {
      continue;
    }

    const worldCenter = worldBox.getCenter(new THREE.Vector3());
    validInstances.push({
      inst,
      bufGeom,
      mat4,
      worldBox,
      worldCenter
    });
  }

  if (validInstances.length === 0) {
    throw new Error('Tidak ditemukan instance geometri 3D yang valid di dalam paket NWDB v2.');
  }

  // Hitung Median Cluster Center untuk menggeser model ke pusat (0, 0, 0)
  const xs = validInstances.map((v) => v.worldCenter.x).sort((a, b) => a - b);
  const ys = validInstances.map((v) => v.worldCenter.y).sort((a, b) => a - b);
  const zs = validInstances.map((v) => v.worldCenter.z).sort((a, b) => a - b);
  const midIdx = Math.floor(validInstances.length / 2);
  const medianCenter = new THREE.Vector3(xs[midIdx], ys[midIdx], zs[midIdx]);

  const dists = validInstances
    .map((v) => v.worldCenter.distanceTo(medianCenter))
    .sort((a, b) => a - b);
  const p95Dist = dists[Math.floor(dists.length * 0.95)] || 100;
  const clusterRadiusThreshold = Math.max(p95Dist * 6, 500);

  const clusterBox = new THREE.Box3();
  for (const entry of validInstances) {
    if (entry.worldCenter.distanceTo(medianCenter) <= clusterRadiusThreshold) {
      clusterBox.union(entry.worldBox);
    }
  }
  if (clusterBox.isEmpty()) {
    for (const entry of validInstances) {
      clusterBox.union(entry.worldBox);
    }
  }

  const worldCenterOffset = clusterBox.getCenter(new THREE.Vector3());
  const normalizedGlobalBox = new THREE.Box3();

  // Geser translasi matriks setiap instance sebesar -worldCenterOffset (Tanpa menyalin vertex!)
  for (const entry of validInstances) {
    const me = entry.mat4.elements;
    me[12] -= worldCenterOffset.x;
    me[13] -= worldCenterOffset.y;
    me[14] -= worldCenterOffset.z;

    entry.worldBox.min.sub(worldCenterOffset);
    entry.worldBox.max.sub(worldCenterOffset);
    entry.worldCenter.sub(worldCenterOffset);

    if (entry.worldCenter.length() <= clusterRadiusThreshold) {
      normalizedGlobalBox.union(entry.worldBox);
    }
  }

  if (normalizedGlobalBox.isEmpty()) {
    normalizedGlobalBox.set(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
  }
  globalNormalizedBox = normalizedGlobalBox.clone();

  // TAHAP 3: Bangun Model di SceneBuilder dengan Shared BufferGeometry & Pooled Materials
  const ext = await viewer.loadExtension('Autodesk.Viewing.SceneBuilder');
  const modelBuilder = await ext.addNewModel({
    conserveMemory: false,
    modelNameOverride: modelName || 'Extracted_NWD_Model',
    bbox: globalNormalizedBox.clone()
  });

  const materialPool = new Map();
  function getPooledMaterial(colorHex) {
    const key = Number(colorHex || 0x38bdf8);
    let mat = materialPool.get(key);
    if (!mat) {
      mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(key),
        specular: new THREE.Color(0x334155),
        shininess: 38,
        side: THREE.DoubleSide
      });
      modelBuilder.addMaterial(`mat_inst_${key.toString(16)}`, mat);
      materialPool.set(key, mat);
    }
    return mat;
  }

  for (let i = 0; i < validInstances.length; i++) {
    const { inst, bufGeom, mat4, worldBox } = validInstances[i];
    const dbId = Number(inst.dbId || i + 1);
    const mat = getPooledMaterial(inst.colorHex);

    const mesh = new THREE.Mesh(bufGeom, mat);
    mesh.dbId = dbId;
    mesh.PositionIsWorld = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(mat4);
    mesh.matrixWorld.copy(mat4);

    modelBuilder.addMesh(mesh);

    const fragId = mesh.fragId;
    if (fragId !== undefined) {
      fragIdToDbIdMap.set(fragId, dbId);
    }

    const existingPart = partRegistry.get(dbId);
    if (existingPart) {
      existingPart.bbox.union(worldBox);
      existingPart.center = existingPart.bbox.getCenter(new THREE.Vector3());
      existingPart.size = existingPart.bbox.getSize(new THREE.Vector3());
      if (fragId !== undefined) existingPart.fragIds.push(fragId);
      existingPart.meshes.push(mesh);
      existingPart.originalMaterials.push(mat);
    } else {
      partRegistry.set(dbId, {
        dbId,
        name: inst.name || `Component #${dbId}`,
        category: inst.category || 'Navisworks Element',
        system: inst.system || modelName,
        material: inst.materialName || 'Navisworks Material',
        colorHex: inst.colorHex || 0x38bdf8,
        specs: inst.specs || {},
        bbox: worldBox.clone(),
        center: worldBox.getCenter(new THREE.Vector3()),
        size: worldBox.getSize(new THREE.Vector3()),
        visible: true,
        selected: false,
        fragIds: fragId !== undefined ? [fragId] : [],
        meshes: [mesh],
        originalMaterial: mat,
        originalMaterials: [mat],
        highlightMaterial: null,
        modelBuilder
      });
    }
  }

  patchSceneBuilderInstanceTree(modelBuilder, modelName);
  fitToViewAll({ resetIso: true, immediate: true });
  notifyHierarchyChanged();

  return modelBuilder.model;
}

/**
 * Memperbaiki bug bawaan `SceneBuilder.min.js` di mana `nodeAccess.getNodeBox` mengosongkan box.
 */
function patchSceneBuilderInstanceTree(modelBuilder, modelName) {
  try {
    const data = modelBuilder.model?.getData?.();
    if (data && globalNormalizedBox) {
      data.bbox = globalNormalizedBox.clone();
      data.modelSpaceBBox = globalNormalizedBox.clone();
    }

    const nodeAccess = modelBuilder.instanceTree?.nodeAccess;
    if (nodeAccess) {
      nodeAccess.nodeBoxes = true;
      nodeAccess.getNodeBox = (dbId, outBox) => {
        const part = partRegistry.get(Number(dbId));
        const b = part?.bbox || globalNormalizedBox;
        if (!b || !outBox) return;
        if (outBox.min && outBox.max) {
          outBox.copy(b);
        } else {
          outBox[0] = b.min.x;
          outBox[1] = b.min.y;
          outBox[2] = b.min.z;
          outBox[3] = b.max.x;
          outBox[4] = b.max.y;
          outBox[5] = b.max.z;
        }
      };
      nodeAccess.name = (dbId) => {
        if (dbId === nodeAccess.rootId) return modelName || 'Model Root';
        return partRegistry.get(Number(dbId))?.name || `Part #${dbId}`;
      };
    }
  } catch {
    // Abaikan
  }
}

/**
 * Me-load model langsung dari Autodesk Cloud URN (Mode Online).
 */
export async function loadCloudModelByUrn(
  urn,
  accessToken,
  container,
  onSelectionChanged,
  onHierarchyChanged
) {
  const viewer = await initViewer(container, onSelectionChanged, onHierarchyChanged);
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
          populatePartRegistryFromSvfModel(model);
          fitToViewAll({ resetIso: true, immediate: true });
          notifyHierarchyChanged();
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
 * Membangun Model 3D Industrial Process Plant / MEP BIM interaktif (Demo 100% Offline).
 */
async function buildIndustrialPlantDemoScene(viewer, modelRecord) {
  const THREE = window.THREE;
  partRegistry.clear();
  fragIdToDbIdMap.clear();
  selectedDbIdSet.clear();

  const overallDemoBox = new THREE.Box3(
    new THREE.Vector3(-15, -1, -10),
    new THREE.Vector3(15, 11, 10)
  );
  globalNormalizedBox = overallDemoBox.clone();

  const ext = await viewer.loadExtension('Autodesk.Viewing.SceneBuilder');
  const modelBuilder = await ext.addNewModel({
    conserveMemory: false,
    modelNameOverride: modelRecord.name || 'Industrial_Process_Plant_Area01.nwd',
    bbox: overallDemoBox.clone()
  });

  let nextDbId = 1;

  function addBimComponent({
    name,
    category,
    system,
    materialName,
    colorHex,
    geometry,
    position,
    rotation,
    specs
  }) {
    const dbId = nextDbId++;
    const mat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(colorHex),
      specular: new THREE.Color(0x334155),
      shininess: 42,
      side: THREE.DoubleSide
    });
    modelBuilder.addMaterial(`${materialName}_${dbId}`, mat);

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, mat);
    mesh.dbId = dbId;
    mesh.matrixAutoUpdate = false;
    mesh.position.set(position[0], position[1], position[2]);
    if (rotation) {
      mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    }
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);

    const worldBox = geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    modelBuilder.addMesh(mesh);

    const fragIds = mesh.fragId !== undefined ? [mesh.fragId] : [];
    if (mesh.fragId !== undefined) {
      fragIdToDbIdMap.set(mesh.fragId, dbId);
    }

    partRegistry.set(dbId, {
      dbId,
      name,
      category,
      system,
      material: materialName,
      colorHex,
      specs: specs || {},
      bbox: worldBox,
      center: worldBox.getCenter(new THREE.Vector3()),
      size: worldBox.getSize(new THREE.Vector3()),
      visible: true,
      selected: false,
      fragIds,
      meshes: [mesh],
      originalMaterial: mat,
      highlightMaterial: null,
      modelBuilder
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

  // 7. Process Piping Lines
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

  patchSceneBuilderInstanceTree(modelBuilder, modelRecord.name);
  fitToViewAll({ resetIso: true, immediate: true });
  notifyHierarchyChanged();

  return modelBuilder.model;
}

/**
 * Menghitung `THREE.Box3` yang presisi dari seluruh part yang sedang `visible === true`
 * (atau khusus `targetDbIds` jika ditentukan).
 * @param {number[] | null} [targetDbIds=null]
 * @returns {THREE.Box3}
 */
function computeFramingBoundingBox(targetDbIds = null) {
  const THREE = window.THREE;
  const box = new THREE.Box3();

  // 1. Jika menargetkan dbId spesifik (misalnya Focus Part)
  if (Array.isArray(targetDbIds) && targetDbIds.length > 0) {
    for (const rawId of targetDbIds) {
      const part = partRegistry.get(Number(rawId));
      if (part && part.bbox && !part.bbox.isEmpty()) {
        box.union(part.bbox);
      }
    }
    if (!box.isEmpty()) return box;
  }

  // 2. Untuk Fit All (seluruh part yang sedang visible === true)
  const visibleParts = [];
  for (const part of partRegistry.values()) {
    if (part.visible && part.bbox && !part.bbox.isEmpty()) {
      visibleParts.push(part);
    }
  }

  if (visibleParts.length > 0) {
    // Jika hampir semua part visible dan kita punya globalNormalizedBox yang sudah bersih dari outlier
    if (visibleParts.length === partRegistry.size && globalNormalizedBox && !globalNormalizedBox.isEmpty()) {
      return globalNormalizedBox.clone();
    }
    for (const part of visibleParts) {
      box.union(part.bbox);
    }
    if (!box.isEmpty()) return box;
  }

  // 3. Fallback ke globalNormalizedBox atau model.getBoundingBox()
  if (globalNormalizedBox && !globalNormalizedBox.isEmpty()) {
    return globalNormalizedBox.clone();
  }

  const modelBox = viewerInstance?.model?.getBoundingBox?.();
  if (modelBox && !modelBox.isEmpty()) {
    return modelBox.clone();
  }

  return new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
}

/**
 * Fungsi inti `fitToView` sesuai spesifikasi matematika FOV kamera:
 * - Menghitung `center` & `size` dari `THREE.Box3`
 * - `maxDim = Math.max(size.x, size.y, size.z)`
 * - `distance = (maxDim / 2) / Math.tan(fov / 2) * 1.5`
 * - Mengatur `controlsState.target`, `camera.position`, `camera.near`, dan `camera.far`.
 *
 * @param {number[] | null} [targetDbIds=null]
 * @param {{resetIso?: boolean, immediate?: boolean}} [options]
 */
function frameBoundingBoxInCamera(targetDbIds = null, options = {}) {
  if (!viewerInstance || !viewerInstance.impl?.camera) return;
  const THREE = window.THREE;
  const cam = viewerInstance.impl.camera;
  const canvas = viewerInstance.canvas || viewerInstance.impl.canvas;

  const box = computeFramingBoundingBox(targetDbIds);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  let maxDim = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDim) || maxDim <= 0.001) {
    maxDim = 10;
  }

  // Jika melakukan Fit All, simpan skala model utama
  if (!targetDbIds || targetDbIds.length === 0) {
    controlsState.modelMaxDim = maxDim;
  }

  const fovDeg = cam.fov || 45;
  const fov = fovDeg * (Math.PI / 180);
  const aspect = canvas ? canvas.clientWidth / Math.max(1, canvas.clientHeight) : 1.5;

  // Rumus jarak kamera: (maxDim / 2) / Math.tan(fov / 2) * 1.5
  let distance = ((maxDim / 2) / Math.tan(fov / 2)) * 1.5;
  if (aspect < 1) {
    distance = distance / aspect;
  }
  distance = Math.max(distance, controlsState.minDistance * 2);

  // Tentukan arah sudut pandang kamera
  let direction = new THREE.Vector3(1, 0.78, 1).normalize();
  if (!options.resetIso) {
    const currentOffset = cam.position.clone().sub(controlsState.target);
    if (currentOffset.lengthSq() > 0.0001) {
      direction = currentOffset.normalize();
    }
  }

  const newTarget = center.clone();
  const newPosition = center.clone().add(direction.multiplyScalar(distance));

  // Update Clipping Plane secara dinamis
  cam.near = Math.max(0.01, maxDim / 1000);
  cam.far = Math.max(10000, maxDim * 100);
  if (typeof cam.updateProjectionMatrix === 'function') {
    cam.updateProjectionMatrix();
  }

  if (options.immediate) {
    syncCameraStateToViewer(newPosition, newTarget, new THREE.Vector3(0, 1, 0));
  } else {
    animateCameraTransition(newPosition, newTarget, 260);
  }

  showOrbitPivotIndicator(newTarget, 900);
}

/**
 * Menampilkan keseluruhan 3D Model yang sedang `visible` secara utuh dari ujung ke ujung (`Fit All`).
 * @param {{resetIso?: boolean, immediate?: boolean}} [options]
 */
export function fitToViewAll(options = {}) {
  frameBoundingBoxInCamera(null, options);
}

/**
 * Memfokuskan & melakukan Zoom-to-Fit ke daftar `dbId` tertentu (atau part yang sedang dipilih).
 * @param {number[]} [dbIds]
 */
export function focusOnDbIds(dbIds = null) {
  const targets =
    Array.isArray(dbIds) && dbIds.length > 0 ? dbIds : Array.from(selectedDbIdSet);

  if (!targets || targets.length === 0) {
    fitToViewAll();
    return;
  }

  frameBoundingBoxInCamera(targets, { resetIso: false, immediate: false });
}

/**
 * Kompatibilitas tombol "Fit View" utama: menampilkan keseluruhan model 3D secara utuh.
 */
export function fitToView() {
  fitToViewAll({ resetIso: false, immediate: false });
}

/**
 * Mengubah visibilitas (Hide / Unhide) satu atau beberapa `dbId`.
 * @param {number | number[]} dbIds
 * @param {boolean} [forceVisible] - Jika undefined, otomatis toggle status saat ini
 * @returns {boolean} Status visibilitas baru
 */
export function setPartsVisibility(dbIds, forceVisible = undefined) {
  if (!viewerInstance) return true;
  const list = Array.isArray(dbIds) ? dbIds.map(Number) : [Number(dbIds)];
  if (list.length === 0) return true;

  let targetState = forceVisible;
  if (targetState === undefined) {
    const firstPart = partRegistry.get(list[0]);
    targetState = firstPart ? !firstPart.visible : false;
  }

  const fragList = viewerInstance.model?.getFragmentList?.();

  for (const id of list) {
    const part = partRegistry.get(id);
    if (part) {
      part.visible = Boolean(targetState);
      if (fragList && part.fragIds) {
        for (const fragId of part.fragIds) {
          try {
            fragList.setFragOff(fragId, !part.visible);
          } catch {
            // Abaikan
          }
        }
      }
      if (part.meshes) {
        for (const m of part.meshes) {
          m.visible = part.visible;
        }
      }
    } else {
      try {
        if (targetState) viewerInstance.show(id);
        else viewerInstance.hide(id);
      } catch {
        // Abaikan
      }
    }
  }

  viewerInstance.impl?.invalidate?.(true, true, true);
  notifyHierarchyChanged();
  return Boolean(targetState);
}

/**
 * Menyembunyikan (atau toggle hide/unhide) part yang sedang dipilih.
 */
export function hideSelected() {
  const selected = Array.from(selectedDbIdSet);
  if (selected.length === 0) return false;
  return setPartsVisibility(selected, undefined);
}

/**
 * Meng-isolate part yang sedang dipilih (menyembunyikan semua part lain).
 */
export function isolateSelected() {
  const selected = Array.from(selectedDbIdSet);
  if (selected.length === 0) return false;
  isolateAndFocusDbIds(selected, null, false);
  return true;
}

/**
 * Meng-isolate daftar `dbIds` tertentu (dan opsional fokus ke salah satu dbId).
 * @param {number[]} dbIds
 * @param {number | null} [focusSingleId=null]
 * @param {boolean} [shouldZoom=true]
 */
export function isolateAndFocusDbIds(dbIds, focusSingleId = null, shouldZoom = true) {
  if (!viewerInstance || !dbIds || dbIds.length === 0) return;
  const keepSet = new Set(dbIds.map(Number));
  const fragList = viewerInstance.model?.getFragmentList?.();

  if (partRegistry.size > 0) {
    for (const part of partRegistry.values()) {
      const shouldShow = keepSet.has(part.dbId);
      part.visible = shouldShow;
      if (fragList && part.fragIds) {
        for (const fragId of part.fragIds) {
          try {
            fragList.setFragOff(fragId, !shouldShow);
          } catch {
            // Abaikan
          }
        }
      }
      if (part.meshes) {
        for (const m of part.meshes) {
          m.visible = shouldShow;
        }
      }
    }
  } else {
    try {
      viewerInstance.isolate(dbIds);
    } catch {
      // Abaikan
    }
  }

  const targetFocus = focusSingleId !== null ? [Number(focusSingleId)] : Array.from(keepSet);
  applyVisualSelectionHighlight(targetFocus);
  notifySelectionChanged(targetFocus);
  notifyHierarchyChanged();

  if (shouldZoom) {
    focusOnDbIds(targetFocus);
  } else {
    viewerInstance.impl?.invalidate?.(true, true, true);
  }
}

/**
 * Menampilkan kembali seluruh part yang tersembunyi (`Show All` / Reset Isolate & Hide).
 */
export function showAllObjects() {
  if (!viewerInstance) return;
  const fragList = viewerInstance.model?.getFragmentList?.();

  for (const part of partRegistry.values()) {
    part.visible = true;
    if (fragList && part.fragIds) {
      for (const fragId of part.fragIds) {
        try {
          fragList.setFragOff(fragId, false);
        } catch {
          // Abaikan
        }
      }
    }
    if (part.meshes) {
      for (const m of part.meshes) {
        m.visible = true;
      }
    }
  }

  try {
    viewerInstance.isolate([]);
    viewerInstance.showAll();
  } catch {
    // Abaikan
  }

  clearPartSelection();
  viewerInstance.impl?.invalidate?.(true, true, true);
  notifyHierarchyChanged();
}

/**
 * Mencari elemen 3D berdasarkan kata kunci nama atau nilai properti BIM.
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

  if (partRegistry.size > 0) {
    const matchedIds = [];
    for (const [dbId, part] of partRegistry.entries()) {
      const haystack = [
        part.name,
        part.category,
        part.system,
        part.material,
        ...Object.values(part.specs || {})
      ]
        .join(' ')
        .toLowerCase();

      if (haystack.includes(cleanQuery)) {
        matchedIds.push(dbId);
      }
    }
    return matchedIds;
  }

  return new Promise((resolve) => {
    viewerInstance.search(
      cleanQuery,
      (dbIds) => resolve(Array.isArray(dbIds) ? dbIds : []),
      () => resolve([])
    );
  });
}

export function toggleGhosting() {
  if (!viewerInstance) return currentGhostingState;
  currentGhostingState = !currentGhostingState;
  viewerInstance.setGhosting(currentGhostingState);
  return currentGhostingState;
}

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

export function setExplodeScale(scale) {
  if (!viewerInstance) return;
  const val = Math.max(0, Math.min(1, Number(scale || 0)));
  viewerInstance.explode(val);
}

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

export function applyViewerTheme(theme) {
  if (!viewerInstance) return;

  if (theme === 'light') {
    viewerInstance.setBackgroundColor(238, 242, 246, 203, 213, 225);
    viewerInstance.setLightPreset(4);
  } else if (theme === 'sky') {
    viewerInstance.setBackgroundColor(135, 185, 228, 226, 236, 245);
    viewerInstance.setLightPreset(7);
  } else {
    viewerInstance.setBackgroundColor(16, 23, 36, 8, 12, 20);
    viewerInstance.setLightPreset(1);
  }
}

export function getActiveModelIdForViewpoints() {
  return currentLoadedModelId || 'global_default';
}

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

export function saveCurrentViewpoint(viewpointName, modelId = getActiveModelIdForViewpoints()) {
  if (!viewerInstance || !viewerInstance.impl?.camera) {
    throw new Error('3D Viewer belum aktif.');
  }

  const cam = viewerInstance.impl.camera;
  const customCamState = {
    position: [cam.position.x, cam.position.y, cam.position.z],
    target: [controlsState.target.x, controlsState.target.y, controlsState.target.z],
    up: [cam.up.x, cam.up.y, cam.up.z]
  };

  const viewerState = viewerInstance.getState({
    viewport: true,
    cutplanes: true,
    objectSet: false,
    renderOptions: false
  });

  const existing = getSavedViewpoints(modelId);
  const newVp = {
    id: `vp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: (viewpointName || '').trim() || `Viewpoint #${existing.length + 1}`,
    createdAt: new Date().toISOString(),
    state: viewerState,
    customCamera: customCamState
  };

  existing.unshift(newVp);
  localStorage.setItem(VIEWPOINTS_STORAGE_PREFIX + modelId, JSON.stringify(existing));
  return newVp;
}

export function restoreSavedViewpoint(viewpointObj) {
  if (!viewerInstance || !viewpointObj) return;
  const THREE = window.THREE;

  if (viewpointObj.customCamera) {
    const { position, target } = viewpointObj.customCamera;
    if (Array.isArray(position) && Array.isArray(target)) {
      animateCameraTransition(
        new THREE.Vector3(position[0], position[1], position[2]),
        new THREE.Vector3(target[0], target[1], target[2]),
        300
      );
      return;
    }
  }

  if (viewpointObj.state) {
    viewerInstance.restoreState(viewpointObj.state);
  }
}

export function deleteSavedViewpoint(viewpointId, modelId = getActiveModelIdForViewpoints()) {
  const existing = getSavedViewpoints(modelId);
  const filtered = existing.filter((v) => v.id !== viewpointId);
  localStorage.setItem(VIEWPOINTS_STORAGE_PREFIX + modelId, JSON.stringify(filtered));
  return filtered;
}
