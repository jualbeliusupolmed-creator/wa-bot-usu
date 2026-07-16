const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { useSupabaseAuthState } = require('./useSupabaseAuthState');

// Buffer untuk melacak console.log dan error (berguna untuk debugging)
const systemLogs = [];
const originalLog = console.log;
const originalError = console.error;
console.log = function(...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    systemLogs.push(`[${new Date().toISOString()}] [INFO] ${msg}`);
    if (systemLogs.length > 50) systemLogs.shift();
    originalLog.apply(console, args);
};
console.error = function(...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    systemLogs.push(`[${new Date().toISOString()}] [ERROR] ${msg}`);
    if (systemLogs.length > 50) systemLogs.shift();
    originalError.apply(console, args);
};

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://www.jualbeliusupolmed.web.id/api/wa/baileys';
const API_TOKEN = process.env.API_TOKEN || 'jualbeliusu_rahasia';
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '.'; // set ke mount path Volume/Disk kalau mau file persisten
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_info_baileys');
const MARKETPLACE_GROUP_JID = process.env.GROUP_JID || '';

// Sesi WhatsApp disimpan di Supabase kalau env tersedia (persisten tanpa disk,
// cocok untuk Render Free). Fallback ke filesystem (AUTH_DIR) kalau tidak diset.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WA_SESSION_ID = process.env.WA_SESSION_ID || 'default';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;
// Diisi di startBot(): menghapus sesi aktif (Supabase atau file) saat logout/reset.
let clearAuthState = async () => { try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {} };


const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let waSocket = null;
let currentQR = '';
let connectedPhone = '';
let connectedAt = null;
let reconnectAttempts = 0;
const messageQueue = [];

// ID pesan yang dikirim BOT sendiri (via sock.sendMessage). Dipakai untuk membedakan
// echo kiriman bot vs ketikan MANUAL owner dari HP/WA Web di event messages.upsert —
// keduanya sama-sama fromMe, tapi hanya ketikan manual yang jadi sinyal "owner turun
// tangan" (bot senyap otomatis). Tanpa pembeda ini, bot akan membisukan dirinya
// sendiri di setiap kontak yang ia balas.
const botSentIds = new Set();
const botSentIdQueue = [];
function rememberBotSent(result) {
    const id = result?.key?.id;
    if (!id) return;
    botSentIds.add(id);
    botSentIdQueue.push(id);
    if (botSentIdQueue.length > 2000) botSentIds.delete(botSentIdQueue.shift());
}

// Antrean pesan keluar. Dijadwal ulang secara rekursif dengan JEDA ACAK 1,5–4 dtk
// tiap habis mengirim, supaya ritme balasan tidak terlalu seragam seperti robot
// (jeda konstan justru terbaca otomatis oleh WhatsApp → risiko nomor di-flag).
// Saat antrean kosong, cek lagi lebih cepat (800 ms) agar balasan tetap responsif.
async function processQueue() {
    let sent = false;
    if (messageQueue.length > 0 && waSocket) {
        const task = messageQueue.shift();
        // Anti-burst: buang pesan yang sudah terlalu lama menunggu (mis. numpuk saat
        // bot offline). Kirim borongan pesan basi = pola spam → risiko blokir WA.
        if (task.ts && Date.now() - task.ts > 3 * 60 * 1000) {
            console.warn(`[Queue] Buang pesan basi (>3mnt) ke ${task.jid}`);
            setTimeout(processQueue, 100);
            return;
        }
        // Jangan kirim gelembung kosong (teks kosong tanpa gambar/poll) — pernah
        // muncul pesan kosong ke pelanggan.
        const hasContent = task.url || task.poll || (task.message && String(task.message).trim());
        if (!hasContent) {
            console.warn(`[Queue] Lewati pesan kosong ke ${task.jid}`);
        } else {
            try {
                await waSocket.presenceSubscribe(task.jid);
                await waSocket.sendPresenceUpdate('composing', task.jid);
                let sendResult;
                if (task.url) {
                    sendResult = await waSocket.sendMessage(task.jid, { image: { url: task.url }, caption: task.message });
                } else if (task.poll) {
                    sendResult = await waSocket.sendMessage(task.jid, { poll: task.poll });
                } else {
                    sendResult = await waSocket.sendMessage(task.jid, { text: task.message });
                }
                rememberBotSent(sendResult);
                console.log(`[Queue] Pesan terkirim ke ${task.jid}`);
                sent = true;
            } catch (err) {
                console.error(`[Queue] Gagal kirim ke ${task.jid}:`, err.message);
            }
        }
    }
    const nextDelay = sent ? 1500 + Math.floor(Math.random() * 2500) : 800;
    setTimeout(processQueue, nextDelay);
}
setTimeout(processQueue, 800);

const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

function loadMapFromFile(filePath) {
    if (fs.existsSync(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return new Map(Object.entries(data));
        } catch (_) {}
    }
    return new Map();
}

function saveMapToFile(mapData, filePath) {
    try { fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(mapData))); } catch (_) {}
}

let contactMap = loadMapFromFile(CONTACTS_FILE);
let chatMap = loadMapFromFile(CHATS_FILE);
let isStateDirty = false;

setInterval(() => {
    if (isStateDirty) {
        saveMapToFile(contactMap, CONTACTS_FILE);
        saveMapToFile(chatMap, CHATS_FILE);
        isStateDirty = false;
    }
}, 10000);

let messageLog = []; // in-memory log (max 100 entries)
let conversationContext = new Map(); // jid → [{ role, text, time }] max 5 entries, expire 30 min
let photoBuffer = new Map();         // jid → { images:[{buf,mime}], caption:string, timer }
// Map @lid JID → phone JID (@s.whatsapp.net) agar nomor user konsisten
let lidMap = new Map();
// Set berukuran terbatas (FIFO) — cegah pertumbuhan memori tak terbatas pada bot
// yang uptime-nya panjang di VPS.
function boundedSet(cap) {
  const s = new Set();
  const q = [];
  const _add = s.add.bind(s);
  s.add = (v) => { if (!s.has(v)) { q.push(v); if (q.length > cap) s.delete(q.shift()); } return _add(v); };
  return s;
}
// Penanda @lid yang sudah pernah ditanya nama (agar tanya nama HANYA sekali, tak loop)
const askedNameOnce = boundedSet(5000);
// @lid yang mapping nomornya SUDAH dikirim ke website (untuk memicu migrasi data lama
// LID→nomor sekali saja per lifetime bot). Migrasi di sisi website tetap idempotent.
const migratedLids = boundedSet(5000);
// ID pesan yang sudah diproses — cegah dobel (Baileys kadang kirim event sama >1x)
const processedMsgIds = new Set();
// Map @lid JID → phone JID yang dikonfirmasi manual oleh user.
const LID_MAP_FILE = path.join(DATA_DIR, 'lid_resolution_map.json');
// Map phone/@lid JID → nama (dari registrasi manual @lid).
const NAME_MAP_FILE = path.join(DATA_DIR, 'name_map.json');

