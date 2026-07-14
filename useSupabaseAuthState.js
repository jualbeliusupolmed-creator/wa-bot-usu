// Baileys auth-state adapter yang menyimpan sesi WhatsApp di Supabase (Postgres)
// alih-alih di filesystem. Ini membuat sesi tetap persisten di host tanpa disk
// permanen (mis. Render Free) — bot reconnect otomatis TANPA scan QR ulang.
//
// Interface-nya identik dengan useMultiFileAuthState: mengembalikan { state, saveCreds }
// plus tambahan clear() untuk menghapus sesi (dipakai saat logout/reset).
//
// Skema tabel (lihat wa_auth.sql):
//   create table public.wa_auth (
//     session_id text, key text, data jsonb, updated_at timestamptz,
//     primary key (session_id, key)
//   );
// Diakses HANYA lewat service role key (RLS aktif tanpa policy = terkunci).

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

const TABLE = 'wa_auth';

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

    async function writeData(key, value) {
        const payload = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
        const { error } = await supabase
            .from(TABLE)
            .upsert(
                { session_id: sessionId, key, data: payload, updated_at: new Date().toISOString() },
                { onConflict: 'session_id,key' }
            );
        if (error) throw error;
    }

    async function removeData(key) {
        const { error } = await supabase
            .from(TABLE)
            .delete()
            .eq('session_id', sessionId)
            .eq('key', key);
        if (error) throw error;
    }

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const result = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
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
        saveCreds: () => writeData('creds', creds),
        // Hapus seluruh sesi untuk sessionId ini (dipakai saat logout / /reset)
        clear: async () => {
            const { error } = await supabase.from(TABLE).delete().eq('session_id', sessionId);
            if (error) throw error;
        },
    };
}

module.exports = { useSupabaseAuthState };
