-- Tabel penyimpanan sesi WhatsApp (Baileys auth state) di Supabase.
-- Dipakai oleh useSupabaseAuthState.js agar sesi persisten tanpa disk permanen
-- (mis. di Render Free) — bot reconnect otomatis TANPA scan QR ulang.
--
-- Jalankan di Supabase SQL Editor (project yang sama dengan marketplace).

create table if not exists public.wa_auth (
    session_id  text        not null,
    key         text        not null,
    data        jsonb       not null,
    updated_at  timestamptz not null default now(),
    primary key (session_id, key)
);

-- Kunci tabel: hanya bisa diakses lewat service role key (yang dipakai bot).
-- RLS aktif tanpa policy apa pun = semua akses via anon/authenticated ditolak.
-- Service role otomatis bypass RLS.
alter table public.wa_auth enable row level security;
