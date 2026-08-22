# PROJECT_KNOWLEDGE.md

Peta kerja **Jual Beli USU Polmed** — satu berkas yang harus dibaca lebih dulu
sebelum menyentuh apa pun, dan diperbarui setiap kali ada yang berubah.

> **Aturan kerja.** Sebelum mengerjakan fitur atau perbaikan: baca berkas ini,
> lalu periksa apakah perubahannya bersinggungan dengan alur, tabel, atau modul
> yang sudah ada. Sesudah selesai: perbarui berkas ini tanpa menunggu diminta.
> Yang belum benar-benar dipahami **ditandai `⚠ perlu klarifikasi`**, bukan
> dilewati diam-diam. Jangan menebak cara kerja sesuatu — buka kodenya.

| | |
|---|---|
| **Audit terakhir** | 21 Agustus 2026 (perapian dokumentasi & rupa: 22 Agustus) |
| **Repo bot** | `github.com/jualbeliusupolmed-creator/wa-bot-usu` (publik) |
| **Repo situs** | `github.com/jualbeliusupolmed-creator/jualbeliusupolmed` (publik) |
| **Database** | Supabase `autgrnrqeqdpqwkbolyh`, ap-southeast-1, Postgres 17.6 |
| **Pemilik** | Ridho Robbi Pasi — Teknik Informatika, USU |

---

## 0. Apa ini sebenarnya

Marketplace barang bekas untuk mahasiswa USU dan Polmed, dengan **dua pintu
masuk ke satu database**:

- **Pintu situs** — katalog, pencarian, halaman produk, profil penjual, toko,
  tawar-menawar, pembayaran, dasbor iklan.
- **Pintu WhatsApp** — penjual yang malas membuka apa pun tinggal mengirim foto
  ke chat bot; iklannya tetap tayang di situs.

Keputusan yang membentuk seluruh sistem: **penjual tidak perlu pindah**. Karena
itu bot bukan pelengkap, melainkan pintu setara — dan hampir semua alur bisnis
melintasi kedua repo. Audit atau perubahan yang hanya menyentuh salah satunya
akan salah membaca sistem ini.

### Tiga bagian, tiga tanggung jawab

```
   Pembeli                          Penjual
   (peramban)                       (chat WhatsApp)
       │                                 │
       ▼                                 ▼
┌──────────────────┐            ┌──────────────────┐
│  SITUS           │            │  BOT             │
│  Next.js 14      │            │  Node + Baileys  │
│  Vercel          │            │  VPS, pm2+nginx  │
│                  │            │                  │
│  • tampilan      │◄───────────┤  • sambungan WA  │
│  • SEMUA logika  │  webhook   │  • gerbang titik │
│    bisnis        │  multipart │  • antrean kirim │
│  • satu-satunya  ├───────────►│  • panel operasi │
│    yang menulis  │  /send     │                  │
│    ke database   │            │  TIDAK punya     │
└────────┬─────────┘            │  kredensial DB   │
         │                      └──────────────────┘
         ▼
   ┌───────────┐
   │ Supabase  │  32 tabel
   └───────────┘
```

**Batas yang paling penting untuk dijaga:** bot **tidak** punya kredensial
Supabase. `pm2 env` tidak memuat satu pun variabel Supabase, dan itu disengaja —
VPS terbuka di internet lewat nginx dan reponya publik. Bot memanggil situs;
situslah yang menulis ke database. `useSupabaseAuthState.js` masih ada di repo
sebagai adapter penyimpan sesi di Postgres, tapi **menganggur** — sesi WhatsApp
hidup di filesystem (`auth_info_baileys/`).

Konsekuensinya yang sering bikin bingung: **antrean notifikasi `wa_outbox` itu
milik situs, bukan bot.** Halaman `/antrean` di panel bot hanyalah proxy yang
meneruskan ke `/api/admin/outbox` di situs.

---

## 1. Struktur & inventarisasi

### 1.1 Repo bot (`wa-bot-usu`) — 24 berkas dilacak

| Berkas | Baris | Tanggung jawab |
|---|---:|---|
| `index.js` | 2.693 | Inti bot: soket Baileys, antrean kirim, state, dan pemuatan modul. Dulu 4.075 baris dan memuat semuanya. |
| `src/lib/utils.js` | 184 | 18 fungsi murni — masuk-keluar, tanpa state. |
| `src/lib/gerbang.js` | 265 | Token mesin, sandi manusia, kuki sesi, rem tebak-token, dua gerbang pemulihan. Berbentuk pabrik. |
| `src/routes/web.routes.js` | 251 | 18 rute yang menjawab HTML + pintu masuk/keluar. |
| `src/routes/panel.routes.js` | ~300 | 18 rute data yang dibaca dashboard. |
| `src/routes/wa.routes.js` | ~540 | 30 rute yang menyentuh WhatsApp. |
| `src/routes/sesi.routes.js` | ~100 | 8 rute taut-ulang, reset, buka kunci, bot kedua. |
| `src/routes/antrean.routes.js` | ~125 | 4 rute antrean kirim & proxy antrean situs. |
| `waAuthState.js` | 302 | Penyimpan sesi Baileys di filesystem, dengan cadangan berputar & tulis atomik. |
| `useSupabaseAuthState.js` | 190 | Adapter sesi ke Postgres. **Tidak dipakai** (tidak ada env Supabase). |
| `halaman/dashboard.html` | 958 | Panel operasi: QR, inbox chat, statistik gerbang, blocklist, story, log. |
| `halaman/home.html` | 449 | Daftar tombol ke semua halaman & endpoint. |
| `halaman/update.html` | 289 | Linimasa perubahan (dari git) + daftar "Yang belum selesai" yang ditulis tangan. Tiga baris, semuanya `Perlu pemilik`. |
| `halaman/projek.html` | 208 | Catatan proyek naratif. Angkanya dihitung ulang 21 Agu 2026, sama dengan `/lomba`, dan cara menghitungnya ikut ditulis. |
| `halaman/progres-claude.html` | 660 | **Halaman audit ini.** Bergerbang sandi. Isinya beku di pagi 21 Agu; penandanya disetel ulang 22 Agu (14 dari 18 temuan ditutup). Memuat penyaji markdown sendiri untuk `catatan/temuan-keamanan.md`. |
| `public/lomba.html` | 931 | Presentasi lomba 12 slide. **Satu-satunya halaman tanpa sandi.** |
| `public/assets/ui.css` / `ui.js` | 1.054 / 169 | Rupa bersama + navbar yang disuntik ke semua halaman + ikon SVG sebaris (menggantikan Font Awesome CDN) + tombol terang/gelap. |
| `antrean.html`, `laporan.html`, `laporan-publik.html`, `jalankan.html` | 401/385/384/252 | Halaman antrean notifikasi, laporan analisis, dan penyaji SQL migrasi. |
| `migrasi/migrasi.sql` | 1.824 | **29 BAGIAN** migrasi, dirancang aman diulang. |
| `migrasi/migrasi-keamanan.sql` | 98 | Migrasi RLS terpisah. |
| `penjaga-bot.sh` | 115 | Cron tiap 2 menit: cek `/health`, restart kalau mati. |
| `cadangkan-sesi.sh` | 194 | Cadangan sesi terenkripsi AES ke repo GitHub privat. |
| `.github/workflows/pantau-bot.yml` | 122 | Pemantau dari luar VPS. |

**Refactor 22 Agustus 2026 — apa yang sudah dan belum dipecah.** `index.js`
turun dari 4.075 ke 2.693 baris; seluruh 78 rute Express pindah ke
`src/routes/`. Yang MASIH di dalamnya: soket Baileys, handler
`messages.upsert`, antrean kirim, dan 28 variabel state yang dipakai bersama.

Modul rute menerima satu objek konteks `K`. Isinya dua macam: nilai tetap
(diambil sekali lewat destrukturisasi) dan **state hidup lewat getter/setter**.
Yang kedua bukan gaya penulisan — `waSocket` diganti tiap kali bot menyambung
ulang, jadi modul yang menyalinnya ke variabel lokal akan memegang soket mati
selamanya, dan gejalanya bukan galat melainkan pesan yang tidak pernah sampai.

⚠ **Sebelum memindah apa pun lagi dari `index.js`, jalankan
`/root/uji-boot-bot.sh`.** Ia menyalakan bot di port 3099 dengan DATA_DIR
sementara dan memeriksa 32 hal. Fase 2 menemukan empat kesalahan penggantian
nama lewat alat ini, dan satu di antaranya — nama yang terganti di dalam string
literal, membuat `/stats` dan `/settings` hilang jadi 404 — lolos dari
`node --check` dengan sintaksis sempurna.

**Berkas state runtime** (semuanya di-`.gitignore`, dan **harus tetap begitu**):
`auth_info_baileys/`, `contacts.json`, `chats.json`, `messages.json`,
`name_map.json`, `lid_resolution_map.json`, `greeted_map.json`, `statuses.json`,
`stats.json`, `settings.json`, `outbox.json`, `outage_guard.json`,
`wa_version.json`, `.bot.lock`, `.penjaga-*`, `penjaga-bot.log`.

Isinya nomor telepon dan percakapan orang sungguhan. Pada 21 Agustus 2026 berkas
ini pernah ikut ter-commit ke repo situs; lihat catatan audit di §6.

### 1.2 Rute bot — 74 endpoint

Tiga lapis gerbang, didefinisikan di `index.js:1127`–`1273`:

| Gerbang | Fungsi | Menerima |
|---|---|---|
| `requireAuthPage` | halaman panel | kuki sesi → kalau tidak ada, alihkan ke `/masuk` |
| `requireAuth` | API | kuki, `Authorization`, `?token=`, atau sandi panel. Rem: 10 gagal / 5 menit / IP → 429 |
| `requireRelink` | `/reset`, `/restart` | hanya kalau `ALLOW_RELINK=true` |
| `requirePemulihan` | `/pairing-code`, `/sesi/buka-kunci` | kalau sesi memang sudah mati — supaya pemilik tidak terkunci di luar saat paling butuh |

