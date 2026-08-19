// Penyimpan sesi WhatsApp berbasis file — pengganti useMultiFileAuthState bawaan
// Baileys. Bentuk folder & nama filenya SAMA PERSIS (`${type}-${id}.json`), jadi
// sesi yang sudah ada tetap kepakai tanpa scan ulang.
//
// Kenapa tidak pakai bawaan Baileys? Bawaannya menulis dengan writeFile biasa:
// kalau proses mati di tengah tulis (pm2 restart, SIGTERM, VPS reboot),
// creds.json tinggal separuh → JSON.parse gagal → Baileys DIAM-DIAM mengira ini
// instalasi baru (initAuthCreds) → perangkat "keluar" dan minta scan QR lagi.
// Persis keluhan yang bikin file ini ada.
//
// Tiga pengaman di sini:
//   1. Tulis atomik: tulis ke .tmp → fsync → rename. Rename itu atomik di ext4,
//      jadi creds.json tidak pernah dalam keadaan separuh.
//   2. Cadangan: setiap creds.json yang sukses ditulis disalin ke creds.bak.json.
//      Kalau yang utama rusak, sesi dipulihkan dari cadangan — bukan direset.
//   3. Cache memori: folder sesi bisa berisi puluhan ribu file (lid-mapping),
//      dan tiap dekripsi pesan membaca beberapa di antaranya. Tanpa cache, I/O
//      itu jadi lambat, operasi signal telat, pesan gagal didekripsi.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

