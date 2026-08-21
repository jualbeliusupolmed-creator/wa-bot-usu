-- =====================================================================
-- PENGENCANGAN AKSES DATABASE (RLS)
-- Menutup temuan audit 16 Juli 2026 — nomor HP & hash PIN penjual bisa
-- dibaca siapa pun yang punya kunci anon.
-- ---------------------------------------------------------------------
-- BUKAN berkas "aman diulang" seperti migrasi.sql. Yang ini MENCABUT hak,
-- bukan menambah kolom. Jalankan sendiri, terpisah, saat kamu siap
-- membuka situsnya satu per satu sesudahnya.
--
-- APA YANG BOCOR SEKARANG. Migrasi RLS memasang policy
-- `anon_read_seller_profiles ... USING (true)` — seluruh baris, seluruh
-- kolom. Isi `seller_profiles` termasuk `wa` (nomor HP) dan `pin` (hash
-- bcrypt). Hash bcrypt tidak bisa dibalik, tapi ia tetap bahan tebakan
-- offline, dan nomor HP-nya sendiri sudah cukup jadi kebocoran. Hal yang
-- sama berlaku untuk `seller_wa` di `listings` dan `seller_ratings`, dan
-- `buyer_wa` di `wanted_listings`.
--
-- KENAPA MENCABUTNYA AMAN. Diperiksa ulang 21 Agustus 2026: seluruh
-- pembacaan tabel di situs lewat `getAdminClient()` (service-role, yang
-- melewati RLS) — termasuk beranda, /toko/[slug], /penjual/[wa], dan semua
-- rute /api. Kunci anon cuma dipakai dua hal, dan keduanya TIDAK disentuh
-- berkas ini:
--   • `src/lib/upload.js`  → unggah ke storage bucket "listings"
--   • `/api/analytics/pwa-install` → insert ke tabel `pwa_installs`
-- (`AdminPanel.jsx` mengimpor klien anon tapi tidak pernah memakainya.)
--
-- SATU TRANSAKSI. Kalau ada satu perintah yang gagal, semuanya dibatalkan.
--
-- SESUDAH RUN, BUKA SATU PER SATU — ini bagian yang tidak boleh dilewat:
--   beranda /, /dicari, /jual, /jasa, /blog, satu halaman produk,
--   satu /toko/[slug], satu /penjual/[wa], dasbor penjual, panel admin.
--   Kalau ADA yang jadi kosong → jalankan blok ROLLBACK di paling bawah,
--   lalu kabari; berarti ada bagian yang membaca lewat anon dan harus
--   dipindah ke API dulu.
-- =====================================================================

BEGIN;

-- RLS tetap dinyalakan. Dua lapis: tanpa hak akses tabel, anon ditolak
-- sebelum policy dilihat; kalau suatu saat haknya diberikan lagi tanpa
-- sengaja, policy yang membatasi masih berdiri di belakangnya.
alter table public.seller_profiles        enable row level security;
alter table public.listings               enable row level security;
alter table public.seller_ratings         enable row level security;
alter table public.price_offers           enable row level security;
alter table public.category_subscriptions enable row level security;
alter table public.wanted_listings        enable row level security;

-- Cabut seluruh akses langsung dari peran publik.
--
-- `seller_ratings` TIDAK ada di berkas audit aslinya — ditambahkan di sini
-- karena tabel itu juga menyimpan `seller_wa`, dan policy `anon_read_ratings`
-- membukanya dengan USING (true) persis seperti seller_profiles. Dibaca
-- hanya oleh /api/ratings dan halaman penjual, keduanya service-role.
revoke all on public.seller_profiles        from anon, authenticated;
revoke all on public.listings               from anon, authenticated;
revoke all on public.seller_ratings         from anon, authenticated;
revoke all on public.price_offers           from anon, authenticated;
revoke all on public.category_subscriptions from anon, authenticated;
revoke all on public.wanted_listings        from anon, authenticated;

-- SENGAJA TIDAK DICABUT:
--   pwa_installs   → butuh insert anon (analitik pemasangan PWA)
--   storage.objects → butuh unggah anon (foto iklan)
--   categories, blogs → tidak memuat data pribadi; membiarkannya berarti
--                       lebih sedikit yang bisa patah tanpa alasan.

COMMIT;

-- =====================================================================
-- RINGKASAN — baca ini, bukan "Success. No rows returned"
--
-- Semua baris harus 'TERTUTUP'. Yang 'MASIH TERBUKA' berarti perintah di
-- atas tidak jalan untuk tabel itu.
-- =====================================================================
SELECT t.tabel,
       COALESCE(string_agg(DISTINCT g.privilege_type, ', '), '—') AS hak_anon,
       CASE WHEN count(g.privilege_type) = 0 THEN 'TERTUTUP' ELSE 'MASIH TERBUKA' END AS status
  FROM (VALUES ('seller_profiles'), ('listings'), ('seller_ratings'),
               ('price_offers'), ('category_subscriptions'), ('wanted_listings')) AS t(tabel)
  LEFT JOIN information_schema.role_table_grants g
         ON g.table_schema = 'public'
        AND g.table_name   = t.tabel
        AND g.grantee      IN ('anon', 'authenticated')
 GROUP BY t.tabel
 ORDER BY t.tabel;

-- =====================================================================
-- ROLLBACK — jalankan HANYA kalau ada bagian situs yang jadi kosong.
-- Kembalikan persis seperti sebelumnya, lalu kabari apa yang hilang.
-- ---------------------------------------------------------------------
-- grant select                 on public.listings               to anon, authenticated;
-- grant select                 on public.seller_profiles        to anon, authenticated;
-- grant select                 on public.seller_ratings         to anon, authenticated;
-- grant select, insert, update on public.price_offers           to anon, authenticated;
-- grant select, insert, delete on public.category_subscriptions to anon, authenticated;
-- grant select, insert         on public.wanted_listings        to anon, authenticated;
-- =====================================================================