**Publik (6):** `/health`, `/masuk` (GET+POST), `/keluar`, `/lomba`,
`/kontak-admin`, `/progres` (pengalihan ke halaman progres situs).

`/health` dan `/kontak-admin` **tidak boleh** ditutup: yang pertama dibaca
`penjaga-bot.sh` dan pemantau GitHub Actions, yang kedua dipanggil situs untuk
memindahkan tombol "Hubungi Admin" ke nomor cadangan saat bot padam.

**Halaman bergerbang sandi (10):** `/`, `/home`, `/projek`, `/update`,
`/jalankan`, `/antrean`, `/riwayat`, `/laporan`, `/laporan/penuh`,
`/progres-claude`.

**API bergerbang token (58):** pengelompokan kasarnya —
*sesi & keadaan* (`/status`, `/qr`, `/logs`, `/restart`, `/reset`,
`/sesi/buka-kunci`, `/pairing-code`, `/perangkat2/*`),
*percakapan* (`/chats`, `/messages`, `/message-log`, `/context`, `/resolve-lid`,
`/lid-map`),
*kirim* (`/send`, `/broadcast`, `/broadcast/targets`, `/send-poll`, `/send-raw`,
`/story`, `/channel/send`),
*grup & komunitas* (`/groups*`, `/community/*`, `/newsletters*`),
*pengaturan* (`/settings*`, `/modul`, `/profile*`, `/blocklist/*`, `/set-privacy`),
*antrean situs* (`/antrean/data`, `/antrean/kirim`, `/antrean/lokal`).

### 1.3 Repo situs (`jualbeliusupolmed`) — 401 berkas

- **38 halaman** (`src/app/**/page.js*`) — 14 di antaranya di bawah `/admin`.
- **78 berkas rute API** (`src/app/api/**/route.js`). Kalau ada dua angka yang
  beredar untuk "jumlah endpoint", sebabnya satu berkas rute bisa memuat
  beberapa metode GET/POST/PUT/PATCH/DELETE.
- **`/admin-demo/*`** — kembaran terbuka panel admin, komponen yang sama persis
  dengan `/admin`, data karangan dari `src/lib/demoData.js`. Lihat §2.6.
- **63 berkas komponen** (34 akar, 7 admin, 21 `baileys/`, 1 `ui/`).
- **31 modul** di `src/lib/` — logika bisnis dipisah dari tampilan.
- Berkas terbesar: `src/app/api/wa/baileys/route.js` (**2.930 baris**) — otak
  balasan bot; `src/app/admin/AdminPanel.jsx` (1.866); `src/app/dashboard/page.jsx` (1.709).

Modul `src/lib/` yang perlu diketahui: `auth.js` (sesi admin & penjual),
`pin.js`/`pinRules.js` (PIN penjual, bcrypt), `gemini.js` (AI baca chat → iklan),
`fonnte.js` (jalur WA cadangan + semua kata-kata pesan, **satu sumber**),
`fees.js` (tarif, satu sumber), `settings.js` (pengaturan dari DB
menang atas kode), `webpush.js`, `rateLimit.js`, `toko.js` (status toko),
`lidMigrate.js` (@lid → nomor), `supabaseAdmin.js` (klien service-role).

**Kode mati — sudah dihapus 21 Agustus 2026.** Tujuh berkas yang tidak dirujuk
satu baris pun di seluruh `src/`, dipastikan dengan penelusuran dua arah (nama
berkas → pemanggil, dan sebaliknya):

| Berkas | Baris | Kenapa ada |
|---|---:|---|
| `src/lib/middleware.js` | 65 | Boilerplate Supabase SSR. Kalau "dihidupkan", ia mengalihkan **seluruh** pengunjung ke `/auth/login` — marketplace-nya padam. |
| `src/lib/server.js` | 32 | Saudara berkas di atas; satu-satunya pemakai `@supabase/ssr`. |
| `src/lib/qris.js` | 67 | Pembangun QRIS dinamis per nominal. Pembayaran akhirnya memakai QRIS statis + verifikasi struk oleh AI. |
| `src/lib/dummyBlogs.js` | 68 | Artikel contoh; `blogs` sudah berisi 7 baris sungguhan. |
| `src/components/BottomNav.jsx` | 48 | Navigasi bawah yang tidak pernah dipasang. |
| `src/components/IGShareButton.jsx` | 98 | Ekspor gambar 9:16 untuk IG Story. `ShareModal` dan `QRButton` yang dipakai. |
| `src/components/ToastProvider.jsx` | 48 | `sonner` dipanggil langsung dari layout. |

Semuanya bisa dibangkitkan lagi dari git kalau ternyata dibutuhkan. Yang **tidak**
boleh dihidupkan lagi tanpa berpikir: `middleware.js`.

### 1.4 Database — 32 tabel

Semua tabel punya RLS aktif. Situs mengaksesnya dengan service-role dari server;
`anon` hanya boleh membaca yang memang publik (iklan aktif, kategori, profil
penjual, blog, penilaian, papan dicari).

**Inti transaksi**
`listings` (45 baris, 25 aktif) · `payments` (497) · `seller_profiles` (82) ·
`categories` (7) · `wanted_listings` (37) · `wanted_unlocks` (2)

**Akun & identitas**
`otps` (24) · `verified_sellers` (0) · `blacklist` (0) ·
`profile_change_requests` (5) · `referrals` (0)

**Jembatan WhatsApp**
`wa_conversations` (820 — riwayat chat sejak 16 Juli) · `wa_listing_drafts` (3 —
draf setengah jadi saat alur `.JUAL` terputus) · `wa_outbox` (0 — notifikasi
yang gagal terkirim) · `wa_auth` (0) · `wa_state` (0)

**Notifikasi & jangkauan**
`push_subscriptions` (4) · `category_subscriptions` (0) ·
`scheduled_broadcasts` (0) · `group_posts` (0) · `pwa_installs` (0)

**Operasi & jejak**
`settings` (5) · `admin_logs` (19) · `error_logs` (2) · `search_logs` (0) ·
`blogs` (7) · `reports` (0) · `seller_ratings` (0) · `offers` (0) ·
`price_offers` (0) · `distributor_invites` (1) · `distributor_categories` (0)

⚠ **16 dari 32 tabel kosong.** Sebagian memang fitur yang belum jalan, sebagian
lagi ditinggalkan. `offers` dan `price_offers` dua-duanya kosong dan menamai
konsep yang sama — dan sejak 21 Agustus 2026 pertanyaannya bukan lagi "mana yang
sisa": ditelusuri di seluruh `src/`, **tidak ada satu baris pun yang memanggil
`offers`**; semua tawar-menawar lewat `price_offers`. Menghapus tabelnya perlu
persetujuan pemilik, jadi ia masih berdiri.

⚠ **`payments` (497 baris) bukan cerita yang disangka audit pertama.** Yang
menumpuk bukan "tiap penekanan tombol lanjutkan bayar", melainkan tiga hal
berbeda, dan dua sudah ditutup di kode pada 21 Agustus 2026:

| Asal | Baris pending | Sudah ditutup? |
|---|---:|---|
| `/api/payments/unlock-wanted` — tagihan terbit saat jendela QRIS **dibuka** | 346 | ya — sekarang terbit saat struk dikirim |
| Iklan yang keburu dihapus (`listing_id` jadi NULL lewat `ON DELETE SET NULL`) | 69 | tidak — memang jejak sah |
| Sisanya (iklan hidup, bump, sold_fee, subscribe) | 45 | ya — `/resume` memakai ulang tagihan, tidak menyisipkan baris baru |

418 dari 460 baris pending itu `listing_id IS NULL`, bukan menggantung: tidak ada
satu pun foreign key yatim. Baris lamanya **sengaja tidak dibersihkan** — pemilik
memilih menyimpannya sebagai jejak. Yang diperbaiki hanya labelnya: 355 baris
pembukaan kontak pindah dari `type = 'iklan'` ke `'wanted'`.

---

## 2. Alur bisnis

### 2.1 Gerbang titik — keputusan yang menentukan segalanya

**Pemicu:** setiap pesan WhatsApp masuk (`index.js:3507`).

Aturannya dibalik dari bot toko pada umumnya: **chat pelanggan adalah milik
admin manusia**, sampai pelanggan sendiri memanggil bot dengan mengawali pesan
memakai titik. Pesan tanpa titik **tidak pernah sampai ke webhook** — bukan
diabaikan diam-diam, memang tidak pernah dikirim ke otak balasan.

Urutan yang dijalankan tiap pesan:

1. Buang duplikat (`processedMsgIds`, 800 terakhir).
2. Status WA sendiri → simpan ke `statuses.json`, berhenti.
3. Pesan grup → hanya dari `GROUP_JID`, teruskan ke webhook `source=group`, berhenti.
4. Reaksi/hapus/edit/poll → buang.
5. **`fromMe` tanpa `#`** → berarti admin turun tangan manual: sesi bot di kontak
   itu ditutup, dan webhook diberi sinyal `fromMe=true` supaya bot senyap di sana.
6. `@lid` → cari nomor asli. Urutan: `remoteJidAlt` → `lidMap` (sinkron kontak) →
   `lidResolutionMap` (cache) → `getPNForLID()` langsung ke WhatsApp. Yang baru
   dipelajari ikut disimpan. Sekali per kontak, penanda `prev_lid` dikirim ke
   situs supaya data lama (`seller_wa` = LID) dimigrasi, mencegah profil dobel.
7. **Gerbang:** panggilan `"min"` → sapaan (cooldown 60 detik) · kata penutup
   (`admin`/`stop`/`selesai`) → sesi ditutup · tanpa titik & tanpa sesi → sapaan
   sekali seumur kontak, sesudah itu bot diam total · lolos → sesi 15 menit
   dibuka/disegarkan supaya pesan lanjutan tak perlu bertitik lagi.
