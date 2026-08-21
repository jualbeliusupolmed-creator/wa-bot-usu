-- =====================================================================
-- SEMUA MIGRASI, SEKALI JALAN
-- ---------------------------------------------------------------------
-- Tempel SELURUH berkas ini ke Supabase → SQL Editor → Run. Sekali saja,
-- tidak perlu berkas lain, tidak perlu urutan.
--
-- AMAN DIJALANKAN BERULANG. Setiap perintah di sini menambah atau tidak
-- melakukan apa-apa; tidak ada satu pun yang menghapus tabel, kolom, atau
-- baris. Kalau ragu suatu migrasi sudah pernah jalan atau belum — jalankan
-- saja berkas ini; bagian yang sudah ada akan dilewati sendiri.
--
-- SATU TRANSAKSI. Kalau ada satu perintah yang gagal, SELURUHNYA dibatalkan
-- dan database kembali persis seperti sebelum Run. Tidak ada keadaan
-- setengah jadi.
--
-- YANG TIDAK IKUT, dan sengaja:
--   • supabase/seed_dummy_20.sql — itu 20 iklan karangan untuk mencoba-coba,
--     bukan migrasi. Jangan pernah dijalankan di produksi.
--   • supabase/migration_security_rls.sql — berkas itu MENCABUT hak baca
--     anon dari lima tabel. Itu perubahan perilaku, bukan penambahan, dan
--     berkasnya sendiri minta dicoba di jam sepi lalu situsnya dibuka satu
--     per satu. Ia tidak boleh menumpang di berkas "aman diulang" seperti
--     ini. Jalankan sendiri, terpisah, saat kamu siap memeriksa.
--
-- SETELAH RUN: baris terakhir mencetak tabel ringkasan. Itu jawabannya —
-- bukan tulisan "Success. No rows returned" yang muncul baik saat ada yang
-- berubah maupun tidak.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- BAGIAN 1 — Dasar: kategori, iklan, pembayaran, blacklist, bucket gambar
--
-- Dari schema.sql. Kalau situsnya sudah jalan, seluruh bagian ini tidak
-- mengubah apa pun — ia cuma memastikan tidak ada yang hilang.
-- ---------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------
create table if not exists public.categories (
  id    uuid primary key default gen_random_uuid(),
  name  text not null,
  slug  text not null unique
);

insert into public.categories (name, slug) values
  ('Elektronik', 'elektronik'),
  ('Fashion', 'fashion'),
  ('Buku', 'buku'),
  ('Makanan', 'makanan'),
  ('Kos', 'kos'),
  ('Buku Kuliah', 'buku-kuliah'),
  ('Jasa', 'jasa')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------
create table if not exists public.listings (
  id             uuid primary key default gen_random_uuid(),
  seller_name    text not null,
  seller_wa      text not null,
  title          text not null,
  description    text,
  price          bigint not null default 0,
  stock          int not null default 1,
  category       text not null,
  type           text not null default 'barang' check (type in ('barang','poster')),
  image_url      text,
  status         text not null default 'pending'
                   check (status in ('pending','active','expired','sold','suspended')),
  featured       boolean not null default false,
  featured_until timestamptz,
  bumped_at      timestamptz default now(),
  expires_at     timestamptz default (now() + interval '14 days'),
  sold_price     bigint,
  sold_fee       bigint,
  created_at     timestamptz not null default now()
);

create index if not exists listings_status_idx   on public.listings (status);
create index if not exists listings_category_idx on public.listings (category);
create index if not exists listings_bumped_idx   on public.listings (bumped_at desc);
create index if not exists listings_seller_idx   on public.listings (seller_wa);

-- ---------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------
create table if not exists public.payments (
  id               uuid primary key default gen_random_uuid(),
  listing_id       uuid references public.listings (id) on delete set null,
  type             text not null check (type in ('iklan','bump','featured','sold_fee')),
  amount           bigint not null,
  status           text not null default 'pending'
                     check (status in ('pending','paid','failed','expired')),
  midtrans_order_id text unique,
  meta             jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists payments_listing_idx on public.payments (listing_id);
create index if not exists payments_order_idx   on public.payments (midtrans_order_id);

-- ---------------------------------------------------------------------
-- blacklist (nomor WA penjual yang diblokir admin)
-- ---------------------------------------------------------------------
create table if not exists public.blacklist (
  id         uuid primary key default gen_random_uuid(),
  wa         text not null unique,
  reason     text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Row Level Security
-- Akses tulis dilakukan lewat service-role di server (API routes),
-- jadi RLS hanya mengizinkan SELECT publik untuk listing aktif.
-- ---------------------------------------------------------------------
alter table public.listings   enable row level security;
alter table public.categories enable row level security;
alter table public.payments   enable row level security;
alter table public.blacklist  enable row level security;

drop policy if exists "public read active listings" on public.listings;
create policy "public read active listings"
  on public.listings for select
  using (status in ('active','sold'));

drop policy if exists "public read categories" on public.categories;
create policy "public read categories"
  on public.categories for select using (true);

-- payments & blacklist: tidak ada policy publik => hanya service-role yang bisa akses.

-- =====================================================================
-- STORAGE
-- Buat bucket "listings" (public) lewat dashboard, atau jalankan:
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('listings', 'listings', true)
on conflict (id) do nothing;

drop policy if exists "public read listing images" on storage.objects;
create policy "public read listing images"
  on storage.objects for select
  using (bucket_id = 'listings');

drop policy if exists "anon upload listing images" on storage.objects;
create policy "anon upload listing images"
  on storage.objects for insert
  with check (bucket_id = 'listings');


-- ---------------------------------------------------------------------
-- BAGIAN 2 — Rating, laporan, hitungan dilihat, pengaturan, galeri, papan dicari
--
-- Dari migration_all.sql (gabungan lama). Backfill galeri hanya menyentuh
-- iklan yang kolom images-nya masih kosong, jadi aman diulang.
-- ---------------------------------------------------------------------
create table if not exists public.seller_ratings (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid references public.listings (id) on delete cascade,
  seller_wa   text not null,
  rating      smallint not null check (rating between 1 and 5),
  comment     text,
  buyer_name  text,
  created_at  timestamptz not null default now()
);

create unique index if not exists seller_ratings_listing_idx
  on public.seller_ratings (listing_id);

create index if not exists seller_ratings_seller_idx
  on public.seller_ratings (seller_wa);

alter table public.seller_ratings enable row level security;

drop policy if exists "public read ratings" on public.seller_ratings;
create policy "public read ratings"
  on public.seller_ratings for select using (true);


-- =====================================================================
-- 2) reports  (laporan iklan dari pembeli)
-- =====================================================================
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid references public.listings (id) on delete cascade,
  reason      text not null,
  detail      text,
  reporter_wa text,
  status      text not null default 'open' check (status in ('open','resolved')),
  created_at  timestamptz not null default now()
);

create index if not exists reports_status_idx
  on public.reports (status, created_at desc);

create index if not exists reports_listing_idx
  on public.reports (listing_id);

-- RLS aktif & tanpa policy publik => hanya service-role (server) yang akses.
alter table public.reports enable row level security;


-- =====================================================================
-- 3) views  (counter "dilihat" per listing)
-- =====================================================================
alter table public.listings
  add column if not exists views bigint not null default 0;

create index if not exists listings_views_idx
  on public.listings (views desc);

-- Increment atomik (hindari race condition) — dipanggil via supa.rpc()
create or replace function public.increment_listing_views(lid uuid)
returns void
language sql
as $$
  update public.listings set views = views + 1 where id = lid;
$$;


-- =====================================================================
-- 4) admin dinamis  (settings + kategori icon/urutan)
-- =====================================================================
create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.settings enable row level security;
-- Tanpa policy publik => hanya service-role (server) yang akses.

insert into public.settings (key, value) values
  ('pricing', '{"adBarang":2000,"adPoster":10000,"bump":1000,"featuredPerDay":5000,"featuredMaxPerDay":10000,"soldTiers":[{"upto":50000,"flat":2000},{"upto":100000,"pct":10},{"upto":null,"pct":5}]}'::jsonb),
  ('contact', '{"marketplaceWa":"62895429126232","waGroupLink":"https://chat.whatsapp.com/DQMZK2qSgq2D0WvH7BlBSA"}'::jsonb),
  ('site', '{"heroTitle":"Marketplace Mahasiswa USU & POLMED","heroSubtitle":"Jual-beli laptop, HP, buku, fashion, makanan, kos, hingga jasa. Aman, cepat, dibantu admin.","footerTagline":"Marketplace mahasiswa USU & POLMED. Jual-beli aman, dibantu admin."}'::jsonb)
