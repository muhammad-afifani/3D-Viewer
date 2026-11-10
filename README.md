# 🏗️ NWD Offline & Cloud Web Viewer (PWA)

Aplikasi web progresif (**Progressive Web App / PWA**) berbasis browser untuk mengonversi, mengekstrak, menyimpan, dan memvisualisasikan model 3D **Autodesk Navisworks (`.nwd` / `.nwc`)**, **OpenBIM (`.ifc`)**, **glTF 2.0 (`.glb` / `.gltf`)**, **Wavefront (`.obj`)**, dan **CAD Solid (`.stl`)** secara **100% Offline** di browser tanpa perlu menginstal software `.exe`, tanpa akses Administrator, dan **tanpa memerlukan Kartu Kredit**.

---

## ✨ 3 Cara Membuka Model 3D (Termasuk 2 Metode 100% Gratis Tanpa Kartu Kredit!)

### 🟢 Metode 1: Direct Offline 3D/BIM Loader (`.IFC`, `.GLB`, `.GLTF`, `.OBJ`, `.STL`) — *Tanpa Kartu Kredit & Tanpa Internet*
1. Buka tab **Offline Library** di sidebar kiri.
2. Langsung *Drag & Drop* file **`.ifc`**, **`.glb`**, **`.gltf`**, **`.obj`**, atau **`.stl`** dari komputer Anda.
3. Engine parser lokal ([`js/local-loaders.js`](file:///home/antigravity/muhammad-afifani/3D-Viewer/js/local-loaders.js)) akan memproses geometri 3D dan properti BIM secara **100% lokal di dalam browser**, menyimpannya ke **IndexedDB**, dan menampilkannya di 3D Viewer lengkap dengan fitur *Orbit, Walk (WASD), Measure, Section Box/Plane, Explode, Search, Isolate, dan Saved Viewpoints*.

### 🟢 Metode 2: Ekstrak File `.NWD` Mentah Gratis via `viewer.autodesk.com` — *Tanpa Kartu Kredit*
Jika Anda hanya memiliki file mentah **`.nwd`** dan tidak ingin mendaftarkan Kartu Kredit di portal developer APS:
1. Buka portal web gratis resmi Autodesk: **[https://viewer.autodesk.com](https://viewer.autodesk.com)** (cukup login dengan email biasa, **100% gratis tanpa kartu kredit**).
2. Upload file **`.nwd`** Anda ke `viewer.autodesk.com` dan tunggu hingga model 3D selesai tampil di layar.
3. Di aplikasi **NWD Offline & Cloud Web Viewer** kita, buka tab **Cloud .NWD** lalu klik tombol hijau **"Copy Script Ekstraktor .NWD"** (atau tarik tombol **⚡ Bookmarklet** ke bilah bookmark browser Anda).
4. Kembali ke tab `viewer.autodesk.com`, tekan tombol **`F12`** (buka tab **Console**), *Paste* script tersebut lalu tekan **`Enter`**.
5. Browser akan otomatis mengekstrak seluruh mesh 3D, posisi dunia, warna material, dan nama objek menjadi satu file **`Model_Offline_Package.nwdjson`**.
6. *Drag & Drop* file **`Model_Offline_Package.nwdjson`** tersebut ke tab **Offline Library** di aplikasi kita — model `.nwd` Anda kini tersimpan di **IndexedDB**, bisa di-export menjadi **`.nwdpack.zip`** (untuk Flashdisk), dan bisa dibuka **100% Offline selamanya**!

### 🔵 Metode 3: Direct APS Cloud Translator (Jika Memiliki `Client ID` & `Client Secret` APS)
Jika Anda memiliki kredensial API dari `aps.autodesk.com`:
1. Buka tombol **APS Settings** di pojok kanan atas, masukkan `Client ID` & `Client Secret`, lalu klik **Test Connection**.
2. Pada tab **Cloud .NWD** (Opsi 2), *Drag & Drop* file `.nwd` Anda untuk diterjemahkan ke `.svf` dan diunduh seluruh bubble-nya ke IndexedDB secara otomatis.

---

## 📁 Struktur File Proyek

```text
3D-Viewer/
├── index.html          # Layout utama bergaya aplikasi desktop CAD/BIM (Dark Mode)
├── manifest.json       # Konfigurasi PWA untuk instalasi mandiri di Chrome/Edge
├── sw.js               # Service Worker: Caching SDK Offline & Virtual Server (/local-svf/*)
├── .nojekyll           # Konfigurasi agar GitHub Pages melayani seluruh file statis
├── assets/
│   └── icon.svg        # Ikon vektor 3D CAD Isometric untuk PWA
├── css/
│   └── styles.css      # Styling workstation CAD/BIM & kustomisasi panel Autodesk Viewer
├── js/
│   ├── app.js          # Controller utama UI, manajemen tab, state, & event handler
│   ├── local-loaders.js# Parser 3D/BIM lokal (.IFC, .GLB, .OBJ, .STL, .NWDJSON) & Extractor
│   ├── aps-client.js   # Modul REST API Autodesk APS & Recursive SVF Bubble Downloader
│   ├── storage.js      # Modul IndexedDB & Export/Import paket .nwdpack.zip (JSZip)
│   └── viewer.js       # Modul GuiViewer3D, Offline Loader, Search, & Saved Viewpoints
└── README.md           # Dokumentasi lengkap instalasi & penggunaan
```

---

## 💻 Cara Pakai Mode 100% Offline di Laptop Kantor (Tanpa Admin & Tanpa Internet)

1. Buka URL GitHub Pages Anda: **[https://muhammad-afifani.github.io/3D-Viewer/](https://muhammad-afifani.github.io/3D-Viewer/)** di Google Chrome atau Microsoft Edge laptop kantor saat masih ada jaringan.
2. Klik tombol **"Cache Engine Offline"** di bagian header atas hingga muncul notifikasi bahwa seluruh modul **Autodesk Viewer v7 SDK** telah tersimpan di cache Service Worker.
3. Klik tombol **"Install PWA"** di bagian header agar aplikasi terpasang di Desktop / Start Menu laptop kantor Anda.
4. Matikan Wi-Fi / internet kapan saja — Anda tetap dapat membuka model dari daftar **IndexedDB Offline Library** atau melakukan *Drag & Drop* file `.nwdpack.zip`, `.nwdjson`, `.ifc`, `.glb`, `.obj`, dan `.stl` dari Flashdisk secara **100% Offline**!