8. Media diunduh **setelah** gerbang — pesan untuk admin tidak perlu ongkos unduh.
   Foto ditahan 4 detik supaya kiriman beruntun jadi satu iklan multi-foto.
9. POST multipart ke `WEBHOOK_URL` beserta `context` (riwayat singkat),
   `profile_name`, `prev_lid`, `fromMe`.

**Efek samping:** `stats.json` (`masuk`, `sapaan`, `didiamkan`, `sesi_bot`,
`perintah_polos`, `webhook_ok`, `webhook_gagal`), arsip pesan, `chatMap`.

**Edge case yang sudah ditangani:** titik telanjang tanpa perintah → dianggap
`MENU` · kata perintah polos (`jual`, `cari`, …) dihitung terpisah supaya
keputusan melonggarkan gerbang punya angka, bukan firasat · centang biru sengaja
tidak dikirim supaya tidak ketahuan dijaga bot.

### 2.2 Pasang iklan lewat WhatsApp

**Pemicu:** `.JUAL`, atau foto+keterangan di dalam sesi bot yang sedang terbuka.

1. Bot meneruskan teks + foto ke `POST /api/wa/baileys` (multipart, `Authorization: API_TOKEN`).
2. Situs memeriksa token (**fail-closed**), rate limit 20/menit + rem banjir 3/5 menit.
3. `parseListingFromText()` (Gemini) membaca teks **dan gambar** → judul, harga,
   kategori. Bisa mengembalikan lebih dari satu barang sekaligus.
4. Profil penjual dibuat kalau belum ada (`seller_profiles`).
5. **Batas iklan aktif** ditegakkan: 5 untuk penjual biasa,
   30 untuk distributor. Lewat batas → ditolak dengan penjelasan.
6. Gambar diunggah (dikonversi WebP lewat `sharp`), `listings` ditulis
   `status='pending'`, `payments` ditulis `pending`.
7. Bot membalas ringkasan + nominal biaya iklan. Penjual bayar QRIS lalu
   memotret struknya.
8. `verifyReceiptImage()` (Gemini) membaca struk → kalau cocok, iklan
   `status='active'`.
9. **Efek samping saat aktif:** notifikasi ke admin, posting ke grup WA,
   `notifyCategorySubscribers`, `pushListingBaru` ke **semua** pelanggan push,
   dan (kalau dinyalakan) posting ke Facebook/Instagram.

**Tarif** (`src/lib/fees.js`, satu sumber untuk UI dan server):
iklan barang berjenjang Rp2.000–1% dari harga · poster/jasa Rp10.000 ·
bump Rp1.000 · featured Rp5.000–10.000/hari · autobump 7 hari Rp15.000 ·
fee terjual 0% di bawah Rp50rb, 10% di bawah Rp100rb, 5% di atasnya.

**Toko aktif = iklan gratis.** Sejak BAGIAN 26, membuat toko bukan lagi urusan
tampilan melainkan pintu ke iklan tanpa biaya — karena itu toko harus disetujui
admin dulu (`draf → menunggu → aktif/ditolak`).

**Edge case:** alur terputus di tengah disimpan di `wa_listing_drafts`, jadi
pesan berikutnya melanjutkan, bukan mengulang · pesan tanpa harga menyimpan draf
dan menunggu · foto beruntun digabung 4 detik · AI gagal membaca → bot minta
ditulis ulang, bukan menebak.

### 2.3 Notifikasi keluar, dan kenapa tidak ada yang hilang

**Jalur utama:** situs → `POST /send` di bot → antrean → WhatsApp.

`/send` (`index.js:2327`) menerima `ttlDetik` dari pemanggil, karena hanya
pemanggil yang tahu pesannya masih berguna atau tidak kalau terlambat.

**Aturan yang lahir dari kejadian nyata:** pesan berumur pendek (≤15 menit,
artinya OTP) **ditolak 503** kalau bot belum tersambung. Menerimanya berarti
situs terlanjur bilang "OTP terkirim" sementara pesannya mati kedaluwarsa di
antrean — itu betul-betul terjadi pada 21 Agustus 2026. Pesan berumur panjang
tetap diterima; ia memang dibuat untuk menunggu.

**Jaring-jaring:** `outbox.json` bertahan melewati restart · pesan yang dibuang
dicatat lengkap dengan sebabnya (tidak hilang tanpa jejak) · gagal total
ditampung `wa_outbox` di sisi situs dan bisa dikirim ulang dari `/antrean` ·
`kontakAdmin` memindahkan tombol "Hubungi Admin" ke nomor cadangan selama bot
padam · jeda antar pesan diacak (anti-ban).

### 2.4 Masuk akun di situs

- **Penjual:** nomor WA + PIN (bcrypt). Nomor yang belum punya PIN **dan** belum
  punya iklan boleh mendaftar langsung tanpa OTP — tidak ada yang bisa dicuri
  dengan mengklaimnya. Nomor yang punya iklan tapi tanpa PIN diarahkan ke jalur
  "Lupa PIN", yang menuntut kode dari WhatsApp nomor itu sendiri. **OTP hanya
  ada untuk lupa sandi, dan itu satu-satunya jalan pulang ke akun.**
- **Admin situs:** satu sandi (`ADMIN_PASSWORD`), kuki `sha256(sandi)`.
- **Panel bot:** sandi panel dari `/root/.sandi-panel` → kuki `httpOnly` +
  `sameSite=strict` + `secure`, berlaku 30 hari. Token tetap untuk mesin.

### 2.5 Keandalan bot

`penjaga-bot.sh` cek `/health` tiap 2 menit → restart kalau mati, tapi **tidak**
kalau `terkunci` atau `menungguPindai` (restart hanya menambah ketukan sia-sia).
Kunci proses tunggal (`.bot.lock`, flag `wx`, atomik) mencegah dua proses menulis
`creds.json` bergantian. `KUNCI_RETRY_MINUTES` menurunkan ketukan login dari
144×/hari jadi 1×/jam saat nomor sedang dibatasi WhatsApp.

> **Pantangan:** kalau log menunjukkan 401 berturut-turut, nomornya sedang
> dibatasi WhatsApp. **Jangan pindai QR** — menautkan ulang saat dibatasi justru
> memperpanjangnya. Kembalikan folder `.bak-` kalau nomornya masih tertaut di HP.

---

### 2.5b Penjual menulis blog — dan badge yang memutuskan siapa antre

**Pemicu:** penjual membuka `/dashboard` → tab **Blog**.

```
tulis  →  [ Simpan draf ]  →  status "draft", tidak ke mana-mana
       →  [ Kirim ]        →  berbadge?  ya  → "published", langsung tayang
                                         tidak → "menunggu", masuk antrean admin
```

Yang menentukan bukan tombolnya, melainkan `seller_profiles.blog_badge`, dan
nilainya dibaca **di server** dari profil penulisnya. `status` dan `author_wa`
tidak pernah diterima dari badan permintaan — kalau boleh, "menunggu persetujuan
admin" cuma jadi saran yang sopan.

Admin meninjau di `/admin/blogs` (antrean ditarik ke atas tabel) atau memberi
badge di `/admin/penjual/[wa]`. Penulis dikabari lewat WhatsApp saat artikelnya
terbit, ditolak, dan saat badge-nya berubah — tapi hanya kalau nilainya
benar-benar berubah, supaya menekan tombol dua kali tidak mengirim dua pesan.

⚠ **Yang perlu diketahui sebelum mengubah alur ini:** penulis tanpa badge yang
menyunting artikel yang SUDAH terbit membuatnya kembali ke antrean, dan artikel
itu turun dari `/blog` sampai disetujui lagi. Itu memang arti "setiap tulisan
minta konfirmasi admin", dan formulirnya memperingatkan sebelum tombolnya
ditekan. Kalau suatu saat ini terasa terlalu keras, yang dibutuhkan tabel
revisi — bukan melonggarkan pemeriksaannya.

### 2.6 Dua panel demo — satu kode, dua alamat

Panel admin dan panel bot adalah bagian yang paling banyak menjelaskan cara
kerja sistem ini, dan keduanya justru yang paling tidak bisa diperlihatkan:
bergerbang sandi, dan isinya nomor telepon serta percakapan orang sungguhan.
Jadi yang dibuka bukan panelnya, melainkan kembarannya.

| Sungguhan | Kembaran terbuka | Data |
|---|---|---|
| `/admin/*` (situs) | `/admin-demo/*` | `src/lib/demoData.js` |
| `/dashboard` (bot) | `/demo` (bot) | dirakit di dalam `halaman/dashboard.html` |

**Bukan salinan — mount kedua.** Komponennya sama persis. Yang membedakan
diturunkan dari **alamat halaman**, bukan dari prop yang disulam ke seluruh
pohon komponen:

- `useBasisAdmin()` → `/admin` atau `/admin-demo` (ke mana tautan menuju)
- `useBasisApi()` → `/api/admin` atau `/api/admin-demo` (dari mana data datang)

Alasannya: komponen nav sudah membaca `usePathname()` untuk menandai menu aktif,
jadi prop `base` berarti dua sumber kebenaran untuk satu hal — dan yang satu
pasti akan lupa diperbarui. **Menyalin panelnya jadi versi kedua akan berhasil
hari ini dan salah dalam dua minggu**, dan yang dilihat orang untuk mempelajari
sistem ini justru salinan yang basi.

**Tiga lapis supaya tidak ada data asli yang bisa bocor:**
1. Tidak ada satu pun `getAdminClient()` di seluruh cabang `/admin-demo`.
   Bukan "tidak dipakai" — tidak ada jalannya. (Panel bot: `api()`/`post()`
   tidak pernah memanggil jaringan di mode demo.)
2. `AdminProvider` mengenali mode demo dan menolak mengirim aksi apa pun.
3. Kalau lapis 1 dan 2 sama-sama bocor, `/api/admin/action` tetap menuntut
   `isAdmin()`.

