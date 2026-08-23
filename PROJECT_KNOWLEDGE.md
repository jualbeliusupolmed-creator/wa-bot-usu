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
   │ Supabase  │  43 tabel
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
| `index.js` | 3.030 | Inti bot: soket Baileys, antrean kirim, state, dan pemuatan modul. Dulu 4.075 baris dan memuat semuanya. |
| `src/lib/utils.js` | 184 | 18 fungsi murni — masuk-keluar, tanpa state. |
| `src/lib/gerbang.js` | 265 | Token mesin, sandi manusia, kuki sesi, rem tebak-token, dua gerbang pemulihan. Berbentuk pabrik. |
| `src/routes/web.routes.js` | 252 | 18 rute yang menjawab HTML + pintu masuk/keluar. |
| `src/routes/panel.routes.js` | 426 | 18 rute data yang dibaca dashboard. |
| `src/routes/wa.routes.js` | 572 | 30 rute yang menyentuh WhatsApp. |
| `src/routes/sesi.routes.js` | 123 | 8 rute taut-ulang, reset, buka kunci, bot kedua. |
| `src/routes/antrean.routes.js` | 139 | 4 rute antrean kirim & proxy antrean situs. |
| `waAuthState.js` | 302 | Penyimpan sesi Baileys di filesystem, dengan cadangan berputar & tulis atomik. |
| `useSupabaseAuthState.js` | 190 | Adapter sesi ke Postgres. **Tidak dipakai** (tidak ada env Supabase). |
| `halaman/dashboard.html` | 1.102 | Panel operasi: QR, inbox chat, statistik gerbang, blocklist, story, log. |
| `halaman/home.html` | 449 | Daftar tombol ke semua halaman & endpoint. |
| `halaman/update.html` | 513 | Linimasa perubahan (dari git) + daftar "Yang belum selesai" yang ditulis tangan. 11 baris, semuanya `Perlu pemilik`. |
| `halaman/projek.html` | 216 | Catatan proyek naratif. Angkanya dihitung ulang 22 Agu 2026, sama dengan `/lomba`, dan cara menghitungnya ikut ditulis. |
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

### 1.4 Database — 43 tabel

Semua tabel punya RLS aktif. Situs mengaksesnya dengan service-role dari server;
`anon` hanya boleh membaca yang memang publik (iklan aktif, kategori, profil
penjual, blog, penilaian, papan dicari).

**Super App (semua sejak 23 Agu 2026)**
`mading_posts` · `mading_comments` · `mading_likes` · `mading_reports`
(lapor + auto-sembunyi) · `chat_rooms` · `chat_messages` (keduanya TANPA
kebijakan publik — lihat catatan RLS 23 Agu) · `keyword_subscriptions`
(perintah `.PANTAU`) · `receipt_hashes` (anti-fraud struk) · `buyer_contacts` · `chat_reports` + `chat_bans` (lapor & blokir otomatis)

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
jadi hitungannya tetap benar). Angka per 22 Agustus malam: **12.411** — naik dari 11.454 murni
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

✅ **Aktif di produksi sejak 22 Agustus 2026.** Sempat ditahan karena menyalakannya berarti
restart, dan `menungguPindai` waktu itu cuma hidup di memori: proses baru me-*reset*-nya lalu
mengetuk WhatsApp lagi — ketukan ke nomor yang sedang dibatasi. Ketakutan itu terbukti benar
(lihat bagian lingkaran restart di bawah), penyebabnya diperbaiki, baru halamannya dinyalakan.
**Restart HARUS lewat `/root/wa-bot-usu/jalankan.sh`**, bukan `pm2 restart` telanjang — skrip
itu yang membawa ulang `API_TOKEN` dan `PANEL_PASSWORD`.

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

### 🐛 Sebab keempat: keadaan diam yang cuma berlaku sekali — 22 Agustus 2026 (pagi)

Tiga sebab di atas benar dan perbaikannya bekerja — **untuk siklus pertama saja.** Empat jam
sesudahnya kedua bot mengetuk WhatsApp lagi tanpa henti, tiap ≤60 detik, dan tidak ada satu pun
baris log yang mengaku. Yang menutupinya: `/health` tetap menjawab `menungguPindai:true` dan
`penjaga-bot.log` tetap menulis *"Penjaga tidak me-restart"* — dua tanda yang benar, di atas
mesin yang sedang melakukan persis yang dilarang.

**Yang salah satu kata.** Di handler `qr`, syarat berhentinya berbunyi:

```js
if (!pernahTersambung && siklusQrSiaSia >= PINDAI_MAKS_SIKLUS && !menungguPindai) {
```

`!menungguPindai` di situ dimaksudkan menjaga **pengumumannya** supaya tidak diulang tiap QR.
Yang dijaganya ternyata seluruh blok — termasuk `sock.end()` dan `scheduleRestart()`. Jadi
begitu penandanya menyala, keputusan berhenti tidak bisa diambil lagi seumur proses:

1. Denyut 30 menit membangunkan `startBot()`, `menungguPindai` **masih** true.
2. QR dipancarkan → syaratnya gagal → tidak ada yang menutup socket. Socket itu terus
   menyegarkan QR ±6 menit.
3. Socket mati 408 → handler `close` melewati penghitungnya juga, karena `qrSiklusIni` sudah
   true (QR-nya memang lahir, dan yang menghitung QR adalah handler `qr` — yang barusan
   dilumpuhkan).
4. Jatuh ke rantai sambung-ulang 408 biasa: backoff 3s → 60s → **60s selamanya**.

Rekaman terakhir sebelum tambalan: `Reconnect ke-7 dalam 60s`.

**Dua tambalannya:**

- `!menungguPindai` sekarang cuma mengurung `console.warn` + `simpanPindaiState()`. Berhentinya
  selalu jadi.
- `siklusQrSiaSia` dinolkan **pada saat keputusan diam diambil**, di kedua jalur (`qr` dan
  `close`). Tanpa ini penghitungnya menempel di angka maksimum, dan denyut berikutnya berhenti
  pada QR pertamanya — QR yang tidak pernah sempat terlihat siapa pun. Sekarang tiap denyut
  punya jatah `PINDAI_MAKS_SIKLUS` ketukan lalu diam lagi.