// State ini DISIMPAN DI SUPABASE kalau env tersedia (tabel wa_state), bukan di file
// lokal. Alasannya: host gratis seperti Render Free filesystem-nya sementara (kehapus
// tiap spin-down ~15 mnt idle). Kalau disimpan di file, nama user & resolusi @lid akan
// hilang tiap bot restart → user ditanya nama berulang. Fallback ke file lokal hanya
// kalau Supabase tidak diset (mis. saat dev lokal). Lihat wa_state.sql untuk skema tabel.
const STATE_TABLE = 'wa_state';
let nameMap = new Map();            // diisi di startBot() via loadState()
let lidResolutionMap = new Map();   // diisi di startBot() via loadState()
let stateLoaded = false;            // supaya tidak clobber map in-memory saat reconnect

async function loadState(key, fallbackFile) {
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from(STATE_TABLE)
                .select('data')
                .eq('session_id', WA_SESSION_ID)
                .eq('key', key)
                .maybeSingle();
            if (error) throw error;
            if (data?.data) return new Map(Object.entries(data.data));
        } catch (e) {
            console.error(`[state] Gagal muat ${key} dari Supabase:`, e.message);
        }
        return new Map();
    }
    return loadMapFromFile(fallbackFile);
}

async function saveState(key, mapData, fallbackFile) {
    if (supabase) {
        try {
            const { error } = await supabase.from(STATE_TABLE).upsert(
                { session_id: WA_SESSION_ID, key, data: Object.fromEntries(mapData), updated_at: new Date().toISOString() },
                { onConflict: 'session_id,key' }
            );
            if (error) throw error;
        } catch (e) {
            console.error(`[state] Gagal simpan ${key} ke Supabase:`, e.message);
        }
        return;
    }
    saveMapToFile(mapData, fallbackFile);
}

// Fire-and-forget: simpan tanpa memblokir alur pesan.
function saveLidResolutionMap() { saveState('lid_resolution_map', lidResolutionMap, LID_MAP_FILE).catch(() => {}); }
function saveNameMap() { saveState('name_map', nameMap, NAME_MAP_FILE).catch(() => {}); }

// Sekali per proses: pindai data lama ber-key LID di DB, "pelajari" nomornya lewat
// getPNForLID (query ke WhatsApp), simpan ke lid_resolution_map. Setelah ini, endpoint
// website /api/admin/migrate-lid?apply=1 bisa memindahkan datanya ke nomor 08.
let dbLidsResolvedOnce = false;
async function resolveDbLidsOnce(sock) {
    if (dbLidsResolvedOnce || !supabase) return;
    dbLidsResolvedOnce = true;
    try {
        const tables = [
            ['seller_profiles', 'wa'], ['listings', 'seller_wa'], ['wanted_listings', 'buyer_wa'],
            ['price_offers', 'buyer_wa'], ['seller_ratings', 'seller_wa'], ['category_subscriptions', 'buyer_wa'],
            ['group_posts', 'sender_wa'], ['profile_change_requests', 'seller_wa'],
        ];
        const lids = new Set();
        for (const [t, c] of tables) {
            const { data, error } = await supabase.from(t).select(c).not(c, 'like', '0%').limit(5000);
            if (error) continue;
            for (const r of data || []) {
                const v = r[c];
                if (!v) continue;
                const digits = String(v).split('@')[0].replace(/:\d+$/, '');
                // LID = 12–18 digit, tak diawali '0' (nomor HP valid selalu 08xxx)
                if (/^\d{12,18}$/.test(digits) && !digits.startsWith('0')) lids.add(digits);
            }
        }
        if (!lids.size) { console.log('[lid-db-resolve] Tak ada LID di DB.'); return; }
        let resolved = 0;
        for (const digits of lids) {
            const lidJid = digits + '@lid';
            if (lidResolutionMap.has(lidJid)) continue;
            try {
                const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
                if (pn && pn.endsWith('@s.whatsapp.net')) { lidResolutionMap.set(lidJid, pn); resolved++; }
            } catch { /* biarkan, coba LID berikutnya */ }
        }
        if (resolved) saveLidResolutionMap();
        console.log(`[lid-db-resolve] ${lids.size} LID di DB, ${resolved} dapat nomor → tersimpan. Sisa ${lids.size - resolved} belum ketahuan.`);
    } catch (e) { console.warn('[lid-db-resolve] error:', e.message); }
}