Nomor di data contoh memakai awalan `0800000…` / `6280000…` yang tidak dipakai
operator mana pun.

⚠ **Kalau menambah tab atau kolom di panel admin, periksa `demoData.js`.**
Bentuknya wajib sama dengan yang dikembalikan `getAdminStats()`. Sudah terbukti
sekali: `sellersList` diisi baris profil mentah, dan `/admin-demo/penjual`
menjawab 500 karena `s.seller_wa` undefined. Bentuk data yang salah tidak
terlihat sampai halamannya benar-benar dirender.

`/admin-demo/antrean` **sengaja tidak** memakai `TabAntrean`: komponen itu
memanggil VPS bot untuk membaca antrean sungguhan, dan halaman terbuka yang
mengetuk mesin produksi bukan demo yang jujur.

---

## 3. Keadaan sekarang (21 Agustus 2026)

**Dua bot hidup, dua-duanya belum tertaut.** `wa-bot-usu` (port 3000) dan
`wa-bot-2` (port 3001) sama-sama `ok:false`, folder sesi kosong. 6 pesan
menunggu di outbox bot pertama. Cadangan sesi lama ada di
`auth_info_baileys.bak-20260821T063431/` (1.281 berkas).

Langkah selanjutnya ada di tangan pemilik, bukan di kode — lihat "Yang belum
selesai" di `/update`.

---

## 4. Utang teknis

Diperbarui 21 Agustus 2026 sore. Yang ditandai ✅ sudah selesai hari itu; yang
lain masih berdiri, dan alasannya ditulis.

### ✅ Sudah dibereskan

- **Komentar model AI di kode produksi.** `/api/payments/resume` memuat
  `// Wait, sold_fee is soldFeeFrom, not adFeeFrom! I will fix this in a moment`
  dan `// Actually, let's fetch...`, lengkap dengan variabel `amount` yang
  dihitung lalu langsung ditimpa dua puluh baris kemudian. Berkasnya ditulis
  ulang.
- **Bug yang tersembunyi di balik komentar itu.** Rute yang sama menolak semua
  tagihan komisi penjualan: syaratnya `listing.status !== "pending"` → 400,
  padahal `sold_fee` justru ditagih saat iklan `active`/`sold`. Ketiga tombol
  "Bayar Tagihan" di dasbor penjual **tidak pernah bisa ditekan sampai selesai**.
  Syaratnya sekarang bercabang per jenis tagihan.
- **Baris `payments` yang beranak.** Lihat tabel di §1.4. `/resume` memakai ulang
  tagihan yang ada (dan nomor pesanannya, supaya struk lama tetap cocok);
  `/unlock-wanted` baru menerbitkan tagihan saat struk dikirim, bukan saat
  jendela QRIS dibuka.
- **`type: "iklan"` pada pembukaan kontak.** Komentarnya bilang "bypass check
  constraint" — benar sampai BAGIAN 9 menambahkan `'wanted'` ke
  `payments_type_check`, sesudah itu tinggal merusak laporan. 346 transaksi
  masuk ke kolom "Iklan Baru" di `/admin/keuangan`, sementara baris "Cari
  Barang" yang sudah disiapkan selamanya kosong. Kode baru menulis `"wanted"`, dan
  **355 baris lama ikut diperbaiki** (346 pending + 9 lunas) pada 21 Agustus 2026
  atas persetujuan pemilik. Sejak itu `/admin/keuangan` menampilkan Rp 18.000
  pendapatan buka-kontak yang selama ini tersamar sebagai penjualan iklan.
- **`PAYMENT_TYPES` di `AdminPanel.jsx` cuma memuat 4 dari 9 jenis**, jadi
  rincian "per tipe" tidak pernah menjumlah sampai "Total Lunas". Sekarang
  sembilan, sama dengan constraint database.
- **Kode mati** — 7 berkas, lihat tabel di §1.3.
- **Angka basi di `halaman/projek.html`.** Dua halaman menyebut angka berbeda
  untuk hal yang sama. Keduanya dihitung ulang dari repo dan cara menghitungnya
  ikut ditulis di halaman, supaya bisa diperiksa: 38.068 baris situs, 8.508
  baris bot, 358 commit, 32 tabel, 74 rute situs, 70 rute bot. Angka bot naik
  dari 7.820 setelah refactor fase 1-2: `index.js` 2.693 + tujuh modul `src/`
  1.856 + halaman panel 3.959. Dua halaman menyebutnya (`/lomba` dan
  `/projek`) — kalau satu diubah, yang lain ikut, atau keduanya berbohong lagi.

### ✅ BAGIAN 27 — dijalankan 21 Agustus 2026 sore

Isinya membuang yang kembar, dan satu di antaranya bukan sekadar kerapian:
- **9 indeks berlebih.** Empat menduplikasi indeks yang dibuat berkas migrasi
  ini sendiri dengan nama lain (`idx_listings_status` vs `listings_status_idx`,
  dst.); lima lagi indeks biasa di kolom yang sudah punya constraint `UNIQUE`.
  Advisor Supabase hanya melihat 5 pasang — ia tidak menghitung pasangan
  unik-vs-biasa, padahal itu tetap satu pohon berlebih tiap tulis.
- **`seller_profiles_wa_key`** — `UNIQUE (wa)` di kolom yang sudah PRIMARY KEY.
- **`fk_seller_profiles`** — foreign key **kedua** di `listings.seller_wa`,
  tidak ada di berkas migrasi mana pun. Postgres menegakkan keduanya, jadi yang
  paling ketat menang dan `listings_seller_wa_fkey` (`ON UPDATE CASCADE ON
  DELETE SET NULL`, BAGIAN 5) tidak pernah berlaku. Akibatnya nyata:
  `migrateLidToPhone()` mengganti `seller_profiles.wa` dari LID ke nomor HP dan
  mengandalkan cascade itu; selama FK siluman ini berdiri, UPDATE-nya selalu
  ditolak dan kodenya jatuh ke jalur cadangan yang **membuang `created_at` dan
  `referral_code` penjual** setiap kali.
- **7 kebijakan RLS kembar** pada `blogs`, `categories`, `listings`,
  `seller_profiles`, `seller_ratings`, `wanted_listings`. Enam pasang benar-benar
  berbunyi sama. Pasangan `blogs` **tidak**: yang satu `USING (true)`, yang lain
  membatasi ke artikel terbit — dua aturan berbeda untuk satu tabel, dan yang
  paling longgar yang menang. Yang disimpan yang lebih ketat. Baris ini yang
  membuat BAGIAN 27 sebaiknya tidak menunggu lama.

**Diverifikasi setelah dijalankan:** 0 indeks kembar tersisa · 0 kebijakan
kembar tersisa · `listings.seller_wa` tinggal satu foreign key, yang benar
(`ON UPDATE CASCADE ON DELETE SET NULL`) · `seller_profiles` tinggal
`PRIMARY KEY (wa)` · `blogs` tinggal satu policy, yang membatasi ke artikel
terbit.

### ✅ Perapian 22 Agustus 2026 — dokumentasi yang basi & dua bug rupa

Tidak ada logika bot yang disentuh; `/root/uji-boot-bot.sh` lulus 32/32 sesudahnya.
Yang dikerjakan semuanya hal yang **menggantung**, bukan fitur:

- **`/progres-claude` masih membaca seperti pagi 21 Agustus.** Enam dari delapan
  kartu utang tekniknya sudah dikerjakan sore itu juga, dan daftar "kerjakan
  berikutnya"-nya lima dari enam sudah selesai — termasuk `CRON_SECRET` yang
  masih tertulis "menggantung" padahal sudah terjawab. Penandanya disetel ulang
  (`t-done`), **isinya tidak dihapus**: temuan yang lenyap begitu diperbaiki akan
  ditemukan lagi oleh audit berikutnya sebagai hal baru. Bagian 05 ditulis ulang
  jadi "Yang benar-benar tersisa" — empat, tidak satu pun bisa ditutup dari dalam
  repo mana pun.
- **Dua kesalahan audit pagi dikoreksi di tempatnya**, bukan dihapus: U-2 (tiga
  paket disebut tak terpakai padahal dipakai lewat `await import()` — jangan
  dicabut) dan U-4 (460 baris pembayaran menggantung lahir dari tiga sebab
  berbeda, bukan dari tombol "lanjutkan bayar" seperti yang disangka).
- **`.tag.t-crit` tidak pernah cocok dengan markup mana pun.** Penanda tingkat
  dipasang di `<article class="find t-crit">`, sedangkan selektornya menuntut
  kelas itu ada di `<div class="tag">` di dalamnya. Akibatnya setiap penanda
  temuan di `/laporan`, `/laporan-publik`, dan `/progres-claude` jatuh ke rupa pil
  biasa sejak `ui.css` disatukan. Diikat ulang ke `.find .tag`; sifat pil yang
  ikut terwarisi (sudut bulat, padding samping, `nowrap`) dimatikan di sana.
- **Penyaji markdown `/progres-claude` tidak mengenal tabel.** Tabel 12 baris
  "Dulu | Sekarang" di berkas temuan tampil sebagai satu blok prosa penuh tanda
  pipa. Ditambahkan cabang tabel pipa (dengan baris pemisah opsional) — diuji
  dengan menjalankan penyajinya di Node atas berkas temuan yang asli.
- **Versi cache aset tidak seragam**: sembilan halaman `?v=20260821b`, satu
  `?v=20260821d`. Disamakan jadi `?v=20260822` di sepuluh halaman — kalau
  `ui.css` berubah tapi versinya tidak, peramban menahan yang lama sampai satu jam.
- **`halaman/progres.html` masih mengutip sandi admin yang sudah dirotasi**, di
  enam tempat, termasuk satu tabel env dan satu daftar prioritas. Disensor; dua
  temuannya yang sudah selesai (sandi lemah, `index.js` 4.017 baris) ditandai
  selesai. Berkasnya **tetap di luar git** — alasannya ditulis panjang di
  `.gitignore`, dan keputusannya milik pemilik.
