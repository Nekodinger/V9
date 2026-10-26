# Panduan Pemasangan Emergent

Panduan ini untuk pengelola situs (guru). Semua layanan memakai paket gratis, kecuali kredit API Claude yang sudah Bapak/Ibu beli.

Gambaran arsitektur:

```
Browser siswa/guru
   │  (situs statis: index.html, teacher.html, js/, css/)
   ▼
Vercel  ── /api/backend  → sesi kelas, gate, kuis, LKPD, rekap guru
        ── /api/ai       → Claude Haiku 5.5 (tutor) & Claude Opus 5.5 (simulasi), streaming
        ── /api/health   → cek kesehatan + cron harian
   │
   ├──► Supabase (PostgreSQL gratis): semua data siswa
   └──► Claude API (Anthropic): API key HANYA ada di server
```

API key tidak pernah dikirim ke browser. Siswa cukup memasukkan kode kelas atau kode belajar mandiri.

---

## 1. Hubungkan repositori ke Vercel

1. Buka <https://vercel.com/new> dan masuk dengan akun GitHub.
2. Pilih repositori **V9**, lalu klik **Import**.
3. Biarkan semua pengaturan default (Framework Preset: *Other*, tanpa build command). Klik **Deploy**.
4. Setelah selesai, catat alamat situs, misalnya `https://v9-xxxx.vercel.app`.

## 2. Buat database Supabase (gratis)

Pilih salah satu cara.

**Cara A, paling mudah (lewat Vercel):**

1. Di proyek Vercel, buka tab **Storage** → **Create Database** → pilih **Supabase** → ikuti langkahnya (paket Free).
2. Setelah terhubung, Vercel otomatis menambahkan variabel `POSTGRES_URL` dan lainnya. Tidak perlu menyalin apa pun.

**Cara B, lewat akun Supabase sendiri:**

1. Buka <https://supabase.com/dashboard> → **New project**. Pilih region **Southeast Asia (Singapore)** supaya cepat dari Indonesia.
2. Setelah proyek jadi, klik **Connect** → tab **ORMs** atau **Connection string** → pilih **Transaction pooler** (port 6543).
3. Salin URI-nya dan ganti `[YOUR-PASSWORD]` dengan kata sandi database (bisa di-reset di *Project Settings → Database*).
4. Simpan URI itu sebagai variabel `DATABASE_URL` di Vercel (langkah 3).

Tabel database dibuat otomatis saat situs pertama kali dipakai. Semua tabel memakai Row Level Security tanpa policy, jadi kunci publik Supabase tidak bisa membaca data siswa.

## 3. Isi Environment Variables di Vercel

Buka proyek Vercel → **Settings → Environment Variables**, tambahkan (centang Production, Preview, Development):

| Nama | Wajib | Isi |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ya | API key dari <https://console.anthropic.com/settings/keys> (diawali `sk-ant-`) |
| `TEACHER_CONTROL_CODE` | ya | Kode masuk Panel Guru. Buat sendiri, minimal 12 karakter, jangan dibagikan ke siswa |
| `SELF_STUDY_CODE` | disarankan | Kode belajar mandiri untuk siswa (default `belajar-mandiri`; sebaiknya diganti) |
| `EXPLORE_CODE` | opsional | Kode eksplorasi untuk validator/guru tamu: semua tab terbuka tanpa urutan |
| `DATABASE_URL` | ya, bila pakai Cara B | URI transaction pooler Supabase |
| `ALLOWED_ORIGINS` | opsional | Hanya bila situs juga dibuka dari domain lain, mis. `https://nekodinger.github.io` |

Setelah menyimpan, buka tab **Deployments** → titik tiga pada deployment terbaru → **Redeploy**. Variabel baru hanya berlaku setelah redeploy.

### Pengaturan opsional (hemat biaya dan kualitas)

