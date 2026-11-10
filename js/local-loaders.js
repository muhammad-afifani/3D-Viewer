/**
 * ============================================================================
 * js/local-loaders.js — 100% Client-Side Offline 3D/BIM Parser Engine
 *                       & No-Credit-Card NWD Extractor
 * ============================================================================
 * Memungkinkan user membuka model 3D/BIM secara 100% OFFLINE tanpa memerlukan
 * akun berbayar / Kartu Kredit di Autodesk Platform Services (APS):
 *
 * 1. Direct Local 3D/BIM Parsers (berjalan murni di browser):
 *    - .GLB / .GLTF (glTF 2.0 Binary & JSON lengkap dengan hierarki node & warna)
 *    - .IFC (STEP Physical File parser untuk geometri BIM & properti IFC)
 *    - .OBJ (Wavefront 3D CAD Object dengan pemisahan grup/komponen)
 *    - .STL (Binary & ASCII Stereolithography CAD Mesh)
 *    - .NWDJSON / nwd-extracted-scene.json (Hasil ekstraksi 1-klik dari
 *      viewer.autodesk.com gratis tanpa kartu kredit)
 *
 * 2. Generator Script Ekstraktor 1-Klik untuk viewer.autodesk.com:
 *    Mengekstrak seluruh mesh 3D, transformasi matriks, warna material,
 *    pohon objek, dan properti BIM dari file .NWD yang dibuka di
 *    https://viewer.autodesk.com menjadi paket offline yang siap dibuka kapan saja.
 */

/**
 * Menghitung vertex normals secara otomatis jika geometri belum memiliki normal.
 * @param {Float32Array} positions
 * @param {Uint32Array|Uint16Array|null} indices
 * @returns {Float32Array}
 */
export function computeVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);

  if (indices && indices.length >= 3) {
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      const ax = positions[i0],
        ay = positions[i0 + 1],
        az = positions[i0 + 2];
      const bx = positions[i1],
        by = positions[i1 + 1],
        bz = positions[i1 + 2];
      const cx = positions[i2],
        cy = positions[i2 + 1],
        cz = positions[i2 + 2];

      const abx = bx - ax,
        aby = by - ay,
        abz = bz - az;
      const acx = cx - ax,
        acy = cy - ay,
        acz = cz - az;

      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;

      normals[i0] += nx;
      normals[i0 + 1] += ny;
      normals[i0 + 2] += nz;
      normals[i1] += nx;
      normals[i1 + 1] += ny;
      normals[i1 + 2] += nz;
      normals[i2] += nx;
      normals[i2 + 1] += ny;
      normals[i2 + 2] += nz;
    }
  } else {
    for (let i = 0; i < positions.length; i += 9) {
      const ax = positions[i],
        ay = positions[i + 1],
        az = positions[i + 2];
      const bx = positions[i + 3],
        by = positions[i + 4],
        bz = positions[i + 5];
      const cx = positions[i + 6],
        cy = positions[i + 7],
        cz = positions[i + 8];

      const abx = bx - ax,
        aby = by - ay,
        abz = bz - az;
      const acx = cx - ax,
        acy = cy - ay,
        acz = cz - az;

      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;

      for (let k = 0; k < 9; k += 3) {
        normals[i + k] = nx;
        normals[i + k + 1] = ny;
        normals[i + k + 2] = nz;
      }
    }
  }

  // Normalisasi panjang vektor normal
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i],
      y = normals[i + 1],
      z = normals[i + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i] = x / len;
    normals[i + 1] = y / len;
    normals[i + 2] = z / len;
  }

  return normals;
}

/**
 * Mengalikan matriks 4x4 (column-major seperti Three.js / WebGL).
 */
function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/**
 * Menyusun matriks 4x4 dari translation [x,y,z], quaternion [x,y,z,w], dan scale [x,y,z].
 */
function composeTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;

  const sx = s[0],
    sy = s[1],
    sz = s[2];
  const out = new Float32Array(16);

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;

  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;

  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;

  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  out[15] = 1;

  return out;
}

