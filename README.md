# 🏗️ NWD Offline & Cloud Web Viewer (PWA)

Aplikasi web progresif (**Progressive Web App / PWA**) berbasis browser untuk mengonversi, mengekstrak, menyimpan, dan memvisualisasikan model 3D **Autodesk Navisworks (`.nwd` / `.nwc`)**, **Revit (`.rvt`)**, dan **IFC (`.ifc`)** secara **100% Offline** maupun **Cloud** tanpa perlu menginstal software `.exe` atau membutuhkan hak akses Administrator di laptop kantor.

---

## ✨ Fitur Utama

1. **Zero-Install & 100% Jalan di Browser (Tanpa Admin)**
   - Dibangun menggunakan **Pure HTML5, Vanilla CSS3 (Dark CAD/BIM Workstation UI), dan Vanilla JavaScript (ES Modules)**.
   - Dapat langsung di-host secara gratis di **GitHub Pages** dan di-install sebagai aplikasi mandiri (**PWA**) di Google Chrome atau Microsoft Edge.

2. **Hybrid Cloud-to-Offline Architecture**
   - **Mode Online (NWD Cloud Translator & SVF Bubble Extractor):**
     Menggunakan **Autodesk Platform Services (APS / Forge) REST API v2** langsung dari browser (*client-side*) untuk melakukan autentikasi 2-Legged OAuth2, membuat OSS Bucket, mengunggah file `.nwd` berukuran besar menggunakan *Direct-to-S3 Signed Chunked Upload*, menjalankan *Model Derivative SVF Translation Job*, lalu **membongkar `manifest.json` di dalam file `.svf` (menggunakan `JSZip`) untuk mengunduh seluruh file bubble dependen** (`.svf`, `.pf`, `.pack`, `.bin`, `Materials.json.gz`, tekstur, dan *Property Database* `objects_*.json.gz`) langsung ke **IndexedDB** browser.
   - **Mode Offline (100% Offline Viewer via Service Worker Virtual Server):**
     `sw.js` meng-cache seluruh *App Shell* beserta engine **Autodesk Viewer v7 (`viewer3D.min.js`, `style.min.css`, `lmvworker.min.js`, dan ekstensi)** serta menyediakan **Virtual Local SVF Server (`/local-svf/{modelId}/{path}`)** yang melayani request binary langsung dari **IndexedDB** saat tidak ada koneksi internet sama sekali.

3. **Offline Model Library & `.nwdpack.zip` Packager**
   - Kelola daftar model 3D yang tersimpan di **IndexedDB** lengkap dengan informasi ukuran, jumlah file, dan tanggal simpan.
   - **Export as `.zip` (`.nwdpack.zip`):** Bungkus seluruh bubble SVF dari IndexedDB menjadi satu file `.nwdpack.zip` untuk dipindahkan lewat Flashdisk dari PC rumah/pribadi ke laptop kantor yang terkunci.
   - **Import Offline `.zip` Package:** Drag & Drop file `.nwdpack.zip` di laptop kantor tanpa internet — otomatis diekstrak ke IndexedDB dan langsung dibuka di 3D Viewer.
   - **Built-in Demo Industrial Plant 3D Model:** Dilengkapi model 3D *Industrial Process Plant (Hydrotreater Unit 100)* bawaan untuk menguji seluruh fitur navigasi 3D secara instan tanpa perlu menyiapkan kredensial APS terlebih dahulu.

4. **Full Navisworks-like 3D CAD/BIM Toolbar**
   - **Orbit, Pan, Zoom, Fit to View**
   - **First-Person Walkthrough (`BIM Walk`)** dengan kontrol keyboard `W` `A` `S` `D` + `Q`/`E` + `Shift` + Mouse seperti Navisworks Freedom.
   - **Model Browser / Selection Tree** & **BIM Properties Inspector Panel** (menampilkan seluruh metadata rekayasa/engineering saat pipa, peralatan, atau struktur diklik).
   - **Measure Tool** (ukur jarak, sudut, area, dan kalibrasi).
   - **Section Analysis** (potong model 3D dengan bidang X / Y / Z atau *Section Box*).
   - **Explode Model Slider** & **Ghosting / Isolate / Hide Selected / Show All**.
   - **Search & Isolate Bar** (cari nama item/pipa/tag di dalam pohon model & properti, lalu otomatis melakukan *Isolate & Fit-to-View* dengan navigasi Next/Prev).
   - **Color Theme Switcher** (*Dark CAD Studio*, *Technical Light*, *Sky Daylight*) & **Saved Viewpoints** (simpan posisi kamera + potongan section ke `localStorage`).

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
│   ├── aps-client.js   # Modul REST API Autodesk APS & Recursive SVF Bubble Downloader
│   ├── storage.js      # Modul IndexedDB & Export/Import paket .nwdpack.zip (JSZip)
│   └── viewer.js       # Modul GuiViewer3D, Offline Loader, Search, & Saved Viewpoints
└── README.md           # Dokumentasi lengkap instalasi & penggunaan
```

---

## 🚀 1. Cara Mengaktifkan GitHub Pages di Repository Ini

Karena aplikasi ini dibuat dengan arsitektur **Zero-Build Static ES Modules**, Anda tidak perlu menjalankan `npm run build` untuk men-deploy ke GitHub Pages:

1. Buka repository GitHub ini di browser (`https://github.com/muhammad-afifani/3D-Viewer`).
2. Klik tab **Settings** di bagian atas repository.
3. Pada menu sebelah kiri, klik **Pages** (di bagian *Code and automation*).
4. Pada bagian **Build and deployment** -> **Source**, pilih **Deploy from a branch**.
5. Pada bagian **Branch**, pilih branch **`main`** dan folder **`/ (root)`**, lalu klik **Save**.
6. Tunggu sekitar 1–2 menit, lalu buka URL GitHub Pages Anda:
   👉 **`https://muhammad-afifani.github.io/3D-Viewer/`**