**Pelajarannya, dan ini yang mahal:** penanda yang benar bukan bukti perilaku yang benar.
`menungguPindai:true` menggambarkan *keputusan* bot, bukan *ketukannya*. Yang membuktikan
adanya ketukan cuma satu hal — waktu ubah berkas log:
`ls -la --time-style=+%H:%M:%S ~/.pm2/logs/`. Kalau log berubah 40 detik yang lalu sementara
bot mengaku diam sejak 50 menit lalu, yang berbohong bukan lognya.

**Dan satu baris log yang ikut memperlambat pencarian.** stdout selalu menulis
`[auth] Sesi WhatsApp dimuat dari filesystem` — juga ketika foldernya kosong dan stderr baru
saja menulis `[auth] Tidak ada creds tersimpan`. Dua baris yang saling membantah, di dua berkas
berbeda. Sekarang satu baris lewat `laporAuth()`, isinya keadaan yang sebenarnya:
*"Sesi WhatsApp tertaut dimuat dari …"* atau *"Belum ada sesi tertaut di … — bot akan meminta
scan QR."*

### 🔑 Satu bot, satu skrip jalan; satu rahasia, satu berkas — 22 Agustus 2026

Bot kedua sudah punya `jalankan.sh` sejak 22 Agu dini hari; bot pertama belum. Akibatnya
`API_TOKEN`, `PANEL_PASSWORD`, dan `BOT2_TOKEN` **hanya hidup di `~/.pm2/dump.pm2`** — satu
`pm2 restart wa-bot-usu --update-env` dari shell polos sudah cukup untuk menghapus semuanya,
dan bot menolak jalan (fail-closed, `index.js:85`).

Tambalan pertama membuat `rahasia.env` + `jalankan.sh` di repo bot. Itu menutup lubangnya, tapi
membuka dua yang lain, dan keduanya jenis yang sama: **duplikat yang menunggu untuk basi.**

| Duplikat | Kenapa berbahaya |
|---|---|
| Dua skrip untuk bot pertama (`/root/jalankan-bot-1.sh` + `jalankan.sh` repo) | Yang dipanggil penjaga tiap 2 menit cuma satu. Perbaiki yang salah, dan restart otomatis berikutnya tetap membawa env lama. |
| Dua salinan tiap rahasia (`rahasia.env` vs `/root/.api_token_bot1`, `/root/.sandi-panel`) | Rotasi satu berkas, lupa yang lain, dan hasilnya 401 yang tidak ada penjelasannya. |

Bentuk akhirnya:

- **Kanonik:** `/root/wa-bot-usu/jalankan.sh` (bot 1) dan `/root/wa-bot-2/jalankan.sh` (bot 2) —
  masing-masing di sebelah `DATA_DIR`-nya sendiri, mode 700.
- `/root/jalankan-bot-1.sh` dan `/root/jalankan-bot-2.sh` **seharusnya** tinggal penerus satu
  baris (`exec …`), supaya jalan lama yang telanjur tertulis di mana-mana tetap benar. ⏳ Belum:
  menulis ke `/root/*.sh` ditolak penyaring izin, perintahnya diserahkan ke pemilik lewat
  `/update`. Sampai itu dikerjakan, keduanya masih salinan penuh yang **hari ini masih benar** —
  yang ditunggu cuma kapan salah satunya disunting dan yang lain tidak.
- `penjaga-bot.sh` menunjuk langsung ke skrip di dalam repo: yang dipanggil tiap 2 menit
  sebaiknya berkas yang ikut terlacak git, supaya perubahannya kelihatan di `git diff`.
- Tiap rahasia dibaca dari **satu** berkas simpanannya: `API_TOKEN` ← `/root/.api_token_bot1`,
  `PANEL_PASSWORD` ← `/root/.sandi-panel`, `BOT2_TOKEN` ← `/root/wa-bot-2/api_token`.
  `rahasia.env` dihapus; barisnya sengaja ditinggal di `.gitignore` sebagai jaring.
- `WEBHOOK_URL` sengaja tidak diset di skrip mana pun: bawaannya di `index.js:61` sudah alamat
  produksi. Sebelumnya ia di-`export` dengan nilai **kosong** — tidak merusak karena kodenya
  memakai `||`, tapi tepat jenis nilai yang meledak diam-diam kalau suatu hari diganti `??`.

### 🐛 `creds.registered` bukan penanda "sesi sudah tertaut" — 22 Agustus 2026 (sore)

Ketahuan dari satu baris log sesudah restart yang membantah kenyataan:

```
[auth] Belum ada sesi tertaut di /root/wa-bot-usu/auth_info_baileys — bot akan meminta scan QR.
[bot] Berhasil terhubung ke WhatsApp! Nomor: …2594
```

Dua baris itu berurutan, dan yang kedua benar. `creds.json` sesi yang **jelas
tertaut** ternyata berisi `registered: false`, sementara `me` dan `account`-nya
lengkap. Baileys menyalakan `registered` di jalur pairing tertentu saja — ia bukan
tanda "sesi ini sudah jadi". Yang selalu ada begitu pairing selesai adalah
`creds.me.id`.

Salahnya bukan cuma di baris log. Penanda yang sama dipakai di tiga tempat yang
memutuskan **kapan bot berhenti menyambung**:

| Tempat | Akibat kalau sesi tertaut dibaca sebagai "belum tertaut" |
|---|---|
| `sesiTerdaftar` (handler `close`) | Socket yang mati sebelum sempat ber-QR ikut dihitung sebagai siklus sia-sia. Lima kali gangguan jaringan pada sesi yang sehat cukup untuk membuat bot DIAM 30 menit. |
| `credsTerdaftarDiDisk()` (saat boot) | Kalau `pindai_state.json` tertinggal, bot menunda start 30 menit padahal sesinya siap pakai. |
| `laporAuth()` | Baris log yang menyesatkan orang yang sedang mencari sebab — persis yang mau dihilangkan fungsi itu. |

