# Emergent

Platform pembelajaran fisika untuk **Cambridge International AS & A Level Physics (9702)** berbasis *Project Based Learning* dan Generative AI. Topik yang aktif: **Magnetic Fields** (media penelitian tesis, UNJ).

| Tahap | Tab | Isi |
| --- | --- | --- |
| 01 | Materi | 31 slide interaktif (animasi konsep, langkah bertahap, catatan slide) + versi teks |
| 02 | Eksperimen | LKPD 2 Neraca Arus dalam tiga pilihan: Praktikum Virtual, Alat Sederhana, Alat Laboratorium |
| 03 | Latihan Soal | Soal bergaya 9702 dengan pembahasan |
| 04 | Makerspace | Generator prompt terstruktur, simulasi dibuat Claude Opus 5.5, edit lanjutan, refleksi |

Tutor Fisika (Claude Haiku 5.5) bisa dibuka dari semua halaman. Panel Guru (`teacher.html`) berisi sesi kelas, konfirmasi checkpoint, rekap progres dan semua jawaban siswa, ekspor **Excel (.xlsx)** dan **PDF**, kuis topik, dan pemakaian AI.

## Yang baru di V9

- **Tanpa API key di sisi pengguna.** Semua panggilan AI lewat server Vercel; API key Claude disimpan sebagai Environment Variable.
- **Backend baru:** Vercel Functions + PostgreSQL (Supabase) menggantikan Google Apps Script. Respons AI di-*stream*, jadi tidak ada lagi batas 60 detik.
- **Semua jawaban terekam:** konfirmasi Materi/Eksperimen (setiap percobaan), LKPD, data eksperimen + analisis, latihan, kuis, prompt dan simulasi, refleksi.
- **Desain baru** mengikuti deck materi (Newsreader, Public Sans, IBM Plex Mono; bone, graphite, merah bata, teal) dan logo baru.
- **Perbaikan bug V7:**
  - Kode belajar mandiri dan kode eksplorasi kini berbeda dan diperiksa server.
  - Siswa tidak lagi dilempar ke gerbang saat sesi kelas berakhir.
  - Hipotesis, gradien, B, dan kesimpulan praktikum virtual kini ikut tersimpan.
  - Umpan balik cek B tidak lagi membocorkan nilai jawaban.
  - Soal konfirmasi Materi diacak (urutan soal dan opsi).
  - Kode guru dipindah ke server.
  - Kuis lama tidak lagi menghapus jawaban siswa; semua kuis diarsipkan.
  - Progres siswa tersinkron antarperangkat.

## Struktur

```
index.html, teacher.html     halaman siswa & guru
css/style.css                design system
js/                          app, slide viewer, LKPD, chatbot, Panel Guru, ekspor, i18n
materi/magnetic-fields/      sumber slide (format Claude Slides) -> tools/build-slides.mjs
api/                         Vercel Functions: backend, ai (streaming), health
lib/                         database, prompt, klien Claude, kuota, handler
vendor/                      SheetJS & jsPDF untuk ekspor (di-host sendiri)
tests/                       dev server lokal, uji API, uji end-to-end Playwright
docs/SETUP.md                panduan pemasangan Vercel + Supabase + env vars
```

## Pemasangan

Ikuti **[docs/SETUP.md](docs/SETUP.md)**. Ringkasnya: import repo ke Vercel, sambungkan Supabase, isi `ANTHROPIC_API_KEY`, `TEACHER_CONTROL_CODE`, `SELF_STUDY_CODE`, lalu redeploy.

## Pengembangan lokal

```
npm install
npm run dev     # http://localhost:4010 (PGlite + AI tiruan)
npm test        # 15 uji API + 13 langkah uji browser
```

Pengembang: Muhammad Afta Jadid, S.Pd., Gr. · Magister Pendidikan Fisika, Universitas Negeri Jakarta.


## Desain & aset

- Tampilan mengikuti template **Eduleb - Education HTML Template**, Copyright (c) Bestwpware, lisensi MIT, didistribusikan oleh ThemeWagon (https://themewagon.com/themes/eduleb/). Yang dipakai hanya bahasa visualnya (warna, tipografi Jost/DM Sans, bentuk kartu); foto dan gambar stok dari template tidak disertakan.
- Maskot Emergent (anak berambut keriting bermain laptop, gaya chibi) dan logo di `assets/` adalah gambar vektor buatan sendiri untuk proyek ini.