// Tambah entri context percakapan per-user
function addToContext(jid, role, text) {
    const now = Date.now();
    const EXPIRE_MS = 30 * 60 * 1000; // 30 menit
    let history = (conversationContext.get(jid) || [])
        .filter(e => now - e.time < EXPIRE_MS); // buang yang sudah expire
    history.push({ role, text: (text || '').slice(0, 300), time: now });
    if (history.length > 5) history = history.slice(-5);
    conversationContext.set(jid, history);
    return history;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.headers.authorization !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ── Health check (public, untuk Railway health check) ────────────────────────
app.get('/health', (req, res) => {
    const isConnected = !!(waSocket && !currentQR);
    // Endpoint publik — JANGAN bocorkan nomor telepon di sini.
    res.status(isConnected ? 200 : 503).json({
        ok: isConnected,
        uptime: Math.floor(process.uptime()),
    });
});

// ── QR Page (public) ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── QR JSON endpoint (untuk admin panel web) ─────────────────────────────────
app.get('/qr', requireAuth, async (req, res) => {
    if (!currentQR) return res.json({ qr: null, connected: true });
    try {
        const qrImage = await QRCode.toDataURL(currentQR, { width: 300 });
        res.json({ qr: qrImage, connected: false });
    } catch (err) {
        res.status(500).json({ error: 'Gagal generate QR' });
    }
});

// ── Status endpoint ───────────────────────────────────────────────────────────
app.get('/status', requireAuth, (req, res) => {
    // Konversi eksplisit ke boolean agar tidak pernah null/undefined
    const isConnected = !!(waSocket && connectedPhone && !currentQR);
    res.json({
        connected: isConnected,
        phone: connectedPhone || null,
        connectedAt: connectedAt || null,
        hasQR: !!currentQR,
        qr: currentQR, // Tambahkan raw QR string agar bisa di-debug jika perlu
        uptime: Math.floor(process.uptime()),
        webhookUrl: WEBHOOK_URL,
        queueLength: messageQueue.length,
    });
});

// ── Logs endpoint ─────────────────────────────────────────────────────────────
app.get('/logs', requireAuth, (req, res) => {
    res.json({ logs: systemLogs });
});

// ── Groups endpoint ───────────────────────────────────────────────────────────
app.get('/groups', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    try {
        const chats = await waSocket.groupFetchAllParticipating();
        const groups = Object.entries(chats).map(([jid, meta]) => ({
            jid,
            name: meta.subject || 'Tanpa Nama',
            participants: meta.participants?.length || 0,
            isAdmin: meta.participants?.some(p =>
                p.id === waSocket.user?.id && (p.admin === 'admin' || p.admin === 'superadmin')
            ) || false,
        }));
        res.json({ groups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Chats / Kontak endpoint ───────────────────────────────────────────────────
app.get('/chats', requireAuth, (req, res) => {
    // Tetap kembalikan data dari cache meski bot sedang reconnecting
    const list = Array.from(chatMap.values())
        .filter(c => c.jid.endsWith('@s.whatsapp.net') || c.jid.endsWith('@lid'))
        .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    res.json({ chats: list, connected: !!(waSocket && connectedPhone) });
});

// ── Messages endpoint (riwayat pesan per JID dari in-memory log) ──────────────
app.get('/messages', requireAuth, (req, res) => {
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ error: 'jid required' });
    // Filter log pesan berdasarkan sender (in-memory, max 100 entri)
    const msgs = messageLog
        .filter(m => m.sender === jid)
        .slice(0, 30)
        .map((m, i) => ({
            id: i,
            text: m.preview || '',
            fromMe: false,
            timestamp: m.time ? Math.floor(new Date(m.time).getTime() / 1000) : 0,
        }));
    res.json({ messages: msgs });
});

// ── Newsletters / Channels endpoint ──────────────────────────────────────────
const NEWSLETTER_FILE = path.join(DATA_DIR, 'newsletters.json');
function getSavedNewsletters() {
    if (fs.existsSync(NEWSLETTER_FILE)) {
        try { return JSON.parse(fs.readFileSync(NEWSLETTER_FILE, 'utf-8')); } catch(e) {}
    }
    return [];
}
function saveNewsletter(data) {
    const list = getSavedNewsletters();
    if (!list.find(n => n.jid === data.jid)) {
        list.push(data);
        fs.writeFileSync(NEWSLETTER_FILE, JSON.stringify(list));
    }
}

// ── Status WA Tracking ────────────────────────────────────────────────────────
const STATUS_FILE = path.join(DATA_DIR, 'statuses.json');
function getSavedStatuses() {
    if (fs.existsSync(STATUS_FILE)) {
        try {
            const list = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
            const now = Date.now();
            return list.filter(s => s.expiresAt > now); // Hanya yang belum expired (24h)
        } catch(e) {}
    }
    return [];
}
function saveStatus(data) {
    const list = getSavedStatuses();
    list.push(data);
    fs.writeFileSync(STATUS_FILE, JSON.stringify(list));
}

app.get('/newsletters', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    res.json({ newsletters: getSavedNewsletters() });
});

app.post('/newsletters/add', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const { invite } = req.body;
    if (!invite) return res.status(400).json({ error: 'Invite link required' });
    try {
        let code = invite;
        if (invite.includes('whatsapp.com/channel/')) {
            code = invite.split('whatsapp.com/channel/')[1].split('?')[0].split('/')[0];
        }
        const meta = await waSocket.newsletterMetadata('invite', code);
        if (!meta || !meta.id) throw new Error('Saluran tidak ditemukan atau bot tidak memiliki akses.');
        const data = {
            jid: meta.id,
            name: meta.name || 'Tanpa Nama',
            description: meta.description?.text || meta.description || '',
            subscribers: meta.subscribers || 0,
            addedAt: new Date().toISOString()
        };
        saveNewsletter(data);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Logs endpoint ─────────────────────────────────────────────────────────────
app.get('/logs', requireAuth, (req, res) => {
    res.json({ logs: messageLog });
});

// ── Restart endpoint ──────────────────────────────────────────────────────────
app.post('/restart', requireAuth, (req, res) => {
    res.json({ ok: true, message: 'Bot akan restart dalam 1 detik...' });
    setTimeout(() => process.exit(1), 1000);
});

// ── Reset / Hapus sesi ────────────────────────────────────────────────────────
app.get('/reset', requireAuth, async (req, res) => {
    try { await clearAuthState(); } catch (e) { console.error('[reset] gagal hapus sesi:', e); }
    res.send('Sesi dihapus. Restarting...');
    setTimeout(() => process.exit(1), 1000);
});

app.post('/reset', requireAuth, async (req, res) => {
    try { await clearAuthState(); } catch (e) { console.error('[reset] gagal hapus sesi:', e); }
    res.json({ ok: true, message: 'Sesi dihapus. Bot akan restart...' });
    setTimeout(() => process.exit(1), 1000);
});

// ── Pairing Code endpoint ─────────────────────────────────────────────────────
app.post('/pairing-code', requireAuth, async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: 'Nomor HP wajib diisi' });
        
        if (!waSocket) return res.status(503).json({ error: 'Bot sedang tidak aktif/terhubung' });
        
        if (waSocket.authState.creds.registered || connectedPhone) {
            return res.status(400).json({ error: 'Bot sudah login dan terdaftar' });
        }
        
        // Bersihkan nomor (hilangkan +, spasi, -) dan ganti awalan 0 menjadi 62
        let cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
        
        // Request kode pairing ke Baileys
        let code = await waSocket.requestPairingCode(cleanPhone);
        
        // Format kode agar lebih mudah dibaca, misalnya: "ABCD-EFGH"
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        
        res.json({ ok: true, code });
    } catch (e) {
        console.error('Error request pairing code:', e);
        res.status(500).json({ error: e.message || 'Gagal meminta kode pairing' });
    }
});

// ── Send message endpoint ─────────────────────────────────────────────────────
app.post('/send', requireAuth, async (req, res) => {
    const { target, message, url } = req.body;
    if (!target) return res.status(400).json({ error: 'Target required' });

    let jid = String(target);
    if (!jid.includes('@')) {
        let num = jid.replace(/[^0-9]/g, '');
        if (num.startsWith('0')) num = '62' + num.substring(1);
        jid = num + '@s.whatsapp.net';
    }

    // Cap antrean: kalau menumpuk (bot lama offline), tolak daripada burst nanti.
    if (messageQueue.length > 200) {
        return res.status(503).json({ error: 'Antrean penuh, bot sedang tidak stabil' });
    }
    messageQueue.push({ jid, message, url, ts: Date.now() });
    res.json({ status: true, detail: 'Pesan ditambahkan ke antrean (Queue)' });
});