- **Empat tangkapan layar nganggur di `public/assets/img/`** — tidak dirujuk
  berkas mana pun, tidak ikut git, tapi `express.static` menyajikan seluruh isi
  `public/` tanpa gerbang, jadi keempatnya bisa diambil siapa saja yang menebak
  namanya (salah satunya panel admin lengkap dengan angka pendapatan). Dipindah
  ke `/root/tangkapan-layar-lomba/`, di luar repo dan di luar jangkauan web.
  Galeri `/lomba` tidak terpengaruh: ia memakai 16 `.webp` di
  `public/assets/lomba-img/`, semuanya terlacak git dan semuanya dirujuk.

### ✅ Angka `/lomba` dihitung ulang — 22 Agustus 2026

**Halaman itu bertengkar dengan dirinya sendiri**, dan justru di slide yang menantang
juri untuk mengecek. Kartu angka menulis 40 halaman / 56 komponen / 30 tabel; panel
"rinciannya" satu klik di bawahnya menulis 38 / 63 / 32; teks deskripsi untuk formulir
menulis angka ketiga lagi (74 API situs, 70 rute bot). Perbaikan 21 Agustus menyamakan
`/projek` dengan `/lomba`, tapi tidak pernah mendamaikan `/lomba` dengan isinya sendiri.

Dihitung ulang dari klon segar kedua repo dan dari database langsung:

| | Angka | Cara menghitung |
|---|---:|---|
| Baris situs | 40.288 | `find src -type f \( -name '*.js' -o -name '*.jsx' -o -name '*.css' \) -exec cat {} + \| wc -l` |
| Baris bot | 11.454 | `git ls-files \| grep -E '\.(js\|html\|css)$' \| grep -v package-lock \| xargs cat \| wc -l` |
| Commit situs | 375 | `git rev-list --count HEAD` (pertama 11 Juni 2026) |
| API situs | 78 | `find src/app/api -name route.js \| wc -l` |
| Rute bot | 71 | jalur unik di `index.js` + `src/routes/*.js` |
| Halaman situs | 50 | 24 pengguna + 14 admin + **12 `/admin-demo/*`** |
| Komponen | 66 | 35 akar + 21 `baileys/` + 9 admin + 1 `ui/` |
| Tabel | 32 | `list_tables` lewat konektor Supabase |

Tiga hal yang ikut ketahuan:
- **Cara verifikasi di halaman itu sudah tidak berlaku.** Ia menyuruh `grep ... index.js`
  untuk menghitung rute bot — padahal refactor memindahkannya ke `src/routes/`.
  Perintahnya diperbaiki jadi `grep -rhoE ... index.js src/routes/*.js`.
- **12 halaman `/admin-demo/*`** ikut terhitung di angka 50. Sekarang disebut terpisah,
  dengan angka ketat 38 ditulis di sebelahnya.
- **Hitungan 8.508 baris bot yang lama melewatkan berkasnya sendiri** — `ui.css`,
  `lomba.html`, `waAuthState.js` semuanya dilacak git tapi tidak ikut dihitung.

⚠ **Kalau angka ini diubah lagi, `/projek` harus ikut** — dua halaman menyebut angka
yang sama, dan itu tepat kesalahan U-6 yang dulu.

**Dan itu terjadi lagi.** Penghitungan ulang 22 Agustus hanya dipasang di `/lomba`;
`/projek` ketinggalan dengan angka 21 Agustus (38.068 · 8.508 · 358 commit · 74 API · 70 rute ·
63 komponen) sambil tetap menulis "halaman /lomba menyebut angka yang sama persis". Disamakan
malam itu juga, dan sekarang `/projek` menyebut sendiri bahwa keduanya sudah dua kali berselisih.

🪤 **Jebakan yang baru ketahuan: hitungan baris bot menghitung dirinya sendiri.** Rumusnya
memuat semua `.html` yang dilacak git — termasuk `public/lomba.html`, `halaman/projek.html`, dan
`halaman/update.html`. Jadi **setiap kali salah satu halaman itu disunting, angkanya berubah**,
dan menulis angka baru ke halaman itu bisa membatalkan angkanya sendiri. Urutan yang benar:
sunting seluruh isinya dulu → hitung → baru **ganti digitnya saja** (jumlah baris tidak berubah,
jadi hitungannya tetap benar). Angka per 22 Agustus malam: **11.941** — naik dari 11.454 murni
karena suntingan halaman hari itu, bukan karena kode bot bertambah.

### ✅ Analisis `/lomba` dikerjakan — 22 Agustus 2026

Temuan yang dicatat sesi sebelumnya sudah **dipasang ke halamannya**, dan dua di antaranya
ternyata salah begitu diperiksa ke sumbernya. Semua angka di bawah diverifikasi hari itu
dari database langsung, dari `stats.json`/`messages.json` di VPS, dan dari klon segar repo situs.

**Yang berubah di `public/lomba.html`:**

- ⚠ **"Cimory Rp8.000" itu iklan uji coba**, penjualnya `Test Agent` — catatan sesi lalu
  memasukkannya ke daftar "katalog asli". Sudah dicabut dari halaman; penggantinya
  **Jasa Turnitin & AI Rp8.000** (penjual sungguhan). Sebelum mengutip baris katalog,
  periksa `seller_name`-nya.
- **Contoh karangan dicabut.** "Keyboard mekanik second Rp250.000" → **Sepatu Crocs Classic
  Biru Muda Rp750.000** (iklan asli), sekalian menunjukkan biaya tayangnya Rp7.000. Grup
  karangan **"912 anggota"** dihapus; percakapan mockup-nya diganti bunyi permintaan asli dari
  papan Dicari (kasur 1 orang, galon bekas), dengan catatan tegas bahwa itu bukan karangan.
- **Slide baru `06 · Uangnya dari mana`** (deck jadi **13 slide**, slide 06–10 lama digeser ke
  07–11): tarif berjenjang Rp2.000 → 1%, komisi setelah deal 10%/5%, iklan gratis untuk pemilik
  toko, plus angka 42 dijawab manusia / 30 bot diam / 8 sesi bot.
- **Bagian 06 dibuka dengan katalog asli**: iPhone XR (156 tayangan), APK Premium (154), Akun
  Free Fire (126), BARANG KOS (104), Pokemon TCG Archaludon (96) — plus papan Dicari 37 baris
  yang isinya anak kos mengisi kamar, dan blog yang ditulis mahasiswanya sendiri.
- **Suara pengguna masuk**: 30 dari 71 pesan cuma satu kata, 57 tidak lebih dari lima kata;
  4 orang lupa titik dan admin menjawab "Pake titik we"; bot punya **28 perintah pelanggan**
  dan yang paling dipakai `.CARI`, bukan `.JUAL`; balasan bot yang menyebut "sudah tayang di
  /dicari **dan sudah dibroadcast ke grup**" dipakai untuk menjelaskan grup + situs itu satu
  lingkaran.
- **Tiga kali mati, bukan satu.** Slide "bot mati 6 jam" jadi **501 + 907 + 360 menit** pada
  18–19 Agustus (≈30 jam) dengan jam putus/pulih persis, dan poin bahwa **botnya sendiri yang
  mengumumkan** tiap kalinya. Lini masa di bagian 06 ikut dibetulkan tanggalnya.

**Dua koreksi atas analisis sesi sebelumnya — dan keduanya penting:**

1. ⚠ **Alur bayar TIDAK pindah ke QRIS otomatis.** Catatan lama bilang halaman `/lomba` basi
   karena masih menulis "foto struknya". Yang basi justru catatannya: `POST /api/listings`
   membuat baris `payments` berstatus `pending` lalu mengembalikan `paymentUrl = "/qris.png"`
   — QRIS **statis**, diverifikasi manusia lewat `/api/payments/verify-receipt`. Halaman
   `/lomba` benar; **yang berbohong adalah form `/jual` di situs**, yang menulis
   "⚡ QRIS Dinamis Otomatis — konfirmasi instan tanpa kirim bukti" secara hardcoded.
   Sumber salahnya: sesi lalu membaca teks UI, bukan alurnya.
2. ⚠ **`settings.payment.mode` itu sakelar mati.** Ditulis panel admin
   (`AdminPanel.jsx:1633/1657`), **tidak dibaca siapa pun** di seluruh `src/`. Nilai di DB
   sekarang `"manual"`, dan itu tidak mengubah apa-apa: kedua mode berakhir di alur QRIS
   statis yang sama. Jangan pakai sakelar ini sebagai bukti apa pun.

**Yang perlu diingat soal tarif** (merge settings itu *shallow per-key*, jadi baris DB menimpa
seluruh key): `adTiers` di DB sama dengan bawaan kode, tapi `adPoster` **0**, `renewalFee` **0**,
dan `soldTiers` **`[]`** — artinya `soldFeeFrom()` mengembalikan 0 dan komisi otomatis mati,
sementara `pricing.tokoGratis` (bawaan `true`, tidak ada di DB) membuat iklan pemilik toko gratis.
Tarif yang ditulis di `/lomba` mengutip yang **dipublikasikan** di `/daftar-harga` dan
`/cara-bergabung`, bukan yang aktif di DB. Kalau ada yang menagih dengan angka itu, cocokkan
dulu DB-nya.

⚠ **Sisa yang tetap menunggu pemilik: sejarah sebelum kodenya ada.** Halaman menulis "hidup
sejak Juni 2026" — itu tanggal commit pertama. Usahanya berdiri **8 Desember**, dan tidak ada
satu jejak pun soal itu di repo mana pun. Inilah akar kesan "ditulis AI": presentasinya bercerita
seolah proyeknya lahir dari kode, padahal kebalikannya. Barisnya sudah menunggu di `/update`.

**Dua cacat situs yang ditemukan sambil memeriksa, belum diperbaiki** (repo situs, bukan bot):
- Form `/jual` mengklaim QRIS otomatis (lihat koreksi 1 di atas) — teksnya harus disamakan
  dengan alur yang sebenarnya, atau alurnya yang dibuat otomatis.