on conflict (key) do nothing;

alter table public.categories add column if not exists icon text default '🏷️';
alter table public.categories add column if not exists sort_order int not null default 0;

update public.categories set icon='💻', sort_order=1 where slug='elektronik';
update public.categories set icon='👕', sort_order=2 where slug='fashion';
update public.categories set icon='📚', sort_order=3 where slug='buku';
update public.categories set icon='🍜', sort_order=4 where slug='makanan';
update public.categories set icon='🏠', sort_order=5 where slug='kos';
update public.categories set icon='🎓', sort_order=6 where slug='buku-kuliah';
update public.categories set icon='🛠️', sort_order=7 where slug='jasa';


-- =====================================================================
-- 5) gallery  (galeri multi-foto per listing)
-- =====================================================================
alter table public.listings
  add column if not exists images jsonb not null default '[]'::jsonb;

-- Backfill: listing lama yang punya image_url -> jadikan elemen pertama images
update public.listings
  set images = jsonb_build_array(image_url)
  where (images is null or images = '[]'::jsonb)
    and image_url is not null;


-- =====================================================================
-- 6) Papan Dicari / Wanted Listings
-- =====================================================================
create table if not exists public.wanted_listings (
  id           uuid primary key default gen_random_uuid(),
  buyer_name   text not null,
  buyer_wa     text not null,
  title        text not null,
  description  text,
  budget       bigint not null default 0,
  category     text not null,
  campus       text not null default 'Semua' check (campus in ('USU', 'POLMED', 'Semua')),
  area         text not null default 'Sekitar Kampus',
  status       text not null default 'active' check (status in ('active', 'resolved', 'expired')),
  created_at   timestamptz not null default now()
);

create index if not exists wanted_listings_status_idx on public.wanted_listings (status);
create index if not exists wanted_listings_campus_idx on public.wanted_listings (campus);
create index if not exists wanted_listings_buyer_idx  on public.wanted_listings (buyer_wa);

alter table public.wanted_listings enable row level security;

drop policy if exists "public read active wanted" on public.wanted_listings;
create policy "public read active wanted"
  on public.wanted_listings for select
  using (status = 'active');


-- =====================================================================
-- 7) Kolom campus & area di listings (filter kampus)
-- =====================================================================
alter table public.listings
  add column if not exists campus text default 'Semua'
    check (campus in ('USU', 'POLMED', 'Semua')),
  add column if not exists area text default 'Sekitar Kampus';

create index if not exists listings_campus_idx on public.listings (campus);


-- =====================================================================
-- Selesai!
-- Cek: select key from public.settings;           → harus ada 3 baris
--      select count(*) from public.wanted_listings; → tabel ada
-- =====================================================================


-- ---------------------------------------------------------------------
-- BAGIAN 3 — Verifikasi mahasiswa & kolom seller_verified
--
-- Dari migration_wanted.sql. Bagian papan dicari-nya sudah tercakup di
-- atas, tapi dua hal ini tidak ada di mana pun selain berkas itu:
-- tabel verified_sellers dan kolom listings.seller_verified.
-- ---------------------------------------------------------------------
create table if not exists public.wanted_listings (
  id             uuid primary key default gen_random_uuid(),
  buyer_name     text not null,
  buyer_wa       text not null,
  title          text not null,
  description    text,
  budget         bigint not null default 0,
  category       text not null,
  campus         text not null default 'Semua' check (campus in ('USU', 'POLMED', 'Semua')),
  area           text not null default 'Sekitar Kampus',
  status         text not null default 'active' check (status in ('active', 'resolved', 'expired')),
  created_at     timestamptz not null default now()
);

create index if not exists wanted_listings_status_idx on public.wanted_listings (status);
create index if not exists wanted_listings_campus_idx on public.wanted_listings (campus);
create index if not exists wanted_listings_buyer_idx on public.wanted_listings (buyer_wa);

alter table public.wanted_listings enable row level security;

drop policy if exists "public read active wanted" on public.wanted_listings;
create policy "public read active wanted"
  on public.wanted_listings for select
  using (status = 'active');

-- 2) Verifikasi Mahasiswa (Verified sellers)
create table if not exists public.verified_sellers (
  wa           text primary key,
  email        text,
  ktm_url      text,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at   timestamptz not null default now()
);

alter table public.verified_sellers enable row level security;

drop policy if exists "public read verified status" on public.verified_sellers;
create policy "public read verified status"
  on public.verified_sellers for select
  using (true);

-- 3) Tambah kolom campus, area, dan seller_verified ke listings
alter table public.listings
  add column if not exists campus text default 'Semua' check (campus in ('USU', 'POLMED', 'Semua')),
  add column if not exists area text default 'Sekitar Kampus',
  add column if not exists seller_verified boolean default false;

create index if not exists listings_campus_idx on public.listings (campus);
create index if not exists listings_verified_idx on public.listings (seller_verified);


-- ---------------------------------------------------------------------
-- BAGIAN 4 — Profil penjual
--
-- Dari migration_seller_profiles.sql. DROP POLICY IF EXISTS ditambahkan:
-- aslinya CREATE POLICY telanjang, yang gagal kalau policy-nya sudah ada —
-- dan satu kegagalan di sini membatalkan seluruh berkas gabungan ini.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seller_profiles (
  wa TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bio TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrasikan data penjual dari listings ke seller_profiles
-- Mengambil nama dari listing tertua (created_at paling awal) untuk setiap WA
INSERT INTO public.seller_profiles (wa, name, created_at)
SELECT seller_wa, seller_name, created_at
FROM (
  SELECT seller_wa, seller_name, created_at,
         ROW_NUMBER() OVER (PARTITION BY seller_wa ORDER BY created_at ASC) as rn
  FROM public.listings
) ranked
WHERE rn = 1
ON CONFLICT (wa) DO NOTHING;

-- Beri policy RLS (opsional)
ALTER TABLE public.seller_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read seller_profiles" ON public.seller_profiles;
CREATE POLICY "Public read seller_profiles"
ON public.seller_profiles FOR SELECT
TO public
USING (true);

-- API/Admin menggunakan admin key sehingga bypass RLS untuk insert/update


-- ---------------------------------------------------------------------
-- BAGIAN 5 — Kunci asing listings.seller_wa → seller_profiles.wa
--
-- Dari migration_seller_fk.sql.
-- ---------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_profiles_wa_key') THEN
    ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_wa_key UNIQUE (wa);
  END IF;
END $$;

-- 2. Tambah foreign key. ON DELETE SET NULL: jika profil dihapus, listing tetap ada
--    (seller_wa jadi NULL) alih-alih ikut terhapus. ON UPDATE CASCADE: ganti nomor ikut tersinkron.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listings_seller_wa_fkey') THEN
    ALTER TABLE listings
      ADD CONSTRAINT listings_seller_wa_fkey
      FOREIGN KEY (seller_wa) REFERENCES seller_profiles(wa)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Index untuk mempercepat lookup/join per penjual.
CREATE INDEX IF NOT EXISTS idx_listings_seller_wa ON listings(seller_wa);


-- ---------------------------------------------------------------------
-- BAGIAN 6 — Tabel OTP
--
-- Dari migration_otp.sql. Sejak pendaftaran tidak lagi memakai OTP, tabel
-- ini tinggal dipakai satu hal: memulihkan sandi yang lupa.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.otps (
  wa TEXT PRIMARY KEY,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Hapus data yang sudah kedaluwarsa secara otomatis agar tidak menumpuk (opsional, via cron atau Supabase pg_cron jika diaktifkan, tapi untuk sekarang kita biarkan atau bersihkan saat upsert).


-- ---------------------------------------------------------------------
-- BAGIAN 7 — Blog, langganan PRO, kode referral, wanted_unlocks
--
-- Dari migration_blogs_subscription.sql. Kolom referral_code lahir di sini,
-- dan itu yang dipakai pendaftaran untuk memberi bonus bump ke pengundang.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blogs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  slug             text NOT NULL UNIQUE,
  content_markdown text,
  image_url        text,
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'published')),
  author           text NOT NULL DEFAULT 'Admin',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blogs_status_idx ON public.blogs (status);
CREATE INDEX IF NOT EXISTS blogs_slug_idx   ON public.blogs (slug);

ALTER TABLE public.blogs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read published blogs" ON public.blogs;
CREATE POLICY "public read published blogs"
  ON public.blogs FOR SELECT
  USING (status = 'published');