function applyMat4ToPositions(positions, m) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/**
 * ============================================================================
 * 1. PARSER FORMAT .GLB / .GLTF (glTF 2.0 Binary & JSON)
 * ============================================================================
 */
export async function parseGltfOrGlbBuffer(arrayBuffer, fileName) {
  const dataView = new DataView(arrayBuffer);
  let json = null;
  let binBuffer = null;

  // Cek magic header 'glTF' (0x46546C67)
  if (arrayBuffer.byteLength >= 12 && dataView.getUint32(0, true) === 0x46546c67) {
    const totalLength = dataView.getUint32(8, true);
    let offset = 12;

    while (offset + 8 <= Math.min(totalLength, arrayBuffer.byteLength)) {
      const chunkLen = dataView.getUint32(offset, true);
      const chunkType = dataView.getUint32(offset + 4, true);
      offset += 8;

      if (chunkType === 0x4e4f534a) {
        // JSON chunk
        const jsonBytes = new Uint8Array(arrayBuffer, offset, chunkLen);
        json = JSON.parse(new TextDecoder().decode(jsonBytes));
      } else if (chunkType === 0x004e4942) {
        // BIN chunk
        binBuffer = arrayBuffer.slice(offset, offset + chunkLen);
      }
      offset += chunkLen;
    }
  } else {
    // Plain JSON .gltf
    const text = new TextDecoder().decode(new Uint8Array(arrayBuffer));
    json = JSON.parse(text);
  }

  if (!json) {
    throw new Error('File GLB/GLTF tidak valid atau gagal dibaca.');
  }

  // Siapkan buffers (termasuk data URI base64 jika .gltf)
  const buffers = [];
  for (let i = 0; i < (json.buffers || []).length; i++) {
    const bufDef = json.buffers[i];
    if (i === 0 && !bufDef.uri && binBuffer) {
      buffers.push(binBuffer);
    } else if (bufDef.uri && bufDef.uri.startsWith('data:')) {
      const base64Part = bufDef.uri.split(',')[1] || '';
      const binaryStr = atob(base64Part);
      const u8 = new Uint8Array(binaryStr.length);
      for (let j = 0; j < binaryStr.length; j++) {
        u8[j] = binaryStr.charCodeAt(j);
      }
      buffers.push(u8.buffer);
    } else if (binBuffer) {
      buffers.push(binBuffer);
    }
  }

  const componentTypeMap = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5125: Uint32Array,
    5126: Float32Array
  };

  const numComponentsMap = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT4: 16
  };

  function readAccessor(accessorIdx) {
    if (accessorIdx === undefined || accessorIdx === null) return null;
    const acc = json.accessors?.[accessorIdx];
    if (!acc) return null;
    const bv = json.bufferViews?.[acc.bufferView];
    if (!bv) return null;
    const rawBuf = buffers[bv.buffer || 0];
    if (!rawBuf) return null;

    const TypedArr = componentTypeMap[acc.componentType] || Float32Array;
    const numComp = numComponentsMap[acc.type] || 1;
    const count = acc.count * numComp;
    const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const byteStride = bv.byteStride || 0;
    const elemSize = TypedArr.BYTES_PER_ELEMENT;

    if (!byteStride || byteStride === numComp * elemSize) {
      return new TypedArr(rawBuf, byteOffset, count);
    }

    // Interleaved bufferView
    const out = new TypedArr(count);
    const dv = new DataView(rawBuf);
    for (let i = 0; i < acc.count; i++) {
      const base = byteOffset + i * byteStride;
      for (let c = 0; c < numComp; c++) {
        const pos = base + c * elemSize;
        if (acc.componentType === 5126) out[i * numComp + c] = dv.getFloat32(pos, true);
        else if (acc.componentType === 5123) out[i * numComp + c] = dv.getUint16(pos, true);
        else if (acc.componentType === 5125) out[i * numComp + c] = dv.getUint32(pos, true);
        else if (acc.componentType === 5121) out[i * numComp + c] = dv.getUint8(pos);
      }
    }
    return out;
  }

  const items = [];
  const palette = [0x38bdf8, 0x10b981, 0xf59e0b, 0x60a5fa, 0xa78bfa, 0x34d399, 0xf87171];

  function traverseNode(nodeIdx, parentMat) {
    const node = json.nodes?.[nodeIdx];
    if (!node) return;

    let localMat;
    if (Array.isArray(node.matrix) && node.matrix.length === 16) {
      localMat = new Float32Array(node.matrix);
    } else {
      localMat = composeTRS(node.translation, node.rotation, node.scale);
    }
    const worldMat = parentMat ? multiplyMat4(parentMat, localMat) : localMat;

    if (node.mesh !== undefined && json.meshes?.[node.mesh]) {
      const meshDef = json.meshes[node.mesh];
      const primitives = meshDef.primitives || [];

      primitives.forEach((prim, primIdx) => {
        if (prim.mode !== undefined && prim.mode !== 4) return; // Hanya TRIANGLES (mode 4)
        const rawPos = readAccessor(prim.attributes?.POSITION);
        if (!rawPos || rawPos.length < 9) return;

        const positions = applyMat4ToPositions(new Float32Array(rawPos), worldMat);
        const rawIndices = readAccessor(prim.indices);
        const indices = rawIndices ? new Uint32Array(rawIndices) : null;
        const normals = computeVertexNormals(positions, indices);

        let colorHex = palette[items.length % palette.length];
        let matName = 'GLTF Standard Material';
        if (prim.material !== undefined && json.materials?.[prim.material]) {
          const matDef = json.materials[prim.material];
          matName = matDef.name || `Material #${prim.material}`;
          const baseColor = matDef.pbrMetallicRoughness?.baseColorFactor;
          if (Array.isArray(baseColor) && baseColor.length >= 3) {
            const r = Math.round(Math.min(1, Math.max(0, baseColor[0])) * 255);
            const g = Math.round(Math.min(1, Math.max(0, baseColor[1])) * 255);
            const b = Math.round(Math.min(1, Math.max(0, baseColor[2])) * 255);
            colorHex = (r << 16) | (g << 8) | b;
          }
        }

        const baseName =
          node.name ||
          meshDef.name ||
          `${fileName.replace(/\.[^.]+$/, '')}_Element_${items.length + 1}`;
        const fullName = primitives.length > 1 ? `${baseName} [Part ${primIdx + 1}]` : baseName;

        const extraSpecs = {};
        if (node.extras && typeof node.extras === 'object') {
          for (const [k, v] of Object.entries(node.extras)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              extraSpecs[k] = String(v);
            }
          }
        }

        items.push({
          name: fullName,
          category: extraSpecs.Category || extraSpecs.category || '3D Model Component',
          system: extraSpecs.System || extraSpecs.system || fileName,
          materialName: matName,
          colorHex,
          positions,
          normals,
          indices,
          specs: {
            'Element Name': fullName,
            'Source File': fileName,
            Material: matName,
            Vertices: String(Math.floor(positions.length / 3)),
            Triangles: String(
              indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9)
            ),
            ...extraSpecs
          }
        });
      });
    }

    if (Array.isArray(node.children)) {
      for (const childIdx of node.children) {
        traverseNode(childIdx, worldMat);
      }
    }
  }

  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const defaultSceneIdx = json.scene || 0;
  const scene = json.scenes?.[defaultSceneIdx];

  if (scene && Array.isArray(scene.nodes)) {
    for (const rootNodeIdx of scene.nodes) {
      traverseNode(rootNodeIdx, identity);
    }
  } else if (Array.isArray(json.nodes)) {
    for (let i = 0; i < json.nodes.length; i++) {
      traverseNode(i, identity);
    }
  }

  if (items.length === 0) {
    throw new Error('Tidak ditemukan geometri mesh segitiga di dalam file GLB/GLTF.');
  }

  return items;
}