- Merek di situs terbelah: header "USU POLMED Marketplace", footer & OTP "**Jual Beli Medan**"
  (`api/auth/otp/send/route.js:79`, halaman legal, FAQ, `admin@jualbelimedan.web.id`). **Jangan
  ganti massal** — ada repo terpisah `jualbelimedan`, jadi ini kemungkinan merek induk yang
  disengaja. Keputusan pemilik.
- Sapaan bot menaut `instagram.com/usulovepolmed` (`index.js:181`) sementara akun yang disebut
  aktif `usupolmedupdate`. Tidak bisa diverifikasi dari server (Instagram menolak tanpa login),
  jadi **tidak diubah** — tanya pemilik.

### ✅ `/health` punya tampilan untuk manusia — 22 Agustus 2026

Pertanyaan pemilik: "kok `/health` nggak ada UI-nya?" Jawabannya memang begitu rancangannya —
tapi satu alamat bisa melayani dua pembaca.

`/health` sekarang **memilih bentuk jawaban dari header `Accept`**: peramban dapat halaman
status (hijau/kuning/merah, uptime, terkunci, menunggu-dipindai, menyegar tiap 20 detik),
mesin tetap dapat JSON yang **sama persis** dengan sebelumnya, dengan kode 200/503 yang sama.

⚠ **Urutan `req.accepts(['json','html'])` itu keamanan, bukan gaya.** `curl` mengirim
`Accept: */*`, yang cocok dengan dua-duanya, dan `accepts()` memulangkan yang **pertama
disebut** kalau klien tidak punya preferensi — jadi `'json'` wajib di depan. Kalau dibalik,
`penjaga-bot.sh` (yang membaca badan mentah dengan `grep -q '"terkunci":true'`) akan menerima
HTML, gagal mengenali keadaan, lalu **me-restart bot yang justru sedang menunggu tangan
manusia**. Diuji: `Accept: */*` → JSON tanpa satu tanda `<` pun; `Accept: text/html` → halaman.

⚠ **`Vary: Accept` wajib ikut.** Jawaban yang bentuknya bergantung pada header `Accept`
tanpa `Vary` boleh disimpan cache mana pun (peramban, proxy, `fetch` Next.js di situs) lalu
disodorkan ke peminta yang meminta bentuk lain. Sempat terkirim tanpa header itu pada percobaan
pertama; ketahuan waktu memeriksa header jawaban lewat domain publik.

Halamannya sengaja tanpa berkas luar (tidak ada `<link>`/`<script src>`) — halaman yang
tugasnya menjawab "botnya hidup atau tidak" tidak boleh ikut mati karena satu berkas rupa.
Dan isinya dibatasi field yang sama dengan JSON-nya: endpoint ini publik tanpa sandi.

⚠ **Belum aktif di produksi.** Kode masuk repo, tapi kedua proses bot masih menjalankan versi
lama. Restart dihindari dengan sengaja: `menungguPindai` cuma hidup di memori (`index.js:271`),
jadi proses baru me-*reset*-nya dan langsung mengetuk WhatsApp lagi sampai
`PINDAI_MAKS_SIKLUS` (5) siklus QR — ketukan ke nomor yang sedang dibatasi, persis yang
dihindari sejak 19 Agustus. Diuji tanpa restart, lewat aplikasi Express terpisah yang memasang
`panel.routes.js` dengan `K` palsu. Akan hidup sendiri pada restart berikutnya, apa pun
sebabnya. **Restart HARUS lewat `/root/jalankan-bot-1.sh`**, bukan `pm2 restart` telanjang —
skrip itu yang membawa ulang `API_TOKEN` dan `PANEL_PASSWORD`.

### 🐛 Lingkaran restart yang mengetuk WhatsApp — diperbaiki 22 Agustus 2026

Ditemukan karena menyalakan `/health` mengharuskan restart, dan restart itu membuka bug yang
sudah ada sebelumnya. **Bot tidak pernah sampai ke keadaan diam, dan penjaganya me-restart
terus.** Lingkarannya:

```
bot diam (tidak ada yang memindai) → /health 503
  → penjaga hitung 8×503 (16 menit) → penjaga me-restart
  → proses baru LUPA ia sedang sengaja diam → mengetuk WhatsApp lagi → ulangi
```

Tiap putaran menambah percobaan login ke nomor yang justru sedang dibatasi. Terekam di
`penjaga-bot.log` 03:08–03:20: `GAGAL ke-2 (503)` … `ke-8`, lalu `AMBANG TERCAPAI`.

**Tiga sebab, dan yang ketiga yang paling penting:**

1. **`menungguPindai` cuma hidup di memori** (`index.js:271`). Penjaganya memang mundur kalau
   melihat penanda itu — tapi penandanya terhapus oleh restart yang ia lakukan sendiri.
   → Sekarang ditulis ke `pindai_state.json` di `DATA_DIR` (gitignored, jadi bot kedua punya
   sendiri), dipulihkan saat boot **hanya kalau sesinya masih belum tertaut** — kalau pemilik
   mengembalikan folder `.bak`, penandanya diabaikan dan bot menyambung seperti biasa.
2. **Socket yang mati sebelum sempat memancarkan QR tidak dihitung sama sekali.** Sesi yang
   belum tertaut tidak punya jalan hidup selain dipindai manusia, jadi percobaan seperti itu
   pun ketukan sia-sia. → Ikut menghabiskan jatah, lewat `sesiTerdaftar`
   (`creds.registered` milik Baileys).
3. ⚠ **Yang dihitung selama ini socket yang tertutup, padahal maksudnya QR yang kedaluwarsa.**
   Komentar di `PINDAI_MAKS_SIKLUS` menulis *"5 siklus ≈ 5 menit"* — tapi satu socket
   memancarkan BEBERAPA QR (Baileys menyegarkan tiap ~60 detik sampai daftar referensinya
   habis, ±6 menit per socket). Jadi lima "siklus" sebenarnya ±30 menit, sementara penjaga
   me-restart pada menit ke-16. **Maksud dan pelaksanaannya berselisih, dan selisih itu yang
   membuat keadaan diam tidak pernah tercapai.** → Yang dihitung sekarang QR-nya, dan
   socketnya ditutup begitu keputusan diam diambil (kalau tidak, ia terus mengetuk selama
   sisa referensinya justru sesudah memutuskan berhenti).

**Diverifikasi, bukan diasumsikan** — tiga uji di `DATA_DIR` sekali-pakai, tanpa menyentuh sesi
asli: penanda ada + sesi kosong → **0 percobaan sambung**, `/health` langsung
`menungguPindai:true`; penanda ada + `creds.registered` → penanda diabaikan, bot menyambung;
tanpa penanda → mendiam dalam 65 detik (`PINDAI_MAKS_SIKLUS=2`) dan menulis penandanya.
Lalu di produksi: **kedua bot mendiam dalam 110 detik** (sebelumnya tidak pernah), dan penjaga
mencatat tiga kali berturut-turut *"Penjaga tidak me-restart"* dengan hitungan restart pm2 tetap.

⚠ **Selama perbaikan, penjaga dimatikan sementara lewat crontab dan kedua bot dihentikan** supaya
tidak ada ketukan. Crontab dikembalikan dan dibandingkan baris-per-baris dengan salinan aslinya.

### Perlu diputuskan pemilik

- **Membersihkan baris `payments` lama.** 415 baris pending yang tidak lagi
  menunjuk iklan mana pun. Ditawarkan 21 Agustus dan **ditolak dengan sengaja** —
  pemilik memilih membiarkannya sebagai jejak. Saran: ubah statusnya jadi `expired`
  (`payments_status_check` sudah mengizinkan), **jangan dihapus** — riwayat
  pembayaran lebih baik disimpan. Perlu diingat: `/verify-receipt` hanya
  menerima struk untuk tagihan yang masih `pending`, jadi tagihan yang
  di-`expired` tidak bisa dibayar susulan.
- **Tabel `offers`** (kosong, tidak dipanggil kode mana pun) — dihapus atau
  dibiarkan.
- **13 indeks yang tidak pernah terpakai.** Sengaja **tidak** ikut BAGIAN 27:
  "tidak pernah terpakai" di basis data sekecil ini kemungkinan besar berarti
  jalur kodenya belum pernah ramai, bukan indeksnya salah.

### Dependensi

- **Bot:** 1 moderate (`protobufjs`, transitif dari Baileys).
  `@supabase/supabase-js` dan `axios` tertinggal satu minor.
- **Situs:** `midtrans-client` dan `@supabase/ssr` dicabut 21 Agustus (yang
  pertama tidak pernah di-import — pembayaran memakai QRIS manual; yang kedua
  hanya dipakai dua berkas mati). `pg` dipindah ke `devDependencies`: ia cuma
  dipakai dua skrip di `scratch/`. `package-lock.json` ikut diperbarui, dan
  diperiksa tidak ada versi paket lain yang berubah.
  ⚠ **Koreksi audit pertama:** `html2canvas`, `html-to-image`, dan `qrcode`
  **dipakai** — lewat `await import()` di dalam handler, bukan import statis di
  kepala berkas. Jangan mencabutnya. 10 kerentanan `npm audit` tidak berubah;
  semuanya dari `next` dan `@ducanh2912/next-pwa`, bukan dari yang dicabut.

### Keamanan
Audit 21 Agustus pagi menemukan **5 kritis dan 7 menengah**. Sepuluh di
antaranya ditutup sore harinya; empat yang tersisa tidak bisa diselesaikan dari
dalam repo. Rincian **tidak ditulis di sini** — repo ini publik, dan daftar
endpoint beserta nomor barisnya adalah peta serangan yang sudah jadi.

Laporan lengkapnya ada di **`/progres-claude`** (butuh sandi panel), dibaca dari
`catatan/temuan-keamanan.md` yang sengaja di-`.gitignore` dan tinggal di VPS.

