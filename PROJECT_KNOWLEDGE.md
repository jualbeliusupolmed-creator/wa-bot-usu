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
| **Audit terakhir** | 21 Agustus 2026 |
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
| `index.js` | ~4.020 | **Seluruh bot.** Server Express + soket Baileys + gerbang + antrean + panel API. Satu berkas, sengaja. |
| `waAuthState.js` | 302 | Penyimpan sesi Baileys di filesystem, dengan cadangan berputar & tulis atomik. |
| `useSupabaseAuthState.js` | 190 | Adapter sesi ke Postgres. **Tidak dipakai** (tidak ada env Supabase). |
| `halaman/dashboard.html` | 958 | Panel operasi: QR, inbox chat, statistik gerbang, blocklist, story, log. |
| `halaman/home.html` | 449 | Daftar tombol ke semua halaman & endpoint. |
| `halaman/update.html` | ~245 | Linimasa perubahan (dari git) + daftar "Yang belum selesai" yang ditulis tangan. |
| `halaman/projek.html` | 199 | Catatan proyek naratif. ⚠ angkanya sudah basi (lihat §4). |
| `halaman/progres-claude.html` | — | **Halaman audit ini.** Bergerbang sandi. |
| `public/lomba.html` | 925 | Presentasi lomba 12 slide. **Satu-satunya halaman tanpa sandi.** |
| `public/assets/ui.css` / `ui.js` | 1.051 / ~170 | Rupa bersama + navbar yang disuntik ke semua halaman + ikon SVG sebaris (menggantikan Font Awesome CDN) + tombol terang/gelap. |
| `antrean.html`, `laporan.html`, `laporan-publik.html`, `jalankan.html` | 401/385/384/252 | Halaman antrean notifikasi, laporan analisis, dan penyaji SQL migrasi. |
| `migrasi/migrasi.sql` | 1.589 | **26 BAGIAN** migrasi, dirancang aman diulang. |
| `migrasi/migrasi-keamanan.sql` | 98 | Migrasi RLS terpisah. |
| `penjaga-bot.sh` | 115 | Cron tiap 2 menit: cek `/health`, restart kalau mati. |
| `cadangkan-sesi.sh` | 194 | Cadangan sesi terenkripsi AES ke repo GitHub privat. |
| `.github/workflows/pantau-bot.yml` | 122 | Pemantau dari luar VPS. |

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

### 1.3 Repo situs (`jualbeliusupolmed`) — 408 berkas

- **38 halaman** (`src/app/**/page.js*`) — 15 di antaranya di bawah `/admin`.
- **75 endpoint API** (`src/app/api/**/route.js`).
- **34 modul** di `src/lib/` — logika bisnis dipisah dari tampilan.
- Berkas terbesar: `src/app/api/wa/baileys/route.js` (**2.930 baris**) — otak
  balasan bot; `src/app/admin/AdminPanel.jsx` (1.866); `src/app/dashboard/page.jsx` (1.709).

Modul `src/lib/` yang perlu diketahui: `auth.js` (sesi admin & penjual),
`pin.js`/`pinRules.js` (PIN penjual, bcrypt), `gemini.js` (AI baca chat → iklan),
`fonnte.js` (jalur WA cadangan + semua kata-kata pesan, **satu sumber**),
`qris.js`, `fees.js` (tarif, satu sumber), `settings.js` (pengaturan dari DB
menang atas kode), `webpush.js`, `rateLimit.js`, `toko.js` (status toko),
`lidMigrate.js` (@lid → nomor), `supabaseAdmin.js` (klien service-role).

⚠ **Kode mati yang sudah dipastikan:** `src/lib/middleware.js` (65 baris) tidak
pernah dipanggil siapa pun dan tidak ada `middleware.js` di akar — Next.js tidak
menjalankannya. Ia salinan boilerplate Supabase SSR yang akan mengalihkan semua
pengunjung ke `/auth/login` seandainya aktif. Jangan "menghidupkannya".

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
konsep yang sama — salah satunya kemungkinan besar sisa. Perlu diputuskan
sebelum ada yang menulis kode baru ke tabel yang salah.

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

## 3. Keadaan sekarang (21 Agustus 2026)