// ── Profile Bot endpoint ──────────────────────────────────────────────────────
app.get('/profile', requireAuth, (req, res) => {
    res.json({
        name: waSocket?.user?.name || '',
        jid: waSocket?.user?.id || '',
        phone: connectedPhone || '',
    });
});

app.post('/profile/name', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    try {
        await waSocket.updateProfileName(name.trim());
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/profile/status', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const { status } = req.body;
    if (status === undefined) return res.status(400).json({ error: 'status required' });
    try {
        await waSocket.updateProfileStatus(status);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LID Resolution Map endpoint ───────────────────────────────────────────────
app.get('/lid-map', requireAuth, (req, res) => {
    const entries = Array.from(lidResolutionMap.entries())
        .map(([lid, phone]) => ({ lid, phone }));
    res.json({ entries, count: entries.length });
});

app.delete('/lid-map', requireAuth, (req, res) => {
    const { lid } = req.body;
    if (!lid) return res.status(400).json({ error: 'lid required' });
    const deleted = lidResolutionMap.delete(lid);
    if (deleted) saveLidResolutionMap();
    res.json({ ok: deleted });
});

// ── Conversation Context endpoint ─────────────────────────────────────────────
app.get('/context', requireAuth, (req, res) => {
    const now = Date.now();
    const entries = Array.from(conversationContext.entries()).map(([jid, history]) => ({
        jid,
        messages: history.length,
        lastTime: history[history.length - 1]?.time || 0,
        lastText: history[history.length - 1]?.text?.slice(0, 80) || '',
        lastRole: history[history.length - 1]?.role || '',
        history,
    }));
    res.json({ entries: entries.sort((a, b) => b.lastTime - a.lastTime), count: entries.length, now });
});

app.delete('/context', requireAuth, (req, res) => {
    const { jid } = req.body;
    if (jid) {
        conversationContext.delete(jid);
    } else {
        conversationContext.clear();
    }
    res.json({ ok: true });
});

// ── Blocklist endpoint ────────────────────────────────────────────────────────
app.get('/blocklist', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    try {
        const list = await waSocket.fetchBlocklist();
        res.json({ blocklist: list || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/blocklist/block', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const { jid } = req.body;
    if (!jid) return res.status(400).json({ error: 'jid required' });
    try {
        await waSocket.updateBlockStatus(jid, 'block');
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/blocklist/unblock', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const { jid } = req.body;
    if (!jid) return res.status(400).json({ error: 'jid required' });
    try {
        await waSocket.updateBlockStatus(jid, 'unblock');
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── WA Story / Status endpoint ────────────────────────────────────────────────
app.get('/story', requireAuth, (req, res) => {
    res.json({ statuses: getSavedStatuses() });
});

app.post('/story', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const { text, url } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text required' });
    try {
        const jidsSet = new Set([...chatMap.keys(), ...contactMap.keys()]);
        if (connectedPhone) jidsSet.add(connectedPhone + '@s.whatsapp.net');
        const jids = Array.from(jidsSet).filter(jid => jid.endsWith('@s.whatsapp.net'));
            
        let result;
        if (url) {
            const imgRes = await fetch(url);
            const buf = Buffer.from(await imgRes.arrayBuffer());
            result = await waSocket.sendMessage('status@broadcast', { image: buf, caption: text }, { statusJidList: jids });
        } else {
            result = await waSocket.sendMessage('status@broadcast', { text, backgroundColor: '#075E54', font: 3 }, { statusJidList: jids });
        }
        
        const now = Date.now();
        saveStatus({
            id: result?.key?.id || now.toString(),
            type: url ? 'image' : 'text',
            text,
            url,
            timestamp: now,
            expiresAt: now + 24 * 60 * 60 * 1000
        });
        
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Group management endpoints ────────────────────────────────────────────────
app.get('/groups/:jid/invite', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const jid = decodeURIComponent(req.params.jid);
    try {
        const code = await waSocket.groupInviteCode(jid);
        res.json({ ok: true, link: `https://chat.whatsapp.com/${code}`, code });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/groups/create', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const { name, participants } = req.body;
    if (!name?.trim() || !participants?.length) return res.status(400).json({ error: 'name and participants required' });
    try {
        const jids = participants.map(p => {
            let num = String(p).replace(/[^0-9]/g, '');
            if (num.startsWith('0')) num = '62' + num.slice(1);
            return num + '@s.whatsapp.net';
        });
        const result = await waSocket.groupCreate(name.trim(), jids);
        res.json({ ok: true, jid: result.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/groups/:jid/participants', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const jid = decodeURIComponent(req.params.jid);
    const { action, participants } = req.body;
    if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
        return res.status(400).json({ error: 'action: add/remove/promote/demote' });
    }
    try {
        const jids = participants.map(p => {
            let num = String(p).replace(/[^0-9]/g, '');
            if (num.startsWith('0')) num = '62' + num.slice(1);
            return num + '@s.whatsapp.net';
        });
        const result = await waSocket.groupParticipantsUpdate(jid, jids, action);
        res.json({ ok: true, result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Send Poll endpoint ────────────────────────────────────────────────────────
app.post('/send-poll', requireAuth, async (req, res) => {
    const { target, name, options } = req.body;
    if (!target || !name?.trim() || !options?.length) {
        return res.status(400).json({ error: 'target, name, options required' });
    }
    
    let jid = String(target);
    if (!jid.includes('@')) {
        let num = jid.replace(/[^0-9]/g, '');
        if (num.startsWith('0')) num = '62' + num.slice(1);
        jid = num + '@s.whatsapp.net';
    }
    
    // Cap antrean sama seperti /send: cegah burst (pola spam → risiko blokir WA).
    if (messageQueue.length > 200) {
        return res.status(503).json({ error: 'Antrean penuh, bot sedang tidak stabil' });
    }
    messageQueue.push({ jid, poll: { name: name.trim(), values: options, selectableCount: 1 }, ts: Date.now() });
    res.json({ ok: true, detail: 'Poll ditambahkan ke antrean' });
});

// ── Ekstrak isi pesan — skip metadata wrapper (messageContextInfo, dll) ───────
function extractMessage(rawMessage) {
    if (!rawMessage) return { type: '', content: null, rawForMedia: rawMessage };

    // Unwrap ephemeral / view-once
    const inner = rawMessage.ephemeralMessage?.message
        || rawMessage.viewOnceMessage?.message
        || rawMessage.viewOnceMessageV2?.message?.viewOnceMessage?.message
        || rawMessage;

    const META_KEYS = new Set([
        'messageContextInfo',
        'senderKeyDistributionMessage',
        'deviceSentMessage',
    ]);

    const type = Object.keys(inner).find(k => !META_KEYS.has(k)) || '';
    return { type, content: inner[type], rawForMedia: rawMessage };
}

// ── Bot core ──────────────────────────────────────────────────────────────────
async function startBot() {
    let state, saveCreds;
    if (supabase) {
        const authState = await useSupabaseAuthState(supabase, WA_SESSION_ID);
        state = authState.state;
        saveCreds = authState.saveCreds;
        clearAuthState = authState.clear;
        console.log(`[auth] Sesi WhatsApp dimuat dari Supabase (session_id=${WA_SESSION_ID}).`);
    } else {
        const authState = await useMultiFileAuthState(AUTH_DIR);
        state = authState.state;
        saveCreds = authState.saveCreds;
        clearAuthState = async () => { try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {} };
        console.log(`[auth] Sesi WhatsApp dimuat dari filesystem (${AUTH_DIR}).`);
    }

    // Muat nama user & resolusi @lid SEKALI saja (jangan clobber map in-memory saat
    // reconnect). Dari Supabase kalau ada, else file lokal.
    if (!stateLoaded) {
        nameMap = await loadState('name_map', NAME_MAP_FILE);
        lidResolutionMap = await loadState('lid_resolution_map', LID_MAP_FILE);
        stateLoaded = true;
        console.log(`[state] Dimuat: ${nameMap.size} nama, ${lidResolutionMap.size} resolusi @lid`);

        // Bersihkan nama sampah warisan versi lama (alur tangkap-nama dulu menyimpan
        // kata biasa/kalimat utuh sebagai nama: "min", "Ntar saya kabari...", "Iya").
        // Nama buruk bikin bot menyapa "Haii min!" / "Haii Ntar!" ke pelanggan asli.
        const NAME_JUNK = new Set([
            'min', 'mimin', 'admin', 'bang', 'bg', 'kak', 'ka', 'dek', 'mas', 'mbak', 'pak', 'bu',
            'bro', 'sis', 'cuy', 'iya', 'ya', 'yaw', 'ok', 'oke', 'okey', 'okay', 'sip', 'siap',
            'gas', 'woi', 'woy', 'wey', 'halo', 'hai', 'haii', 'hallo', 'hello', 'ntar', 'nanti',
            'tar', 'besok', 'test', 'tes', 'info', 'misi', 'permisi', 'p', 'pagi', 'siang', 'sore', 'malam',
        ]);
        let junkRemoved = 0;
        for (const [jid, nm] of nameMap) {
            const clean = String(nm || '').trim();
            const firstWord = (clean.split(/\s+/)[0] || '').toLowerCase();
            // Buang kalau: kata sapaan umum, terlalu pendek, atau "nama" >4 kata (kalimat).
            if (!clean || clean.length < 2 || NAME_JUNK.has(firstWord) || clean.split(/\s+/).length > 4) {
                nameMap.delete(jid);
                junkRemoved++;
            }
        }
        if (junkRemoved) {
            saveNameMap();
            console.log(`[state] ${junkRemoved} nama sampah dibersihkan dari name_map`);
        }
    }

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Mac OS', 'Chrome', '121.0.0.0']
    });
    waSocket = sock;
    sock.ev.on('creds.update', saveCreds);

    // Bangun daftar kontak & chat dari event Baileys (pengganti makeInMemoryStore)
    sock.ev.on('contacts.upsert', (contacts) => {
        let changed = false;
        for (const c of contacts) {
            if (!c.id) continue;
            contactMap.set(c.id, { jid: c.id, name: c.name || c.notify || c.verifiedName || '' });
            isStateDirty = true;
            if (c.lid && c.id.endsWith('@s.whatsapp.net')) {
                lidMap.set(c.lid, c.id);
                if (!lidResolutionMap.has(c.lid)) { lidResolutionMap.set(c.lid, c.id); changed = true; }
            }
            if (c.id.endsWith('@lid') && c.jid && c.jid.endsWith('@s.whatsapp.net')) {
                lidMap.set(c.id, c.jid);
                if (!lidResolutionMap.has(c.id)) { lidResolutionMap.set(c.id, c.jid); changed = true; }
            }
        }
        if (changed) saveLidResolutionMap();
    });
    sock.ev.on('contacts.update', (updates) => {
        let changed = false;
        for (const u of updates) {
            if (!u.id) continue;
            const existing = contactMap.get(u.id) || { jid: u.id, name: '' };
            contactMap.set(u.id, { ...existing, name: u.name || u.notify || u.verifiedName || existing.name });
            isStateDirty = true;
            if (u.lid && u.id.endsWith('@s.whatsapp.net')) {
                lidMap.set(u.lid, u.id);
                if (!lidResolutionMap.has(u.lid)) { lidResolutionMap.set(u.lid, u.id); changed = true; }
            }
        }
        if (changed) saveLidResolutionMap();
    });
    sock.ev.on('chats.upsert', (chats) => {
        for (const c of chats) {
            if (!c.id) continue;
            const contact = contactMap.get(c.id);
            chatMap.set(c.id, {
                jid: c.id,
                name: contact?.name || c.name || '',
                lastTime: c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : Date.now(),
                preview: '',
            });
            isStateDirty = true;
        }
    });
    sock.ev.on('chats.update', (updates) => {
        for (const u of updates) {
            if (!u.id) continue;
            const existing = chatMap.get(u.id) || { jid: u.id, name: '', lastTime: 0, preview: '' };
            chatMap.set(u.id, {
                ...existing,
                lastTime: u.conversationTimestamp ? Number(u.conversationTimestamp) * 1000 : existing.lastTime,
            });
            isStateDirty = true;
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) currentQR = qr;
        if (connection === 'close') {
            connectedPhone = '';
            connectedAt = null;
            waSocket = null;
            // Bersihkan timer photoBuffer agar tidak leak saat reconnect
            for (const entry of photoBuffer.values()) {
                if (entry.timer) clearTimeout(entry.timer);
            }
            photoBuffer.clear();
            conversationContext.clear();
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            // PENTING: HANYA 401 (loggedOut) yang boleh menghapus sesi. Kode lain
            // (428 gangguan sementara, 515 restartRequired yang NORMAL) cukup sambung
            // ulang dgn creds yang sama. Menghapus sesi → QR scan ulang berulang =
            // sinyal mencurigakan ke WhatsApp → risiko nomor diblokir.
            if (statusCode === 401) {
                console.log('[reconnect] Sesi WA logout (401). Menghapus sesi, akan tampilkan QR...');
                clearAuthState().then(() => console.log('[reconnect] Hapus sesi sukses.')).catch((e) => console.error('[reconnect] Gagal hapus sesi:', e));
                reconnectAttempts = 0;
                setTimeout(() => startBot(), 3000);
            } else if (statusCode === 515) {
                // restartRequired — normal (mis. tepat setelah pairing). Sambung ulang cepat.
                console.log('[reconnect] restartRequired (515). Sambung ulang tanpa hapus sesi...');
                reconnectAttempts = 0;
                setTimeout(() => startBot(), 2000);
            } else {
                // 428 & lainnya = gangguan sementara. Sambung ulang backoff, JANGAN hapus sesi.
                reconnectAttempts++;
                const backoff = Math.min(3000 * Math.pow(1.8, reconnectAttempts - 1), 60000);
                console.log(`[reconnect] Koneksi terputus (kode: ${statusCode ?? 'unknown'}). Reconnect ke-${reconnectAttempts} dalam ${Math.round(backoff/1000)}s...`);
                setTimeout(() => startBot(), backoff);
            }
        } else if (connection === 'open') {
            currentQR = '';
            connectedPhone = sock.user?.id?.split(':')[0] || '';
            connectedAt = new Date().toISOString();
            reconnectAttempts = 0;
            console.log('[bot] Berhasil terhubung ke WhatsApp! Nomor:', connectedPhone);
            // Bersihkan sisa data lama ber-key LID: pelajari nomornya lalu simpan (sekali saja,
            // beri jeda agar sinkron kontak/LID sempat jalan). Migrasi tabelnya oleh endpoint website.
            setTimeout(() => resolveDbLidsOnce(sock), 20000);
        } else if (connection === 'connecting') {
            console.log('[bot] Sedang menghubungkan ke WhatsApp...');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;
            const sender = msg.key.remoteJid;

            // ── Anti-dobel: skip kalau ID pesan ini sudah pernah diproses ──
            if (msg.key.id) {
                if (processedMsgIds.has(msg.key.id)) continue;
                processedMsgIds.add(msg.key.id);
                if (processedMsgIds.size > 800) processedMsgIds.delete(processedMsgIds.values().next().value);
            }

            // ── Centang biru: tandai pesan dibaca (biar terasa dilihat, bukan bot instan) ──
            if (!msg.key.fromMe && sender && sender !== 'status@broadcast' && !sender.includes('@newsletter')) {
                sock.readMessages([msg.key]).catch(() => {});
            }

            // ── Tangkap Status WA dari HP Sendiri (Manual Post) ──
            if (sender === 'status@broadcast') {
                const isMyStatus = msg.key.fromMe || (msg.key.participant && msg.key.participant === connectedPhone + '@s.whatsapp.net');
                if (isMyStatus) {
                    try {
                        const { type: msgType, content: msgContent, rawForMedia } = extractMessage(msg.message);
                        const isVideo = msgType === 'videoMessage';
                        const isImage = msgType === 'imageMessage';
                        const text = msgType === 'extendedTextMessage' ? msgContent?.text || '' : msgContent?.caption || '';
                        
                        let url = null;
                        if (isImage) {
                            try {
                                const buf = await downloadMediaMessage({ ...msg, message: rawForMedia }, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                                url = 'data:image/jpeg;base64,' + buf.toString('base64');
                            } catch (e) { console.error('[status] Gagal download gambar status manual:', e.message); }
                        }

                        const typeLabel = isImage ? 'image' : isVideo ? 'video' : 'text';
                        const now = Date.now();
                        saveStatus({
                            id: msg.key.id,
                            type: typeLabel,
                            text: text,
                            url: url,
                            timestamp: now,
                            expiresAt: now + 24 * 60 * 60 * 1000
                        });
                    } catch(e) { console.error('[status] Error:', e.message); }
                }
                continue; // Jangan proses status orang lain atau diri sendiri sebagai chat biasa
            }

            // if (msg.key.fromMe) continue; // Allow fromMe for admin takeover
            if (!sender || sender === 'status@broadcast' || sender.includes('@newsletter')) continue;

            // ── Pesan dari grup marketplace → kirim ke webhook untuk diindeks ──
            if (sender.includes('@g.us')) {
                if (!MARKETPLACE_GROUP_JID || sender !== MARKETPLACE_GROUP_JID) continue;
                try {
                    const { type: msgType, content: msgContent, rawForMedia: rawFM } = extractMessage(msg.message);
                    const text = msgType === 'conversation' ? msgContent
                        : msgType === 'extendedTextMessage' ? msgContent?.text || ''
                        : msgContent?.caption || '';
                    if (!text && msgType !== 'imageMessage') continue; // skip stiker/audio grup

                    let buf = null, mime = '', fname = '';
                    if (msgType === 'imageMessage') {
                        mime = msgContent?.mimetype || 'image/jpeg'; fname = 'image.jpg';
                        buf = await downloadMediaMessage({ ...msg, message: rawFM }, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                    }

                    const rawParticipant = (msg.key.participant || sender).replace(/:(\d+)(?=@)/, '');
                    let senderInGroup = rawParticipant;
                    if (rawParticipant.endsWith('@lid')) {
                        const pAlt = (msg.key.participantAlt || '').endsWith('@s.whatsapp.net') ? msg.key.participantAlt : null;
                        senderInGroup = pAlt || lidMap.get(rawParticipant) || lidResolutionMap.get(rawParticipant) || null;
                        if (!senderInGroup) {
                            try {
                                const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(rawParticipant);
                                senderInGroup = (pn && pn.endsWith('@s.whatsapp.net')) ? pn : rawParticipant;
                            } catch { senderInGroup = rawParticipant; }
                        }
                        if (senderInGroup !== rawParticipant && lidResolutionMap.get(rawParticipant) !== senderInGroup) {
                            lidResolutionMap.set(rawParticipant, senderInGroup);
                            saveLidResolutionMap();
                        }
                    }
                    const gForm = new FormData();
                    gForm.append('sender', senderInGroup);
                    gForm.append('message', (text || '').replace(/[﻿​-‍⁠­]/g, '').trim());
                    gForm.append('source', 'group');
                    gForm.append('group_jid', sender);
                    if (buf) gForm.append('file', new Blob([buf], { type: mime }), fname);
                    await fetch(WEBHOOK_URL, { method: 'POST', body: gForm, headers: { 'Authorization': API_TOKEN } }).catch(() => {});
                } catch (e) { console.error('[grup] error:', e.message); }
                continue;
            }

            try {
                const { type: messageType, content, rawForMedia } = extractMessage(msg.message);

                // ── Pesan fromMe (terkirim dari nomor ini sendiri) ────────────────
                // 1) Echo balasan BOT sendiri → abaikan total (sudah tercatat via
                //    sendWa di webhook; kalau diteruskan malah dianggap balasan manual).
                // 2) Ketikan MANUAL owner (HP/WA Web) tanpa '#' → jangan diproses
                //    sebagai chat, tapi teruskan ke webhook dengan fromMe=true sebagai
                //    sinyal "owner lagi turun tangan" → bot senyap otomatis di kontak
                //    ini. Pesan '#...' = perintah takeover, biarkan lanjut ke pipeline.
                if (msg.key.fromMe) {
                    if (botSentIds.has(msg.key.id)) continue;
                    const fmText = ((messageType === 'conversation' ? content : (content?.text || content?.caption || '')) || '').trim();
                    if (!fmText.startsWith('#')) {
                        let manualTarget = sender;
                        if (sender.endsWith('@lid')) {
                            const altFm = (msg.key.remoteJidAlt || '').endsWith('@s.whatsapp.net') ? msg.key.remoteJidAlt : null;
                            manualTarget = altFm || lidMap.get(sender) || lidResolutionMap.get(sender) || sender;
                        }
                        const isMediaFm = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType);
                        const fmForm = new FormData();
                        fmForm.append('sender', manualTarget);
                        fmForm.append('message', fmText.slice(0, 1500));
                        fmForm.append('fromMe', 'true');
                        if (isMediaFm) fmForm.append('manual_media', '1');
                        fetch(WEBHOOK_URL, { method: 'POST', body: fmForm, headers: { 'Authorization': API_TOKEN } }).catch(() => {});
                        console.log(`[owner-manual] Balasan manual ke ${manualTarget} → sinyal senyap dikirim ke webhook`);
                        continue;
                    }
                }

                // Resolve @lid JID ke phone JID agar nomor konsisten dengan website
                // Urutan prioritas: lidMap (dari contacts sync) > lidResolutionMap (konfirmasi manual)
                let resolvedSender = sender;
                if (sender.endsWith('@lid')) {
                    const { type: mType, content: mContent } = extractMessage(msg.message);
                    const rawText = (mType === 'conversation' ? mContent : mContent?.text || '').trim();

                    // Fitur Reset Nomor/nama (bisa dipanggil kapan saja)
                    if (rawText.toLowerCase() === 'reset nomor') {
                        lidResolutionMap.delete(sender);
                        saveLidResolutionMap();
                        nameMap.delete(sender);
                        saveNameMap();
                        askedNameOnce.delete(sender);
                        rememberBotSent(await sock.sendMessage(sender, { text: "🔄 Oke, data kamu sudah di-reset." }));
                        continue;
                    }

                    // (fromMe tanpa '#' sudah ditangani lebih awal sebagai sinyal
                    //  balasan manual owner — yang sampai sini hanya '#takeover'.)

                    // Nomor asli user @lid TIDAK perlu ditanya: WhatsApp menyediakannya.
                    // Prioritas: remoteJidAlt (pesan) > lidMap (contacts) > lidResolutionMap (cache)
                    //          > getPNForLID (query langsung ke pemetaan LID↔nomor Baileys v7).
                    const altJid = msg.key.remoteJidAlt || '';
                    const fromAlt = altJid.endsWith('@s.whatsapp.net') ? altJid : null;
                    let resolvedNum = fromAlt || lidMap.get(sender) || lidResolutionMap.get(sender) || null;
                    // Sumber terkuat: tanya langsung ke WhatsApp. Ini yang bikin nomor "selalu
                    // ketahuan" walau field pesan kebetulan tak memuatnya.
                    let fromQuery = null;
                    if (!resolvedNum) {
                        try {
                            const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(sender);
                            if (pn && pn.endsWith('@s.whatsapp.net')) { fromQuery = pn; resolvedNum = pn; }
                        } catch (e) { console.warn(`[lid-resolve] getPNForLID gagal utk ${sender}: ${e.message}`); }
                    }
                    if (resolvedNum) {
                        resolvedSender = resolvedNum;
                        // Persist mapping yang baru dipelajari (dari alt/query) agar konsisten
                        // & tak perlu query ulang tiap pesan.
                        const learned = fromAlt || fromQuery;
                        if (learned && lidResolutionMap.get(sender) !== learned) {
                            lidResolutionMap.set(sender, learned);
                            saveLidResolutionMap();
                        }
                        const src = fromAlt ? 'alt' : lidMap.get(sender) ? 'contacts' : fromQuery ? 'query' : 'manual';
                        console.log(`[lid-resolve] ${sender} → ${resolvedNum} (${src})`);
                    }

                    // Nama diambil OTOMATIS dari pushName WhatsApp. Kalau pushName benar-benar
                    // kosong, tanya SEKALI saja (arahkan ke command NAMA) — tidak loop, tidak nebak.
                    // Jangan pernah untuk fromMe: pushName pesan fromMe = nama OWNER sendiri,
                    // bukan nama kontak (bisa nyangkut jadi nama pelanggan).
                    if (!msg.key.fromMe && !nameMap.get(sender)) {
                        const pushName = (msg.pushName || '').trim();
                        if (pushName) {
                            nameMap.set(sender, pushName.slice(0, 50));
                            saveNameMap();
                        } else if (!askedNameOnce.has(sender)) {
                            askedNameOnce.add(sender);
                            rememberBotSent(await sock.sendMessage(sender, { text: "👋 Halo! Aku belum tau namamu. Ketik *NAMA [namamu]* ya, contoh: *NAMA Budi*." }));
                            // tidak 'continue' — pesan tetap diteruskan & diproses
                        }
                    }
                }
                const cleanSender = resolvedSender.replace(/:(\d+)(?=@)/, '');

                // Kalau sender asli @lid dan kini sudah jadi nomor, kirim penanda `prev_lid`
                // SEKALI agar website memigrasi data lama (seller_wa=LID → nomor) — cegah "double".
                const originLidDigits = sender.endsWith('@lid') ? sender.split('@')[0].replace(/:\d+$/, '') : null;
                const prevLid = (originLidDigits && cleanSender.endsWith('@s.whatsapp.net') && !migratedLids.has(sender))
                    ? originLidDigits : null;
                if (prevLid) migratedLids.add(sender);

                console.log(`Pesan dari ${cleanSender} | type: ${messageType}`);

                // Update chatMap dari pesan masuk (pastikan selalu ada entry)
                const existingChat = chatMap.get(cleanSender) || { jid: cleanSender, name: '', lastTime: 0, preview: '' };
                const contactName = contactMap.get(cleanSender)?.name || contactMap.get(sender)?.name || '';
                chatMap.set(cleanSender, {
                    ...existingChat,
                    jid: cleanSender,
                    name: contactName || existingChat.name,
                    lastTime: Date.now(),
                    preview: (typeof content === 'string' ? content : content?.text || '[media]')?.slice(0, 60) || '',
                });
                isStateDirty = true;
                // Batas ukuran chatMap: hapus entry terlama jika melebihi 2000
                if (chatMap.size > 2000) {
                    const oldest = [...chatMap.entries()].sort((a, b) => a[1].lastTime - b[1].lastTime)[0];
                    if (oldest) chatMap.delete(oldest[0]);
                }

                // Simpan ke in-memory log (max 100)
                messageLog.unshift({
                    sender: cleanSender,
                    type: messageType,
                    preview: (typeof content === 'string' ? content : content?.text || '[media]')?.slice(0, 100),
                    time: new Date().toISOString(),
                });
                if (messageLog.length > 100) messageLog.pop();

                let text = '', hasMedia = false, buffer = null, mimeType = '', filename = '';

                if (messageType === 'conversation') {
                    text = content;
                } else if (messageType === 'extendedTextMessage') {
                    text = content?.text || '';
                } else if (messageType === 'imageMessage') {
                    hasMedia = true;
                    text = content?.caption || '';
                    mimeType = content?.mimetype || 'image/jpeg';
                    filename = 'image.jpg';
                    buffer = await downloadMediaMessage(
                        { ...msg, message: rawForMedia },
                        'buffer', {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );

                    // ── Multi-foto: buffer 4 detik sebelum kirim ke webhook ──
                    {
                        const existing = photoBuffer.get(cleanSender);
                        if (existing) clearTimeout(existing.timer);
                        const entry = existing || { images: [], caption: '', fromMe: msg.key.fromMe };
                        entry.images.push({ buf: buffer, mime: mimeType });
                        if (text && !entry.caption) entry.caption = text;

                        entry.timer = setTimeout(async () => {
                            photoBuffer.delete(cleanSender);
                            const cleanCap = (entry.caption || '').replace(/[﻿​-‍­]/g, '').trim();
                            const ctx = addToContext(cleanSender, 'user', cleanCap || '[foto]');
                            const pForm = new FormData();
                            pForm.append('sender', cleanSender);
                            pForm.append('message', cleanCap);
                            pForm.append('context', JSON.stringify(ctx.slice(0, -1)));
                            const storedNameP = nameMap.get(cleanSender) || (msg.pushName || '').trim();
                            if (storedNameP) pForm.append('profile_name', storedNameP);
                            if (prevLid) pForm.append('prev_lid', prevLid);
                            pForm.append('fromMe', entry.fromMe ? 'true' : 'false');
                            entry.images.forEach((img, i) => {
                                pForm.append('file', new Blob([img.buf], { type: img.mime }), `image${i + 1}.jpg`);
                            });
                            try {
                                const pResp = await fetch(WEBHOOK_URL, { method: 'POST', body: pForm, headers: { 'Authorization': API_TOKEN } });
                                const pText = await pResp.text();
                                if (!pResp.ok) { console.error(`Webhook error ${pResp.status}: ${pText}`); }
                                else {
                                    console.log(`Webhook OK (${entry.images.length} foto): ${pText}`);
                                    try { const p = JSON.parse(pText); if (p.bot_reply) addToContext(cleanSender, 'bot', p.bot_reply); } catch (_) {}
                                }
                            } catch (e) { console.error('Error kirim foto buffer:', e.message); }
                        }, 4000);

                        photoBuffer.set(cleanSender, entry);
                        messageLog.unshift({ sender: cleanSender, type: messageType, preview: `[${entry.images.length} foto] ${text || ''}`.trim().slice(0, 100), time: new Date().toISOString() });
                        if (messageLog.length > 100) messageLog.pop();
                        continue; // skip webhook send di bawah, sudah ditangani timer
                    }
                } else if (messageType === 'videoMessage') {
                    hasMedia = true;
                    text = content?.caption || '';
                    mimeType = content?.mimetype || 'video/mp4';
                    filename = 'video.mp4';
                    buffer = await downloadMediaMessage(
                        { ...msg, message: rawForMedia },
                        'buffer', {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );
                } else if (messageType === 'documentMessage') {
                    hasMedia = true;
                    text = content?.caption || content?.fileName || '';
                    mimeType = content?.mimetype || 'application/octet-stream';
                    filename = content?.fileName || 'document';
                    buffer = await downloadMediaMessage(
                        { ...msg, message: rawForMedia },
                        'buffer', {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );
                } else if (messageType === 'audioMessage') {
                    hasMedia = true;
                    text = '';
                    mimeType = content?.mimetype || 'audio/ogg; codecs=opus';
                    filename = 'audio.ogg';
                    buffer = await downloadMediaMessage(
                        { ...msg, message: rawForMedia },
                        'buffer', {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );
                } else {
                    // Stiker dan tipe lain yang tidak didukung
                    text = 'non-text message';
                }

                // Strip BOM dan invisible chars agar FormData tidak gagal encode
                const cleanText = (text || '').replace(/[﻿​-‍⁠­]/g, '').trim();

                // Bangun context percakapan (kirim sebagai JSON ke webhook)
                const contextHistory = addToContext(cleanSender, 'user', cleanText || `[${messageType}]`);

                const form = new FormData();
                form.append('sender', cleanSender);
                form.append('message', cleanText);
                form.append('context', JSON.stringify(contextHistory.slice(0, -1))); // kirim history sebelum pesan ini
                const storedName = nameMap.get(cleanSender) || (msg.pushName || '').trim();
                if (storedName) form.append('profile_name', storedName);
                if (prevLid) form.append('prev_lid', prevLid);
                form.append('fromMe', msg.key.fromMe ? 'true' : 'false');
                if (hasMedia && buffer) form.append('file', new Blob([buffer], { type: mimeType }), filename);

                const response = await fetch(WEBHOOK_URL, {
                    method: 'POST',
                    body: form,
                    headers: { 'Authorization': API_TOKEN }
                });
                const responseText = await response.text();
                if (!response.ok) {
                    console.error(`Webhook error ${response.status}: ${responseText}`);
                } else {
                    console.log(`Webhook OK: ${responseText}`);
                    // Simpan balasan bot ke context
                    try {
                        const parsed = JSON.parse(responseText);
                        if (parsed.bot_reply) {
                            addToContext(cleanSender, 'bot', parsed.bot_reply);
                            // Catatan: untuk @lid + fromMe, webhook sudah kirim via sendWa→Baileys
                            // Tidak perlu kirim ulang via sock.sendMessage (akan dobel)
                        }
                    } catch (_) {}
                }
            } catch (err) {
                console.error('Error memproses pesan:', err.message);
            }
        }
    });
}

// Jaring pengaman: satu error async liar jangan menjatuhkan proses tanpa jejak.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));

app.listen(PORT, () => {
    console.log(`Bot Server listening on port ${PORT}`);
    startBot().catch((e) => {
        console.error('[startBot] gagal init:', e?.message || e);
        setTimeout(() => startBot().catch(() => {}), 10000); // coba lagi 10 dtk
    });
});