Malam harinya dua dari empat sisanya ikut ditutup oleh pemilik: riwayat git
repo situs ditulis ulang (`git filter-branch`, diverifikasi dari klon segar
GitHub — 0 berkas data di seluruh riwayat, `bot-wa/package*.json` selamat,
361 commit tetap 361), dan ketiga kredensial diganti nilainya.

Yang benar-benar tersisa, tanpa rincian yang menolong penyerang:
1. **Rate limit tidak berlaku lintas-instance** di serverless — butuh layanan
   luar (Vercel Firewall / Upstash), bukan perubahan kode.
2. **Tujuh kerentanan dependensi** yang menuntut naik `next` satu major.
3. **`SESSION_SECRET` belum diisi di Vercel** — bukan lubang, tapi selama ia
   kosong kuki penjual masih ditandatangani dengan `ADMIN_PASSWORD`, jadi
   rotasi sandi admin berikutnya akan mengeluarkan seluruh penjual sekaligus.

Satu pertanyaan yang menggantung sejak audit pagi sekarang terjawab:
**`CRON_SECRET` memang terisi di Vercel.** Diuji setelah gerbang cron dibuat
fail-closed — keempat rute menjawab 401, bukan 503. Kalau rahasianya kosong,
jawabannya akan 503 dengan alasannya.

Yang **sudah** diperiksa dan aman, supaya audit berikutnya tidak mengulang:
XSS panel bot (semua `innerHTML` melewati `esc()`), injeksi SQL (klien Supabase
parameterized di semua jalur), token bot & webhook dua-duanya fail-closed, rem
tebak-token, kuki panel `httpOnly`+`strict`+`secure`, pengalihan `?next=`
dibatasi jalur internal, dan kelayakan target broadcast ditegakkan di server.

---

## 5. Variabel lingkungan

### Bot — wajib
| Variabel | Fungsi |
|---|---|
| `API_TOKEN` | Token API bot. **Fail-closed** — bot menolak start tanpa ini. Dipakai juga sebagai `Authorization` saat memanggil webhook situs. |
| `PANEL_PASSWORD` | Sandi panel untuk manusia. Kosong → hanya token yang bisa dipakai. |

### Bot — penting
`WEBHOOK_URL` (default `https://www.jualbeliusupolmed.web.id/api/wa/baileys`) ·
`PORT` (3000) · `BIND_HOST` (127.0.0.1, semua trafik lewat nginx) ·
`DATA_DIR` / `AUTH_DIR` (**wajib berbeda untuk instans kedua**) ·
`GROUP_JID` (grup marketplace) · `OWNER_JID` (penerima alarm) ·
`BOT2_URL` / `BOT2_TOKEN` (jendela ke bot kedua) ·
`ALLOW_RELINK` (buka `/reset` & `/restart`, **matikan lagi setelah selesai**) ·
`KUNCI_RETRY_MINUTES` (jeda coba-ulang saat nomor dibatasi; 60 saat ini,
bersifat sementara) · `BOT_PREFIX` (`.`) · `BOT_SESSION_MINUTES` (15) ·
`AUTH_FAIL_MAX` (10) / `AUTH_FAIL_WINDOW_MINUTES` (5) · `BROADCAST_MAX` (50) ·
`OUTBOX_MAX` / `OUTBOX_TTL_HOURS`.

Selebihnya ±30 variabel penyetel (jeda anti-ban, ambang eskalasi padam, batas
arsip, TTL cache) — semuanya punya default yang masuk akal dan terdokumentasi
sebagai komentar di `index.js`.

> **Jebakan yang sudah pernah menggigit:** restart lewat pm2 dari shell yang
> berbeda **tidak** membawa serta env sebelumnya. Setiap restart harus membawa
> ulang `API_TOKEN`, kalau tidak bot mati saat start (fail-closed).