const fixFileName = (file) => String(file).replace(/\//g, '__').replace(/:/g, '-');

const CREDS = 'creds.json';
const CREDS_BAK = 'creds.bak.json';

async function useFileAuthState(folder, opts = {}) {
    const cacheMax = Number(opts.cacheMax || process.env.AUTH_CACHE_MAX || 4000);
    const keepBackups = Number(opts.keepBackups || process.env.AUTH_KEEP_BACKUPS || 3);

    // 0700: isi folder ini adalah kunci Signal dan creds WhatsApp. Bisa dibaca
    // berarti sesi bisa dibajak tanpa menyentuh HP siapa pun, jadi jangan pernah
    // mengandalkan izin bawaan (0755) yang membuatnya terbuka untuk semua akun
    // di server.
    await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(folder, 0o700); } catch (_) { /* folder lama milik proses lain */ }

    // ── Antrean tulis per-file ────────────────────────────────────────────────
    // Dua penulisan ke file yang sama tidak boleh saling menyalip (creds ditulis
    // berkali-kali per detik saat sinkronisasi awal). Rantai promise per file.
    const chains = new Map();
    const inflight = new Set();
    function enqueue(file, job) {
        const prev = chains.get(file) || Promise.resolve();
        const next = prev.then(job, job);
        chains.set(file, next);
        const tracked = next.catch(() => {}).finally(() => {
            inflight.delete(tracked);
            // Rantai yang sudah selesai dilepas supaya Map-nya tidak tumbuh
            // seukuran jumlah file sesi (bisa puluhan ribu).
            if (chains.get(file) === next) chains.delete(file);
        });
        inflight.add(tracked);
        return tracked;
    }

    // Cache baca. Nilai null pun disimpan (miss ikut di-cache) supaya file yang
    // memang tidak ada tidak ditanyakan ke disk berulang-ulang.
    const cache = new Map();
    function cacheSet(file, value) {
        if (cache.has(file)) cache.delete(file);
        cache.set(file, value);
        while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
    }

    async function writeAtomic(file, data, { sync = false } = {}) {
        const target = path.join(folder, fixFileName(file));
        const tmp = `${target}.tmp${process.pid}`;
        const json = JSON.stringify(data, BufferJSON.replacer);
        const fh = await fsp.open(tmp, 'w', 0o600);   // sama alasannya dengan 0700 di folder
        try {
            await fh.writeFile(json, 'utf-8');
            if (sync) await fh.sync();   // creds saja: pastikan benar-benar mendarat di disk
        } finally {
            await fh.close();
        }
        await fsp.rename(tmp, target);
        return json;
    }

    async function readRaw(file) {
        try {
            const raw = await fsp.readFile(path.join(folder, fixFileName(file)), 'utf-8');
            return JSON.parse(raw, BufferJSON.reviver);
        } catch (e) {
            if (e.code === 'ENOENT') return null;
            // Bedakan "tidak ada" (wajar) dari "rusak" (harus kelihatan di log).
            console.error(`[auth] File sesi rusak/tak terbaca: ${file} — ${e.message}`);
            return undefined;
        }
    }

    async function readData(file) {
        if (cache.has(file)) return cache.get(file);
        const val = await readRaw(file);
        const safe = val === undefined ? null : val;
        cacheSet(file, safe);
        return safe;
    }

    function writeData(file, value) {
        cacheSet(file, value);
        return enqueue(file, async () => {
            try {
                await writeAtomic(file, value);
            } catch (e) {
                console.error(`[auth] Gagal simpan ${file}: ${e.message}`);
            }
        });
    }

    function removeData(file) {
        cacheSet(file, null);
        return enqueue(file, async () => {
            try { await fsp.unlink(path.join(folder, fixFileName(file))); }
            catch (e) { if (e.code !== 'ENOENT') console.error(`[auth] Gagal hapus ${file}: ${e.message}`); }
        });
    }

    // ── Pemetaan LID: satu berkas, bukan dua puluh ribu ───────────────────────
    // WhatsApp memakai LID (id internal) berdampingan dengan nomor telepon, dan
    // Baileys menyimpan tiap pasangannya lewat keys.set seperti kunci sesi biasa.
    // Satu file per pasangan berarti 22.896 berkas @ ~14 byte — 0,3 MB data yang
    // memakan 96 MB disk (tiap file tetap mengunci satu blok 4 KB), dan setiap
    // sinkron kontak menjadi puluhan ribu tulis-atomik (open+write+rename) yang
    // berebut disk persis saat handshake WhatsApp sedang dikejar tenggat.
    //
    // Pemetaan ini beda sifat dari kunci Signal: nilainya kecil, jumlahnya banyak,
    // dan kehilangan satu tidak merusak sesi (paling-paling dipetakan ulang). Jadi
    // ia disimpan sebagai SATU objek di memori, ditulis ke satu berkas dengan jeda
    // — bukan per pasangan. Kuncinya memakai fixFileName supaya id yang mengandung
    // karakter berkas tetap cocok dengan hasil migrasi dari format lama.
    const LID_TYPE = 'lid-mapping';
    const LID_FILE = 'lid-mapping.json';
    const LID_WRITE_DELAY_MS = Number(opts.lidWriteDelayMs || process.env.AUTH_LID_WRITE_DELAY_MS || 3000);
    let lidMap = new Map();
    let lidDirty = false;
    let lidTimer = null;

    function lidWrite() {
        if (lidTimer) { clearTimeout(lidTimer); lidTimer = null; }
        if (!lidDirty) return Promise.resolve();
        lidDirty = false;
        const snapshot = Object.fromEntries(lidMap);
        return enqueue(LID_FILE, async () => {
            try { await writeAtomic(LID_FILE, snapshot); }
            catch (e) { lidDirty = true; console.error(`[auth] Gagal simpan ${LID_FILE}: ${e.message}`); }
        });
    }
    function lidTouch() {
        lidDirty = true;
        if (lidTimer) return;
        lidTimer = setTimeout(() => { lidTimer = null; lidWrite(); }, LID_WRITE_DELAY_MS);
        if (lidTimer.unref) lidTimer.unref();
    }

    // Migrasi sekali jalan dari format lama. Berkas lama baru dihapus SETELAH
    // berkas gabungan mendarat — kalau proses mati di tengah migrasi, yang hilang
    // cuma pekerjaan, bukan pemetaannya.
    async function lidLoad() {
        const gabungan = await readRaw(LID_FILE);
        if (gabungan && typeof gabungan === 'object') lidMap = new Map(Object.entries(gabungan));
        let lama = [];
        try {
            lama = (await fsp.readdir(folder))
                .filter((n) => n.startsWith(`${LID_TYPE}-`) && n.endsWith('.json'));
        } catch (_) { return; }
        if (!lama.length) return;
        for (const nama of lama) {
            const kunci = nama.slice(LID_TYPE.length + 1, -'.json'.length);
            if (lidMap.has(kunci)) continue;
            const nilai = await readRaw(nama);
            if (nilai !== null && nilai !== undefined) lidMap.set(kunci, nilai);
        }
        lidDirty = true;
        await lidWrite();
        let terhapus = 0;
        for (const nama of lama) {
            try { await fsp.unlink(path.join(folder, nama)); terhapus++; } catch (_) {}
        }
        console.warn(`[auth] ${terhapus} berkas ${LID_TYPE} lama disatukan ke ${LID_FILE} `
            + `(${lidMap.size} pemetaan).`);
    }
    await lidLoad();

    // ── Muat creds, dengan pemulihan dari cadangan ────────────────────────────
    let creds = await readRaw(CREDS);
    if (creds === undefined || creds === null) {
        const bak = await readRaw(CREDS_BAK);
        if (bak) {
            creds = bak;
            console.warn('[auth] creds.json hilang/rusak — sesi DIPULIHKAN dari creds.bak.json. '
                + 'Tidak perlu scan ulang.');
            try { await writeAtomic(CREDS, creds, { sync: true }); } catch (_) {}
        }
    }
    if (!creds) {
        creds = initAuthCreds();
        console.warn('[auth] Tidak ada creds tersimpan — sesi BARU dibuat, bot akan meminta scan QR.');
    }

    // creds ditulis paling sering dan paling mahal kalau hilang: fsync + cadangan.
    function saveCreds() {
        return enqueue(CREDS, async () => {
            try {
                const json = await writeAtomic(CREDS, creds, { sync: true });
                // Cadangan ditulis dari isi yang BARU SAJA sukses, bukan hasil baca
                // ulang — kalau yang utama rusak setelah ini, cadangannya tetap sah.
                await fsp.writeFile(path.join(folder, CREDS_BAK), json, { encoding: 'utf-8', mode: 0o600 });
            } catch (e) {
                console.error(`[auth] Gagal simpan creds: ${e.message}`);
            }
        });
    }

    // Tunggu semua tulisan yang masih di udara. Dipanggil sebelum proses keluar —
    // tanpa ini, pm2 restart bisa memotong penulisan creds terakhir.
    async function flush() {
        await lidWrite();
        while (inflight.size) {
            await Promise.allSettled([...inflight]);
        }
    }

    // Buang sesi: folder di-RENAME jadi cadangan, bukan dihapus. Menghapus 20 ribu
    // file butuh detik-detik dan bisa balapan dengan socket baru yang sudah mulai
    // menulis creds; rename itu instan dan menyisakan jalan pulang kalau ternyata
    // logout-nya palsu.
    async function clear() {
        await flush();
        cache.clear();
        lidMap = new Map();
        lidDirty = false;
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
        const backup = `${folder}.bak-${stamp}`;
        try {
            await fsp.rename(folder, backup);
            console.warn(`[auth] Sesi lama dipindah ke ${path.basename(backup)} (bukan dihapus).`);
        } catch (e) {
            if (e.code !== 'ENOENT') console.error(`[auth] Gagal cadangkan sesi: ${e.message}`);
        }
        await fsp.mkdir(folder, { recursive: true });
        pruneBackups().catch(() => {});
    }

    async function pruneBackups() {
        const parent = path.dirname(path.resolve(folder));
        const base = path.basename(path.resolve(folder)) + '.bak-';
        const entries = (await fsp.readdir(parent)).filter((n) => n.startsWith(base)).sort();
        for (const old of entries.slice(0, Math.max(0, entries.length - keepBackups))) {
            await fsp.rm(path.join(parent, old), { recursive: true, force: true }).catch(() => {});
        }
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    if (type === LID_TYPE) {
                        for (const id of ids) data[id] = lidMap.get(fixFileName(id)) ?? null;
                        return data;
                    }
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (category === LID_TYPE) {
                                const kunci = fixFileName(id);
                                if (value) lidMap.set(kunci, value); else lidMap.delete(kunci);
                                lidTouch();
                                continue;
                            }
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(file, value) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds,
        flush,
        clear,
    };
}

module.exports = { useFileAuthState };