**Dua bot hidup, dua-duanya belum tertaut.** `wa-bot-usu` (port 3000) dan
`wa-bot-2` (port 3001) sama-sama `ok:false`, folder sesi kosong. 6 pesan
menunggu di outbox bot pertama. Cadangan sesi lama ada di
`auth_info_baileys.bak-20260821T063431/` (1.281 berkas).

Langkah selanjutnya ada di tangan pemilik, bukan di kode — lihat "Yang belum
selesai" di `/update`.

---

## 4. Utang teknis

### Perlu diputuskan
- **16 dari 32 tabel kosong.** `offers` vs `price_offers` menamai hal yang sama.
- **5 dependensi situs tidak pernah di-import:** `midtrans-client`, `pg`,
  `html2canvas`, `html-to-image`, `qrcode`. `midtrans-client` menarik: kodenya
  memakai QRIS manual, jadi pembayaran otomatis kemungkinan ditinggalkan
  setengah jalan. ⚠ perlu klarifikasi apakah Midtrans masih rencana atau sudah
  dibuang.
- **`src/lib/middleware.js` kode mati** (§1.3).

### Perlu dirapikan
- **Komentar model AI tertinggal di kode produksi.**
  `src/app/api/payments/resume/route.js` memuat
  `// Wait, sold_fee is soldFeeFrom, not adFeeFrom! I will fix this in a moment`
  dan `// Actually, let's fetch...`, lengkap dengan variabel `amount` yang
  dihitung lalu langsung ditimpa. Bukan sekadar jelek dibaca — di berkas yang
  sama ada bug otorisasi (lihat laporan keamanan).
- **460 dari 497 baris `payments` berstatus `pending`** (93%). Tiap penekanan
  "lanjutkan bayar" menambah satu baris dan tidak ada yang membersihkannya.
- **Indeks kembar di database:** 5 pasang (`listings` punya 3 pasang), 13 indeks
  tidak pernah terpakai. Berasal dari migrasi yang dijalankan dua kali dengan
  penamaan berbeda.
- **Kebijakan RLS ganda** pada `blogs`, `categories`, `listings`,
  `seller_profiles`, `seller_ratings`, `wanted_listings` — dua nama untuk aturan
  yang sama, keduanya dievaluasi tiap query.
- **Angka basi di `halaman/projek.html`:** masih 31.538 baris / 323 commit / 12
  tabel, sementara `public/lomba.html` sudah 34.181 / 347 / 30 dan tabel
  sebenarnya 32. Dua halaman yang menyebut angka berbeda untuk hal yang sama.

### Dependensi
- **Bot:** 1 moderate (`protobufjs`, transitif dari Baileys).
  `@supabase/supabase-js` dan `axios` tertinggal satu minor.
- **Situs:** 10 kerentanan (6 tinggi, 4 sedang). Yang hidup di produksi:
  `next@14.2.35`, `nanoid`, `fast-uri`, `brace-expansion`. Sisanya build-time.

### Keamanan
Ada **5 temuan kritis dan 7 menengah**. Rinciannya **tidak ditulis di sini**:
repo ini publik, dan daftar endpoint yang belum bergerbang adalah peta serangan
yang sudah jadi.

Laporan lengkapnya ada di **`/progres-claude`** (butuh sandi panel), dibaca dari
`catatan/temuan-keamanan.md` yang sengaja di-`.gitignore` dan tinggal di VPS.

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
(**tanpa ini gerbang cron jatuh ke cadangan yang bisa dipalsukan** — pastikan
terisi) · `FONNTE_TOKEN` / `FONNTE_WA_GROUP_ID` · `KLIKQRIS_API_KEY` /
`KLIKQRIS_MERCHANT_ID` · `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` ·
`MARKETPLACE_WA` · `NEXT_PUBLIC_BASE_URL` · `ADMIN_WA` / `SUPER_ADMIN_WA`.

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

**Belum dikerjakan, menunggu keputusan pemilik:** rotasi `ADMIN_PASSWORD` dan
`FONNTE_TOKEN`, gerbang untuk `/api/push/subscribe/test`, perbaikan otorisasi
`/api/payments/resume` dan `/api/payments/unlock-wanted`, verifikasi
`CRON_SECRET` terisi di Vercel, bcrypt untuk 32 PIN plaintext.

### Sebelum audit ini
Riwayat perubahan lengkap kedua repo ada di **`/update`**, dirakit langsung dari
git — bukan ditulis tangan, jadi tidak bisa ketinggalan.