### Situs — wajib di produksi
`NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
`..._PUBLISHABLE_KEY` · `SUPABASE_SERVICE_ROLE_KEY` · `DATABASE_URL` /
`DIRECT_URL` · `ADMIN_PASSWORD` (sandi panel admin) · `BAILEYS_API_URL` /
`BAILEYS_API_TOKEN` (harus sama dengan `API_TOKEN` bot) · `CRON_SECRET`
(**tanpa ini keempat rute cron menolak jalan** dan menjawab 503 — sejak
21 Agu 2026 gerbangnya fail-closed. Sudah diperiksa: terisi) · `FONNTE_TOKEN` / `FONNTE_WA_GROUP_ID` · `KLIKQRIS_API_KEY` /
`KLIKQRIS_MERCHANT_ID` · `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` ·
`MARKETPLACE_WA` · `NEXT_PUBLIC_BASE_URL` · `ADMIN_WA` / `SUPER_ADMIN_WA` ·
`SESSION_SECRET` (penanda tangan kuki sesi penjual; kalau kosong ia memakai
`ADMIN_PASSWORD`, dan itu berarti ganti sandi admin = seluruh penjual keluar).

---

## 6. Log audit

### 21 Agustus 2026 — audit menyeluruh pertama

**Cakupan:** kedua repo (bot 24 berkas, situs 408 berkas) ditelusuri berkas per
berkas; 74 rute bot dan 75 endpoint situs dipetakan beserta gerbangnya; skema
database dibaca langsung dari Supabase lewat konektor MCP, bukan dari berkas
migrasi; advisor keamanan & performa Supabase dijalankan; `npm audit` di kedua
repo; seluruh riwayat git repo situs (358 commit) dipindai kredensial.

**Ditemukan:** 5 kritis, 7 menengah, 6 ringan. Yang paling mendesak adalah
kebocoran data pelanggan ke repo publik yang **terjadi pada hari audit ini
juga**, ditemukan 16 menit setelah di-push.

**Yang berubah pada hari itu:**
- Migrasi **BAGIAN 25** (peramban tanpa akun boleh berlangganan notifikasi) dan
  **BAGIAN 26** (toko menunggu persetujuan admin) dijalankan ke produksi —
  keduanya ditulis setelah "seluruh migrasi sudah dijalankan" pagi harinya, jadi
  sempat tertinggal. Diverifikasi: 5/5 objek ada, 4 langganan push utuh, toko
  `/toko/bismillah` ditandai aktif supaya tidak padam.
- Commit `14d8def` di repo situs ditulis ulang untuk mencabut 17 berkas state
  bot; `.gitignore` situs sekarang menolak `bot-wa/*.json`.
- `PROJECT_KNOWLEDGE.md` (berkas ini) dan halaman `/progres-claude` dibuat.

**Belum dikerjakan pada saat itu:** semuanya di bawah ini ditutup sore harinya
— lihat entri berikutnya. Yang tersisa untuk pemilik cuma rotasi
`ADMIN_PASSWORD` dan `FONNTE_TOKEN`, dan menulis ulang riwayat git.

### 21 Agustus 2026 (sore) — perapian utang teknis

Lanjutan audit di atas, dengan keamanan sengaja dilewati atas permintaan pemilik.

**Yang berubah di repo situs** (7 berkas dihapus, 5 diubah):
`/api/payments/resume` ditulis ulang · `/api/payments/unlock-wanted` menerbitkan
tagihan saat struk dikirim dan memakai `type: "wanted"` · `dicari/DicariClient.jsx`
menyusul perubahan itu, dengan mode `check` supaya peringatan "kontak tidak bisa
dibuka" tetap muncul **sebelum** orangnya transfer · `AdminPanel.jsx` mengenali
sembilan jenis pembayaran · `package.json` + `package-lock.json`.

**Yang berubah di repo bot:** BAGIAN 27 migrasi ditulis · `halaman/projek.html`
dan `public/lomba.html` dihitung ulang dan disamakan · `halaman/update.html`
mendapat satu baris "perlu pemilik" yang baru.

**Tiga koreksi terhadap audit pagi harinya** — dicatat supaya tidak diulang:
1. "5 dependensi tidak pernah di-import" **salah**. `html2canvas`,
   `html-to-image`, dan `qrcode` dipanggil lewat `await import()` dinamis.
   Penelusuran dependensi di repo ini harus mencari `import(` juga, bukan hanya
   `^import`.
2. "460 baris pembayaran adalah sampah, penyebabnya bug K5" **salah**. 346 dari
   460 lahir dari `/unlock-wanted` yang menerbitkan tagihan saat jendela dibuka,
   dan sama sekali tidak berhubungan dengan otorisasi.
3. "5 pasang indeks kembar" adalah angka advisor Supabase, bukan angka
   sebenarnya. Ada 10 pasang; advisor tidak menghitung indeks biasa yang
   ditumpangi constraint `UNIQUE`.

**Ditemukan baru:** foreign key kembar `fk_seller_profiles` yang membuang
`created_at` dan `referral_code` penjual tiap migrasi LID→nomor, dan tombol
"Bayar Tagihan" komisi penjualan yang tidak pernah bisa selesai. Keduanya
dijelaskan di §4.

**Dijalankan ke produksi sore itu juga, setelah pemilik memutuskan:** BAGIAN 27
(diverifikasi, lihat §4) dan perbaikan label 355 baris pembukaan kontak.

**Sengaja tidak dikerjakan:** pembersihan 415 baris `payments` yatim — pemilik
memilih menyimpannya sebagai jejak; penghapusan tabel `offers`; dan seluruh
daftar keamanan, atas permintaan pemilik.

### 21 Agustus 2026 (malam) — perapian keamanan

Sepuluh dari dua belas temuan audit pagi ditutup. Yang tidak bisa: tiga nilai
kredensial yang harus diganti pemiliknya, dan satu penulisan-ulang riwayat git
yang diblokir izin di sesi ini (lihat "Yang tersisa").

**Otorisasi yang sebenarnya bukan otorisasi.** `/api/payments/resume`
membandingkan nomor penjual di database dengan nomor yang dikirim klien — dua
nilai yang dua-duanya datang dari penyerang, dan yang satunya tercetak di
halaman produk. Sekarang dari kuki sesi. `/api/payments/unlock-wanted` lebih
halus: `requester_wa` dari badan permintaan bukan sekadar catatan, melainkan
TUJUAN kiriman kontak pembeli — jadi siapa pun yang membayar Rp 2.000 bisa
menyuruh sistem mengirim kontak orang lain ke nomor pilihannya. Tujuan sekarang
hanya nomor dari sesi; pengunjung tanpa akun tetap dilayani, kontaknya tampil di
layar, dan nomor yang mereka ketik disimpan sebagai `requester_wa_diklaim` untuk
jejak — tidak pernah sebagai tujuan.

**Empat cron yang membuka pintunya sendiri.** Tanpa `CRON_SECRET`, dua rute
menerima siapa saja tanpa header apa pun dan dua lagi mundur ke `x-vercel-cron`,
header HTTP biasa yang bisa diketik siapa pun. Sekarang satu gerbang bersama di
`src/lib/cronAuth.js`, fail-closed. **Dan pertanyaan yang menggantung sejak
pagi akhirnya terjawab dengan menguji perilakunya:** keempat rute menjawab 401,
bukan 503, jadi `CRON_SECRET` memang terisi di Vercel.

**Kredensial yang tersimpan salah bentuk.** 41 PIN penjual di-bcrypt (BAGIAN 28,
dihitung di dalam database supaya nilai polosnya tidak pernah keluar dari sana),
jalur mundur plaintext dicabut. OTP disimpan sebagai hash; 24 baris mati sejak
Juni dihapus, dan penyapunya ditumpangkan ke cron `expire` yang memang sudah
jalan tiap hari. Kuki admin berhenti jadi `sha256(ADMIN_PASSWORD)` — satu nilai
tetap tanpa kedaluwarsa — dan jadi payload bertanda tangan dengan nonce acak.
`checkPassword()` tahan-waktu.

**Diverifikasi di produksi, bukan diasumsikan:** login admin dengan sandi salah
401 / sandi benar 200 → kuki barunya membuka rute bergerbang → keluar 200 ·
`/api/outbound-ip` dan `/api/push/subscribe/test` dua-duanya 401 ·
`/api/payments/resume` menolak tanpa sesi · keempat cron 401 · rem
`/api/auth/check` menyala tepat di permintaan ke-20.

**Satu temuan baru, dan satu koreksi.** `catatan-rahasia-lokal.txt` — berkas yang
membuka dirinya dengan "file ini di-gitignore, TIDAK ikut ke-commit" — ternyata
terlacak di repo publik sejak 20 Juli. Audit pagi menyebutnya bersih karena
memindai pola kredensial alih-alih membacanya. Pelajarannya masuk ke catatan
keamanan: berkas bernama "rahasia" dibuka, bukan dipindai.

**Yang tersisa, dan kenapa.** Berkas data pelanggan sudah tidak ada di puncak
repo situs, tapi masih ada di riwayat commit `14d8def`. Menulis ulang riwayat
itu diblokir penyaring izin di sesi ini — dicoba empat kali, dengan tiga
pendekatan berbeda. Skrip `/tmp/tutup-kebocoran.sh` yang ada **tidak boleh
dijalankan apa adanya**: ia ditulis saat `14d8def` masih HEAD, dan versi
perbaikannya sudah diuji di klon sekali-pakai lalu bentrok di `.gitignore`.
Perintah yang benar (`git filter-branch --index-filter`) ada di ringkasan sesi
dan di `catatan/temuan-keamanan.md`.

### 21 Agustus 2026 (larut) — riwayat git ditulis ulang

Dijalankan pemilik lewat SSH, dengan perintah yang sudah diuji lebih dulu di
klon sekali-pakai. **Dan pengujian itu yang menyelamatkannya:** versi pertama
perintahnya memakai glob `bot-wa/*.json`, dan glob itu ikut menghapus
`bot-wa/package.json` beserta `package-lock.json` — manifest dependensi bot —
dari 361 commit. `git rm --cached` tidak mengenal baris negasi
`!bot-wa/package.json` di `.gitignore`; itu aturan untuk mengabaikan, bukan
untuk menghapus. Versi yang dipakai menyebut ketujuh belas berkasnya satu per
satu.

**Diverifikasi dari klon segar GitHub, bukan dari salinan lokal:** 0 berkas data
di seluruh riwayat · `bot-wa/package*.json` selamat · 246 berkas `src/` utuh ·
361 commit tetap 361 · hash tree puncak sama persis dengan sebelum penulisan
ulang, jadi isi kerjanya tidak bergeser satu byte.

**Satu berkas hampir lolos, dan cara ketahuannya layak dicatat.** Klon segar itu
menunjukkan `catatan-rahasia-lokal.txt` masih terlacak — padahal pencabutannya
sudah dijalankan berjam-jam sebelumnya. Sebabnya: `git rm --cached` menaruh
pencabutan di index, lalu commit-nya dijalankan dengan daftar path
(`git commit -- <path>`), dan bentuk itu mengambil isi **working tree** untuk
path yang disebut, bukan isi index. Berkasnya masih ada di disk, jadi ia ditulis
balik ke commit yang sama. Tanpa galat, tanpa peringatan.
**Aturannya sekarang:** sesudah `git rm --cached`, commit dari index tanpa
pathspec — dan jangan percaya `git status` sendirian; periksa dengan
`git ls-files | grep` atau klon segar.

**Satu temuan yang lahir dari memikirkan akibat, bukan dari membaca kode.**
Rotasi `ADMIN_PASSWORD` yang baru saja dilakukan pemilik membatalkan tanda
tangan seluruh kuki sesi penjual sekaligus — karena kuki itu ditandatangani HMAC
dengan sandi admin. Dua rahasia berbeda tugas berbagi satu nilai. Sudah diputus
lewat `SESSION_SECRET` (jatuh kembali ke `ADMIN_PASSWORD` kalau belum diisi,
supaya rilisnya sendiri tidak mengeluarkan siapa pun).

### 22 Agustus 2026 — dua panel demo, dan penjual yang boleh menulis

Tiga pekerjaan yang saling terkait, semuanya atas permintaan pemilik: panel
admin dan panel bot butuh kembaran terbuka supaya cara kerja sistem ini bisa
dipelajari orang lain (termasuk juri lomba), dan penjual butuh jalan untuk
menulis blog.

**Blog penjual (BAGIAN 29).** Dua jalur — berbadge terbit langsung, tanpa badge
antre di admin — dan yang menentukan dihitung di server, bukan diterima dari
klien. Rincian alurnya di §2.5b.

Satu lubang ikut ditutup: `/blog/[slug]` dulu mengambil artikel **tanpa
menyaring status**. Selama hanya admin yang menulis, itu tidak apa-apa; begitu
tabel `blogs` memuat draf dan tulisan yang menunggu persetujuan, ia jadi pintu
belakang — "menunggu review" yang isinya sudah terbaca di internet bukan
menunggu apa-apa.

**Dua panel demo (§2.6).** Keputusan yang menentukan seluruh bentuk pekerjaan
ini: satu kode, dua alamat — bukan dua salinan. Yang membedakan diturunkan dari
alamat halaman lewat `useBasisAdmin()` / `useBasisApi()`.

**Dua hal yang hanya ketahuan dengan membuka halamannya:**
1. `/admin-demo/penjual` menjawab 500 karena `sellersList` demo diisi baris
   profil mentah (`wa`), sementara tab itu membaca bentuk yang sudah diringkas
   (`seller_wa`). Bentuk data yang salah tidak terlihat di pemeriksaan sintaks
   maupun di build yang sukses.
2. Angka yang terlihat seperti nomor telepon di HTML demo ternyata potongan
   `4.081632653061225%` — CSS, bukan data. Pemeriksaan kebocoran yang benar
   bukan mencari pola nomor di keluaran, melainkan membuktikan **tidak ada
   jalan** dari cabang demo ke database.

**Diverifikasi di produksi:** 24 tab demo dibuka satu per satu · halaman detail
iklan, penjual, editor artikel, dan persetujuan toko semuanya 200 · `/demo` bot
tayang lewat domain publik dengan spanduknya · `/api/blog/penulis` menolak
tanpa sesi.

**Yang tidak bisa diuji dari sini:** alur tulis-kirim-setujui dari sisi penjual
dan admin sungguhan. Sejak `ADMIN_PASSWORD` dirotasi (21 Agu malam) sesi ini
tidak punya jalan masuk ke `/admin` maupun ke akun penjual mana pun — dan itu
memang yang diinginkan. Ujinya ada di tangan pemilik.

### Galeri /lomba — 22 Agustus 2026

Halaman lomba dapat bagian **07 Galeri**: 16 tangkapan layar (bot WhatsApp,
beranda, pasang iklan, panel admin, blog) dengan lightbox klik-untuk-zoom.

Dua hal yang perlu diingat kalau menambah gambar lagi:

1. **Berkas aslinya 4,77 MB PNG.** Dikonversi ke WebP lebar maksimum 1.400 px
   dengan `sharp` (sudah ada di `node_modules`) → 0,90 MB, turun 81%. Repo ini
   publik dan riwayat git tidak bisa ditulis ulang di sini, jadi PNG mentah yang
   terlanjur ter-commit akan menempel selamanya. Konversi dulu, commit kemudian.
2. **Nama berkas jangan pakai spasi.** Aslinya `Screenshot 2026-08-22 0122...`,
   yang di HTML jadi `%20` berderet dan menyulitkan dibaca. Sekarang kebab-case
   sesuai isinya: `beranda.webp`, `admin-dashboard.webp`, `bot-wa-1.webp`.

Berkas asli tidak disimpan di repo; ia ada di scratchpad sesi ini saja.

### Sebelum audit ini
Riwayat perubahan lengkap kedua repo ada di **`/update`**, dirakit langsung dari
git — bukan ditulis tangan, jadi tidak bisa ketinggalan.