| Nama | Default | Keterangan |
| --- | --- | --- |
| `SIM_EFFORT` | `low` | Kedalaman berpikir Opus 5.5 saat membuat simulasi: `low`, `medium`, atau `high`. Lebih tinggi = lebih teliti, lebih lambat, lebih mahal |
| `SIM_MODEL` | `claude-opus-5-5` | Bisa diganti `claude-sonnet-5-5` bila ingin lebih hemat |
| `CHAT_MODEL` | `claude-haiku-5-5` | Model tutor dan generator kuis |
| `LIMIT_SIM_PER_STUDENT` | `6` | Generate simulasi per siswa per hari |
| `LIMIT_EDIT_PER_STUDENT` | `10` | Edit/lanjutkan simulasi per siswa per hari |
| `LIMIT_SIM_GLOBAL` | `80` | Generate simulasi seluruh kelas per hari |
| `LIMIT_EDIT_GLOBAL` | `150` | Edit simulasi seluruh kelas per hari |
| `LIMIT_CHAT_PER_STUDENT` | `150` | Pesan tutor per siswa per hari |
| `LIMIT_CHAT_GLOBAL` | `6000` | Pesan tutor seluruh kelas per hari |
| `SIM_TIME_BUDGET_MS` | `270000` | Batas waktu satu kali generate (maks 290000). Bila habis, siswa bisa klik "Lanjutkan kode yang terpotong" |

Hari dihitung di zona WIB (reset tengah malam). Angka pemakaian terlihat di Panel Guru, tab **Pemakaian AI**.

## 4. Uji coba

1. Buka `https://alamat-situs/api/health`. Hasil yang benar: `{"ok":true,"ai":true,"teacher":true,...}`.
2. Buka `https://alamat-situs/teacher.html`, masuk dengan `TEACHER_CONTROL_CODE`, klik **Mulai Sesi Baru**.
3. Di perangkat lain buka `https://alamat-situs/`, pilih **Saya siswa**, isi nama dan kelas, lalu masukkan kode 6 huruf dari layar guru.

## 5. Perkiraan biaya Claude

- Tutor (Haiku 5.5): sangat murah. Satu pesan memakai sekitar 2.500 token masukan ($0,10/juta) dan 300 token keluaran ($0,50/juta), yaitu sekitar US$0,0004 atau Rp 5-10 per pesan.
- Simulasi (Opus 5.5): kira-kira 10.000-20.000 token keluaran per generate, yaitu sekitar US$0,2-0,4 per simulasi, dan edit sedikit lebih mahal karena kode lama ikut dikirim. Supaya hemat, minta siswa generate per **kelompok** (mis. 4 kelompok × 3 generate + 5 edit).
- Atur juga batas belanja (spend limit) di <https://console.anthropic.com/settings/limits> dan biarkan auto-reload mati.

## 6. Catatan keamanan dan privasi

- Kode guru, kode mandiri, dan kode eksplorasi diperiksa server; tidak ada di kode situs.
- Siswa yang lolos gerbang mendapat token akses 30 hari. Bila sesi kelas berakhir, siswa otomatis lanjut dalam mode mandiri.
- Data yang disimpan: nama dan kelas yang diketik siswa, progres, jawaban, LKPD, data eksperimen, prompt, dan simulasi buatan siswa. Isi percakapan tutor tidak disimpan.
- Periksa ketentuan Anthropic untuk pengguna di bawah 18 tahun sebelum dipakai luas, dan beri tahu orang tua/sekolah bahwa platform memakai layanan AI.
- Proyek Supabase gratis akan di-pause bila tidak aktif 7 hari; cron harian di `vercel.json` memanggil `/api/health` supaya tetap aktif.

## 7. Mengubah materi slide

Slide ada di `materi/magnetic-fields/` (format Claude Slides). Setelah mengedit file slide, jalankan:

```
node tools/build-slides.mjs
```

lalu commit `js/materi-slides.js` yang baru.

## 8. Menjalankan dan menguji di komputer sendiri

```
npm install
npm run dev          # http://localhost:4010, database PGlite + AI tiruan
npm test             # uji API (15 tes) + uji browser end-to-end (13 langkah)
```

Kode guru di mode lokal: `guru-uji`, kode mandiri: `mandiri-uji`, kode eksplorasi: `jelajah-uji`.