/**
 * ============================================================================
 * 2. PARSER FORMAT .OBJ (Wavefront 3D CAD Object)
 * ============================================================================
 */
export function parseObjBuffer(arrayBuffer, fileName) {
  const text = new TextDecoder().decode(new Uint8Array(arrayBuffer));
  const lines = text.split(/\r?\n/);

  const globalVerts = [0, 0, 0]; // 1-indexed dummy
  const groups = new Map();
  let currentGroupName = fileName.replace(/\.[^.]+$/, '') || 'OBJ_Mesh';
  let currentMaterial = 'Default CAD Material';

  function getGroup(name) {
    if (!groups.has(name)) {
      groups.set(name, {
        name,
        material: currentMaterial,
        positions: []
      });
    }
    return groups.get(name);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/);
      globalVerts.push(
        parseFloat(parts[1]) || 0,
        parseFloat(parts[2]) || 0,
        parseFloat(parts[3]) || 0
      );
    } else if (line.startsWith('o ') || line.startsWith('g ')) {
      const gName = line.slice(2).trim();
      if (gName) currentGroupName = gName;
    } else if (line.startsWith('usemtl ')) {
      currentMaterial = line.slice(7).trim() || currentMaterial;
    } else if (line.startsWith('f ')) {
      const parts = line.split(/\s+/).slice(1);
      if (parts.length < 3) continue;

      const faceVertIndices = parts.map((tok) => {
        const vIdxRaw = parseInt(tok.split('/')[0], 10);
        const totalV = Math.floor(globalVerts.length / 3) - 1;
        return vIdxRaw < 0 ? totalV + 1 + vIdxRaw : vIdxRaw;
      });

      const grp = getGroup(currentGroupName);
      const v0 = faceVertIndices[0] * 3;
      for (let t = 1; t < faceVertIndices.length - 1; t++) {
        const v1 = faceVertIndices[t] * 3;
        const v2 = faceVertIndices[t + 1] * 3;
        grp.positions.push(
          globalVerts[v0] || 0,
          globalVerts[v0 + 1] || 0,
          globalVerts[v0 + 2] || 0,
          globalVerts[v1] || 0,
          globalVerts[v1 + 1] || 0,
          globalVerts[v1 + 2] || 0,
          globalVerts[v2] || 0,
          globalVerts[v2 + 1] || 0,
          globalVerts[v2 + 2] || 0
        );
      }
    }
  }

  const palette = [0x38bdf8, 0x10b981, 0xf59e0b, 0x94a3b8, 0x60a5fa, 0xf97316];
  const items = [];
  let idx = 0;

  for (const grp of groups.values()) {
    if (grp.positions.length < 9) continue;
    const posArr = new Float32Array(grp.positions);
    const normArr = computeVertexNormals(posArr, null);
    items.push({
      name: grp.name,
      category: 'CAD Solid / Mesh',
      system: fileName,
      materialName: grp.material,
      colorHex: palette[idx % palette.length],
      positions: posArr,
      normals: normArr,
      indices: null,
      specs: {
        'Object Name': grp.name,
        Material: grp.material,
        Triangles: String(Math.floor(posArr.length / 9)),
        'Source Format': 'Wavefront OBJ'
      }
    });
    idx++;
  }

  if (items.length === 0) {
    throw new Error('File OBJ tidak memiliki poligon 3D yang valid.');
  }
  return items;
}

