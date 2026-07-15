-- Tabel penyimpanan state ringan bot (nama user & resolusi @lid) di Supabase.
-- Dipakai oleh index.js (loadState/saveState) supaya state TIDAK hilang saat
-- Render Free spin-down (filesystem host gratis bersifat sementara). Tanpa ini,
-- nama user & resolusi @lid ke-reset tiap bot restart → user ditanya nama berulang.
--
-- Jalankan di Supabase SQL Editor (project yang sama dengan marketplace & wa_auth).
-- Isi baris: (session_id, key) → data JSON. key = 'name_map' | 'lid_resolution_map'.

create table if not exists public.wa_state (
    session_id  text        not null,
    key         text        not null,
    data        jsonb       not null default '{}'::jsonb,
    updated_at  timestamptz not null default now(),
    primary key (session_id, key)
);

-- Kunci tabel: hanya bisa diakses lewat service role key (yang dipakai bot).
-- RLS aktif tanpa policy apa pun = semua akses via anon/authenticated ditolak.
-- Service role otomatis bypass RLS.
alter table public.wa_state enable row level security;