-- ---------------------------------------------------------------------
-- 2. Kolom PRO Subscription di seller_profiles
-- ---------------------------------------------------------------------
ALTER TABLE public.seller_profiles
  ADD COLUMN IF NOT EXISTS subscription_tier       text NOT NULL DEFAULT 'free'
    CHECK (subscription_tier IN ('free', 'pro')),
  ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS trusted_seller          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS referral_code           text UNIQUE,
  ADD COLUMN IF NOT EXISTS free_bumps              integer NOT NULL DEFAULT 0;

-- Index untuk query PRO aktif (cek subscription_expires_at)
CREATE INDEX IF NOT EXISTS seller_profiles_tier_idx
  ON public.seller_profiles (subscription_tier, subscription_expires_at);

-- ---------------------------------------------------------------------
-- 3. Payments type: tambah nilai 'subscribe', 'renewal', 'autobump'
--    (DROP + ADD karena PostgreSQL tidak bisa ADD VALUE ke inline CHECK)
-- ---------------------------------------------------------------------
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_type_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('iklan', 'bump', 'featured', 'sold_fee', 'subscribe', 'renewal', 'autobump'));

-- ---------------------------------------------------------------------
-- 4. Wanted unlocks table (untuk unlock contact info peminta barang)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wanted_unlocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wanted_id     uuid REFERENCES public.wanted_listings (id) ON DELETE CASCADE,
  unlocked_by_wa text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wanted_unlocks_unique
  ON public.wanted_unlocks (wanted_id, unlocked_by_wa);


-- ---------------------------------------------------------------------
-- BAGIAN 8 — Kondisi barang, tawaran harga, langganan kategori, sponsored
--
-- Dari migration_p4_p6_p7_p8.sql. Harus setelah bagian blog & langganan
-- PRO di atas: price_offers dan category_subscriptions bersandar padanya.
-- ---------------------------------------------------------------------
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS condition text DEFAULT 'used'
    CHECK (condition IN ('new', 'used'));

-- P8: Kolom sponsored di listings
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS sponsored_until timestamptz;

-- P6: Tabel tawaran harga
CREATE TABLE IF NOT EXISTS public.price_offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  buyer_name  text NOT NULL,
  buyer_wa    text NOT NULL,
  offer_price bigint NOT NULL,
  message     text,
  status      text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS price_offers_listing_idx ON public.price_offers (listing_id, status);
CREATE INDEX IF NOT EXISTS price_offers_seller_wa_idx ON public.price_offers (listing_id);

ALTER TABLE public.price_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone can insert offers" ON public.price_offers;
CREATE POLICY "anyone can insert offers"
  ON public.price_offers FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "anyone can read offers" ON public.price_offers;
CREATE POLICY "anyone can read offers"
  ON public.price_offers FOR SELECT USING (true);

DROP POLICY IF EXISTS "anyone can update offers" ON public.price_offers;
CREATE POLICY "anyone can update offers"
  ON public.price_offers FOR UPDATE USING (true);

-- P7: Tabel langganan kategori
CREATE TABLE IF NOT EXISTS public.category_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_wa    text NOT NULL,
  buyer_name  text,
  category    text NOT NULL,
  campus      text NOT NULL DEFAULT 'Semua',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_wa, category, campus)
);

ALTER TABLE public.category_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone can insert cat subscriptions" ON public.category_subscriptions;
CREATE POLICY "anyone can insert cat subscriptions"
  ON public.category_subscriptions FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "anyone can delete own cat subscription" ON public.category_subscriptions;
CREATE POLICY "anyone can delete own cat subscription"
  ON public.category_subscriptions FOR DELETE USING (true);

-- P8: Update payments type check untuk include 'sponsored'
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_type_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('iklan', 'bump', 'featured', 'sold_fee', 'subscribe', 'renewal', 'autobump', 'sponsored'));


-- ---------------------------------------------------------------------
-- BAGIAN 9 — Jenis pembayaran 'wanted'
--
-- Dari migration_wanted_payment.sql. Harus setelah BAGIAN 7: keduanya
-- menulis ulang payments_type_check, dan yang terakhir jalan yang menang.
-- Daftar di sini yang paling lengkap — sembilan jenis.
-- ---------------------------------------------------------------------
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_type_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('iklan', 'bump', 'featured', 'sold_fee', 'subscribe', 'renewal', 'autobump', 'sponsored', 'wanted'));


-- ---------------------------------------------------------------------
-- BAGIAN 10 — Jeda notifikasi (anti-spam)
--
-- Dari migration_antispam.sql. Butuh category_subscriptions dari bagian
-- tawaran harga & langganan kategori di atas.
-- ---------------------------------------------------------------------
ALTER TABLE category_subscriptions
  ADD COLUMN IF NOT EXISTS last_notified_at timestamptz;

-- Tambah last_notified_at ke wanted_listings
ALTER TABLE wanted_listings
  ADD COLUMN IF NOT EXISTS last_notified_at timestamptz;

-- Index agar query cooldown cepat
CREATE INDEX IF NOT EXISTS idx_category_sub_notified
  ON category_subscriptions (buyer_wa, category, last_notified_at);

CREATE INDEX IF NOT EXISTS idx_wanted_notified
  ON wanted_listings (buyer_wa, last_notified_at);


-- ---------------------------------------------------------------------
-- BAGIAN 11 — Sewa, auto-bump, tawaran biaya iklan
--
-- Dari migration_sewa.sql, migration_autobump.sql, migration_fee_offer.sql.
-- ---------------------------------------------------------------------
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rental_period TEXT; -- 'harian' | 'mingguan' | 'bulanan'

-- Index untuk filter tipe
CREATE INDEX IF NOT EXISTS idx_listings_type ON listings(type);

ALTER TABLE listings ADD COLUMN IF NOT EXISTS auto_bump_until timestamp with time zone;

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS fee_offer numeric,
  ADD COLUMN IF NOT EXISTS fee_offer_status text CHECK (fee_offer_status IN ('pending', 'approved', 'rejected'));

-- Index untuk query antrian moderasi
CREATE INDEX IF NOT EXISTS idx_listings_fee_offer_status
  ON listings (fee_offer_status)
  WHERE fee_offer_status IS NOT NULL;


-- ---------------------------------------------------------------------
-- BAGIAN 12 — Jenis iklan: jasa & sewa
--
-- BARU. schema.sql menulis listings.type hanya boleh 'barang' atau
-- 'poster', padahal situs sudah lama memasang iklan 'jasa' dan 'sewa'.
-- Di produksi aturannya jelas sudah dilonggarkan lewat ketikan tangan —
-- dan ketikan tangan tidak ikut kalau databasenya dibangun ulang.
--
-- Pelebarannya hanya dilakukan kalau SEMUA baris yang sudah ada muat di
-- daftar baru. Kalau ada jenis lain yang tidak terduga, aturannya
-- dibiarkan apa adanya dan namanya disebut di NOTICE — lebih baik satu
-- aturan tertinggal daripada seluruh berkas ini batal.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  asing TEXT;
BEGIN
  SELECT string_agg(DISTINCT type, ', ') INTO asing
    FROM public.listings
   WHERE type IS NOT NULL
     AND type NOT IN ('barang', 'poster', 'jasa', 'sewa');

  IF asing IS NOT NULL THEN
    RAISE NOTICE
      'listings_type_check dibiarkan: ada jenis iklan di luar daftar (%). Tambahkan jenis itu ke daftar lalu jalankan lagi.', asing;
  ELSE
    ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS listings_type_check;
    ALTER TABLE public.listings ADD CONSTRAINT listings_type_check
      CHECK (type IN ('barang', 'poster', 'jasa', 'sewa'));
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- BAGIAN 13 — Distributor
--
-- Dari migration_distributor.sql.
-- ---------------------------------------------------------------------
ALTER TABLE seller_profiles
  ADD COLUMN IF NOT EXISTS distributor BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Tambah kolom distributor_fee di listings (fee bagi hasil per iklan)
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS distributor_fee INTEGER;

-- 3. Tabel kategori per distributor (bisa lebih dari 1)
CREATE TABLE IF NOT EXISTS distributor_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_wa   TEXT NOT NULL REFERENCES seller_profiles(wa) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_wa, category)
);

CREATE INDEX IF NOT EXISTS idx_dist_cat_wa ON distributor_categories(seller_wa);

-- 4. Tabel undangan / link bergabung distributor (dibuat admin)
CREATE TABLE IF NOT EXISTS distributor_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT NOT NULL UNIQUE,
  wa          TEXT NOT NULL,
  created_by  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','revoked')),
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dist_invite_token ON distributor_invites(token);
CREATE INDEX IF NOT EXISTS idx_dist_invite_wa    ON distributor_invites(wa);