/**
 * ============================================================================
 * 3. PARSER FORMAT .STL (Binary & ASCII Stereolithography CAD)
 * ============================================================================
 */
export function parseStlBuffer(arrayBuffer, fileName) {
  const dv = new DataView(arrayBuffer);
  let isBinary = false;

  if (arrayBuffer.byteLength >= 84) {
    const triCount = dv.getUint32(80, true);
    const expectedBytes = 84 + triCount * 50;
    if (
      expectedBytes === arrayBuffer.byteLength ||
      (triCount > 0 && expectedBytes <= arrayBuffer.byteLength + 64 && expectedBytes > 84)
    ) {
      isBinary = true;
    }
  }

  let positions;
  if (isBinary) {
    const triCount = dv.getUint32(80, true);
    positions = new Float32Array(triCount * 9);
    let offset = 84;
    let pIdx = 0;

    for (let t = 0; t < triCount; t++) {
      if (offset + 50 > arrayBuffer.byteLength) break;
      offset += 12; // lewati normal вектор (12 byte)
      for (let v = 0; v < 9; v++) {
        positions[pIdx++] = dv.getFloat32(offset, true);
        offset += 4;
      }
      offset += 2; // attribute byte count
    }
  } else {
    const text = new TextDecoder().decode(new Uint8Array(arrayBuffer));
    const coords = [];
    const vertRegex = /vertex\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
    let match;
    while ((match = vertRegex.exec(text)) !== null) {
      coords.push(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
    }
    positions = new Float32Array(coords);
  }

  if (!positions || positions.length < 9) {
    throw new Error('File STL kosong atau tidak memiliki segitiga 3D.');
  }

  const normals = computeVertexNormals(positions, null);
  const cleanName = fileName.replace(/\.[^.]+$/, '');

  return [
    {
      name: cleanName,
      category: 'CAD Solid Geometry',
      system: fileName,
      materialName: 'Metallic CAD Surface',
      colorHex: 0x38bdf8,
      positions,
      normals,
      indices: null,
      specs: {
        'Part Name': cleanName,
        Format: isBinary ? 'Binary STL' : 'ASCII STL',
        Triangles: String(Math.floor(positions.length / 9)),
        Vertices: String(Math.floor(positions.length / 3))
      }
    }
  ];
}

/**
 * ============================================================================
 * 4. PARSER FORMAT .IFC (Industry Foundation Classes — WebAssembly Web-IFC)
 *    Menggunakan engine C++ WebAssembly resmi `web-ifc` (`./vendor/web-ifc-api.js`
 *    & `./vendor/web-ifc.wasm`) untuk mengekstrak seluruh geometri CSG/Boolean,
 *    SweptDiskSolid (pipa), RevolvedAreaSolid, ExtrudedAreaSolid, Brep,
 *    serta mentransformasikannya dengan matriks rotasi + translasi 4x4 dan
 *    `COORDINATE_TO_ORIGIN: true` (bebas dari artefak floating-point jitter!).
 * ============================================================================
 */
let webIfcApiSingleton = null;

async function getInitializedWebIfcApi() {
  if (webIfcApiSingleton) return webIfcApiSingleton;

  const WebIFC = await import('./vendor/web-ifc-api.js');
  const api = new WebIFC.IfcAPI();

  // Gunakan URL absolut ke ./js/vendor/web-ifc.wasm agar aman di sub-path GitHub Pages maupun localhost
  const wasmDirUrl = new URL('./vendor/', import.meta.url).href;
  await api.Init((path) => {
    if (path.endsWith('.wasm')) {
      return new URL(path, wasmDirUrl).href;
    }
    return path;
  });

  webIfcApiSingleton = api;
  return api;
}

export async function parseIfcBuffer(arrayBuffer, fileName) {
  const ifcApi = await getInitializedWebIfcApi();
  const uint8Data = new Uint8Array(arrayBuffer);

  // Buka model IFC dengan COORDINATE_TO_ORIGIN: true agar koordinat proyek besar
  // otomatis dipusatkan ke (0,0,0) dan mencegah mesh pecah/bergaris di WebGL!
  const modelID = ifcApi.OpenModel(uint8Data, {
    COORDINATE_TO_ORIGIN: true,
    CIRCLE_SEGMENTS: 16
  });

  if (modelID === -1) {
    throw new Error('Gagal membuka file IFC (skema tidak didukung atau file rusak).');
  }

  const items = [];

  try {
    ifcApi.StreamAllMeshes(modelID, (flatMesh) => {
      const expressID = flatMesh.expressID;
      const placedGeometries = flatMesh.geometries;
      const geomCount = placedGeometries.size();
      if (geomCount === 0) return;

      // Gabungkan seluruh sub-geometri milik elemen BIM (expressID) ini
      const posChunks = [];
      const normChunks = [];
      let totalVerticesFloats = 0;
      let primaryColorHex = 0x38bdf8;
      let hasColor = false;

      for (let i = 0; i < geomCount; i++) {
        const placed = placedGeometries.get(i);
        const geom = ifcApi.GetGeometry(modelID, placed.geometryExpressID);
        const vPtr = geom.GetVertexData();
        const vSize = geom.GetVertexDataSize();
        const iPtr = geom.GetIndexData();
        const iSize = geom.GetIndexDataSize();

        if (vSize === 0 || iSize === 0) {
          geom.delete();
          continue;
        }

        // Interleaved buffer dari web-ifc: [px, py, pz, nx, ny, nz] (6 float per vertex)
        const verts = ifcApi.GetVertexArray(vPtr, vSize);
        const indices = ifcApi.GetIndexArray(iPtr, iSize);
        const m = placed.flatTransformation; // Matriks 4x4 column-major

        // Warna material RGBA dari IFC
        if (!hasColor && placed.color) {
          const r = Math.round(Math.min(1, Math.max(0, placed.color.x)) * 255);
          const g = Math.round(Math.min(1, Math.max(0, placed.color.y)) * 255);
          const b = Math.round(Math.min(1, Math.max(0, placed.color.z)) * 255);
          if (r > 5 || g > 5 || b > 5) {
            primaryColorHex = (r << 16) | (g << 8) | b;
            hasColor = true;
          }
        }

        const subPos = new Float32Array(indices.length * 3);
        const subNorm = new Float32Array(indices.length * 3);

        for (let k = 0; k < indices.length; k++) {
          const vBase = indices[k] * 6;
          const vx = verts[vBase] || 0;
          const vy = verts[vBase + 1] || 0;
          const vz = verts[vBase + 2] || 0;

          const nx = verts[vBase + 3] || 0;
          const ny = verts[vBase + 4] || 0;
          const nz = verts[vBase + 5] || 1;

          // Transformasi posisi vertex dengan matriks 4x4 (m)
          const tx = m[0] * vx + m[4] * vy + m[8] * vz + m[12];
          const ty = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
          const tz = m[2] * vx + m[6] * vy + m[10] * vz + m[14];

          // Transformasi arah normal dengan matriks rotasi 3x3
          let tnx = m[0] * nx + m[4] * ny + m[8] * nz;
          let tny = m[1] * nx + m[5] * ny + m[9] * nz;
          let tnz = m[2] * nx + m[6] * ny + m[10] * nz;
          const nLen = Math.hypot(tnx, tny, tnz) || 1;
          tnx /= nLen;
          tny /= nLen;
          tnz /= nLen;

          const outIdx = k * 3;
          subPos[outIdx] = tx;
          subPos[outIdx + 1] = ty;
          subPos[outIdx + 2] = tz;

          subNorm[outIdx] = tnx;
          subNorm[outIdx + 1] = tny;
          subNorm[outIdx + 2] = tnz;
        }

        posChunks.push(subPos);
        normChunks.push(subNorm);
        totalVerticesFloats += subPos.length;
        geom.delete();
      }

      if (totalVerticesFloats < 9) return;

      const mergedPos = new Float32Array(totalVerticesFloats);
      const mergedNorm = new Float32Array(totalVerticesFloats);
      let offset = 0;
      for (let c = 0; c < posChunks.length; c++) {
        mergedPos.set(posChunks[c], offset);
        mergedNorm.set(normChunks[c], offset);
        offset += posChunks[c].length;
      }

      // Ambil metadata BIM (Name, GlobalId, ObjectType, Tag, Description) dari baris STEP
      let elemName = `IFC Element #${expressID}`;
      let entityTypeName = 'IFC Product';
      let globalId = `EXP_${expressID}`;
      let objectType = '-';
      let tagVal = '-';
      let descVal = '-';

      try {
        const typeCode = ifcApi.GetLineType(modelID, expressID);
        if (typeCode) {
          entityTypeName = ifcApi.GetNameFromTypeCode(typeCode) || entityTypeName;
        }
        const lineData = ifcApi.GetLine(modelID, expressID, false);
        if (lineData) {
          if (lineData.Name?.value) elemName = String(lineData.Name.value);
          else if (lineData.LongName?.value) elemName = String(lineData.LongName.value);
          else elemName = `${entityTypeName} #${expressID}`;

          if (lineData.GlobalId?.value) globalId = String(lineData.GlobalId.value);
          if (lineData.ObjectType?.value) objectType = String(lineData.ObjectType.value);
          if (lineData.Tag?.value) tagVal = String(lineData.Tag.value);
          if (lineData.Description?.value) descVal = String(lineData.Description.value);
        }
      } catch {
        // Abaikan jika properti opsional tidak tersedia pada elemen tertentu
      }

      items.push({
        name: `${elemName} [${entityTypeName}]`,
        category: entityTypeName,
        system: fileName,
        materialName: `IFC ${entityTypeName}`,
        colorHex: primaryColorHex,
        positions: mergedPos,
        normals: mergedNorm,
        indices: null,
        specs: {
          'Item Name': elemName,
          'IFC Class': entityTypeName,
          'Express ID': `#${expressID}`,
          GlobalId: globalId,
          'Object Type': objectType,
          Tag: tagVal,
          Description: descVal,
          Triangles: String(Math.floor(totalVerticesFloats / 9))
        }
      });
    });
  } finally {
    ifcApi.CloseModel(modelID);
  }

  if (items.length === 0) {
    throw new Error('Tidak ditemukan geometri 3D di dalam file IFC ini.');
  }

  return items;
}

/**
 * ============================================================================
 * 5. PARSER UNIVERSAL UNTUK FILE LOKAL (.GLB, .GLTF, .IFC, .OBJ, .STL, .NWDJSON)
 * ============================================================================
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} fileName
 * @returns {Promise<Array<Object>>} Daftar komponen mesh 3D + metadata BIM
 */
export async function parseLocal3DFile(arrayBuffer, fileName) {
  const lower = String(fileName || '').toLowerCase();

  if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
    return parseGltfOrGlbBuffer(arrayBuffer, fileName);
  }
  if (lower.endsWith('.obj')) {
    return parseObjBuffer(arrayBuffer, fileName);
  }
  if (lower.endsWith('.stl')) {
    return parseStlBuffer(arrayBuffer, fileName);
  }
  if (lower.endsWith('.ifc')) {
    return parseIfcBuffer(arrayBuffer, fileName);
  }
  if (lower.endsWith('.nwdjson') || lower.endsWith('.json')) {
    const text = new TextDecoder().decode(new Uint8Array(arrayBuffer));
    const parsed = JSON.parse(text);
    const rawMeshes = Array.isArray(parsed.meshes) ? parsed.meshes : [];
    if (rawMeshes.length === 0) {
      throw new Error('File JSON/NWDJSON tidak berisi daftar mesh 3D yang valid.');
    }
    return rawMeshes.map((m) => {
      const positions = new Float32Array(m.positions || []);
      const indices = m.indices ? new Uint32Array(m.indices) : null;
      const normals = m.normals
        ? new Float32Array(m.normals)
        : computeVertexNormals(positions, indices);
      return {
        name: m.name || 'NWD Element',
        category: m.category || 'Navisworks Component',
        system: m.system || parsed.modelName || fileName,
        materialName: m.materialName || 'Autodesk Material',
        colorHex: Number(m.colorHex || 0x38bdf8),
        positions,
        normals,
        indices,
        specs: m.specs || {
          'Item Name': m.name || 'NWD Element',
          Source: 'Extracted from Autodesk Viewer'
        }
      };
    });
  }

  throw new Error(
    `Format file "${fileName}" belum didukung secara langsung. Gunakan .GLB, .GLTF, .IFC, .OBJ, .STL, .NWDPACK.ZIP, atau .NWDJSON.`
  );
}