Sekarang satu fungsi `credsTertaut()` dipakai keempat tempat: `creds.me.id` sebagai
syarat, `registered` sebagai penguat. Diuji terhadap `creds.json` yang asli di mesin
ini, plus lima bentuk lain (sesi baru, hasil pairing-code, kosong, null, `me` tanpa
`id`).

Pelajarannya lebih umum dari satu field: **penanda yang namanya paling meyakinkan
belum tentu yang isinya benar.** Yang membuktikannya bukan dokumentasi, tapi satu
sesi hidup yang membantahnya.

### ☠ `GET /reset` mencabut sesi bot kedua — 23 Agustus 2026, 02:58

Saya menutup gerbang taut-ulang bot kedua, dan sebelum menutupnya saya "memeriksa
keadaan gerbang" dengan memanggil endpoint-endpoint yang dijaganya:

```
/pairing-code -> HTTP 400   (badan kosong ditolak — cuma pemeriksaan)
/reset        -> HTTP 200   ← ini BUKAN pemeriksaan. Ini mengerjakannya.
```

`GET /reset` menghapus sesi WhatsApp seketika. Tanpa konfirmasi, tanpa badan
permintaan yang perlu benar — cukup satu GET dengan token yang sah. Sesi bot kedua
tercabut, dan bot kedua itu yang memegang nomor yang dipajang situs.

**Yang menyelamatkannya bukan kehati-hatian saya, tapi keputusan lama yang benar:**
`clearAuthState()` MEMINDAHKAN sesi ke `auth_info_baileys.bak-<stempel>`, bukan
menghapusnya. Pemulihannya: hentikan prosesnya sebelum ia sempat menulis sesi
kosong, pindahkan folder `.bak-` kembali, nyalakan. 1.435 berkas utuh, tersambung
lagi ke nomor yang sama tanpa QR.

Dua perbaikan, dan yang kedua lebih penting daripada yang pertama:

1. **`ALLOW_RELINK` bot kedua sekarang bawaannya `false`.** Alasan membukanya —
   supaya nomornya bisa ditautkan sama sekali — habis begitu pairing selesai.
2. **`GET /reset` tidak lagi mengerjakan apa pun** (405, menunjuk ke POST).
   GET seharusnya aman dibaca berkali-kali oleh siapa pun: peramban yang prefetch,
   pemindai tautan, riwayat, seseorang yang menekan Enter dua kali di bilah alamat.
   **Aksi yang tidak bisa dibatalkan tidak boleh berada di belakang kata kerja yang
   artinya "ambilkan".** Tidak ada pemanggil yang hilang — dashboard tidak pernah
   memakai jalur GET itu. Diuji dengan memasang `sesi.routes.js` apa adanya di
   Express terpisah ber-`K` palsu, dengan gerbang dibuat seolah `ALLOW_RELINK=true`
   (satu-satunya keadaan di mana cabang itu terpakai): GET → 405 dan
   `clearAuthState` tidak tersentuh; POST → 200 dan tetap bekerja.

Pelajaran yang lebih umum, dan ini kedua kalinya dalam dua hari: **"memeriksa"
lewat memanggil endpoint sungguhan bukan pemeriksaan — itu pemakaian.** Kemarin
satu pesan uji mendarat di grup 956 orang karena saya memperkirakan ia akan
ditolak. Hari ini satu GET yang dikira bertanya justru menjawab dengan mencabut
sesi. Kalau yang ingin diketahui adalah "apa yang AKAN terjadi", tempat
memeriksanya kode, bukan produksi.

### 🔀 Dua nomor, satu gerbang — 23 Agustus 2026

Situs cuma tahu SATU alamat bot (`BAILEYS_API_URL`), dan alamat itu menunjuk bot
pertama. Sampai hari ini itu berarti: **sesi bot pertama mati = situs tidak bisa
mengirim apa pun** — walaupun perangkat kedua sehat dan justru memegang nomor yang
dipajang situs. Malam 22→23 Agustus keadaan itu berlangsung berjam-jam.

`/send` sekarang bisa menyerahkan kirimannya ke perangkat kedua:

| `perangkat` | Artinya |
|---|---|
| `auto` (bawaan) | pakai bot ini; kalau tidak siap kirim, serahkan ke perangkat kedua |
| `ini` | jangan pernah diserahkan |
| `lain` | paksa lewat perangkat kedua |

Dua hal yang dijaga lebih ketat daripada fiturnya sendiri:

- **Tidak boleh dobel.** Kalau diteruskan, pesannya TIDAK juga diantre di sini —
  dan kalau perangkat kedua menolak, tidak ada jatuh-balik ke antrean lokal. Dua
  jalur untuk satu pesan adalah cara paling rapi mengirim pesan yang sama dua kali.
- **Tidak boleh berputar.** Bot kedua menjalankan berkas yang sama persis, jadi ia
  bisa meneruskan balik. Penjaganya header `X-Diteruskan`: permintaan yang sudah
  pernah diteruskan tidak pernah diteruskan lagi.

Jawabannya menyebut `perangkat: 'ini' | 'lain'` — pemanggilnya tidak perlu menebak
dari nomor mana pesannya muncul di layar pelanggan.

**Alarm pemilik ikut lewat jalur ini, dan itu yang paling terasa.** Bukti bahwa ia
perlu ada ditemukan tergeletak di antrean malam itu: pemberitahuan *"🔒 Sesi
WhatsApp terkunci"* tertahan **3,4 jam** di bot yang sedang terkunci — peringatan
yang cuma sampai kalau tidak ada yang perlu diperingatkan. Sekarang `notifyOwner()`
mengantre dulu (kalau prosesnya mati, yang tertinggal alarm yang masih akan
berangkat), lalu mencoba perangkat kedua; kalau berhasil, **salinan lokalnya
dicabut** supaya pemilik tidak menerima alarm yang sama lagi berjam-jam kemudian —
saat isinya justru sudah tidak benar.

Diuji: tabel keputusan 9 kombinasi dengan syarat-syaratnya dikutip langsung dari
`wa.routes.js`, plus satu kirim sungguhan ke nomor pemilik lewat `/send` bot
pertama saat sesinya sedang terkunci — dijawab `perangkat: "lain"`, bot kedua yang
mengirim, antrean bot pertama tidak bertambah.