-- 5. RLS — kedua tabel hanya bisa diakses via service-role (server-side).
--    Anon key tidak dapat SELECT/INSERT/UPDATE/DELETE sama sekali.
ALTER TABLE distributor_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE distributor_invites    ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- BAGIAN 14 — Log pencarian, log admin, log galat
--
-- Dari migration_logs.sql.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query       text NOT NULL,
  results_count integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_logs_query_idx ON search_logs(query);
CREATE INDEX IF NOT EXISTS search_logs_created_at_idx ON search_logs(created_at DESC);

-- Agar tabel tidak tumbuh tak terbatas — hapus data > 90 hari lewat cron atau manual
-- DELETE FROM search_logs WHERE created_at < now() - interval '90 days';

-- ADMIN LOGS — audit trail semua aksi admin
CREATE TABLE IF NOT EXISTS admin_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action      text NOT NULL,
  target_id   text,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_logs_action_idx ON admin_logs(action);
CREATE INDEX IF NOT EXISTS admin_logs_created_at_idx ON admin_logs(created_at DESC);

-- ERROR LOGS — tangkap error kritis di API routes
CREATE TABLE IF NOT EXISTS error_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint      text NOT NULL,
  error_message text,
  context       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_logs_endpoint_idx ON error_logs(endpoint);
CREATE INDEX IF NOT EXISTS error_logs_created_at_idx ON error_logs(created_at DESC);

-- RLS: semua log hanya bisa diakses service_role
ALTER TABLE search_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_logs  ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- BAGIAN 15 — Postingan grup WhatsApp
--
-- Dari migration_group_posts.sql.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_wa TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  group_jid TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index untuk pencarian teks
CREATE INDEX IF NOT EXISTS idx_group_posts_message ON group_posts(message);
CREATE INDEX IF NOT EXISTS idx_group_posts_sender ON group_posts(sender_wa);
CREATE INDEX IF NOT EXISTS idx_group_posts_created ON group_posts(created_at DESC);

-- Hapus postingan lebih dari 30 hari secara otomatis (opsional, jalankan manual atau via cron)
-- DELETE FROM group_posts WHERE created_at < NOW() - INTERVAL '30 days';

ALTER TABLE group_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON group_posts;
CREATE POLICY "Service role only" ON group_posts
  USING (false) WITH CHECK (false);


-- ---------------------------------------------------------------------
-- BAGIAN 16 — Pemasangan PWA
--
-- Dari migration_pwa_installs.sql, dengan satu huruf 'p' nyasar di awal
-- berkas dibuang. Selama huruf itu ada, berkasnya SELALU gagal di baris
-- pertama — jadi tabel ini kemungkinan besar memang belum pernah lahir.
-- ---------------------------------------------------------------------
create table if not exists pwa_installs (
  id uuid primary key default gen_random_uuid(),
  user_agent text,
  created_at timestamptz default now()
);


-- ---------------------------------------------------------------------
-- BAGIAN 17 — Web push & broadcast terjadwal
--
-- Dari migration_push_broadcast.sql, dua CREATE POLICY telanjang diberi
-- DROP POLICY IF EXISTS dengan alasan yang sama seperti pada profil penjual
-- di atas.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wa TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_wa ON push_subscriptions(wa);

-- Row Level Security: hanya service role yang bisa akses
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON push_subscriptions;
CREATE POLICY "Service role only" ON push_subscriptions
  USING (false)
  WITH CHECK (false);

-- -----------------------------------------------

-- Tabel untuk broadcast terjadwal
CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message TEXT NOT NULL,
  image_url TEXT,
  target_type TEXT DEFAULT 'all',        -- 'all' = semua penjual
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending'          -- pending | sending | sent | failed
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  meta JSONB,                            -- { successCount, failCount, error }
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_status_scheduled
  ON scheduled_broadcasts(status, scheduled_at);

ALTER TABLE scheduled_broadcasts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON scheduled_broadcasts;
CREATE POLICY "Service role only" ON scheduled_broadcasts
  USING (false)
  WITH CHECK (false);

-- -----------------------------------------------

-- Tambah kolom meta ke payments jika belum ada (untuk renewal/upgrade via WA)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS meta JSONB;

-- Tambah kolom renewal_fee ke settings pricing jika belum ada
-- (nilai default Rp 2.000, sama dengan biaya iklan barang murah)
-- Ini hanya catatan; nilai disimpan di tabel settings sebagai JSON


-- ---------------------------------------------------------------------
-- BAGIAN 18 — Permintaan ubah profil
--
-- Dari migration_profile_change_requests.sql.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profile_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_wa TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('name', 'bio')),
  current_value TEXT,
  requested_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_via TEXT NOT NULL DEFAULT 'web' CHECK (requested_via IN ('web', 'wa')),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_change_requests_seller_wa ON profile_change_requests(seller_wa);
CREATE INDEX IF NOT EXISTS idx_profile_change_requests_status ON profile_change_requests(status);


-- ---------------------------------------------------------------------
-- BAGIAN 19 — Riwayat chat bot & draft pasang iklan
--
-- Dari migration_missing_wa_tables.sql (yang juga mencakup isi
-- migration_wa_conversations.sql dan migration_wa_drafts.sql).
-- ---------------------------------------------------------------------
create table if not exists public.wa_conversations (
    id         bigint      generated always as identity primary key,
    wa         text        not null,               -- nomor ternormalisasi (08xxx)
    jid        text,                                -- raw JID (628xxx@s.whatsapp.net / xxx@lid)
    role       text        not null,               -- 'user' | 'bot'
    message    text,
    has_media  boolean     not null default false,
    created_at timestamptz not null default now()
);
create index if not exists wa_conversations_wa_idx   on public.wa_conversations (wa, created_at);
create index if not exists wa_conversations_jid_idx  on public.wa_conversations (jid, created_at);
create index if not exists wa_conversations_time_idx on public.wa_conversations (created_at desc);
alter table public.wa_conversations enable row level security;  -- hanya service role (webhook/admin server)

-- 2) Draft "Pemandu Pasang Iklan" --------------------------------------------
create table if not exists public.wa_listing_drafts (
    wa          text        primary key,     -- nomor penjual (ternormalisasi)
    text_parts  text        not null default '',
    updated_at  timestamptz not null default now()
);
alter table public.wa_listing_drafts enable row level security;  -- hanya service role

-- Pembersihan berkala (opsional, jalankan manual kapan perlu):
--   delete from public.wa_conversations   where created_at < now() - interval '90 days';
--   delete from public.wa_listing_drafts  where updated_at < now() - interval '1 day';


