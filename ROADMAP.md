# Roadmap Jual Beli USU — Fitur & Pengembangan

---

## ✅ Sudah Jalan

### Bot WA
- 32 command lengkap (lihat d.md)
- AI baca foto + teks → pasang iklan otomatis
- AI verifikasi struk transfer
- Memori percakapan per-user (30 menit, max 5 pesan)
- Buffer multi-foto 4 detik sebelum kirim webhook
- Bot listen grup marketplace → index ke DB
- Greeting bot (min/admin/mimin)
- Command NAMA → set nama profil + update semua iklan
- Free bump dari referral (cek saldo sebelum tagih QRIS)
- Notifikasi H-3 & H-1 sebelum iklan expired (cron 08:00)
- AutoBump cron harian
- Broadcast terjadwal admin
- Notifikasi kategori (LANGGANAN / STOP)
- Tawar harga via WA (TAWAR / TERIMA / TOLAK)
- Perpanjang / Upgrade (Featured, AutoBump, Bump) via WA
- HAPUS LAKU / HAPUS GALAKU + flow APPROVE/REJECT admin

### Web / Marketplace
- Login via OTP WA + PIN
- Dashboard penjual (iklan, statistik, tawaran)
- Halaman produk dengan gallery foto
- Halaman profil publik penjual `/penjual/[wa]`
- Halaman /dicari (wanted listings)
- Push notification PWA (web-push VAPID)
- Analytics penjual (tab Statistik)
- Referral system (kode unik, free bump bonus)
- Rating seller dari web
- Sistem laporan iklan
- Blog (infrastruktur + admin editor sudah ada)
- QRIS dinamis Midtrans (nominal otomatis terisi)
- Sponsored listing (field `sponsored_until` aktif di search)
- Featured & AutoBump via payment

### Infrastruktur
- Railway (bot WA) + Vercel (Next.js) + Supabase
- Cron: expire reminder, auto-bump, broadcast
- Auth: OTP WA + cookie session + PIN
- Storage: Supabase Storage untuk gambar
- AI: Gemini 2.5 Flash untuk parsing & chat

---

## 🔴 Prioritas Tinggi

### Bot WA
- [ ] **REFERRAL** command → tampil kode referral + link ajak teman + sisa free bumps
- [ ] **RIWAYAT** command → daftar semua pembayaran (iklan, bump, featured, dll)
- [ ] **Rate limiting / flood protection** → max N pesan/menit per-JID di index.js
- [ ] **Laporan mingguan penjual** → cron Senin pagi, kirim views + tawaran minggu lalu
- [ ] **Rating via WA** → setelah HAPUS LAKU, bot forward ke buyer minta rating 1-5
- [ ] **Komisi terjual (sold_fee)** → `soldTiers` sudah di settings, tapi belum jalan di WA flow
- [ ] **Monitor bot Railway** → cron Vercel ping bot, kalau mati kirim WA ke admin
- [ ] **Notif saldo referral** → ingatkan user kalau ada free bumps yang belum dipakai

### Web
- [ ] **Metode bayar tambahan** → GoPay / OVO / Dana deep link selain QRIS
- [ ] **Sponsored listing via WA** → command SPONSOR [kode] [hari] + QRIS
- [ ] **IKLANKU pagination** → sekarang limit 8, tambah IKLANKU 2 untuk halaman berikutnya

---

## 🟡 Prioritas Menengah

### Bot WA
- [ ] **ALERT [barang] [budget]** → notif kalau ada iklan baru yang match keyword + budget
- [ ] **FOLLOW [nomor]** → notif WA tiap seller itu pasang iklan baru
- [ ] **GANTI PIN** via WA → keamanan akses dashboard
- [ ] **Milestone views notification** → "Iklanmu sudah dilihat 100×! Mau di-bump?"
- [ ] **Filter kata terlarang** → scan teks sebelum proses, tolak konten spam/penipuan
- [ ] **COD Confirmation** → setelah deal, bot kirim checklist lokasi + jam ke kedua pihak
- [ ] **Notif penurunan harga** → kalau iklan yang di-wishlist turun harga, notif buyer