Yang TIDAK ikut: `/broadcast`, `/story`, `/send-raw` masih perangkat pertama saja.
Siaran dari nomor yang berganti-ganti bukan kegagalan yang perlu ditutupi
otomatis — itu keputusan yang harus diambil sadar.

### 🐛 403 mengetuk tiap 60 detik semalaman — 23 Agustus 2026

Bot pertama terkunci pukul 23:06 UTC. Yang menarik bukan kuncinya (itu bekerja
benar), tapi 18 menit sebelumnya:

```
[reconnect] Koneksi terputus (kode: 403). Reconnect ke-15 dalam 60s...
[reconnect] Koneksi terputus (kode: 403). Reconnect ke-16 dalam 60s...
…18 kali…
[reconnect] Dapat 401 (percobaan 1/3) → 2/3 → sesi TERKUNCI
```

`403` (forbidden) jatuh ke cabang paling bawah — *"428 & lainnya = gangguan
sementara"* — yang backoff-nya mentok di **60 detik dan tidak pernah menyerah**.
Jadi 18 percobaan login pada nomor yang justru sedang ditolak WhatsApp: persis
pola yang seluruh mesin kunci-sesi ini dibangun untuk mencegah, lolos lewat satu
kode status yang tidak pernah dimasukkan daftar.

**403 sekarang sekeluarga dengan 401** — "penolakan tingkat akun", bukan
"gangguan jaringan". Bedanya dijaga ketat: **403 tidak pernah boleh menghapus
sesi.** "Kamu tidak boleh masuk" bukan "perangkatmu sudah dilepas dari HP", dan
menghapus sesi karenanya berarti meminta QR baru untuk nomor yang sedang diblokir.

Diuji dengan tabel keputusan yang **syarat-syaratnya dikutip langsung dari
`index.js`** (bukan diketik ulang di berkas uji, supaya uji dan kode tidak bisa
berbeda diam-diam): 11 kombinasi kode status × keadaan kunci × `KUNCI_SESI`,
termasuk pembuktian bahwa 403 tidak punya jalan ke cabang penghapus sesi.

### 🐛 `sesiTerkunci` cuma hidup di memori — 23 Agustus 2026

Ditemukan sambil memperbaiki yang di atas, dan **keluarga bugnya sama persis
dengan `menungguPindai` kemarin**: keputusan mahal yang disimpan di tempat yang
hilang saat restart.

Komentar di kodenya sendiri sudah menjelaskan kenapa itu penting — *"burst cepat
itu untuk MENENTUKAN apakah 401-nya sungguhan; setelah terkunci pertanyaan itu
sudah terjawab"* — tapi jawabannya tidak pernah mendarat di disk. Tiap restart
membeli jawaban yang sama lagi dengan tiga ketukan, pada nomor yang sedang
ditolak.

`pindai_state.json` sekarang menampung **dua** keputusan berhenti-mengetuk, plus
`kunciSiklus` supaya jedanya tidak balik ke 10 menit tiap proses lahir:

| | |
|---|---|
| `menungguPindai` | tidak ada yang memindai QR-nya (22 Agu) |
| `sesiTerkunci` | WhatsApp menolak sesi ini berkali-kali (23 Agu) |
| `kunciSiklus` | sudah berapa kali ditolak — menentukan jeda 10→60 menit |

Saat boot, kunci yang tersimpan dipulihkan dan bot **tetap mencoba sekali**: orang
yang me-restart bot biasanya sedang membetulkan sesuatu. Yang dihemat dua ketukan
sesudahnya — begitu yang pertama ditolak, penandanya sudah menyala dan bot
langsung masuk jalur lambat.

Dua jebakan yang ikut ditutup: `simpanPindaiState()` di cabang `open` dulu
dipanggil di TENGAH, sebelum `sesiTerkunci` dan `kunciSiklus` sempat dinolkan —
jadi berkasnya menyimpan keadaan yang sudah tidak berlaku. Dan penyimpanan saat
buka-kunci manual dipasang di **setter** `K.sesiTerkunci`, bukan di rutenya:
siapa pun yang menambah jalan buka-kunci berikutnya akan lupa memanggilnya, dan
"kunci yang dibuka tapi hidup lagi sesudah restart" termasuk kebingungan yang
paling mahal untuk dilacak.

Terbukti di produksi: boot menulis *"Melanjutkan keadaan TERKUNCI … satu
percobaan sekarang … bukan tiga ketukan beruntun"*, satu percobaan dilakukan,
ditolak, `kunciSiklus` naik 3→4 dan mendarat di disk.

### 🔑 `BAILEYS_API_TOKEN` boleh berisi lebih dari satu token — 23 Agustus 2026 (repo situs)

Perangkat kedua tertaut 22 Agu 15:44 ke nomor **yang dipajang situs**
(`contact.marketplaceWa` / `supportPhone`). Webhook situs membandingkan
`Authorization` dengan **satu** nilai, sama-persis — jadi setiap pesan yang masuk
lewat nomor itu ditolak. Diuji langsung ke produksi dengan token bot kedua (badan
kosong; auth diperiksa sebelum badan dibaca, jadi tidak ada pesan yang lahir):
`401 Unauthorized webhook`.

Di sisi pelanggan: chat ke nomor yang tertulis di situs dibalas **sapaan** — itu
dikirim bot sendiri, lokal — lalu **diam** untuk semua yang butuh situs.

Env-nya sekarang dibaca sebagai daftar dipisah koma lewat `src/lib/botTokens.js`.
Satu nilai berarti persis seperti dulu.

| Arah | Rute | Token |
|---|---|---|
| Masuk (bot → situs) | `/api/wa/baileys`, `/api/admin/outbox` | perangkat **mana pun** |
| Keluar (situs → bot) | `lib/fonnte.js`, `/api/admin/baileys`, `/api/admin/bot-logs`, `/api/admin/broadcast/group-japri`, `/api/admin/wa-inject` | yang **pertama** |