-- ---------------------------------------------------------------------
-- BAGIAN 20 — Yang tidak pernah punya berkas migrasinya
--
-- BARU. Kode memakai kedua tabel ini, tapi tidak ada satu pun berkas di
-- supabase/ yang membuatnya; keduanya pasti lahir dari ketikan tangan di
-- dashboard, dan ketikan tangan tidak ikut kalau databasenya dibangun
-- ulang. Bentuknya diambil dari cara kode memakainya.
--
-- referrals dipakai pendaftaran (daftar-langsung & otp/verify menulis satu
-- baris per undangan) dan panel admin membacanya. Kegagalan insert-nya
-- tidak pernah dilaporkan ke siapa pun, jadi kalau tabelnya tidak ada,
-- seluruh program referral diam-diam tidak mencatat apa-apa.
--
-- wa_state dibaca lib/lidMigrate.js untuk memetakan @lid ke nomor asli.
-- Isinya ditulis bot; membuatnya kosong di sini tidak mengubah perilaku
-- apa pun, ia cuma berhenti jadi galat.
--
-- Lima kolom bernasib sama, dan salah satunya seller_profiles.pin —
-- seluruh sistem masuk bergantung padanya. Selama ia cuma hidup sebagai
-- ketikan tangan di satu database, database kedua yang dibangun dari
-- repo ini tidak akan bisa dimasuki siapa pun.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.referrals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_wa  text NOT NULL,
  referred_wa  text NOT NULL,
  status       text NOT NULL DEFAULT 'completed'
                 CHECK (status IN ('pending', 'completed', 'rewarded')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Sengaja BUKAN indeks unik. Kalau tabel ini sudah ada di database dengan
-- satu saja nomor kembar di dalamnya, membuat indeks unik gagal — dan satu
-- kegagalan membatalkan seluruh berkas ini. Menolak undangan kembar adalah
-- urusan kode, bukan alasan untuk menjatuhkan migrasi orang.
CREATE INDEX IF NOT EXISTS referrals_referred_idx
  ON public.referrals (referred_wa);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx
  ON public.referrals (referrer_wa, created_at DESC);

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wa_state (
  key        text PRIMARY KEY,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_state ENABLE ROW LEVEL SECURITY;

-- Kolom-kolom yang nasibnya sama seperti dua tabel di atas: dipakai kode,
-- tidak pernah ditulis di berkas migrasi mana pun.

-- seller_profiles.pin — inti seluruh sistem masuk. Tanpa kolom ini tidak ada
-- yang bisa mendaftar maupun login, dan BAGIAN wa_verified di bawah pun
-- membacanya. Isinya hash bcrypt (60 karakter); PIN lama yang masih polos
-- dinaikkan jadi hash sendiri saat pemiliknya berhasil login.
ALTER TABLE public.seller_profiles
  ADD COLUMN IF NOT EXISTS pin TEXT;

-- blogs.excerpt & blogs.keywords — ringkasan dan tag artikel. Keduanya teks
-- biasa; keywords dipisah koma oleh layarnya, bukan array Postgres.
ALTER TABLE public.blogs
  ADD COLUMN IF NOT EXISTS excerpt  TEXT,
  ADD COLUMN IF NOT EXISTS keywords TEXT;

-- listings.updated_at — dibaca sitemap untuk lastModified.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- listings.listing_code — nomor pendek yang diketik penjual di WhatsApp
-- ("TERIMA 1234"), dan yang dicetak di halaman produk sebagai SKU. Kode
-- membaca nomor ini di banyak tempat, tapi tidak ada berkas yang membuatnya.
--
-- Seluruhnya dijaga "hanya kalau kolomnya belum ada": di produksi kolom ini
-- sudah ada dengan urutan nomor yang sudah berjalan, dan menyentuhnya berarti
-- mengubah kode yang sudah terlanjur disebut orang di chat.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'listings'
       AND column_name = 'listing_code'
  ) THEN
    ALTER TABLE public.listings ADD COLUMN listing_code INTEGER;

    -- Iklan yang sudah ada dinomori dulu, yang tertua dapat nomor terkecil.
    -- Nomornya dihitung row_number(), bukan nextval() sambil jalan: urutan
    -- baris yang keluar dari sebuah UPDATE ... FROM tidak dijanjikan siapa
    -- pun, jadi nextval() akan memberi urutan yang kelihatan acak.
    EXECUTE $sql$
      UPDATE public.listings l
         SET listing_code = u.nomor
        FROM (
          SELECT id, 999 + row_number() OVER (ORDER BY created_at, id) AS nomor
            FROM public.listings
        ) u
       WHERE l.id = u.id
    $sql$;

    CREATE SEQUENCE IF NOT EXISTS public.listings_listing_code_seq AS INTEGER;
    EXECUTE 'SELECT setval(''public.listings_listing_code_seq'',
                           COALESCE((SELECT max(listing_code) FROM public.listings), 999))';
    ALTER TABLE public.listings
      ALTER COLUMN listing_code SET DEFAULT nextval('public.listings_listing_code_seq');

    CREATE UNIQUE INDEX IF NOT EXISTS listings_listing_code_idx
      ON public.listings (listing_code);
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- BAGIAN 21 — Halaman toko penjual (/toko/[slug])
--
-- Dari migration_storefront.sql. Pemeriksa prasyaratnya dibiarkan — di
-- berkas gabungan ini ia tidak akan pernah menyala, dan itu memang
-- jawabannya kalau menyala.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.seller_profiles') IS NULL THEN
    RAISE EXCEPTION
      'Tabel public.seller_profiles belum ada. Jalankan supabase/migration_seller_profiles.sql lebih dulu, baru berkas ini.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. Kolom toko
-- ---------------------------------------------------------------------
ALTER TABLE public.seller_profiles
  ADD COLUMN IF NOT EXISTS slug               TEXT,
  ADD COLUMN IF NOT EXISTS store_name         TEXT,
  ADD COLUMN IF NOT EXISTS tagline            TEXT,
  ADD COLUMN IF NOT EXISTS logo_url           TEXT,
  ADD COLUMN IF NOT EXISTS banner_url         TEXT,
  ADD COLUMN IF NOT EXISTS store_area         TEXT,
  ADD COLUMN IF NOT EXISTS store_hours        TEXT,
  ADD COLUMN IF NOT EXISTS store_instagram    TEXT,
  ADD COLUMN IF NOT EXISTS store_accent       TEXT    DEFAULT 'emerald',
  ADD COLUMN IF NOT EXISTS store_open         BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS store_announcement TEXT,
  ADD COLUMN IF NOT EXISTS store_updated_at   TIMESTAMPTZ;

-- trusted_seller sebenarnya milik migration_blogs_subscription.sql, bukan
-- berkas ini. Ikut disebut di sini karena GET /api/toko memilih kolom itu
-- dalam satu SELECT bersama kolom toko: kalau ia belum ada, form toko di
-- dasbor menjawab 500 dan penjual melihat "gagal memuat" tanpa satu pun
-- petunjuk bahwa yang kurang adalah kolom dari migrasi yang sama sekali
-- lain. IF NOT EXISTS membuat baris ini tidak berbuat apa-apa kalau
-- migrasi itu memang sudah dijalankan.
ALTER TABLE public.seller_profiles
  ADD COLUMN IF NOT EXISTS trusted_seller BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------
-- 2. Kolom yang dibaca sebagai keadaan, bukan sebagai teks, tidak boleh NULL
--
-- Halaman toko memutuskan "Buka"/"Tutup" dari store_open dan memilih warna
-- dari store_accent. NULL di keduanya terbaca sebagai tutup dan sebagai
-- warna bawaan — dua kebohongan kecil untuk baris profil lama yang dibuat
-- sebelum kolomnya ada. Isi dulu, baru dikunci.
-- ---------------------------------------------------------------------
UPDATE public.seller_profiles SET store_open   = TRUE      WHERE store_open   IS NULL;
UPDATE public.seller_profiles SET store_accent = 'emerald' WHERE store_accent IS NULL;

ALTER TABLE public.seller_profiles
  ALTER COLUMN store_open   SET DEFAULT TRUE,
  ALTER COLUMN store_open   SET NOT NULL,
  ALTER COLUMN store_accent SET DEFAULT 'emerald',
  ALTER COLUMN store_accent SET NOT NULL;

-- ---------------------------------------------------------------------
-- 3. Rapikan slug yang mungkin sudah terlanjur masuk
--
-- Alamat toko disimpan huruf kecil apa adanya. Kalau ada baris yang masuk
-- lewat jalan lain (SQL Editor, impor, versi API yang lebih tua), rapikan
-- sekarang — sebelum indeks unik di bawah menilai dua bentuk dari alamat
-- yang sama sebagai dua alamat berbeda.
-- ---------------------------------------------------------------------
UPDATE public.seller_profiles
   SET slug = NULLIF(btrim(lower(slug)), '')
 WHERE slug IS NOT NULL
   AND slug IS DISTINCT FROM NULLIF(btrim(lower(slug)), '');