### Web / Marketplace
- [ ] **PRO Membership** → subscription bulanan, unlock limit iklan + free bump tiap bulan
- [ ] **Sewa / Rental listing** → tipe listing baru dengan harga per hari/minggu
- [ ] **Wishlist / SIMPAN [kode]** → buyer simpan iklan favorit, notif kalau mau expired
- [ ] **Leaderboard penjual** → `/top-penjual`, command TOP, update bulanan
- [ ] **Badge / Achievement seller** → Penjual Baru, Aktif, Top Seller berdasarkan transaksi
- [ ] **Verifikasi penjual** → kirim foto KTP ke bot → admin review → badge Terverifikasi
- [ ] **Halaman harga pasaran** → `/harga-pasaran`, agregasi harga rata-rata per kategori
- [ ] **Q&A publik** → buyer tanya di halaman produk, semua bisa lihat jawaban seller
- [ ] **Review per produk** → beda dari rating seller, ulasan spesifik barang
- [ ] **Garansi seller** → seller tambah "Garansi X hari" di listing
- [ ] **Landing page per kampus** → `/usu`, `/polmed` dengan iklan sesuai area kampus

### Infrastruktur
- [ ] **Image moderation AI** → flag gambar tidak pantas sebelum iklan tayang
- [ ] **Deteksi penipuan** → pattern matching: minta transfer duluan, rekber palsu, dll
- [ ] **Auto-post ke WA Channel** → iklan baru tayang → otomatis post ke Channel WA

---

## 🟢 Nice to Have / Jangka Panjang

### Fitur Marketplace
- [ ] **Lelang / Bidding** → harga minimum + durasi, pemenang tertinggi dinotif
- [ ] **Flash sale** → seller set harga diskon + countdown waktu
- [ ] **Jastip (Jasa Titip)** → seller post lagi di mall, buyer request titip beli dengan fee
- [ ] **Booking / Jadwal jasa** → listing tipe jasa dengan slot waktu tersedia
- [ ] **Cicilan antar user** → seller tawarkan cicilan 2-3× tanpa bunga
- [ ] **Escrow** → dana pembeli ditahan bot/platform sampai barang dikonfirmasi diterima
- [ ] **Bandingkan produk** → compare 2-3 listing side by side
- [ ] **Kategori trending** → tampil kategori yang sedang banyak dicari minggu ini
- [ ] **Rekomendasi AI personal** → iklan direkomendasikan berdasarkan histori user
- [ ] **Chatbot bubble di web** → tombol chat AI di sudut halaman produk
- [ ] **Bulk upload iklan** → import beberapa iklan sekaligus via CSV/spreadsheet

### Konten & SEO
- [ ] **Blog konten** → isi artikel tips jual beli, panduan COD, dll (editor sudah ada)
- [ ] **SEO per kategori** → halaman `/kategori/elektronik` dengan meta dinamis
- [ ] **Schema markup** → rich snippets Google untuk halaman produk
- [ ] **QR code per iklan** → command QR [kode] → bot kirim gambar QR siap cetak/share
- [ ] **Export iklan ke flyer** → generate gambar siap share ke Instagram/status WA
- [ ] **Halaman statistik publik** → total iklan, transaksi bulan ini, kategori terpopuler

### Integrasi
- [ ] **Google Analytics / Meta Pixel** → tracking konversi dari iklan berbayar
- [ ] **Tokopedia / OLX cross-post** → iklan otomatis dipost ke platform lain
- [ ] **Google Maps COD** → pilih titik COD di peta saat buat/lihat iklan

### Infrastruktur
- [ ] **Migration ke WhatsApp Business API** → lebih stabil dari Baileys (berbayar per pesan)
- [ ] **Loyalty points** → setiap transaksi dapat poin, bisa ditukar diskon/bump gratis
- [ ] **Gift card / voucher** → beli voucher diskon marketplace sebagai hadiah
- [ ] **Dark mode web**
- [ ] **Export data CSV** → admin bisa download data iklan/penjual/transaksi
- [ ] **Auto backup DB** → scheduled backup Supabase ke Google Drive

---

## 📊 Ringkasan

| Status | Jumlah |
|--------|--------|
| ✅ Sudah jalan | ~40 fitur |
| 🔴 Prioritas tinggi | 11 fitur |
| 🟡 Prioritas menengah | 18 fitur |
| 🟢 Jangka panjang | 22 fitur |
| **Total** | **~91 fitur** |

---

_Terakhir diupdate: 2026-06-24_