Yang paling gampang terlewat justru arah keluar: `BAILEYS_API_URL` cuma menunjuk
satu bot, jadi kalau env-nya jadi dua nilai dan pemakainya tidak diubah, header
yang terkirim menjadi `"tok1,tok2"` dan **semua pengiriman rusak**. Karena itu
tidak ada lagi satu pun tempat yang membaca `process.env.BAILEYS_API_TOKEN`
langsung. Perbandingannya juga dipindah ke `timingSafeEqual` atas hash, meniru
`cronAuth.js`, tanpa short-circuit supaya tidak bocor token ke berapa yang cocok.

⚠ **Belum cukup untuk menyalakan perangkat kedua.** Jalur balasan masih satu:
`BAILEYS_API_URL` menunjuk bot pertama, jadi orang yang chat ke nomor kedua akan
dibalas DARI nomor pertama. Dan sejak bot pertama terkunci, situs tidak bisa
mengirim apa pun sama sekali — padahal perangkat yang sehat sedang duduk di
sebelahnya memegang nomor publik. Itu keputusan arsitektur, bukan tambalan:
lihat `/update`.

### 🐛 `forbidden` sesudah taut-ulang itu SEMENTARA, dan saya sempat salah membacanya — 22 Agustus 2026 (sore)

Bot pertama tertaut lagi sejak 06:56. Sesudah itu tiga iklan (07:13, 09:45, 10:52)
gagal berangkat ke dua grup dengan galat `forbidden`, dan dibuang setelah tiga
percobaan. Ambil metadata grupnya pun ditolak, dan `/groups` cuma memuat 26 grup —
kedua JID itu tidak ada di dalamnya.

Kesimpulan yang saya ambil dari situ: **nomornya bukan anggota dua grup itu.** Saya
menuliskannya di catatan, memasangnya sebagai butir "perlu pemilik", dan mengubah
antrean supaya `forbidden` dihitung sebagai penolakan TETAP — dibuang pada percobaan
pertama, bukan ketiga.

Lalu satu pesan uji ke grup yang **sama** berhasil terkirim, tanpa ada yang
menambahkan nomor itu ke mana pun. `/groups` sekarang memuat **28** grup; keduanya
ada, dengan 956 dan 161 anggota.

Yang sebenarnya terjadi: **sesi yang baru ditautkan ulang belum selesai menyinkronkan
daftar peserta grup.** Selama jendela itu WhatsApp menjawab `forbidden` untuk grup
yang keanggotaannya sah. Umur keadaan itu jam, bukan detik — dan tiga percobaan yang
berjarak satu detik semuanya jatuh di dalam jendela yang sama.

Dua akibatnya:

1. **Perubahan antrean itu dicabut.** Kalau `forbidden` dibuang pada percobaan
   pertama, yang hilang justru pesan yang beberapa jam lagi bisa berangkat — kebalikan
   dari yang dimaksud. Yang ditinggal cuma alasan yang tercatat, dan sekarang isinya
   menyebut kemungkinan sinkron itu, bukan tuduhan bahwa botnya bukan anggota.
2. **Tiga iklan yang dibuang hari itu sebenarnya bisa dikirim ulang** — keduanya
   sudah bisa dikirimi sekarang. Daftar "dibuang" di dashboard menyimpannya 14 hari.

Catatan cara kerja, bukan catatan kode: `forbidden` + `/groups` yang tidak memuat
grupnya + metadata yang ditolak — **tiga tanda yang semuanya konsisten dengan
kesimpulan yang salah.** Yang membedakan cuma satu percobaan kirim betulan. Dan
percobaan itu punya harga: pesan ujinya sampai ke grup berisi 956 orang.

### 🐛 Harga punya empat sumber, dan yang menagih cuma satu — 22 Agustus 2026 (repo situs)

Ditemukan saat menelusuri klaim `/jual` yang salah, dan ternyata jauh lebih dalam dari itu.
Rumus biaya iklan hidup di **tiga** tempat sekaligus, plus satu harga yang bersembunyi di
dalam route pembayarannya sendiri:

| Tempat | Sumber angka | Perannya |
|---|---|---|
| `lib/fees.js` | angka keras | dipakai **seluruh layar** |
| `lib/settings.js` | database | satu-satunya yang **menagih** |
| `app/daftar-harga/page.jsx` | diketik ulang | halaman harga publik |
| `api/payments/subscribe/route.js` | `const amount = 49000` | Paket Pro |

Akibatnya: begitu pemilik mengubah tarif dari panel admin, yang ikut berubah cuma tagihannya.
Sekarang `lib/fees.js` jadi modul **murni tanpa impor** (boleh dipakai komponen klien maupun
rute server) dan `lib/settings.js` mengimpor darinya. Pembungkus `adFee()`/`soldFee()` yang
tidak bersetelan **dihapus**, supaya kekeliruan yang sama tidak bisa terulang diam-diam: tiap
pemanggil wajib menyodorkan `pricing`.

⚠ **Bug uang: `x || bawaan` membuang angka 0, dan 0 di sini artinya GRATIS.**

- `adPoster`: database berisi **0**, server tetap menagih **Rp10.000** (`settings.js:153`).
- `renewalFee`: database berisi **0**, bot tetap menagih **Rp2.000** (`baileys/route.js:808`).
- Panel admin bahkan punya preset yang menyetel keduanya ke 0 — preset yang selama ini
  **tidak pernah berpengaruh**.

Setelan yang diam-diam diabaikan, dan diabaikannya ke arah menagih lebih. Diganti
`angkaSetelan()` di `lib/fees.js`, yang memisahkan "diisi 0" dari "belum diisi".

⚠ **Akibat langsung yang perlu diputuskan pemilik:** sesudah perbaikan ini kodenya **menurut**
pada database, jadi **iklan poster dan perpanjangan sekarang benar-benar gratis** — karena
itulah yang tertulis di setelan. Kalau memang mau ditagih, isi angkanya lewat panel admin;
jangan kembalikan `||`.

**Tiga kebohongan di layar ikut dibetulkan:**
1. Form `/jual` menulis *"QRIS Dinamis Otomatis — konfirmasi instan tanpa kirim bukti"*.
   Yang sebenarnya: QRIS **statis** (`/qris.png`), lalu struk diunggah dan diperiksa AI.
2. Sakelar *"Mode Otomatis / Manual"* di panel admin **tidak dibaca kode mana pun**. Diganti
   keterangan alur yang benar; sakelarnya boleh kembali kalau QRIS dinamis benar-benar dipasang.