-- Dua penjual dengan slug yang cuma beda huruf besar-kecil baru ketahuan di
-- sini, dan pesan bawaan Postgres saat indeks unik gagal ("could not create
-- unique index") tidak menyebut siapa yang bentrok. Sebut.
DO $$
DECLARE bentrok TEXT;
BEGIN
  SELECT string_agg(slug || ' (' || jumlah || ' penjual)', ', ')
    INTO bentrok
    FROM (
      SELECT slug, count(*) AS jumlah
        FROM public.seller_profiles
       WHERE slug IS NOT NULL
       GROUP BY slug HAVING count(*) > 1
    ) d;
  IF bentrok IS NOT NULL THEN
    RAISE EXCEPTION
      'Alamat toko kembar, indeks unik tidak bisa dibuat: %. Ubah salah satu lewat tab Toko di panel admin, lalu jalankan berkas ini lagi.', bentrok;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. Bentuk slug ditegakkan basis data
--
-- normalisasiSlug() di src/lib/toko.js sudah menghasilkan bentuk ini, tapi
-- ia cuma mengikat penjual yang lewat form. Halaman /toko/[slug] mencari
-- dengan ilike, jadi slug yang mengandung % atau _ akan cocok dengan toko
-- orang lain — dan yang bisa menutup jalan itu untuk SEMUA penulis, termasuk
-- SQL Editor dan skrip impor, cuma basis datanya sendiri.
--
-- Yang TIDAK ikut ke sini: daftar kata terlarang ("admin", "official", …)
-- dan larangan slug serba-angka. Keduanya aturan produk yang akan berubah,
-- dan salinan kedua yang perlahan berbeda dari src/lib/toko.js lebih
-- berbahaya daripada tidak punya salinan sama sekali. Di sini hanya bentuk
-- yang tidak akan berubah: huruf kecil, angka, tanda hubung sebagai pemisah,
-- 3–32 huruf.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.seller_profiles'::regclass
       AND conname  = 'seller_profiles_slug_bentuk'
  ) THEN
    -- NOT VALID: baris lama yang menyalahi aturan tidak menggagalkan migrasi
    -- ini — mereka diperiksa terpisah di bawah. Setiap penulisan BARU tetap
    -- terikat sejak detik ini.
    ALTER TABLE public.seller_profiles
      ADD CONSTRAINT seller_profiles_slug_bentuk
      CHECK (
        slug IS NULL
        OR (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 32)
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE public.seller_profiles VALIDATE CONSTRAINT seller_profiles_slug_bentuk;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE
    'Ada alamat toko lama yang bentuknya tidak sah — dibiarkan apa adanya supaya tautan yang sudah disebar penjual tidak mati. Cari lewat: SELECT wa, slug FROM seller_profiles WHERE slug IS NOT NULL AND NOT (slug ~ ''^[a-z0-9]+(-[a-z0-9]+)*$'' AND char_length(slug) BETWEEN 3 AND 32);';
END $$;

-- ---------------------------------------------------------------------
-- 5. Keunikan alamat toko
--
-- Slug itu alamat publik: keunikan ditegakkan basis data, bukan dipercayakan
-- pada pemeriksaan di aplikasi yang bisa kalah balapan antara dua permintaan
-- yang datang bersamaan. Partial index supaya penjual yang belum punya toko
-- (slug NULL) tidak saling bentrok, dan lower() supaya tetap benar meski
-- aturan huruf kecil di atas suatu saat dilepas.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS seller_profiles_slug_key
  ON public.seller_profiles (lower(slug))
  WHERE slug IS NOT NULL;

-- ---------------------------------------------------------------------
-- 6. Hak baca
--
-- Halaman toko dibaca publik tanpa login. RLS di tabel ini sudah mengizinkan
-- SELECT untuk semua (migration_seller_profiles.sql dan migration_rls.sql),
-- jadi tidak ada policy baru yang perlu ditambahkan — kolom baru ikut policy
-- tabelnya, bukan punya izin sendiri.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- BAGIAN 22 — Penanda wa_verified — daftar tanpa OTP
--
-- Dari migration_daftar_tanpa_otp.sql. Inilah yang membedakan akun yang
-- nomornya terbukti dari akun yang cuma diketik orang, dan backfill-nya
-- hanya boleh jalan sekali seumur hidup database ini.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.seller_profiles') IS NULL THEN
    RAISE EXCEPTION
      'Tabel public.seller_profiles belum ada. Jalankan supabase/migration_seller_profiles.sql lebih dulu, baru berkas ini.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. Kolomnya, dan backfill yang hanya boleh terjadi sekali
--
-- Semua akun yang sudah punya PIN sebelum perubahan ini lahir lewat OTP, jadi
-- nomornya memang sudah terbukti. Tanpa backfill itu mereka akan terlihat seolah
-- belum terverifikasi dan diminta memverifikasi ulang tanpa alasan.
--
-- Tapi backfill yang sama, dijalankan ulang bulan depan, akan menandai TERBUKTI
-- setiap orang yang mendaftar tanpa OTP — persis yang penanda ini dipasang untuk
-- membedakan. Karena itu ia hanya jalan saat kolomnya baru saja lahir di jalan
-- ini, atau saat kolomnya ada tapi belum ada satu pun akun bertanda TRUE
-- (kolomnya pernah ditambahkan sendirian tanpa backfill-nya). Begitu ada satu
-- akun terbukti, berkas ini tidak pernah lagi menyentuh isi tabel.
-- ---------------------------------------------------------------------
--
-- Perintah yang menyebut wa_verified ditulis lewat EXECUTE dengan sengaja:
-- kolomnya baru lahir beberapa baris di atas, dan SQL biasa di dalam blok yang
-- sama menyebut nama yang belum ada saat blok ini disiapkan.
DO $$
DECLARE
  kolom_baru BOOLEAN;
  sudah_ada  BOOLEAN;
  jumlah     BIGINT := 0;
BEGIN
  kolom_baru := NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'seller_profiles'
       AND column_name = 'wa_verified'
  );

  IF kolom_baru THEN
    ALTER TABLE public.seller_profiles
      ADD COLUMN wa_verified BOOLEAN DEFAULT FALSE;
    sudah_ada := FALSE;
  ELSE
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.seller_profiles WHERE wa_verified IS TRUE)'
      INTO sudah_ada;
  END IF;

  IF sudah_ada THEN
    RAISE NOTICE 'Backfill dilewati — tabelnya sudah punya akun bertanda terbukti.';
  ELSE
    EXECUTE 'UPDATE public.seller_profiles
                SET wa_verified = TRUE
              WHERE pin IS NOT NULL AND wa_verified IS DISTINCT FROM TRUE';
    GET DIAGNOSTICS jumlah = ROW_COUNT;
    RAISE NOTICE 'Akun lama yang ditandai terbukti: %', jumlah;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- BAGIAN 23 — Row Level Security
--
-- Dari migration_rls.sql, setiap CREATE POLICY diberi DROP POLICY IF EXISTS.
--
-- Policy anon di sini TIDAK membuka apa pun kalau kamu sudah pernah
-- menjalankan migration_security_rls.sql: berkas itu mencabut hak akses
-- tabel dari peran anon, dan policy tanpa hak akses tetap menolak.
-- ---------------------------------------------------------------------
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_active_listings" ON listings;
CREATE POLICY "anon_read_active_listings"
  ON listings FOR SELECT TO anon
  USING (status IN ('active', 'sold'));

-- SELLER_PROFILES — publik bisa baca semua profil
ALTER TABLE seller_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_seller_profiles" ON seller_profiles;
CREATE POLICY "anon_read_seller_profiles"
  ON seller_profiles FOR SELECT TO anon
  USING (true);

-- CATEGORIES — publik bisa baca semua kategori
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_categories" ON categories;
CREATE POLICY "anon_read_categories"
  ON categories FOR SELECT TO anon
  USING (true);

-- SELLER_RATINGS — publik bisa baca semua rating
ALTER TABLE seller_ratings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_ratings" ON seller_ratings;
CREATE POLICY "anon_read_ratings"
  ON seller_ratings FOR SELECT TO anon
  USING (true);

-- WANTED_LISTINGS — publik baca yang masih active
ALTER TABLE wanted_listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_active_wanted" ON wanted_listings;
CREATE POLICY "anon_read_active_wanted"
  ON wanted_listings FOR SELECT TO anon
  USING (status = 'active');

-- BLOGS — publik bisa baca semua artikel
ALTER TABLE blogs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_blogs" ON blogs;
CREATE POLICY "anon_read_blogs"
  ON blogs FOR SELECT TO anon
  USING (true);

-- PAYMENTS — sensitif, tidak ada akses anon
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- REPORTS — sensitif, tidak ada akses anon
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- PRICE_OFFERS — tidak ada akses anon (semua via API)
ALTER TABLE price_offers ENABLE ROW LEVEL SECURITY;

-- CATEGORY_SUBSCRIPTIONS — tidak ada akses anon
ALTER TABLE category_subscriptions ENABLE ROW LEVEL SECURITY;

-- BLACKLIST — tidak ada akses anon
ALTER TABLE blacklist ENABLE ROW LEVEL SECURITY;

-- PROFILE_CHANGE_REQUESTS — tidak ada akses anon
ALTER TABLE profile_change_requests ENABLE ROW LEVEL SECURITY;

-- SETTINGS — tidak ada akses anon
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- PWA_INSTALLS — tidak ada akses anon
ALTER TABLE pwa_installs ENABLE ROW LEVEL SECURITY;

-- PUSH_SUBSCRIPTIONS — tidak ada akses anon
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- GROUP_POSTS — tidak ada akses anon
ALTER TABLE group_posts ENABLE ROW LEVEL SECURITY;

-- REFERRALS — tidak ada akses anon
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- OTPS — tidak ada akses anon
ALTER TABLE otps ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- CATATAN PENTING:
-- service_role (dipakai API routes) bypass RLS secara otomatis
-- di Supabase. Tidak perlu policy tambahan untuk service_role.
-- Semua tabel yang disebut di sini sudah dibuat di bagian-bagian atas,
-- jadi tidak ada lagi statement yang perlu dilewati.
-- ============================================================

