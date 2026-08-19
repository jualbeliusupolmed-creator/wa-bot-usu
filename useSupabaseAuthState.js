// Baileys auth-state adapter yang menyimpan sesi WhatsApp di Supabase (Postgres)
// alih-alih di filesystem. Ini membuat sesi tetap persisten di host tanpa disk
// permanen (mis. Render Free) — bot reconnect otomatis TANPA scan QR ulang.
//
// Interface-nya identik dengan useMultiFileAuthState: mengembalikan { state, saveCreds }
// plus tambahan flush() dan clear() (dipakai saat logout/reset).
//
// Pengaman yang sama seperti waAuthState.js versi file, karena sebabnya sama —
// sesi yang hilang berarti admin harus scan QR lagi:
//   • creds ditulis berantai (tidak saling menyalip) dan dicoba ulang saat gagal.
//     Satu kegagalan jaringan yang lewat begitu saja = creds tertinggal versi lama.
//   • Salinan creds disimpan di baris 'creds.bak'; kalau yang utama hilang/rusak,
//     sesi dipulihkan dari situ alih-alih memulai sesi baru.
//   • clear() menyalin sesi ke session_id cadangan dulu, baru menghapus.
//
// Skema tabel (lihat wa_auth.sql):
//   create table public.wa_auth (
//     session_id text, key text, data jsonb, updated_at timestamptz,
//     primary key (session_id, key)
//   );
// Diakses HANYA lewat service role key (RLS aktif tanpa policy = terkunci).

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

const TABLE = 'wa_auth';
const CREDS = 'creds';
const CREDS_BAK = 'creds.bak';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function useSupabaseAuthState(supabase, sessionId = 'default') {
    async function readData(key) {
        const { data, error } = await supabase
            .from(TABLE)
            .select('data')
            .eq('session_id', sessionId)
            .eq('key', key)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        // data.data disimpan sebagai JSON hasil BufferJSON.replacer → revive Buffer-nya
        return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
    }

    // Sekali gagal bukan berarti selamanya gagal: jaringan ke Supabase sesekali
    // meleset. Tanpa percobaan ulang, kunci sesi yang gagal ditulis hilang diam-diam.
    async function withRetry(label, fn, tries = 3) {
        let lastErr;
        for (let i = 1; i <= tries; i++) {
            try { return await fn(); } catch (e) {
                lastErr = e;
                if (i < tries) await sleep(300 * i);
            }
        }
        console.error(`[auth] Gagal ${label} setelah ${tries} percobaan: ${lastErr?.message || lastErr}`);
        return null;
    }

    async function writeRaw(key, value) {
        const payload = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
        const { error } = await supabase
            .from(TABLE)
            .upsert(
                { session_id: sessionId, key, data: payload, updated_at: new Date().toISOString() },
                { onConflict: 'session_id,key' }
            );
        if (error) throw error;
    }

    function writeData(key, value) {
        return track(withRetry(`simpan ${key}`, () => writeRaw(key, value)));
    }

    function removeData(key) {
        return track(withRetry(`hapus ${key}`, async () => {
            const { error } = await supabase
                .from(TABLE)
                .delete()
                .eq('session_id', sessionId)
                .eq('key', key);
            if (error) throw error;
        }));
    }

    // Penulisan yang masih di udara — ditunggu sebelum proses keluar.
    const inflight = new Set();
    function track(p) {
        const t = p.finally(() => inflight.delete(t));
        inflight.add(t);
        return t;
    }
    async function flush() {
        while (inflight.size) await Promise.allSettled([...inflight]);
    }

    let creds = null;
    try {
        creds = await readData(CREDS);
    } catch (e) {
        console.error('[auth] Gagal baca creds dari Supabase:', e.message);
    }
    if (!creds) {
        try {
            const bak = await readData(CREDS_BAK);
            if (bak) {
                creds = bak;
                console.warn('[auth] creds hilang/tak terbaca — sesi DIPULIHKAN dari cadangan. Tidak perlu scan ulang.');
                await withRetry('pulihkan creds', () => writeRaw(CREDS, creds));
            }
        } catch (e) {
            console.error('[auth] Gagal baca cadangan creds:', e.message);
        }
    }
    if (!creds) {
        creds = initAuthCreds();
        console.warn('[auth] Tidak ada creds tersimpan — sesi BARU dibuat, bot akan meminta scan QR.');
    }

    // creds ditulis berantai supaya dua penyimpanan tidak saling menyalip, dan
    // cadangannya diperbarui setelah yang utama sukses.
    let credsChain = Promise.resolve();
    function saveCreds() {
        credsChain = credsChain.then(async () => {
            const ok = await withRetry('simpan creds', () => writeRaw(CREDS, creds));
            if (ok !== null) await withRetry('simpan cadangan creds', () => writeRaw(CREDS_BAK, creds), 2);
        }, () => {});
        return track(credsChain);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const result = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await withRetry(`baca ${type}-${id}`, () => readData(`${type}-${id}`), 2);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            result[id] = value;
                        })
                    );
                    return result;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(key, value) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds,
        flush,
        // Buang sesi untuk sessionId ini. Barisnya disalin dulu ke session_id
        // cadangan — kalau ternyata logout-nya palsu, sesinya masih bisa dipulihkan
        // dengan menyalin balik baris-baris itu.
        clear: async () => {
            await flush();
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
            const bakId = `${sessionId}__bak_${stamp}`;
            try {
                const { data, error } = await supabase
                    .from(TABLE).select('key,data').eq('session_id', sessionId);
                if (error) throw error;
                if (data?.length) {
                    const rows = data.map((r) => ({ session_id: bakId, key: r.key, data: r.data, updated_at: new Date().toISOString() }));
                    for (let i = 0; i < rows.length; i += 500) {
                        const { error: e2 } = await supabase.from(TABLE).upsert(rows.slice(i, i + 500), { onConflict: 'session_id,key' });
                        if (e2) throw e2;
                    }
                    console.warn(`[auth] Sesi lama disalin ke session_id "${bakId}" sebelum dihapus.`);
                }
            } catch (e) {
                console.error('[auth] Gagal cadangkan sesi ke Supabase:', e.message);
            }
            const { error } = await supabase.from(TABLE).delete().eq('session_id', sessionId);
            if (error) throw error;
        },
    };
}

module.exports = { useSupabaseAuthState };