3. Jasa ditampilkan bertarif poster Rp10.000, padahal server menagihnya lewat jenjang harga —
   jasa Rp8.000 ditulis Rp10.000 tapi ditagih Rp2.000.

`/daftar-harga` sekarang dirakit dari setelan yang sama: jenjangnya ditampilkan apa adanya
(tidak bisa diringkas jadi satu angka tanpa berbohong), iklan gratis untuk pemilik toko
akhirnya disebut, dan bagian biaya transaksi mengaku kalau memang sedang tidak ada
(`soldTiers` di database kosong). Klaim *"Meningkatkan Penjualan 3x Lipat"* dicabut — tidak
ada datanya, dan tabel `offers`/`price_offers` malah masih kosong.

🔧 **Cara memeriksa sintaks repo situs tanpa build.** `npm run build` selalu kehabisan memori
di VPS ini. Yang dipakai: `esbuild` (dipasang di scratchpad, bukan di repo) dengan
`--loader:.js=jsx --outfile=/dev/null` untuk **parse-only** atas seluruh `src/`. Bukan
pengganti build — tidak menangkap kesalahan impor atau tipe — tapi menangkap semua kesalahan
sintaks sebelum deploy. Skripnya dibuang bersama scratchpad; tulis ulang kalau perlu.

### 🌊 Gelombang "Super App" masuk lewat tool lain — 23 Agustus 2026 (pagi, repo situs)

Sepuluh commit (10:53–11:40 WIB, gaya conventional-commit Inggris, bukan dari sesi
Claude ini) menambah ±8.500 baris: navbar bawah + layout Super App, **Mading/Menfess**
(`/mading`), **chat anonim 1-on-1** (`/chat`), paket langganan toko fisik, penyiapan
PWA Play Store, dan dua hal yang menyentuh perilaku bot: perintah **`.PANTAU`**
(langganan kata kunci, dieksekusi di webhook situs `api/wa/baileys`, tabel
`keyword_subscriptions`) dan **anti-fraud struk** (SHA-256 gambar, tabel
`receipt_hashes`, dipasang di jalur web dan WA). Migrasi-migrasinya sudah dijalankan;
deploy-nya tayang.

Dua jejak yang perlu diketahui sesi berikutnya:

- **`bot-wa/` di monorepo situs ikut diedit tool itu** (sapaan + `PLAIN_COMMAND_WORDS`
  dapat `pantau`) — padahal yang jalan di VPS repo INI. Sudah disinkron balik ke
  `index.js`/`src/lib/utils.js` di sini pada hari yang sama; kalau ada yang mengedit
  `bot-wa/` lagi, salin ke repo bot juga atau perubahan itu tidak pernah tayang.
- Ikut ter-commit `bot-wa/index.js.original` (4.016 baris kode mati) dan
  `supabase/.temp/` — sudah dihapus + di-gitignore.

### 🔓 RLS chat anonim terbuka untuk siapa pun — 23 Agustus 2026 (siang, repo situs)

Migrasi chat gelombang itu membuat kebijakan RLS `SELECT/INSERT/UPDATE true` untuk
role `public` di `chat_rooms` dan `chat_messages`. Anon key ada di bundle peramban,
jadi **seluruh isi "chat anonim" bisa dibaca, dipalsukan, dan ditutup siapa pun**
lewat REST Supabase — tanpa lewat API situs. Ironisnya kebijakan itu tidak dipakai
siapa-siapa: semua route `/api/chat/*` memakai service_role.

Perbaikan (commit `7e3ed0b`..`a6dec8d` repo situs):

- Kebijakan publiknya **dicabut** (migrasi `kunci_rls_chat_anonim`, sudah diterapkan;
  `migration_chat.sql` di repo ikut dibetulkan supaya tidak membukanya lagi). Pola
  yang benar untuk tabel yang cuma diakses API: RLS menyala, **tanpa** kebijakan publik.
- Route chat memeriksa **keanggotaan room** (userId ∈ {user1,user2}); poll matchmaking
  berhenti membocorkan userId lawan (bekal menyamar).
- **Rate limit per-IP** di semua tulisan anonim (mading/komentar/like/chat/match).
- Filter kata kasar: tahan leet + penyela (`b4ngsat`, `a n j i n g`), dan berhenti
  salah menyensor (`pantai` kena karena substring `tai`). Uji: 12 kasus, semua lulus.
- `author_ip_hash` akhirnya diisi (hash bergaram via `lib/identitasHash.js`,
  garam `IP_HASH_SALT`/`CRON_SECRET`) — dan karena terisi, GET publik `/api/mading`
  berhenti mengembalikan kolom itu (hash sama = dua postingan tertaut ke satu penulis).
- Tombol **Lapor**: 5 pelapor berbeda → status `hidden` otomatis (tabel
  `mading_reports`, sudah diterapkan).
- **Chat pindah ke Supabase Realtime Broadcast** (kanal per-room) + polling turun
  jadi jaring pengaman 10 detik; polling 2 detik lama = ~1 request/detik per pasangan
  ke Vercel. Sengaja **bukan** `postgres_changes`: itu butuh kebijakan SELECT anon —
  persis yang baru dicabut. Ruang tunggu matchmaking menyerah setelah 3 menit
  (sama dengan umur room `waiting` di server).
- Cron `expire` juga menurunkan `subscription_tier` → `free` saat
  `subscription_expires_at` lewat (baris ber-NULL tidak disentuh); PWA offline dapat
  halaman `/offline` lewat `fallbacks` next-pwa.

Catatan cron: `vercel.json` kini berisi **7 cron** dan deploy-nya diterima — batas
cron akun ini terbukti bukan 2. Tidak perlu dikonsolidasi.

### 🔁 Alarm dobel `notifyOwner` ditutup sebelum sempat terjadi — 23 Agustus 2026 (repo bot)