-- ---------------------------------------------------------------------
-- BAGIAN 24 — Antrean notifikasi WhatsApp yang belum sampai
--
-- BARU. Sampai sekarang, notifikasi dari situs (iklan tayang, bump, iklan
-- terjual) dikirim dengan sekali tembak ke bot lalu dilupakan. Kalau bot
-- masih hidup tapi WhatsApp-nya putus, bot menyimpannya sendiri di
-- outbox.json dan itu selesai. Tapi kalau bot ATAU VPS-nya yang mati,
-- fetch dari situs gagal, dan pemanggilnya cuma `.catch(console.error)` —
-- pesannya lenyap tanpa seorang pun tahu, sementara iklannya tetap tayang
-- dan penjualnya menunggu kabar yang tidak akan datang.
--
-- Tabel ini rumah untuk pesan-pesan itu: ditulis situs saat pengiriman
-- gagal, dibaca dua panel, dan dikirim ulang lewat tombol begitu botnya
-- tersambung lagi.
--
-- OTP SENGAJA TIDAK PERNAH MASUK SINI. Kode yang berlaku lima menit dan
-- baru dikirim tiga jam kemudian bukan pertolongan, melainkan kebingungan.
-- Penyaringnya ada di src/lib/fonnte.js — hanya pesan tanpa masa berlaku
-- atau yang berlakunya di atas 15 menit yang ditampung.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wa_outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target         text NOT NULL,          -- nomor atau JID, apa adanya seperti saat gagal
  message        text NOT NULL,
  image_url      text,
  ttl_detik      integer,                -- diteruskan lagi saat kirim ulang
  jenis          text,                   -- 'iklan' | 'bump' | 'terjual' | ...
  listing_id     uuid REFERENCES public.listings (id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'tertunda'
                   CHECK (status IN ('tertunda', 'terkirim', 'dibatalkan')),
  percobaan      integer NOT NULL DEFAULT 0,
  galat_terakhir text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  terkirim_at    timestamptz
);

-- Panel selalu membuka daftar "tertunda, terbaru dulu" — indeksnya mengikuti
-- pertanyaan itu, bukan sekadar menandai kolom status.
CREATE INDEX IF NOT EXISTS wa_outbox_tertunda_idx
  ON public.wa_outbox (status, created_at DESC);
CREATE INDEX IF NOT EXISTS wa_outbox_listing_idx
  ON public.wa_outbox (listing_id);

-- Tanpa policy publik => hanya service-role. Isinya nomor HP dan teks pesan
-- pribadi; ia tidak punya urusan dengan peran anon.
ALTER TABLE public.wa_outbox ENABLE ROW LEVEL SECURITY;


COMMIT;

-- =====================================================================
-- RINGKASAN — inilah yang harus dibaca setelah Run
--
-- Semua baris harus 'OK'. Yang 'KURANG' berarti ada perintah di atas yang
-- tidak jalan; salin barisnya ke sini biar bisa dilihat kenapa.
-- =====================================================================
WITH diharap(nama) AS (
  VALUES ('categories'), ('listings'), ('payments'), ('blacklist'),
         ('seller_profiles'), ('seller_ratings'), ('reports'), ('settings'),
         ('wanted_listings'), ('wanted_unlocks'), ('verified_sellers'),
         ('otps'), ('blogs'), ('price_offers'), ('category_subscriptions'),
         ('distributor_categories'), ('distributor_invites'),
         ('search_logs'), ('admin_logs'), ('error_logs'),
         ('group_posts'), ('pwa_installs'), ('push_subscriptions'),
         ('scheduled_broadcasts'), ('profile_change_requests'),
         ('wa_conversations'), ('wa_listing_drafts'),
         ('referrals'), ('wa_state'), ('wa_outbox')
),
kurang AS (
  SELECT d.nama FROM diharap d
   WHERE to_regclass('public.' || d.nama) IS NULL
)
SELECT 'Tabel' AS bagian,
       (SELECT count(*) FROM diharap) - (SELECT count(*) FROM kurang)
         || ' / ' || (SELECT count(*) FROM diharap) || ' ada'
         || COALESCE(' — belum ada: ' || (SELECT string_agg(nama, ', ') FROM kurang), '') AS keadaan,
       CASE WHEN (SELECT count(*) FROM kurang) = 0 THEN 'OK' ELSE 'KURANG' END AS status

UNION ALL
SELECT 'Kolom listings',
       count(*) || ' / 14 terpasang',
       CASE WHEN count(*) = 14 THEN 'OK' ELSE 'KURANG' END
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'listings'
   AND column_name IN ('views','images','campus','area','seller_verified','condition',
                       'sponsored_until','rental_period','auto_bump_until','fee_offer',
                       'fee_offer_status','distributor_fee','listing_code','updated_at')

UNION ALL
SELECT 'Kolom blogs',
       count(*) || ' / 2 terpasang (excerpt, keywords)',
       CASE WHEN count(*) = 2 THEN 'OK' ELSE 'KURANG' END
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'blogs'
   AND column_name IN ('excerpt', 'keywords')

UNION ALL
SELECT 'Kolom seller_profiles',
       count(*) || ' / 9 terpasang',
       CASE WHEN count(*) = 9 THEN 'OK' ELSE 'KURANG' END
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'seller_profiles'
   AND column_name IN ('pin','wa_verified','subscription_tier','subscription_expires_at',
                       'trusted_seller','referral_code','free_bumps','distributor','slug')

UNION ALL
SELECT 'Kolom toko',
       count(*) || ' / 13 terpasang',
       CASE WHEN count(*) = 13 THEN 'OK' ELSE 'KURANG' END
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'seller_profiles'
   AND column_name IN ('slug','store_name','tagline','logo_url','banner_url',
                       'store_area','store_hours','store_instagram','store_accent',
                       'store_open','store_announcement','store_updated_at','trusted_seller')

UNION ALL
SELECT 'Jenis pembayaran',
       CASE WHEN count(*) = 1 THEN 'payments_type_check terpasang' ELSE 'tidak ada' END,
       CASE WHEN count(*) = 1 THEN 'OK' ELSE 'KURANG' END
  FROM pg_constraint
 WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_type_check'

UNION ALL
SELECT 'Kunci asing iklan → penjual',
       CASE WHEN count(*) = 1 THEN 'listings_seller_wa_fkey terpasang' ELSE 'tidak ada' END,
       CASE WHEN count(*) = 1 THEN 'OK' ELSE 'KURANG' END
  FROM pg_constraint
 WHERE conname = 'listings_seller_wa_fkey'

UNION ALL
SELECT 'Baris pengaturan',
       count(*) || ' / 3 ada (pricing, contact, site)',
       CASE WHEN count(*) = 3 THEN 'OK' ELSE 'KURANG' END
  FROM public.settings
 WHERE key IN ('pricing', 'contact', 'site')

UNION ALL
SELECT 'Akun nomornya terbukti',
       count(*) || ' akun (lahir lewat OTP, atau pernah lewat "Lupa PIN")',
       'INFO'
  FROM public.seller_profiles
 WHERE wa_verified IS TRUE

UNION ALL
SELECT 'Akun belum terbukti',
       count(*) || ' akun (daftar tanpa OTP, belum membuktikan nomornya)',
       'INFO'
  FROM public.seller_profiles
 WHERE wa_verified IS DISTINCT FROM TRUE

UNION ALL
SELECT 'Toko yang sudah dibuat',
       count(*) || ' penjual sudah punya alamat toko',
       'INFO'
  FROM public.seller_profiles
 WHERE slug IS NOT NULL;


-- ---------------------------------------------------------------------
-- BAGIAN 25 — Notifikasi peramban untuk SEMUA pengunjung
--
-- push_subscriptions lahir dengan `wa NOT NULL`, dan itu diam-diam berarti
-- "hanya orang yang sudah punya akun yang boleh dikabari". Padahal yang
-- paling ingin tahu ada barang baru justru pembeli — dan pembeli tidak
-- perlu punya akun di situs ini untuk membeli.
--
-- Satu baris di bawah membuka pintunya: peramban boleh berlangganan tanpa
-- menyebut nomor. Barisnya tetap unik per endpoint (satu perangkat = satu
-- baris), jadi tidak ada yang bisa dikirimi dua kali untuk hal yang sama.
--
-- Aman diulang: kalau kolomnya sudah nullable, PostgreSQL diam saja.
-- ---------------------------------------------------------------------
ALTER TABLE public.push_subscriptions ALTER COLUMN wa DROP NOT NULL;

-- Broadcast membaca seluruh tabel dan mengecualikan penjualnya sendiri.
-- Indeks endpoint sudah ada lewat UNIQUE; yang belum ada indeks waktu, dipakai
-- untuk mengambil pelanggan terbaru dulu saat jumlahnya sudah besar.
CREATE INDEX IF NOT EXISTS push_subscriptions_created_idx
  ON public.push_subscriptions (created_at DESC);