/**
 * ============================================================================
 * 6. GENERATOR SCRIPT 1-KLIK EKSTRAKTOR .NWD DARI VIEWER.AUTODESK.COM
 *    (100% Gratis Tanpa Kartu Kredit)
 * ============================================================================
 * Menghasilkan script JavaScript mandiri yang dapat ditempel ke Console (F12)
 * pada https://viewer.autodesk.com saat model .NWD sedang terbuka, untuk
 * mengekstrak seluruh geometri 3D, matriks dunia, warna material, dan nama
 * komponen menjadi satu file `.nwdjson` yang bisa langsung dibuka 100% Offline!
 */
export function getFreeAutodeskViewerExtractorScript() {
  return `(function(){
  const v = window.NOP_VIEWER || (window.NOP_VIEWERS && window.NOP_VIEWERS[0]);
  if (!v || !v.model) {
    alert("Buka dan tunggu hingga model 3D .NWD selesai tampil di viewer.autodesk.com terlebih dahulu!");
    return;
  }
  const model = v.model;
  const fragList = model.getFragmentList();
  const tree = model.getInstanceTree ? model.getInstanceTree() : null;
  const count = fragList.getCount();
  const meshes = [];
  const mat4 = new window.THREE.Matrix4();
  const vec3 = new window.THREE.Vector3();

  // Helper mengambil dbId untuk setiap fragId
  const frag2dbId = fragList.fragments?.fragId2dbId || (fragList.getFragIdToDbIdMap ? fragList.getFragIdToDbIdMap() : null);

  for (let fragId = 0; fragId < count; fragId++) {
    const vizmesh = fragList.getVizmesh(fragId);
    if (!vizmesh || !vizmesh.geometry) continue;
    const geom = vizmesh.geometry;
    fragList.getWorldMatrix(fragId, mat4);

    let dbId = frag2dbId ? frag2dbId[fragId] : (fragList.getDbIds ? fragList.getDbIds(fragId) : fragId);
    if (Array.isArray(dbId)) dbId = dbId[0];
    if (typeof dbId !== 'number') dbId = fragId;

    let name = "Component_" + dbId;
    if (tree && typeof tree.getNodeName === 'function') {
      try {
        name = tree.getNodeName(dbId) || name;
      } catch(e){}
    }

    let posOut = [];
    if (geom.vb && geom.vbstride) {
      const vb = geom.vb;
      const stride = geom.vbstride;
      const offset = (geom.attributes && geom.attributes.position && geom.attributes.position.itemOffset) || 0;
      const vCount = Math.floor(vb.length / stride);
      for (let i = 0; i < vCount; i++) {
        const b = i * stride + offset;
        vec3.set(vb[b], vb[b+1], vb[b+2]).applyMatrix4(mat4);
        posOut.push(Number(vec3.x.toFixed(4)), Number(vec3.y.toFixed(4)), Number(vec3.z.toFixed(4)));
      }
    } else if (geom.attributes && geom.attributes.position && geom.attributes.position.array) {
      const arr = geom.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        vec3.set(arr[i], arr[i+1], arr[i+2]).applyMatrix4(mat4);
        posOut.push(Number(vec3.x.toFixed(4)), Number(vec3.y.toFixed(4)), Number(vec3.z.toFixed(4)));
      }
    }
    if (posOut.length < 9) continue;

    const rawIb = geom.ib || (geom.attributes && geom.attributes.index && geom.attributes.index.array);
    const indices = rawIb ? Array.from(rawIb) : null;

    let colorHex = 0x38bdf8;
    const mat = fragList.getMaterial(fragId);
    if (mat && mat.color && typeof mat.color.getHex === 'function') {
      colorHex = mat.color.getHex();
    }

    meshes.push({
      dbId: dbId,
      name: name,
      category: "Navisworks Element",
      colorHex: colorHex,
      positions: posOut,
      indices: indices,
      specs: { "Item Name": name, "Element dbId": String(dbId) }
    });
  }

  const payload = JSON.stringify({
    format: "nwd-offline-scene",
    exportedAt: new Date().toISOString(),
    modelName: "Extracted_Model.nwd",
    meshes: meshes
  });

  const blob = new Blob([payload], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "Model_Offline_Package.nwdjson";
  document.body.appendChild(a);
  a.click();
  a.remove();
  alert("Berhasil mengekstrak " + meshes.length + " komponen 3D! Silakan Drag & Drop file Model_Offline_Package.nwdjson ke aplikasi NWD Offline Viewer Anda.");
})();`;
}