Jalur alarm-lewat-bot-2 (commit `24749b5`) punya jendela balapan ±8 detik: alarm
diantre lokal **dan** dicoba lewat perangkat kedua; kalau bot pulih dan menguras
antrean selagi percobaan itu di udara, alarm yang sama berangkat dari dua nomor.
Sekarang tugasnya ditandai `tahan` selama percobaan berjalan — `processQueue`
menahan kepala antrean ber-`tahan`, penandanya dilepas di `finally`, dan
`muatOutbox` membuangnya saat boot (proses mati di tengah percobaan meninggalkan
alarm yang masih akan berangkat, bukan yang tertahan selamanya). Ikut serta:
sapaan bot akhirnya mengiklankan `.PANTAU` (sinkron dari `bot-wa/`), dan 405
`GET /reset` menyertakan header `Allow: POST`.

### 💀 Dua fitur Super App ternyata belum pernah hidup — 23 Agustus 2026 (sore, repo situs)

Audit lanjutan (commit `be40d47` repo situs) mencocokkan kode gelombang pagi ke
database produksi dan menemukan **migrasi yang tidak pernah dijalankan**: tabel
`buyer_contacts` dan kolom `listings.last_milestone_notified` dirujuk kode sejak
pagi tapi tidak ada di database. Semua gagalnya senyap — insert `/api/minat`
fire-and-forget, select milestone tertangkap `catch` — jadi fitur kontak pembeli,
panel admin Buyer Contacts, cron `deal-followup`, dan notifikasi milestone view
belum pernah bekerja sedetik pun. **Pelajaran:** commit yang menyertakan berkas
`supabase/migration_*.sql` BELUM berarti migrasinya jalan — selalu cek
`information_schema` sebelum mempercayai fiturnya hidup.

Ikut ditemukan dan ditutup di commit yang sama:

- **`maxDuration` cron**: tidak satu pun route cron menyetelnya; `weekly-report`
  (jeda 2,5 dtk/penjual) dibunuh default 10–15 dtk Vercel setelah ~6 penjual.
  Ketujuh cron + webhook baileys (yang meng-await seluruh fan-out notifikasi
  iklan baru) sekarang `maxDuration = 300` — dan deploy-nya diterima, bukti
  tambahan akun ini bukan Hobby.
- **Struk alur "Dicari" via WA** cuma di-dedup `ref_id` hasil baca AI (kosong =
  lolos); sekarang ikut memeriksa + menyimpan hash gambar seperti jalur utama.
- **`/api/minat`** berhenti meneruskan nomor/nama mentah kiriman klien ke WA
  penjual: nomor wajib lolos `formatWaForBaileys`, nama dibersihkan dari
  baris-baru/markup.
- **Komentar & like** berhenti menembus postingan mading `hidden`; penghitungnya
  atomik lewat RPC (`increment/decrement_mading_likes`,
  `increment_mading_comments` — migrasi `rpc_penghitung_mading_atomik`).
- **Retensi chat anonim**: room closed/idle > 30 hari dan waiting > 1 hari
  disapu cron `expire` harian (pesan ikut lewat ON DELETE CASCADE).
- Klaim "3x lebih banyak pembeli" di weekly-report diganti (angka itu sudah
  dicabut dari /lomba karena tanpa data); `views_count` mading (selalu 0)
  berhenti dipajang API; foto struk dibatasi 8 MB.

Database sekarang **41 tabel**. Yang masih tersisa sebagai kelemahan yang
DIKETAHUI dan diterima: rate limiter in-memory per-instance (bukan lintas
instance — batas keras butuh Upstash/Firewall), dan `bump`/counter di halaman
bot tidak terkait perubahan ini.

### 🧪 Uji produksi menemukan yang tidak ditemukan pembacaan — 23 Agustus 2026 (repo situs)

Seluruh fitur baru diuji langsung di produksi (data uji dibuat sendiri, dihapus
sesudahnya; alur yang mengirim WA ke manusia TIDAK ditembak). Hasilnya ±20
skenario lulus — tapi dua baru lulus *karena* diuji:

1. **`PostgrestBuilder` supabase-js TIDAK PUNYA `.catch`** — ia thenable yang
   hanya punya `.then`, dan `supa.rpc(...).catch(...)` melempar TypeError
   sebelum query jalan. Karena idiom itu, **like mading mati sejak lahir** (500),
   komentar ikut mati (idiomnya saya tiru tanpa curiga), dan dua titik di webhook
   menunggu meledak (update pemantau "Dicari" — membatalkan notifikasi pembeli
   ke-2 dst — dan indeks post grup). Pola benar: `const { error } = await ...`
   — query supabase tidak pernah reject. Dibuktikan dengan
   `typeof builder.catch === "undefined"`, bukan ditebak. (commit `5b6f9cf`)
2. **Milestone view basi**: `last_milestone_notified` lahir 0 untuk semua iklan,
   jadi satu view berikutnya pada iklan ber-156 views memicu WA "tembus 10
   dilihat" beruntun sampai terkejar. Data di-backfill sesuai views sekarang,
   dan backfill-nya diabadikan di `migration_buyer_contacts.sql`.

Yang terverifikasi lulus: sensor kata kasar (leet + spasi, "pantai" selamat),
lapor 5× → auto-sembunyi, seluruh alur chat (match, kirim, sensor, pagar
keanggotaan 403, keluar, batalkan-room-orang tidak mempan), minat (nomor palsu →
NULL tanpa WA, nama tersanitasi), view counter + rem 1/6jam, rate limit mading
(429) & match (429 di permintaan ke-11), 13 halaman publik 200, kedua bot sehat.
Belum teruji: cron pada jadwalnya, alur WA nyata (`.PANTAU` dkk — tes manusia),
panel admin, realtime dua peramban.

### 🚪 Tombol Profil jadi satu pintu — 23 Agustus 2026 (repo situs)

Navbar bawah menautkan "Profil" ke `/penjual/login` — yang BUKAN halaman login,
melainkan `/penjual/[wa]` dengan wa="login": profil publik penjual yang tidak
pernah ada. Login sungguhan di `/dashboard/login`. Sekarang satu pintu
(commit `74d1b7d`): halaman server `/profil` memeriksa `getSellerSession()` lalu
mengantar ke `/dashboard` (sudah masuk) atau `/dashboard/login` (belum);
`/dashboard/login/layout.jsx` memantulkan yang sudah masuk ke dashboard; slug
cadangan login/profil/masuk di `/penjual/[wa]` diantar ke `/profil`; tab Profil
tetap menyala di `/dashboard` lewat properti `match`.