-- ---------------------------------------------------------------------
-- BAGIAN 26 — Toko harus disetujui admin dulu
--
-- Sejak "punya toko = iklan gratis", membuat toko bukan lagi urusan
-- tampilan: ia pintu masuk ke iklan tanpa biaya. Pintu yang siapa pun
-- bisa buka sendiri dengan mengetik satu alamat bukan pintu.
--
-- Empat kolom, satu alur: penjual mengisi tokonya (draf) → menekan
-- "Minta persetujuan" (menunggu) → admin membuka tautan yang dikirimkan
-- lewat WhatsApp dan menekan Aktifkan (aktif). 'ditolak' menyimpan
-- alasannya supaya penjual tahu apa yang harus diperbaiki.
--
-- Halaman /toko/<slug> hanya tayang untuk yang 'aktif'.
-- ---------------------------------------------------------------------
ALTER TABLE public.seller_profiles
  ADD COLUMN IF NOT EXISTS store_status text NOT NULL DEFAULT 'draf',
  ADD COLUMN IF NOT EXISTS store_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS store_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS store_reject_note text;

-- CHECK ditambah terpisah supaya menjalankan ulang berkas ini tidak gagal
-- di baris yang constraint-nya sudah ada.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'seller_profiles_store_status_check'
  ) THEN
    ALTER TABLE public.seller_profiles
      ADD CONSTRAINT seller_profiles_store_status_check
      CHECK (store_status IN ('draf', 'menunggu', 'aktif', 'ditolak'));
  END IF;
END $$;

-- Toko yang SUDAH terlanjur ada sebelum aturan ini tidak boleh mendadak
-- padam: alamatnya sudah disebar penjualnya ke pelanggan. Semuanya
-- dianggap sudah disetujui. Hanya baris 'draf' yang disentuh, jadi
-- menjalankan ulang berkas ini tidak menghidupkan kembali toko yang
-- sengaja ditolak admin.
UPDATE public.seller_profiles
   SET store_status = 'aktif',
       store_approved_at = COALESCE(store_approved_at, now())
 WHERE slug IS NOT NULL
   AND store_status = 'draf';

-- Panel admin selalu membuka daftar "yang menunggu dulu".
CREATE INDEX IF NOT EXISTS seller_profiles_store_status_idx
  ON public.seller_profiles (store_status);


-- ---------------------------------------------------------------------
-- BAGIAN 27 — Membuang yang kembar
--
-- Tidak ada fitur baru di sini. Yang dibuang lahir dari kebiasaan lama:
-- SQL yang sama dijalankan lewat dasbor Supabase dengan nama berbeda,
-- lalu dijalankan lagi lewat berkas ini. Postgres menurut saja — dua
-- indeks identik dipelihara dua-duanya (dua kali kerja tiap INSERT), dan
-- dua kebijakan RLS yang berbunyi sama dievaluasi dua-duanya tiap query.
--
-- Aman diulang: semuanya IF EXISTS.
-- ---------------------------------------------------------------------

-- 1. INDEKS KEMBAR ------------------------------------------------------
-- Yang disimpan selalu nama yang ditulis berkas ini, supaya menjalankan
-- ulang migrasi tidak menghidupkan lagi yang barusan dibuang.
DROP INDEX IF EXISTS public.idx_listings_bumped_at;   -- = listings_bumped_idx (BAGIAN 1)
DROP INDEX IF EXISTS public.idx_listings_status;      -- = listings_status_idx (BAGIAN 1)
DROP INDEX IF EXISTS public.idx_listings_seller_wa;   -- = listings_seller_idx (BAGIAN 1)
DROP INDEX IF EXISTS public.idx_reports_listing_id;   -- = reports_listing_idx (BAGIAN 3)

-- 2. INDEKS YANG SUDAH DITANGGUNG CONSTRAINT UNIQUE ---------------------
-- UNIQUE membuat indeksnya sendiri. Indeks biasa di kolom yang sama tidak
-- menambah kecepatan apa pun — cuma satu pohon lagi yang harus diperbarui
-- tiap tulis.
DROP INDEX IF EXISTS public.idx_listings_listing_code; -- ada listings_listing_code_unique
DROP INDEX IF EXISTS public.blogs_slug_idx;            -- ada blogs_slug_key
DROP INDEX IF EXISTS public.idx_dist_invite_token;     -- ada distributor_invites_token_key
DROP INDEX IF EXISTS public.payments_order_idx;        -- ada payments_midtrans_order_id_key
DROP INDEX IF EXISTS public.referrals_referred_idx;    -- ada referrals_referred_wa_key

-- 3. UNIQUE KEMBAR DI KUNCI UTAMA ---------------------------------------
-- `seller_profiles.wa` adalah PRIMARY KEY, dan primary key sudah unik.
-- `seller_profiles_wa_key` yang dibuat BAGIAN 5 tidak pernah menambah
-- jaminan apa pun. Sudah diperiksa: ketiga foreign key yang menunjuk ke
-- tabel ini memakai seller_profiles_pkey, bukan constraint ini.
ALTER TABLE public.seller_profiles DROP CONSTRAINT IF EXISTS seller_profiles_wa_key;

-- 4. DUA FOREIGN KEY DI SATU KOLOM --------------------------------------
-- `listings.seller_wa` punya DUA foreign key ke seller_profiles(wa):
--
--   listings_seller_wa_fkey   ON UPDATE CASCADE  ON DELETE SET NULL  (BAGIAN 5)
--   fk_seller_profiles        (tanpa ON UPDATE)  ON DELETE RESTRICT  (entah dari mana)
--
-- Postgres menegakkan keduanya, jadi yang paling ketat yang menang dan
-- BAGIAN 5 tidak pernah benar-benar berlaku. Akibatnya nyata, bukan
-- teoretis: `migrateLidToPhone()` di situs mengganti `seller_profiles.wa`
-- dari LID ke nomor HP dan mengandalkan ON UPDATE CASCADE. Selama
-- fk_seller_profiles berdiri, UPDATE itu SELALU ditolak, dan kodenya jatuh
-- ke jalur cadangan: baris profil baru dibuat lalu yang lama dihapus —
-- `created_at` dan `referral_code` penjualnya hilang tiap kali.
ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS fk_seller_profiles;

-- 5. KEBIJAKAN RLS KEMBAR -----------------------------------------------
-- Satu kebijakan per tabel per aksi. Yang disimpan adalah policy anon dari
-- BAGIAN 23 (dan untuk blogs: policy "published" dari BAGIAN 7).
DROP POLICY IF EXISTS "public read active listings"  ON public.listings;
DROP POLICY IF EXISTS "public read categories"       ON public.categories;
DROP POLICY IF EXISTS "public read ratings"          ON public.seller_ratings;
DROP POLICY IF EXISTS "public read active wanted"    ON public.wanted_listings;
DROP POLICY IF EXISTS "Public read seller_profiles"  ON public.seller_profiles;  -- kembar BAGIAN 4
DROP POLICY IF EXISTS "Public can view published blogs" ON public.blogs;

-- blogs perlu perlakuan sendiri. Dua policy-nya TIDAK berbunyi sama:
-- `anon_read_blogs` (BAGIAN 23) memakai USING (true), sedangkan
-- "public read published blogs" (BAGIAN 7) membatasi ke artikel yang sudah
-- terbit. Dua aturan berbeda untuk satu tabel berarti yang paling longgar
-- yang menang. Yang disimpan yang lebih ketat.
DROP POLICY IF EXISTS "anon_read_blogs" ON public.blogs;


-- ---------------------------------------------------------------------
-- RINGKASAN BAGIAN 27 — semuanya harus 0
-- ---------------------------------------------------------------------
WITH kembar AS (
  SELECT tablename, regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \S+ ON', 'ON') AS bentuk
    FROM pg_indexes WHERE schemaname = 'public'
   GROUP BY 1, 2 HAVING count(*) > 1
)
SELECT 'indeks kembar tersisa' AS periksa, count(*)::text AS jumlah FROM kembar
UNION ALL
SELECT 'foreign key kembar di listings.seller_wa',
       (count(*) - 1)::text FROM pg_constraint
 WHERE conrelid = 'public.listings'::regclass AND contype = 'f'
   AND confrelid = 'public.seller_profiles'::regclass
UNION ALL
SELECT 'kebijakan kembar tersisa', (count(*))::text FROM (
  SELECT tablename, cmd, qual FROM pg_policies WHERE schemaname = 'public'
   GROUP BY 1, 2, 3 HAVING count(*) > 1) k;