---

## 🔑 2. Cara Mendapatkan `Client ID` & `Client Secret` Gratis di Autodesk Platform Services (APS)

Untuk menerjemahkan file mentah `.nwd` ke format web `.svf` (Mode Online), Anda memerlukan kredensial API dari Autodesk Platform Services:

1. Kunjungi portal resmi [**https://aps.autodesk.com/**](https://aps.autodesk.com/) lalu klik **Sign In** (atau daftar akun Autodesk gratis).
2. Klik tombol **Go to my apps** di pojok kanan atas, lalu klik **Create application**.
3. Beri nama aplikasi (misalnya `NWD Offline Converter`), pilih tipe **Traditional Web App** (atau *Server-to-Server*), lalu klik **Create**.
4. Pada halaman konfigurasi aplikasi yang baru dibuat:
   - Salin **Client ID** dan **Client Secret** Anda.
   - Pastikan pada daftar API di bawahnya, opsi **Data Management API** dan **Model Derivative API** sudah dicentang (*Enabled*).
5. Buka aplikasi **NWD Offline & Cloud Web Viewer**, klik tombol **APS Settings** di pojok kanan atas:
   - Tempelkan `Client ID` dan `Client Secret` Anda.
   - Klik **Test Connection (2-Legged OAuth)** untuk memastikan token valid.
   - Klik **Simpan Kredensial**. *(Kredensial hanya disimpan di `localStorage` browser Anda sendiri, tidak pernah dikirim ke pihak ketiga atau disimpan di GitHub).*

---

## ☁️ 3. Cara Pakai Mode Online (Convert `.nwd` $\rightarrow$ Simpan Offline / Export `.zip`)

Lakukan langkah ini saat Anda memiliki koneksi internet (misalnya di laptop pribadi atau saat terhubung Wi-Fi):

1. Buka tab **Cloud .NWD** di sidebar sebelah kiri.
2. **Drag & Drop** file `.nwd` (atau `.nwc`, `.rvt`, `.ifc`) ke area upload.
3. Pantau **4 Tahapan Progress Bar Real-time**:
   - **Tahap 1:** Autentikasi 2-Legged OAuth2 ke server APS.
   - **Tahap 2:** Pembuatan OSS Bucket otomatis & pengunggahan file `.nwd` menggunakan *Signed S3 Chunked Upload* (aman untuk file berukuran besar).
   - **Tahap 3:** Menjalankan *Model Derivative Job* (konversi `.nwd` ke `.svf`) dan memantau progress translasi `0% - 100%`.
   - **Tahap 4:** **Recursive SVF Bubble Downloader** — aplikasi secara otomatis membongkar manifest utama dan `manifest.json` di dalam `0.svf` untuk mengunduh seluruh file geometri (`.pf`, `.pack`, `.bin`), material (`Materials.json.gz`), tekstur, dan *Property Database* (`objects_attrs.json.gz`, `objects_vals.json.gz`, `objects_avs.json.gz`, `objects_offs.json.gz`, `objects_ids.json.gz`) ke **IndexedDB** browser.
4. Setelah selesai, model akan langsung terbuka di 3D Viewer dan muncul di daftar **Offline Library**.
5. Klik tombol **Export .zip** pada kartu model untuk mengunduh satu file bundel **`.nwdpack.zip`** yang siap disimpan di Flashdisk.

---

## 💻 4. Cara Pakai Mode 100% Offline di Laptop Kantor (Tanpa Admin & Tanpa Internet)

### A. Persiapan Satu Kali di Laptop Kantor (Saat Masih Terhubung Jaringan)
1. Buka URL GitHub Pages aplikasi ini di Google Chrome atau Microsoft Edge laptop kantor.
2. Klik tombol **Cache Engine Offline** di bagian header atas hingga muncul notifikasi bahwa seluruh modul **Autodesk Viewer v7 SDK** (`viewer3D.min.js`, `style.min.css`, `lmvworker.min.js`, dan ekstensi) telah tersimpan di cache Service Worker.
3. *(Opsional namun disarankan)* Klik tombol **Install PWA** di bagian header (atau ikon *Install App* di address bar Chrome/Edge) agar aplikasi terpasang di Desktop / Start Menu laptop kantor Anda.

### B. Membuka Model `.nwd` Saat 100% Offline (Tanpa Internet)
1. Buka aplikasi **NWD Offline & Cloud Web Viewer** (melalui shortcut PWA Desktop atau browser).
2. Jika model sudah pernah di-download di laptop tersebut, langsung klik tombol **Buka 3D (Offline)** pada daftar **Offline Library**.
3. Jika Anda membawa file **`.nwdpack.zip`** menggunakan Flashdisk dari komputer lain:
   - Pada tab **Offline Library**, *Drag & Drop* file `.nwdpack.zip` ke kotak **Import Paket Offline (.zip)**.
   - Aplikasi akan mengekstrak seluruh isi paket ke **IndexedDB** secara lokal dan langsung menampilkan model 3D lengkap dengan struktur pohon (*Model Browser*) dan properti BIM-nya secara **100% Offline**!