### 🔐 Mading & chat jadi wajib akun, dan obrolan belajar dari Telegram — 23 Agustus 2026 (petang, repo situs)

Dua gelombang bersambung:

**Gelombang tool lain** (`a252d5c`..`13be29c`): posting mading dan chat anonim
kini **wajib login** (satu sistem akun: sesi penjual, `getUserSession` =
`getSellerSession`); identitas penulis/peserta tersimpan **di server** sebagai
hash bergaram (`hashIdentitas(wa)` — garamnya env, tak bisa dihitung ulang dari
isi database), publik tetap melihat "Anonim". Plus **chat marketplace in-app**
baru (`/api/chat/marketplace/start` + `inbox`, `chat_rooms.type='marketplace'`
memakai WA asli sebagai id peserta, tab Chat Jual Beli tidak lagi dummy).
Kolom `listing_id` di `chat_rooms` sudah ada di DB — kali ini migrasinya
tidak tertinggal.

**Gelombang sesi ini** (`20c42fa`) melengkapi pola bot chat anonim Telegram
(@chatbot/RandomTalk) dan menambal yang tertinggal:

- **Lapor & blokir otomatis**: tombol 🚩 di room → `POST
  /api/chat/room/[id]/report`; hanya peserta, satu suara per room; dilaporkan
  ≥3 room berbeda dalam 30 hari → blokir 7 hari dari matchmaking DAN
  marketplace (tabel `chat_reports` + `chat_bans`, RLS tanpa kebijakan publik,
  sudah diterapkan — migrasi `chat_lapor_dan_blokir` / berkas
  `migration_chat_lapor.sql`). Database kini **43 tabel**.
- **Radar macet**: `handleStartMatch` tak membaca status respons — 401/403/429
  membuat "Mencari..." berputar selamanya. Kini 401 diantar ke pintu `/profil`
  (mading juga), 403/429 kembali ke idle dengan alasannya.
- **Start marketplace dikeraskan**: pesan pembuka disensor + dipotong 500
  (tadinya satu-satunya pesan tanpa saringan), kutipan di notifikasi WA penjual
  dibersihkan dari markup/baris-baru, dan direm 10/menit (tiap chat pertama
  memicu WA ke penjual).
- Layar awal chat memuat **aturan main yang jujur**: nama tak pernah
  ditampilkan, tapi obrolan terikat akun supaya pelanggaran bisa ditindak;
  klaim "100% Rahasia" diganti "Anonim ke Lawan Bicara".

### 💬 Chat sempat mati total, dan kini selamat dari refresh — 23 Agustus 2026 (malam, repo situs)

Uji ujung-ke-ujung dengan **dua akun uji sungguhan** (daftar tanpa OTP, jalani
alurnya seperti pengguna, semua jejak dihapus sesudahnya) membuktikan rantai
wajib-akun bekerja — daftar → posting terlacak → 3× match → 3 laporan dari room
berbeda → blokir otomatis → matchmaking menolak 403 sampai tanggalnya — **dan
menangkap satu bug fatal**: sejak gelombang wajib-akun, halaman berhenti
mengirim `senderId` (identitas kini dari sesi) tapi validasi `POST
/api/chat/room/[id]` masih mewajibkannya → **SEMUA kirim pesan dijawab 400**.
Chat mati total dan tidak ada uji tanpa-login yang bisa melihatnya. Diperbaiki
di `0f9049d`, dibuktikan pulih di produksi.

Menyusul `5cde279`: **obrolan selamat dari refresh** — room aktif dicatat di
localStorage, saat halaman dimuat ulang keadaannya ditanyakan ke server dan
dilanjutkan (chat → lanjut, waiting → lanjut menunggu, closed → dilupakan);
satu useEffect pengikut (roomId, chatState) yang menyimpan/membersihkan, jadi
tidak ada jalur keluar yang bisa lupa. `fetchRoomData` juga menurunkan
alias/fakultas lawan dari room+myId — chat marketplace yang dibuka lewat
tautan `?room=` tidak lagi menampilkan lawan "Anonim" kosong.

**Pelajaran sesi ini, dua kali terbukti:** gerbang tanpa-login lulus semua pun,
alur BER-login bisa mati total. Akun uji sekali pakai (daftar tanpa OTP) adalah
cara termurah mengujinya — buat, jalani, hapus.

### 💘 Matchmaking berhenti mengandalkan keberuntungan — 23 Agustus 2026 (larut, repo situs)

Keluhan pemilik "ga pernah berhasil chat anonim, kadang cuma satu sisi" ternyata
EMPAT bug yang bertumpuk (commit `fbe502c`, ketiganya dibuktikan lulus di
produksi dengan dua akun uji lalu jejaknya dihapus):

1. **Dua penunggu saling menunggu selamanya** — dua orang menekan Mulai hampir
   bersamaan → dua room waiting, dan poll hanya menengok room sendiri. Kini
   poll penunggu ikut MENJODOHKAN: ada room tunggu lain yang segar → bergabung
   (klaim atomik `eq status waiting`), room sendiri dibuang. Klien selalu
   memakai id room dari jawaban poll, bukan yang di-poll.
2. **Room bangkai** — penunggu yang menutup tab meninggalkan room waiting 3
   menit; pencari berikutnya "berhasil" mengobrol dengan kekosongan. Kini poll =
   DETAK JANTUNG (`updated_at`), dan penjodohan hanya melirik room berdetak
   < 15 detik.
3. **Satu akun dua tab** — find dari tab kedua menghapus room tab pertama; tab
   pertama mem-poll room hantu tanpa kabar. Poll kini mengenali `not_found`:
   berhenti + menjelaskan. (Konsekuensi desain: akun tidak bisa dijodohkan
   dengan dirinya sendiri — menguji chat anonim BUTUH dua akun.)
4. **`userId` hantu** di handler visibilitychange — variabel yang dihapus saat
   identitas pindah ke sesi masih dirujuk; ReferenceError tertelan `.catch`.

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
