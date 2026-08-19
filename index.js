// IPv6 server ini tidak sampai ke WhatsApp (curl -6 timeout, -4 lancar), sedangkan
// Node ≥17 memakai urutan DNS apa adanya — AAAA duluan berarti WebSocket Baileys
// menggantung di alamat IPv6 sampai timeout 408, lalu loop reconnect tiap 60 detik.
require('node:dns').setDefaultResultOrder('ipv4first');

const { default: makeWASocket, downloadMediaMessage, Browsers, fetchLatestBaileysVersion, normalizeMessageContent, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { useSupabaseAuthState } = require('./useSupabaseAuthState');
const { useFileAuthState } = require('./waAuthState');

// Baris log libsignal yang dibungkam. Bukan sekadar berisik: empat di antaranya
// ("Closing session:" dkk) mencetak objek SessionEntry UTUH — termasuk `privKey` —
// ke file log pm2 di disk. Kunci sesi WhatsApp tidak boleh mendarat di file yang
// bisa dibaca siapa pun yang punya akses server.
const SIGNAL_NOISE = [
    'Closing session:',
    'Opening session:',
    'Removing old closed session:',
    'Session already closed',
    'Session already open',
    'Decrypted message with closed session.',
    'Closing stale open session',
    'Closing open session in favor of incoming prekey bundle',
];
const isSignalNoise = (args) => typeof args[0] === 'string' && SIGNAL_NOISE.some(p => args[0].startsWith(p));

// Buffer untuk melacak console.log dan error (berguna untuk debugging)
const systemLogs = [];
const originalLog = console.log;
const originalError = console.error;
const originalInfo = console.info;
const originalWarn = console.warn;

// Buffer & kunci mentah jangan ikut ter-serialize ke buffer yang disajikan /logs.
function safeStringify(a) {
    if (Buffer.isBuffer(a)) return `<Buffer ${a.length}B>`;
    if (typeof a !== 'object' || a === null) return String(a);
    try {
        return JSON.stringify(a, (k, v) => {
            if (v?.type === 'Buffer' && Array.isArray(v.data)) return `<Buffer ${v.data.length}B>`;
            if (/priv|secret|key/i.test(k) && typeof v === 'string' && v.length > 32) return '<redacted>';
            return v;
        });
    } catch (_) { return '[unserializable]'; }
}
function pushLog(level, args) {
    systemLogs.push(`[${new Date().toISOString()}] [${level}] ${args.map(safeStringify).join(' ')}`);
    if (systemLogs.length > 200) systemLogs.shift();
}
console.log = function(...args) { pushLog('INFO', args); originalLog.apply(console, args); };
console.error = function(...args) { pushLog('ERROR', args); originalError.apply(console, args); };
console.info = function(...args) { if (isSignalNoise(args)) return; originalInfo.apply(console, args); };
console.warn = function(...args) { if (isSignalNoise(args)) return; originalWarn.apply(console, args); };

// Karakter tak terlihat (BOM, zero-width, soft hyphen) ikut terbawa dari HP dan
// bikin FormData/pencocokan keyword meleset. Dulu regex ini disalin di 3 tempat
// dengan isi yang berbeda-beda — sekarang satu definisi untuk semuanya.
const INVISIBLE_RE = /[﻿​-‍⁠­]/g;
const stripInvisible = (s) => String(s || '').replace(INVISIBLE_RE, '').trim();
// Titik pemanggil bot dibuang sebelum pesan diteruskan: website mengenali perintah
// polos ("JUAL", "CARI sepatu"), bukan ".JUAL".
const stripBotPrefix = (s) => {
    const t = String(s || '');
    return t.startsWith(BOT_PREFIX) ? t.slice(BOT_PREFIX.length).trimStart() : t;
};

// '08xxx' / '+62 xxx' / '62xxx' → JID WhatsApp. Dulu disalin di 4 endpoint.
function toJid(target) {
    const raw = String(target || '');
    if (raw.includes('@')) return raw;
    let num = raw.replace(/[^0-9]/g, '');
    if (num.startsWith('0')) num = '62' + num.slice(1);
    return num + '@s.whatsapp.net';
}

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://www.jualbeliusupolmed.web.id/api/wa/baileys';
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
    console.error('[FATAL] API_TOKEN wajib di-set di environment. Bot berhenti (fail-closed) '
        + 'agar tidak jalan dengan token default publik yang bisa dieksploitasi.');
    process.exit(1);
}
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '.'; // set ke mount path Volume/Disk kalau mau file persisten
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_info_baileys');
const MARKETPLACE_GROUP_JID = process.env.GROUP_JID || '';

// ── Gerbang bot ───────────────────────────────────────────────────────────────
// Default percakapan pelanggan adalah dengan ADMIN (manusia). Bot baru ikut campur
// kalau pesan diawali tanda ini. Tanpa gerbang, bot menyahut tiap chat masuk dan
// admin jadi tak leluasa membalas manual.
const BOT_PREFIX = process.env.BOT_PREFIX || '.';
// Titik cuma dipakai untuk MEMBUKA sesi. Alur bot itu bertahap (.JUAL → bot tanya
// harga/kondisi → pelanggan kirim foto tanpa caption); kalau tiap pesan wajib
// bertitik, alur itu putus di langkah kedua. Sesi disegarkan tiap pesan yang lolos.
const BOT_SESSION_MS = Number(process.env.BOT_SESSION_MINUTES || 15) * 60 * 1000;
// Kata yang menutup sesi bot lebih cepat (pelanggan mau balik ngobrol ke admin).
// Sengaja pendek: kata seperti "sudah"/"oke" sering jadi JAWABAN wajar di tengah alur
// .JUAL, jadi kalau dimasukkan ke sini sesi bisa putus di tengah pemasangan iklan.
const BOT_END_WORDS = new Set(['admin', 'stop', 'selesai']);
// Panggilan ke admin ("min"). Bedanya dengan BOT_END_WORDS: kata di sini BUKAN cuma
// menutup sesi, tapi selalu dibalas sapaan — orang yang manggil "min" jelas sedang
// mencari manusia, jadi dia harus langsung tahu chat ini dipegang admin dan bot
// punya jalur titik sendiri. Sengaja dipisah supaya "admin"/"stop" di tengah alur
// .JUAL tetap menutup sesi tanpa memuntahkan sapaan panjang.
const ADMIN_CALL_WORDS = new Set(
    (process.env.ADMIN_CALL_WORDS || 'min,mimin')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);
// Jeda minimum antar sapaan untuk kontak yang sama. Tanpa ini, "min min min" tiga
// kali dibalas tiga sapaan panjang — mirip spam dan bikin admin susah baca chat.
const ADMIN_CALL_COOLDOWN_MS = Number(process.env.ADMIN_CALL_COOLDOWN_SECONDS || 60) * 1000;
// Cocokkan hanya kalau SELURUH pesan berupa panggilan itu ("Min", "min?", "MIN!!").
// Kalimat seperti "admin nya kemana" sengaja tidak kena: itu pesan untuk dibaca
// admin, bukan permintaan menu.
const isAdminCall = (s) => ADMIN_CALL_WORDS.has(
    String(s || '').toLowerCase().replace(/[^a-z]/g, '')
);
// Kata perintah yang sering diketik TANPA titik. Tidak mengubah perilaku gerbang —
// murni untuk dihitung, supaya keputusan "buka kata polos atau tidak" punya angka.
const PLAIN_COMMAND_WORDS = new Set(['jual', 'cari', 'menu', 'perpanjang', 'upgrade', 'saya', 'beli']);
function plainCommandWord(text) {
    const first = String(text || '').trim().toLowerCase().split(/\s+/)[0] || '';
    const word = first.replace(/[^a-z]/g, '');
    return PLAIN_COMMAND_WORDS.has(word) ? word : '';
}
// Sapaan untuk pesan TANPA titik — dikirim SEKALI per kontak, sesudah itu bot diam
// total di chat itu supaya admin bebas membalas manual.
const DEFAULT_GREETING = process.env.GREETING_TEXT || [
    'Terima kasih telah menghubungi 🙏',
    '',
    'Anda akan chat dengan *admin (manusia)*.',
    '',
    `Kalau ingin jual beli & cari barang lewat *bot*, awali pesan dengan tanda titik ( *${BOT_PREFIX}* ), contoh: *${BOT_PREFIX}MENU*`,
    '',
    `• *${BOT_PREFIX}JUAL* — Pasang iklan`,
    `• *${BOT_PREFIX}CARI [nama barang]* — Cari barang`,
    `• *${BOT_PREFIX}PERPANJANG* — Perpanjang iklan`,
    `• *${BOT_PREFIX}UPGRADE* — Upgrade iklan`,
    `• *${BOT_PREFIX}SAYA* — Profil & statistik saya`,
    `• *${BOT_PREFIX}MENU* — Lihat semua perintah lengkap`,
    '',
    'Dan jika ingin lebih mudah, bisa melalui website:',
    '*Lihat Barang* jualbeliusupolmed.web.id',
    '*Jual Barang* jualbeliusupolmed.web.id/jual',
    '*Cari Barang* jualbeliusupolmed.web.id/dicari',
    '*Instagram* instagram.com/usulovepolmed',
    '',
    'Terima kasih 🙏',
].join('\n');
// Teks sapaan yang BERLAKU. Dipisah dari DEFAULT_GREETING supaya bisa diubah dari
// dashboard tanpa menyunting berkas ini dan tanpa restart bot — mengganti kalimat
// sapaan itu pekerjaan admin sehari-hari, bukan pekerjaan deploy. Nilai kustom
// disimpan di settings.json (lihat loadSettings) dan menang atas default di atas.
let greetingText = DEFAULT_GREETING;
const GREETING_MAX = 4000;   // batas WhatsApp untuk satu gelembung teks, dengan sisa
// Batas waktu socket boleh menggantung di state 'connecting'. Lewat ini dianggap
// nyangkut (event 'open' maupun 'close' tidak pernah datang) → paksa sambung ulang.
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 90000);
// Fase nunggu QR discan manusia — wajar lama, jadi ambangnya jauh lebih longgar.
const QR_WAIT_TIMEOUT_MS = Number(process.env.QR_WAIT_TIMEOUT_MS || 600000);

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
// Diisi di startBot(): menunggu tulisan sesi yang masih di udara selesai. Dipanggil
// sebelum proses keluar — memotong penulisan creds = sesi rusak = scan QR lagi.
let flushAuthState = async () => {};

// ── Toleransi logout palsu ───────────────────────────────────────────────────
// WhatsApp sesekali membalas 401 pada saat handshake meski perangkat sebenarnya
// masih tertaut (versi protokol basi, jaringan kacau, server WA lagi rewel).
// Dulu 401 pertama langsung menghapus sesi → admin wajib scan QR padahal cukup
// sambung ulang. Sekarang creds yang sama dicoba ulang beberapa kali dulu;
// sesi baru dilepas kalau WhatsApp konsisten menolak.
const LOGOUT_STRIKES = Number(process.env.LOGOUT_STRIKES || 3);
let logoutStrikes = 0;
let sessionLostAt = null;


const app = express();
// Semua trafik masuk lewat nginx di loopback, jadi req.ip apa adanya selalu
// 127.0.0.1 dan rem percobaan token di bawah tidak bisa membedakan penyerang dari
// pengguna sah. Percayai HANYA proxy loopback — header X-Forwarded-For dari luar
// tetap tidak dipercaya.
app.set('trust proxy', 'loopback');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let waSocket = null;
let currentQR = '';
let connectedPhone = '';
let connectedAt = null;
let reconnectAttempts = 0;
const messageQueue = [];

// ── Jejak putus koneksi ───────────────────────────────────────────────────────
// Selama ini bot mati cuma ketahuan kalau kebetulan buka `pm2 logs`. Tiga variabel
// ini menjadikannya terlihat di dashboard, dan yang panjang dilaporkan ke WhatsApp
// pemilik. Catatan jujur: laporannya baru bisa terkirim SETELAH bot tersambung lagi
// — mustahil mengirim pesan WhatsApp justru saat WhatsApp-nya yang putus.
let offlineSince = null;
let lastOutage = null;
let outageCount = 0;
const OFFLINE_ALERT_MS = Number(process.env.OFFLINE_ALERT_MINUTES || 5) * 60 * 1000;
const OWNER_NUMBER = process.env.OWNER_JID || '';

// ── Eskalasi padam berkepanjangan ────────────────────────────────────────────
// 18-19 Agu 2026 bot diam 907 menit: 247 kali sambung-ulang kode 408 beruntun,
// tidak pernah pulih sendiri. Backoff yang mentok di 60 detik memang tidak akan
// menyerah — tapi juga tidak pernah mencoba sesuatu yang BERBEDA. Sebagian
// kegagalan (resolver DNS yang telanjur di-cache proses, handle socket bocor,
// state Baileys yang rusak) cuma sembuh oleh proses yang benar-benar baru.
// Jadi lewat ambang ini, proses dimatikan dan pm2 menghidupkannya dari nol.
const OFFLINE_RESTART_MS = Number(process.env.OFFLINE_RESTART_MINUTES || 20) * 60 * 1000;
// Ambang digandakan tiap eskalasi beruntun sampai batas ini. Alasannya sama dengan
// toleransi 401 di atas: kalau WhatsApp memang sedang menolak nomor ini, restart
// tiap 20 menit tanpa henti justru pola handshake berulang yang bikin nomor
// dicurigai. Menyerah pelan-pelan lebih aman daripada menggedor terus.
const OFFLINE_RESTART_MAX_MS = Number(process.env.OFFLINE_RESTART_MAX_MINUTES || 360) * 60 * 1000;
// Sambungan harus bertahan selama ini sebelum hitungan eskalasi dinolkan: 'open'
// yang putus lagi semenit kemudian bukan pemulihan, dan menolkannya di situ bikin
// bot menggedor WhatsApp tiap 20 menit selamanya.
const ESCALATION_RESET_MS = Number(process.env.ESCALATION_RESET_MINUTES || 5) * 60 * 1000;
const PROSES_MULAI = Date.now();
let offlineEscalations = 0;
let escalationResetTimer = null;

// Hitungan eskalasi disimpan ke disk — kalau hanya di memori, ia ikut hilang tepat
// pada saat yang ia jaga (restart proses), jadi ambangnya tidak pernah naik.
const OUTAGE_GUARD_FILE = path.join(DATA_DIR, 'outage_guard.json');
function loadOutageGuard() {
    try {
        const raw = JSON.parse(fs.readFileSync(OUTAGE_GUARD_FILE, 'utf-8'));
        const n = Number(raw?.escalations);
        if (Number.isFinite(n)) offlineEscalations = Math.max(0, Math.min(20, Math.trunc(n)));
        if (offlineEscalations > 0) {
            console.warn(`[eskalasi] Proses ini lanjutan dari ${offlineEscalations} restart darurat beruntun.`);
        }
    } catch (_) {}
}
function saveOutageGuard() {
    try {
        fs.writeFileSync(OUTAGE_GUARD_FILE, JSON.stringify({
            escalations: offlineEscalations,
            updatedAt: new Date().toISOString(),
        }, null, 2));
    } catch (e) { console.error('[eskalasi] gagal simpan penanda:', e.message); }
}
loadOutageGuard();
// Ambang yang berlaku sekarang, dipakai pemantau sekaligus dilaporkan di /status.
function ambangEskalasiMs() {
    return Math.min(OFFLINE_RESTART_MS * Math.pow(2, offlineEscalations), OFFLINE_RESTART_MAX_MS);
}

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

// Antrean pesan keluar. Dulu dijadwal ulang dengan POLLING 800 ms: tiap balasan
// menunggu sampai 0,8 dtk cuma untuk dilihat antrean, padahal antreannya kosong.
// Sekarang event-driven — kickQueue() dipanggil saat pesan masuk.
//
// Tiap pesan menunggu minimal REPLY_DELAY_MS sejak masuk antrean sebelum
// dikirim (permintaan pemilik: balasan instan terasa robot). Selama menunggu,
// bot memasang status "mengetik…" ke penerima.
//
// Yang TETAP dipertahankan adalah jeda ANTAR kiriman (bukan jeda sebelum kiriman
// pertama): itu bagian yang benar-benar menjaga ritme tidak terbaca sebagai bot.
// Jeda dibedakan dua macam, karena risikonya beda:
//   - ke kontak yang SAMA  → satu percakapan, wajar beruntun cepat.
//   - ke kontak BERBEDA    → pola ini yang mirip blast, jadi tetap dilonggarkan.
const MAX_SEND_ATTEMPTS = 3;
const REPLY_DELAY_MS = Number(process.env.REPLY_DELAY_MS || 2000);
const GAP_SAME_MIN_MS = Number(process.env.GAP_SAME_MIN_MS || 500);
const GAP_SAME_RAND_MS = Number(process.env.GAP_SAME_RAND_MS || 500);
const GAP_OTHER_MIN_MS = Number(process.env.GAP_OTHER_MIN_MS || 1500);
const GAP_OTHER_RAND_MS = Number(process.env.GAP_OTHER_RAND_MS || 2500);
// `waSocket` non-null belum berarti tersambung: ada jendela di mana koneksi sudah
// mati tapi event 'close' belum datang. Cek websocket-nya langsung.
function socketAlive() { return !!(waSocket && waSocket.ws?.isOpen); }

// Laporan ke pemilik lewat WhatsApp. Tanpa OWNER_JID, dikirim ke nomor bot sendiri
// (chat "pesan ke diri sendiri") — tetap sampai dan tidak mengganggu pelanggan.
function notifyOwner(text) {
    const target = OWNER_NUMBER ? toJid(OWNER_NUMBER) : (connectedPhone ? `${connectedPhone}@s.whatsapp.net` : '');
    if (!target) return;
    messageQueue.push({ jid: target, message: text, ts: Date.now() });
    kickQueue();
}

let queueTimer = null;
let queueBusy = false;   // processQueue itu async — tanpa ini, kick di tengah
                         // pengiriman bisa memulai kiriman kedua yang tumpang tindih.
let nextSendAt = 0;      // kiriman berikutnya tidak boleh mendahului waktu ini
let lastSentJid = '';

function scheduleQueue(delayMs) {
    if (queueTimer) clearTimeout(queueTimer);
    queueTimer = setTimeout(processQueue, Math.max(0, delayMs));
}
// Dipanggil tiap ada pesan baru masuk antrean. Kalau jatah jeda sudah lewat
// (kasus normal: balasan pertama setelah bot menganggur), delay-nya jadi 0.
function kickQueue() {
    if (queueBusy) return;   // run yang sedang jalan pasti menjadwalkan lanjutannya
    scheduleQueue(nextSendAt - Date.now());
}

async function processQueue() {
    queueTimer = null;
    if (queueBusy) return;
    if (messageQueue.length === 0) return;                       // menganggur → tunggu kickQueue()
    if (!socketAlive()) { scheduleQueue(1000); return; }          // socket mati → tahan, jangan buang
    const wait = nextSendAt - Date.now();
    if (wait > 0) { scheduleQueue(wait); return; }

    // Jeda balasan: pesan paling depan belum berumur REPLY_DELAY_MS → tunda,
    // dan pasang "mengetik…" (sekali saja) supaya jedanya terlihat manusiawi.
    const head = messageQueue[0];
    const readyAt = (head.ts || 0) + REPLY_DELAY_MS;
    const replyWait = readyAt - Date.now();
    if (replyWait > 0) {
        if (!head.composing) {
            head.composing = true;
            waSocket.presenceSubscribe(head.jid).catch(() => {});
            waSocket.sendPresenceUpdate('composing', head.jid).catch(() => {});
        }
        scheduleQueue(replyWait);
        return;
    }

    queueBusy = true;
    let gap = 0;
    try {
        const task = messageQueue.shift();
        // Anti-burst: buang pesan yang sudah terlalu lama menunggu (mis. numpuk saat
        // bot offline). Kirim borongan pesan basi = pola spam → risiko blokir WA.
        if (task.ts && Date.now() - task.ts > 3 * 60 * 1000) {
            console.warn(`[Queue] Buang pesan basi (>3mnt) ke ${task.jid}`);
        }
        // Jangan kirim gelembung kosong (teks kosong tanpa gambar/poll) — pernah
        // muncul pesan kosong ke pelanggan.
        else if (!(task.url || task.poll || (task.message && String(task.message).trim()))) {
            console.warn(`[Queue] Lewati pesan kosong ke ${task.jid}`);
        } else {
            try {
                // Indikator "mengetik" sengaja TIDAK di-await: dua round-trip ini dulu
                // duduk persis di jalur kritis tiap balasan, padahal hasilnya kosmetik.
                waSocket.presenceSubscribe(task.jid).catch(() => {});
                waSocket.sendPresenceUpdate('composing', task.jid).catch(() => {});
                let sendResult;
                if (task.url) {
                    sendResult = await waSocket.sendMessage(task.jid, { image: { url: task.url }, caption: task.message });
                } else if (task.poll) {
                    sendResult = await waSocket.sendMessage(task.jid, { poll: task.poll });
                } else {
                    sendResult = await waSocket.sendMessage(task.jid, { text: task.message });
                }
                rememberBotSent(sendResult);
                recordMessage(task.jid, 'out', task.poll ? `[poll] ${task.poll.name || ''}` : (task.message || '[media]'), task.url ? 'image' : 'text');
                bump('keluar');
                console.log(`[Queue] Pesan terkirim ke ${task.jid} (antre ${Date.now() - (task.ts || Date.now())}ms)`);
                gap = task.jid === lastSentJid
                    ? GAP_SAME_MIN_MS + Math.floor(Math.random() * GAP_SAME_RAND_MS)
                    : GAP_OTHER_MIN_MS + Math.floor(Math.random() * GAP_OTHER_RAND_MS);
                lastSentJid = task.jid;
            } catch (err) {
                // Dulu di sini pesan langsung hilang: task sudah ter-shift dari antrean
                // dan kegagalan cuma di-log. Tiap "Connection Closed" = satu balasan
                // yang tidak pernah sampai ke pelanggan, padahal website mengira
                // sudah terkirim. Sekarang dikembalikan ke depan antrean.
                task.attempts = (task.attempts || 0) + 1;
                if (task.attempts < MAX_SEND_ATTEMPTS) {
                    messageQueue.unshift(task);
                    gap = 1000;   // beri napas sebelum coba lagi, jangan loop ketat
                    console.error(`[Queue] Gagal kirim ke ${task.jid} (percobaan ${task.attempts}/${MAX_SEND_ATTEMPTS}), diulang:`, err.message);
                } else {
                    bump('kirim_gagal');
                    console.error(`[Queue] Gagal kirim ke ${task.jid} setelah ${MAX_SEND_ATTEMPTS} percobaan, pesan DIBUANG:`, err.message);
                }
            }
        }
    } finally {
        queueBusy = false;
    }
    nextSendAt = Date.now() + gap;
    scheduleQueue(gap);
}
// Jaring pengaman: kalau ada satu kickQueue() yang terlewat, antrean tidak boleh
// menggantung selamanya. Cek longgar, hanya kalau memang ada isinya.
setInterval(() => {
    if (messageQueue.length && !queueTimer && !queueBusy) kickQueue();
}, 5000).unref();

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
    flushMsgArchive();
    flushStats();
}, 10000);

// ── Pengaturan yang bisa diubah dari dashboard ────────────────────────────────
// Hanya untuk hal yang wajar diubah admin saat bot jalan (sapaan). Kredensial dan
// perilaku berisiko TIDAK di sini: itu tetap lewat env supaya tidak bisa diubah
// siapa pun yang kebetulan pegang token dashboard.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = {};
function loadSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) || {};
        if (typeof settings.greeting === 'string' && settings.greeting.trim()) {
            greetingText = settings.greeting;
            console.log(`[settings] Sapaan kustom dimuat (${greetingText.length} karakter).`);
        }
    } catch (e) { console.error('[settings] gagal baca:', e.message); }
}
function saveSettings() {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
    catch (e) { console.error('[settings] gagal simpan:', e.message); }
}
loadSettings();

// ── Arsip pesan (persisten) ───────────────────────────────────────────────────
// messageLog lama cuma 100 entri di memori, tanpa arah pesan, dan lenyap tiap
// restart — cukup untuk mengintip, tidak cukup untuk membalas pelanggan dari
// dashboard. Arsip ini menyimpan masuk DAN keluar ke berkas, jadi riwayat satu
// kontak masih utuh setelah bot di-restart.
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const MSG_ARCHIVE_CAP = Number(process.env.MSG_ARCHIVE_CAP || 5000);
const MSG_TEXT_CAP = 1000;   // isi penuh, bukan preview 60/100 karakter seperti dulu
let msgArchive = [];
let msgArchiveDirty = false;
(function loadMsgArchive() {
    if (!fs.existsSync(MESSAGES_FILE)) return;
    try {
        const raw = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
        if (Array.isArray(raw)) msgArchive = raw.slice(-MSG_ARCHIVE_CAP);
    } catch (e) { console.error('[arsip] gagal baca:', e.message); }
})();
// dir: 'in' = dari pelanggan, 'out' = dari bot/admin. Dipisah eksplisit karena
// /messages yang lama menghardcode fromMe:false — semua pesan tampak masuk.
function recordMessage(jid, dir, text, type = 'text') {
    if (!jid) return;
    msgArchive.push({
        jid,
        dir,
        type,
        text: String(text || '').slice(0, MSG_TEXT_CAP),
        time: new Date().toISOString(),
    });
    if (msgArchive.length > MSG_ARCHIVE_CAP) msgArchive.splice(0, msgArchive.length - MSG_ARCHIVE_CAP);
    msgArchiveDirty = true;
}
function flushMsgArchive() {
    if (!msgArchiveDirty) return;
    try { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(msgArchive)); msgArchiveDirty = false; }
    catch (e) { console.error('[arsip] gagal simpan:', e.message); }
}

// ── Statistik gerbang (persisten) ─────────────────────────────────────────────
// Semua keputusan gerbang selama ini cuma lewat di log terminal lalu hilang. Yang
// paling ingin dijawab angka ini: berapa banyak pesan polos yang DIDIAMKAN bot, dan
// berapa di antaranya sebenarnya kata perintah ("jual" tanpa titik). Selama itu tak
// terukur, membuka kata polos cuma tebak-tebakan.
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const STATS_DAYS = 30;
let stats = { total: {}, daily: {} };
let statsDirty = false;
(function loadStats() {
    if (!fs.existsSync(STATS_FILE)) return;
    try {
        const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
        if (raw && typeof raw === 'object') stats = { total: raw.total || {}, daily: raw.daily || {} };
    } catch (e) { console.error('[stats] gagal baca:', e.message); }
})();
// Kunci harian pakai jam Jakarta, bukan UTC: laporan "hari ini" yang berganti jam
// 07:00 pagi waktu setempat akan membingungkan saat dibaca admin.
function statsDay(ts = Date.now()) { return new Date(ts + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function bump(key, n = 1) {
    const day = statsDay();
    stats.total[key] = (stats.total[key] || 0) + n;
    if (!stats.daily[day]) stats.daily[day] = {};
    stats.daily[day][key] = (stats.daily[day][key] || 0) + n;
    const days = Object.keys(stats.daily).sort();
    while (days.length > STATS_DAYS) delete stats.daily[days.shift()];
    statsDirty = true;
}
function flushStats() {
    if (!statsDirty) return;
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); statsDirty = false; }
    catch (e) { console.error('[stats] gagal simpan:', e.message); }
}

// Sapu context percakapan yang sudah kedaluwarsa. addToContext hanya memangkas JID
// yang sedang mengirim pesan, jadi kontak yang berhenti chat menetap di memori
// sampai koneksi putus — di bot yang uptime-nya panjang, itu tumbuh terus.
setInterval(() => {
    const now = Date.now();
    const EXPIRE_MS = 30 * 60 * 1000;
    for (const [jid, history] of conversationContext) {
        const alive = history.filter(e => now - e.time < EXPIRE_MS);
        if (!alive.length) conversationContext.delete(jid);
        else if (alive.length !== history.length) conversationContext.set(jid, alive);
    }
    // Sesi bot yang sudah lewat waktunya ikut disapu di sini — botSessionActive() hanya
    // membersihkan JID yang kebetulan mengirim pesan lagi.
    for (const [jid, until] of botSessions) if (now > until) botSessions.delete(jid);
}, 5 * 60 * 1000);

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
// Map JID → waktu sapaan "chat ini dilayani admin" dikirim. Disimpan permanen supaya
// pelanggan lama tidak disapa ulang tiap bot restart.
const GREETED_FILE = path.join(DATA_DIR, 'greeted_map.json');

// JID → epoch ms kapan sesi bot berakhir. Sengaja HANYA di memori: sesi cuma
// berumur menit, dan restart yang menutup sesi jauh lebih aman daripada sesi
// zombie yang bikin bot menyahut chat yang sebenarnya ditujukan ke admin.
const botSessions = new Map();
// JID → epoch ms sapaan terakhir akibat panggilan "min". Cukup di memori: cooldown
// ini cuma soal menahan balasan beruntun dalam hitungan detik.
const adminCallMap = new Map();
function botSessionActive(jid) {
    const until = botSessions.get(jid);
    if (!until) return false;
    if (Date.now() > until) { botSessions.delete(jid); return false; }
    return true;
}

// State ini DISIMPAN DI SUPABASE kalau env tersedia (tabel wa_state), bukan di file
// lokal. Alasannya: host gratis seperti Render Free filesystem-nya sementara (kehapus
// tiap spin-down ~15 mnt idle). Kalau disimpan di file, nama user & resolusi @lid akan
// hilang tiap bot restart → user ditanya nama berulang. Fallback ke file lokal hanya
// kalau Supabase tidak diset (mis. saat dev lokal). Lihat wa_state.sql untuk skema tabel.
const STATE_TABLE = 'wa_state';
let nameMap = new Map();            // diisi di startBot() via loadState()
let lidResolutionMap = new Map();   // diisi di startBot() via loadState()
let greetedMap = new Map();         // diisi di startBot() via loadState()
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
function saveGreetedMap() { saveState('greeted_map', greetedMap, GREETED_FILE).catch(() => {}); }

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
// Perbandingan token dibuat waktu-konstan: `!==` biasa keluar lebih cepat pada byte
// pertama yang beda, yang secara teori bisa dipakai menebak token per karakter.
function tokenMatches(given) {
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(String(API_TOKEN));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
// ── Rem percobaan token ──────────────────────────────────────────────────────
// Satu token statis tanpa pembatasan laju artinya token boleh ditebak secepat
// jaringan mengizinkan. Ini tidak mengubah kekuatan tokennya, tapi mengubah
// tebakan dari "jutaan per jam" jadi segelintir — cukup untuk membuat penebakan
// tidak praktis. Per-IP dan hanya di memori; restart membersihkannya, dan itu
// tidak apa-apa karena serangan yang relevan berlangsung dalam hitungan menit.
const AUTH_FAIL_MAX = Number(process.env.AUTH_FAIL_MAX || 10);
const AUTH_FAIL_WINDOW_MS = Number(process.env.AUTH_FAIL_WINDOW_MINUTES || 5) * 60 * 1000;
const authFails = new Map();   // ip → { count, first }
setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of authFails) if (now - rec.first > AUTH_FAIL_WINDOW_MS) authFails.delete(ip);
}, 60000).unref();

function authBlocked(ip) {
    const rec = authFails.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.first > AUTH_FAIL_WINDOW_MS) { authFails.delete(ip); return false; }
    return rec.count >= AUTH_FAIL_MAX;
}
function noteAuthFail(ip) {
    const rec = authFails.get(ip);
    if (!rec || Date.now() - rec.first > AUTH_FAIL_WINDOW_MS) {
        authFails.set(ip, { count: 1, first: Date.now() });
    } else {
        rec.count++;
        if (rec.count === AUTH_FAIL_MAX) console.warn(`[auth] ${ip} diblokir sementara setelah ${rec.count} token salah.`);
    }
}

function requireAuth(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (authBlocked(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' });
    if (!tokenMatches(req.headers.authorization)) {
        noteAuthFail(ip);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ── Gerbang endpoint berbahaya (re-link/reset) ───────────────────────────────
// Endpoint yang bisa MENGHAPUS SESI atau MENAUTKAN perangkat (reset/restart/
// pairing-code) dikunci default. Selama token bot masih bisa bocor (mis. default
// publik), tanpa gerbang ini penyerang bisa /reset → bot logout → /pairing-code →
// ambil alih WhatsApp bisnis. Website normal TIDAK memakai endpoint ini.
// Untuk re-link sah: set env ALLOW_RELINK=true di server sementara, lalu matikan lagi.
function requireRelink(req, res, next) {
    if (process.env.ALLOW_RELINK === 'true') return next();
    return res.status(403).json({ error: 'Endpoint terkunci demi keamanan. Set ALLOW_RELINK=true di server bila memang mau re-link/reset.' });
}

// ── Health check (public, untuk Railway health check) ────────────────────────
app.get('/health', (req, res) => {
    // Definisinya disamakan persis dengan /status — dulu /health cuma cek `waSocket`
    // tanpa `connectedPhone`, jadi bisa bilang sehat padahal login belum selesai.
    const isConnected = !!(waSocket && connectedPhone && !currentQR);
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

// ── Beranda (public) ─────────────────────────────────────────────────────────
// Daftar tombol ke semua halaman & endpoint. Halamannya sendiri publik; data
// yang butuh token tetap diambil lewat fetch ber-Authorization dari browser.
app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
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
        // Kesehatan koneksi — supaya bot mati tidak perlu ditemukan lewat `pm2 logs`.
        offlineSince: offlineSince ? new Date(offlineSince).toISOString() : null,
        lastOutage,
        outageCount,
        reconnectAttempts,
        // Restart darurat karena padam berkepanjangan: 0 = belum pernah, angka naik
        // = bot sedang berjuang. Ambangnya ikut dilaporkan supaya jelas kapan
        // eskalasi berikutnya jatuh tanpa perlu menghitung sendiri.
        offlineEscalations,
        escalationThresholdMinutes: Math.round(ambangEskalasiMs() / 60000),
        // Kapan perangkat terakhir benar-benar dilepas WhatsApp (butuh scan ulang).
        // null artinya sesi masih utuh — putus koneksi biasa tidak mengisi ini.
        sessionLostAt,
        logoutStrikes,
        // Ringkasan hari ini, biar dashboard tidak perlu dua panggilan untuk kartu utama.
        today: stats.daily[statsDay()] || {},
        archiveCount: msgArchive.length,
        chatCount: chatMap.size,
        greetingCustom: greetingText !== DEFAULT_GREETING,
        // Berapa kali sapaan lama website dicegat sejak proses hidup. Angka yang
        // mandek di 0 padahal sapaan lama masih muncul di HP = penandanya meleset.
        legacyGreetingSwaps,
    });
});

// ── Logs endpoint ─────────────────────────────────────────────────────────────
app.get('/logs', requireAuth, (req, res) => {
    res.json({ logs: systemLogs });
});

// ── Halaman laporan analisis ─────────────────────────────────────────────────
// Ada DUA berkas, dan bedanya disengaja:
//
//   laporan-publik.html — /laporan, tanpa token. Temuan bisnis & performa utuh,
//       tapi cara menembus keamanan bot dibuang. Sebuah halaman publik yang
//       menuliskan "endpoint X cuma dijaga satu token dan tidak dibatasi laju"
//       berhenti jadi laporan audit dan berubah jadi petunjuk serangan.
//
//   laporan.html — /laporan/penuh, wajib token. Versi lengkap untuk admin.
//
// Keduanya di root proyek, BUKAN di public/, supaya express.static tidak diam-diam
// menyajikan versi lengkapnya ke siapa saja.
//
// Token boleh lewat query string KHUSUS di rute penuh: tautan yang diklik dari
// browser tidak bisa membawa header Authorization. Konsekuensinya token ikut
// tercatat di riwayat browser, jadi tautan /laporan/penuh jangan disebar.
function requireAuthPage(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (authBlocked(ip)) return res.status(429).type('html').send('<!doctype html><meta charset="utf-8"><title>429</title><body style="font:16px/1.6 system-ui;max-width:34rem;margin:18vh auto"><h1 style="font-size:1.25rem">Terlalu banyak percobaan</h1><p>Coba lagi beberapa menit lagi.</p></body>');
    if (tokenMatches(req.headers.authorization) || tokenMatches(req.query.token)) return next();
    noteAuthFail(ip);
    res.status(401).type('html').send(
        '<!doctype html><meta charset="utf-8">'
        + '<title>401 — token salah</title>'
        + '<body style="font:16px/1.6 system-ui;max-width:34rem;margin:18vh auto;padding:0 1.5rem">'
        + '<h1 style="font-size:1.25rem">Token tidak cocok</h1>'
        + '<p>Halaman ini butuh token bot. Buka lewat tombol <b>Laporan analisis</b> di dashboard, '
        + 'atau tambahkan <code>?token=…</code> di alamatnya.</p></body>'
    );
}
// Versi lengkap — admin saja.
app.get('/laporan/penuh', requireAuthPage, (req, res) => {
    res.sendFile(path.join(__dirname, 'laporan.html'));
});
// Versi publik — tanpa token, boleh dibagikan.
app.get('/laporan', (req, res) => {
    // Token yang sudah terlanjur ditempel di tautan lama tetap dihormati: kalau
    // cocok, langsung sajikan yang lengkap daripada memaksa pindah alamat.
    if (tokenMatches(req.headers.authorization) || tokenMatches(req.query.token)) {
        return res.sendFile(path.join(__dirname, 'laporan.html'));
    }
    res.sendFile(path.join(__dirname, 'laporan-publik.html'));
});
// Menebak '/laporan.html' itu refleks yang wajar — dan tanpa ini jawabannya cuma
// "Cannot GET" dari Express, yang bikin orang mengira halamannya belum ada.
app.get('/laporan.html', (req, res) => {
    const q = req.query.token ? '?token=' + encodeURIComponent(req.query.token) : '';
    res.redirect(301, '/laporan' + q);
});

// ── Resolve @lid → nomor (admin) ─────────────────────────────────────────────
// Untuk migrasi data lama ber-key LID: tanya pemetaan LID↔nomor langsung ke
// WhatsApp (getPNForLID). Hasil dipakai POST /api/admin/migrate-lid di website.
app.get('/resolve-lid', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot belum tersambung' });
    const digits = String(req.query.lid || '').split('@')[0].replace(/\D/g, '');
    if (!digits) return res.status(400).json({ error: 'param ?lid= wajib' });
    const lidJid = digits + '@lid';
    const cached = lidMap.get(lidJid) || lidResolutionMap.get(lidJid) || null;
    let phone = cached;
    if (!phone) {
        try {
            const pn = await waSocket.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
            if (pn && pn.endsWith('@s.whatsapp.net')) phone = pn;
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    if (phone && !lidResolutionMap.has(lidJid)) { lidResolutionMap.set(lidJid, phone); saveLidResolutionMap(); }
    res.json({ lid: lidJid, phone: phone || null, source: phone ? (cached ? 'cache' : 'query') : null });
});

// ── Groups endpoint ───────────────────────────────────────────────────────────
// Hasil di-cache. groupFetchAllParticipating() itu panggilan ke server WhatsApp,
// dan dashboard lama memanggilnya tiap 6 detik — itulah yang membuat WhatsApp
// menjawab 'rate-overlimit' dan daftar grup malah kosong saat dibutuhkan. Daftar
// grup nyaris tidak pernah berubah, jadi cache beberapa menit sudah cukup.
const GROUPS_TTL_MS = Number(process.env.GROUPS_TTL_MINUTES || 5) * 60 * 1000;
let groupsCache = { at: 0, data: null };

app.get('/groups', requireAuth, async (req, res) => {
    const fresh = req.query.fresh === '1';
    if (!fresh && groupsCache.data && Date.now() - groupsCache.at < GROUPS_TTL_MS) {
        return res.json({ groups: groupsCache.data, cached: true, age: Date.now() - groupsCache.at });
    }
    if (!waSocket) {
        // Bot lagi putus? Sajikan cache lama daripada gagal total.
        if (groupsCache.data) return res.json({ groups: groupsCache.data, cached: true, stale: true, age: Date.now() - groupsCache.at });
        return res.status(503).json({ error: 'Bot not connected' });
    }
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
        groupsCache = { at: Date.now(), data: groups };
        res.json({ groups, cached: false });
    } catch (err) {
        // Rate limit WhatsApp jangan menghapus daftar yang sudah pernah berhasil.
        if (groupsCache.data) {
            return res.json({ groups: groupsCache.data, cached: true, stale: true, error: err.message, age: Date.now() - groupsCache.at });
        }
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

// ── Messages endpoint (riwayat pesan per JID dari arsip persisten) ───────────
// Dulu endpoint ini membaca messageLog (100 entri, in-memory, semua ditandai
// fromMe:false). Sekarang dari msgArchive: dua arah, isi penuh, selamat dari restart.
app.get('/messages', requireAuth, (req, res) => {
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ error: 'jid required' });
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const msgs = msgArchive
        .filter(m => m.jid === jid)
        .slice(-limit)
        .map((m, i) => ({
            id: i,
            text: m.text || '',
            type: m.type,
            fromMe: m.dir === 'out',
            time: m.time,
            timestamp: m.time ? Math.floor(new Date(m.time).getTime() / 1000) : 0,
        }));
    res.json({ messages: msgs, count: msgs.length });
});

// ── Statistik gerbang ────────────────────────────────────────────────────────
app.get('/stats', requireAuth, (req, res) => {
    const days = Object.keys(stats.daily).sort();
    res.json({
        total: stats.total,
        today: stats.daily[statsDay()] || {},
        daily: stats.daily,
        days,
        archive: { messages: msgArchive.length, cap: MSG_ARCHIVE_CAP },
        since: days[0] || statsDay(),
    });
});

// ── Pengaturan sapaan ────────────────────────────────────────────────────────
app.get('/settings', requireAuth, (req, res) => {
    res.json({
        greeting: greetingText,
        isCustom: greetingText !== DEFAULT_GREETING,
        default: DEFAULT_GREETING,
        adminCallWords: [...ADMIN_CALL_WORDS],
        botPrefix: BOT_PREFIX,
        max: GREETING_MAX,
    });
});

app.post('/settings/greeting', requireAuth, (req, res) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'Teks sapaan tidak boleh kosong' });
    if (text.length > GREETING_MAX) return res.status(400).json({ error: `Maksimal ${GREETING_MAX} karakter` });
    greetingText = text;
    settings.greeting = text;
    saveSettings();
    console.log(`[settings] Sapaan diubah dari dashboard (${text.length} karakter).`);
    res.json({ ok: true, greeting: greetingText });
});

app.post('/settings/greeting/reset', requireAuth, (req, res) => {
    greetingText = DEFAULT_GREETING;
    delete settings.greeting;
    saveSettings();
    console.log('[settings] Sapaan dikembalikan ke bawaan.');
    res.json({ ok: true, greeting: greetingText });
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
        try { fs.writeFileSync(NEWSLETTER_FILE, JSON.stringify(list)); }
        catch (e) { console.error('[newsletter] gagal simpan:', e.message); }
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
    // Gambar status disimpan sebagai data URI base64. Tanpa batas, satu status foto
    // saja bisa menambah beberapa MB ke statuses.json — dan file itu dibaca ulang
    // penuh tiap kali status baru masuk.
    if (data.url && data.url.length > 400000) {
        console.warn('[status] Gambar terlalu besar untuk disimpan, hanya teksnya yang dicatat.');
        data = { ...data, url: null };
    }
    list.push(data);
    while (list.length > 50) list.shift();
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify(list)); }
    catch (e) { console.error('[status] gagal simpan:', e.message); }
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

// ── Riwayat pesan masuk (in-memory) ──────────────────────────────────────────
// Dulu ini juga didaftarkan sebagai GET /logs — nama yang sudah dipakai endpoint
// log sistem di atas, jadi Express selalu memilih yang pertama dan handler ini
// mati total. Diberi path sendiri supaya benar-benar bisa dipanggil.
app.get('/message-log', requireAuth, (req, res) => {
    res.json({ logs: messageLog });
});

// Keluar setelah tulisan sesi yang masih di udara selesai. process.exit() polos
// bisa memotong penulisan creds.json di tengah jalan — file sesi jadi separuh dan
// start berikutnya minta scan QR lagi.
function exitAfterFlush(code) {
    let done = false;
    const bye = () => { if (!done) { done = true; process.exit(code); } };
    flushAuthState().then(bye).catch(bye);
    setTimeout(bye, 5000).unref();
}

// Pemantau padam berkepanjangan. Dijalankan tiap menit; lihat catatan di
// OFFLINE_RESTART_MS soal kenapa restart proses adalah obat yang berbeda dari
// sekadar startBot() sekali lagi.
function watchProlongedOutage() {
    if (shuttingDown) return;
    // Menunggu manusia menyecan QR itu bukan kegagalan koneksi. Restart di sini
    // justru menghanguskan QR yang sedang dipelototi orang di dashboard, dan sesi
    // yang hilang tidak akan kembali oleh proses baru — itu butuh tangan admin.
    if (currentQR || sessionLostAt) return;
    // Belum pernah tersambung sejak proses hidup pun terhitung padam: kalau
    // startBot() membeku sebelum socket lahir, tidak ada event 'close' yang
    // mengisi offlineSince dan pemantau ini akan tidur selamanya.
    const padamSejak = offlineSince || (connectedAt ? null : PROSES_MULAI);
    if (!padamSejak) return;
    const ms = Date.now() - padamSejak;
    const ambang = ambangEskalasiMs();
    if (ms < ambang) return;
    offlineEscalations++;
    saveOutageGuard();
    console.warn(`[eskalasi] Padam ${Math.round(ms / 60000)} menit (ambang `
        + `${Math.round(ambang / 60000)} menit) — sambung-ulang biasa tidak menolong. `
        + `Proses dimatikan supaya pm2 menghidupkannya bersih. Eskalasi beruntun ke-${offlineEscalations}, `
        + `ambang berikutnya ${Math.round(ambangEskalasiMs() / 60000)} menit.`);
    // exitAfterFlush, bukan process.exit polos: penulisan creds yang masih di udara
    // harus mendarat dulu, kalau tidak restart daruratnya sendiri yang merusak sesi.
    exitAfterFlush(1);
}

// ── Restart endpoint ──────────────────────────────────────────────────────────
app.post('/restart', requireAuth, requireRelink, (req, res) => {
    res.json({ ok: true, message: 'Bot akan restart dalam 1 detik...' });
    setTimeout(() => exitAfterFlush(1), 1000);
});

// ── Reset / Hapus sesi ────────────────────────────────────────────────────────
app.get('/reset', requireAuth, requireRelink, async (req, res) => {
    try { await clearAuthState(); } catch (e) { console.error('[reset] gagal hapus sesi:', e); }
    res.send('Sesi dihapus. Restarting...');
    setTimeout(() => exitAfterFlush(1), 1000);
});

app.post('/reset', requireAuth, requireRelink, async (req, res) => {
    try { await clearAuthState(); } catch (e) { console.error('[reset] gagal hapus sesi:', e); }
    res.json({ ok: true, message: 'Sesi dihapus. Bot akan restart...' });
    setTimeout(() => exitAfterFlush(1), 1000);
});

// ── Pairing Code endpoint ─────────────────────────────────────────────────────
app.post('/pairing-code', requireAuth, requireRelink, async (req, res) => {
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

// ── Sapaan lama dari website → diganti sapaan resmi bot ──────────────────────
// Website punya jawaban cadangan sendiri ("Halo! 👋 Ketik salah satu perintah…")
// yang dikirimnya langsung lewat /send saat perintah pelanggan tidak dikenali.
// Teks itu memakai format TANPA titik, jadi mengajarkan cara pakai yang sudah
// tidak berlaku dan bertabrakan dengan sapaan bot. Selama repo website belum bisa
// disentuh, penggantinya dikerjakan di sini — di pintu masuknya.
//
// SADARI KELEMAHANNYA: ini pencocokan teks. Kalau suatu hari website mengubah
// kalimat sapaannya, penanda di bawah tidak lagi cocok dan sapaan lama akan lolos
// lagi tanpa error. Itu sebabnya setiap penggantian DICATAT ke log — kalau baris
// '[sapaan]' berhenti muncul padahal sapaan lama masih terlihat di HP, penandanya
// yang perlu disesuaikan (atau lebih baik: perbaiki di repo website).
const OLD_GREETING_MARK = process.env.OLD_GREETING_MARK || 'Ketik salah satu perintah berikut';
let legacyGreetingSwaps = 0;
function swapLegacyGreeting(text, jid) {
    if (!text || !String(text).includes(OLD_GREETING_MARK)) return text;
    legacyGreetingSwaps++;
    console.log(`[sapaan] Sapaan lama website dicegat untuk ${jid} → diganti sapaan bot `
        + `(total ${legacyGreetingSwaps}x sejak start).`);
    return greetingText;
}

// ── Pesan "Dicari" dari website → tambah ajakan jual langsung ─────────────────
// Broadcast "🔍 *Dicari:* …" disusun di repo website; selama repo itu belum bisa
// disentuh, tambahannya dikerjakan di sini — di pintu masuk /send, sama seperti
// sapaan lama di atas. Pencocokan teks juga: kalau website mengubah kalimat
// "Punya barangnya? 👉 …/dicari", penanda di bawah tidak cocok lagi dan tambahan
// diam-diam berhenti — pantau baris '[dicari]' di log.
const DICARI_LINK_MARK = 'Punya barangnya? 👉 https://www.jualbeliusupolmed.web.id/dicari';
const DICARI_JUAL_SUFFIX = ', Atau kalau mau lebih cepat langsung jual di https://www.jualbeliusupolmed.web.id/jual';
let dicariEnrichCount = 0;
function enrichDicariMessage(text, jid) {
    if (!text || typeof text !== 'string') return text;
    if (!text.includes(DICARI_LINK_MARK) || text.includes(DICARI_JUAL_SUFFIX)) return text;
    dicariEnrichCount++;
    console.log(`[dicari] Ajakan jual ditambahkan ke pesan Dicari untuk ${jid} `
        + `(total ${dicariEnrichCount}x sejak start).`);
    return text.replace(DICARI_LINK_MARK, DICARI_LINK_MARK + DICARI_JUAL_SUFFIX);
}

// ── Send message endpoint ─────────────────────────────────────────────────────
app.post('/send', requireAuth, async (req, res) => {
    const { target, url } = req.body;
    if (!target) return res.status(400).json({ error: 'Target required' });

    const jid = toJid(target);
    const message = enrichDicariMessage(swapLegacyGreeting(req.body.message, jid), jid);

    // Cap antrean: kalau menumpuk (bot lama offline), tolak daripada burst nanti.
    if (messageQueue.length > 200) {
        return res.status(503).json({ error: 'Antrean penuh, bot sedang tidak stabil' });
    }
    messageQueue.push({ jid, message, url, ts: Date.now() });
    kickQueue();
    res.json({ status: true, detail: 'Pesan ditambahkan ke antrean (Queue)' });
});

// ── Broadcast terbatas ────────────────────────────────────────────────────────
// Batasannya ditegakkan di SERVER, bukan cuma disembunyikan di UI: tujuan wajib
// kontak yang PERNAH mengirim pesan ke bot (ada di chatMap). Nomor hasil sinkron
// buku kontak, anggota grup, atau nomor yang diketik manual tidak diterima —
// mengirim pesan borongan ke orang yang tak pernah menghubungi kita itu spam, dan
// yang kena getahnya nomor WhatsApp ini sendiri (risiko blokir permanen).
const BROADCAST_MAX = Number(process.env.BROADCAST_MAX || 50);

// chatMap TIDAK dipakai sebagai sumber kelayakan: event chats.upsert mengisinya dari
// sinkronisasi daftar chat HP, jadi di dalamnya ikut nomor yang tidak pernah menulis
// ke bot. Dua sumber di bawah ini benar-benar berarti "orang ini menghubungi duluan":
//   - msgArchive dir 'in'  → ada pesan masuk yang tercatat
//   - greetedMap           → sapaan hanya terkirim sebagai jawaban atas pesan masuk
function broadcastTargets() {
    const eligible = new Set();
    for (const m of msgArchive) if (m.dir === 'in' && m.jid) eligible.add(m.jid);
    for (const jid of greetedMap.keys()) eligible.add(jid);
    return Array.from(eligible)
        .filter(jid => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))
        .map(jid => {
            const chat = chatMap.get(jid) || {};
            return {
                jid,
                name: chat.name || nameMap.get(jid) || contactMap.get(jid)?.name || '',
                lastTime: chat.lastTime || greetedMap.get(jid) || 0,
                preview: chat.preview || '',
            };
        })
        .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
}

app.get('/broadcast/targets', requireAuth, (req, res) => {
    const list = broadcastTargets();
    res.json({ targets: list, count: list.length, max: BROADCAST_MAX });
});

app.post('/broadcast', requireAuth, (req, res) => {
    const message = String(req.body?.message || '').trim();
    const jids = Array.isArray(req.body?.jids) ? req.body.jids : [];
    if (!message) return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
    if (!jids.length) return res.status(400).json({ error: 'Pilih minimal satu tujuan' });
    if (jids.length > BROADCAST_MAX) {
        return res.status(400).json({ error: `Maksimal ${BROADCAST_MAX} tujuan sekali kirim` });
    }
    if (messageQueue.length > 100) {
        return res.status(503).json({ error: 'Antrean sedang panjang, coba lagi nanti' });
    }
    const allowed = new Set(broadcastTargets().map(t => t.jid));
    const accepted = [], rejected = [];
    for (const raw of jids) {
        const jid = String(raw || '');
        if (allowed.has(jid)) accepted.push(jid); else rejected.push(jid);
    }
    if (!accepted.length) {
        return res.status(400).json({
            error: 'Tidak ada tujuan yang valid. Hanya kontak yang pernah chat bot yang bisa dikirimi.',
            rejected,
        });
    }
    // Lewat antrean yang sama dengan balasan biasa, jadi jeda antar kontak berbeda
    // (GAP_OTHER_*) tetap berlaku — kiriman menyebar, bukan burst.
    for (const jid of accepted) messageQueue.push({ jid, message, ts: Date.now() });
    kickQueue();
    bump('broadcast', accepted.length);
    console.log(`[broadcast] ${accepted.length} tujuan diantrekan${rejected.length ? `, ${rejected.length} ditolak (bukan kontak yang pernah chat)` : ''}.`);
    res.json({ ok: true, queued: accepted.length, rejected });
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
    if (!name?.trim() || !Array.isArray(participants) || !participants.length) {
        return res.status(400).json({ error: 'name and participants (array) required' });
    }
    try {
        const jids = participants.map(toJid);
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
    // Dulu `participants` tidak divalidasi: kalau tidak dikirim, `.map` melempar di
    // dalam try dan klien menerima 500 padahal itu salah input (400).
    if (!Array.isArray(participants) || !participants.length) {
        return res.status(400).json({ error: 'participants (array) required' });
    }
    try {
        const jids = participants.map(toJid);
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
    
    const jid = toJid(target);

    // Cap antrean sama seperti /send: cegah burst (pola spam → risiko blokir WA).
    if (messageQueue.length > 200) {
        return res.status(503).json({ error: 'Antrean penuh, bot sedang tidak stabil' });
    }
    messageQueue.push({ jid, poll: { name: name.trim(), values: options, selectableCount: 1 }, ts: Date.now() });
    kickQueue();
    res.json({ ok: true, detail: 'Poll ditambahkan ke antrean' });
});

// ── Ekstrak isi pesan — skip metadata wrapper (messageContextInfo, dll) ───────
const META_KEYS = new Set([
    'messageContextInfo',
    'senderKeyDistributionMessage',
    'deviceSentMessage', // sudah di-unwrap Baileys saat dekripsi; jaring pengaman saja
]);

// Tipe yang BUKAN percakapan — hanya metadata/aksi UI. Dulu semuanya jatuh ke
// cabang 'else' dan diteruskan ke webhook sebagai "non-text message", sehingga bot
// bisa membalas orang yang cuma nge-react emoji, mencoblos poll, atau menghapus
// pesannya sendiri.
const IGNORED_MESSAGE_TYPES = new Set([
    'reactionMessage',
    'encReactionMessage',
    'protocolMessage',        // hapus pesan / edit / sinkronisasi
    'pollUpdateMessage',      // orang mencoblos poll
    'reportingTokenMessage',
    'peerDataOperationRequestResponseMessage',
    'keepInChatMessage',
]);

function extractMessage(rawMessage) {
    if (!rawMessage) return { type: '', content: null, rawForMedia: rawMessage };

    // Buka SEMUA pembungkus: ephemeral, view-once V1/V2/V2Extension, edited,
    // documentWithCaption, dst. Dulu ini dikerjakan manual dan salah — rantai
    // `viewOnceMessageV2?.message?.viewOnceMessage?.message` menunjuk nesting yang
    // tidak ada, dan documentWithCaptionMessage tidak ditangani sama sekali, jadi
    // pesan view-once & dokumen berketerangan lolos sebagai "non-text message".
    // normalizeMessageContent bawaan Baileys menangani kesembilan pembungkusnya.
    const inner = normalizeMessageContent(rawMessage) || rawMessage;

    const type = Object.keys(inner).find(k => !META_KEYS.has(k)) || '';
    return { type, content: inner[type], rawForMedia: rawMessage };
}

// ── Bot core ──────────────────────────────────────────────────────────────────
// ── Versi protokol WhatsApp ──────────────────────────────────────────────────
// Versi yang ikut paket Baileys cepat basi; kalau ketinggalan, WhatsApp menolak
// handshake dengan kode 405 dan QR pun tidak pernah muncul. Jadi versinya diambil
// saat runtime — tapi dengan dua pengaman:
//
//  1. Hasilnya DISIMPAN ke disk. Saat pengambilan gagal (GitHub down / kena rate
//     limit karena loop reconnect menembaknya tiap 60 detik), kita pakai versi
//     terakhir yang terbukti jalan, BUKAN bawaan paket yang basi. Persis kejadian
//     18 Agu 2026: fetch gagal → jatuh ke versi bawaan → 405 beruntun 10 menit.
//  2. Cache dianggap segar selama 6 jam, jadi reconnect beruntun tidak lagi
//     memberondong raw.githubusercontent.com.
//
// fetch di dalam fetchLatestBaileysVersion() TIDAK punya timeout — kalau server
// GitHub menggantung, await-nya tak pernah selesai dan bot membeku sebelum
// makeWASocket, tanpa log apa pun. Timeoutnya harus kita bawa sendiri.
const WA_VERSION_FILE = path.join(DATA_DIR, 'wa_version.json');
const WA_VERSION_TTL_MS = Number(process.env.WA_VERSION_TTL_HOURS || 6) * 3600 * 1000;
let waVersionCache = null;
(function loadWaVersion() {
    try {
        const raw = JSON.parse(fs.readFileSync(WA_VERSION_FILE, 'utf-8'));
        if (Array.isArray(raw?.version) && raw.version.length) waVersionCache = raw;
    } catch (_) {}
})();

async function getWaVersion() {
    const fresh = waVersionCache && (Date.now() - (waVersionCache.at || 0) < WA_VERSION_TTL_MS);
    if (fresh) return waVersionCache.version;
    try {
        const { version, isLatest } = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000).unref()),
        ]);
        // isLatest:false artinya fetch-nya gagal diam-diam dan Baileys mengembalikan
        // versi bawaan paket — itu justru versi yang bikin 405. Jangan disimpan.
        if (!isLatest && waVersionCache) {
            console.warn(`[bot] Versi terbaru tak terbaca (dapat ${version.join('.')} basi). `
                + `Pakai versi tersimpan ${waVersionCache.version.join('.')}.`);
            return waVersionCache.version;
        }
        waVersionCache = { version, at: Date.now() };
        try { fs.writeFileSync(WA_VERSION_FILE, JSON.stringify(waVersionCache)); } catch (_) {}
        console.log(`[bot] Versi WA: ${version.join('.')} (terbaru: ${isLatest}).`);
        return version;
    } catch (e) {
        if (waVersionCache) {
            console.warn(`[bot] Gagal ambil versi WA (${e?.message || e}). `
                + `Pakai versi tersimpan ${waVersionCache.version.join('.')}.`);
            return waVersionCache.version;
        }
        console.error('[bot] Gagal ambil versi WA dan tidak ada cache, pakai bawaan Baileys:', e?.message || e);
        return undefined;
    }
}

// ── Simpanan pesan untuk permintaan kirim-ulang ──────────────────────────────
// Kalau perangkat lawan gagal mendekripsi sebuah pesan, WhatsApp meminta pengirim
// mengirimkannya ulang lewat getMessage(). Tanpa ini Baileys menjawab "tidak
// punya" → lawan bicara melihat "Menunggu pesan ini" selamanya, dan sesi signal
// ikut memburuk (gejalanya placeholderMessage yang muncul di log sebelum logout
// 401 tanggal 18 Agu 2026). Cukup di memori: yang dibutuhkan cuma pesan menit-
// menit terakhir.
const sentMsgStore = new Map();   // `${jid}:${id}` → proto message
const SENT_STORE_CAP = Number(process.env.SENT_STORE_CAP || 3000);
function rememberMsgContent(key, message) {
    if (!key?.id || !message) return;
    const k = `${key.remoteJid}:${key.id}`;
    if (sentMsgStore.has(k)) sentMsgStore.delete(k);
    sentMsgStore.set(k, message);
    while (sentMsgStore.size > SENT_STORE_CAP) sentMsgStore.delete(sentMsgStore.keys().next().value);
}

// Penghitung percobaan kirim-ulang milik Baileys. Tanpa cache ini, hitungannya
// hilang tiap pesan dan pasangan yang bermasalah bisa saling minta ulang tanpa henti.
const msgRetryCounterCache = {
    store: new Map(),
    get(key) { return this.store.get(key); },
    set(key, value) {
        if (this.store.has(key)) this.store.delete(key);
        this.store.set(key, value);
        while (this.store.size > 1000) this.store.delete(this.store.keys().next().value);
    },
    del(key) { this.store.delete(key); },
    flushAll() { this.store.clear(); },
};

// Nomor generasi socket. startBot() bisa terpanggil lebih dari sekali (watchdog,
// close handler, retry init); tanpa penanda ini, socket LAMA yang telat mengirim
// event masih ikut menulis creds dan mengubah state milik socket baru. Dua socket
// menulis creds yang sama = kunci sesi kacau = WhatsApp melepas perangkat.
let botGeneration = 0;
let startingBot = false;

async function startBot() {
    // Satu proses start pada satu waktu. Dua startBot() yang jalan bersamaan akan
    // membuat dua socket dengan creds yang sama — persis yang bikin sesi dilepas.
    if (startingBot) {
        console.log('[bot] startBot() dilewati: masih ada proses penyambungan berjalan.');
        // Jaring pengaman: kalau ternyata penyambungan itu gagal total dan tidak
        // menyisakan socket, rantai sambung-ulang jangan ikut mati di sini.
        setTimeout(() => { if (!waSocket) startBot().catch(() => {}); }, 10000).unref();
        return;
    }
    startingBot = true;
    const myGen = ++botGeneration;
    // Socket lama (kalau masih ada) ditutup dulu, jangan dibiarkan hidup paralel.
    if (waSocket) {
        try { waSocket.end(new Error('digantikan socket baru')); } catch (_) {}
        waSocket = null;
    }
    try {
        return await startBotInner(myGen);
    } finally {
        startingBot = false;
    }
}

async function startBotInner(myGen) {
    let state, saveCreds;
    if (supabase) {
        const authState = await useSupabaseAuthState(supabase, WA_SESSION_ID);
        state = authState.state;
        saveCreds = authState.saveCreds;
        clearAuthState = authState.clear;
        flushAuthState = authState.flush;
        console.log(`[auth] Sesi WhatsApp dimuat dari Supabase (session_id=${WA_SESSION_ID}).`);
    } else {
        // useFileAuthState (bukan useMultiFileAuthState bawaan): tulis atomik +
        // creds cadangan + cache baca. Format foldernya sama, sesi lama tetap jalan.
        const authState = await useFileAuthState(AUTH_DIR);
        state = authState.state;
        saveCreds = authState.saveCreds;
        clearAuthState = authState.clear;
        flushAuthState = authState.flush;
        console.log(`[auth] Sesi WhatsApp dimuat dari filesystem (${AUTH_DIR}).`);
    }

    // Muat nama user & resolusi @lid SEKALI saja (jangan clobber map in-memory saat
    // reconnect). Dari Supabase kalau ada, else file lokal.
    if (!stateLoaded) {
        nameMap = await loadState('name_map', NAME_MAP_FILE);
        lidResolutionMap = await loadState('lid_resolution_map', LID_MAP_FILE);
        greetedMap = await loadState('greeted_map', GREETED_FILE);
        stateLoaded = true;
        console.log(`[state] Dimuat: ${nameMap.size} nama, ${lidResolutionMap.size} resolusi @lid, ${greetedMap.size} kontak tersapa`);

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

    const waVersion = await getWaVersion();

    const waLogger = pino({ level: 'silent' });
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            // Kunci signal dibungkus cache: tiap dekripsi pesan membaca beberapa
            // kunci, dan folder sesi di sini berisi puluhan ribu file. Baca dari
            // disk terus-menerus bikin operasi signal telat → pesan gagal
            // didekripsi → sesi memburuk.
            keys: makeCacheableSignalKeyStore(state.keys, waLogger),
        },
        logger: waLogger,
        printQRInTerminal: false,
        browser: ['Mac OS', 'Chrome', '121.0.0.0'],
        ...(waVersion ? { version: waVersion } : {}),
        // Jangan tandai "online" saat tersambung: kalau bot terus-terusan online,
        // WhatsApp berhenti mengirim notifikasi ke HP admin.
        markOnlineOnConnect: false,
        // Riwayat lama tidak dipakai bot ini. Menariknya penuh = badai sinkronisasi
        // ribuan penulisan kunci tiap kali tersambung.
        syncFullHistory: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 1000,
        maxMsgRetryCount: 5,
        msgRetryCounterCache,
        // Dipakai Baileys saat lawan bicara minta kirim ulang pesan yang gagal
        // ia dekripsi. Lihat catatan di sentMsgStore.
        getMessage: async (key) => sentMsgStore.get(`${key.remoteJid}:${key.id}`) || undefined,
    });
    waSocket = sock;
    sock.ev.on('creds.update', saveCreds);

    // Simpan isi pesan (masuk maupun keluar) untuk melayani permintaan kirim ulang.
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const m of messages || []) {
            if (m?.key && m.message) rememberMsgContent(m.key, m.message);
        }
    });

    // Rantai sambung-ulang milik socket ini. Hanya BOLEH dijadwalkan sekali: entah
    // oleh handler 'close' atau oleh watchdog di bawah, jangan dua-duanya.
    let reconnectScheduled = false;
    let connectWatchdog = null;
    const scheduleRestart = (delayMs) => {
        if (reconnectScheduled) return;
        // Socket generasi lama tidak boleh menjadwalkan apa pun: yang aktif sekarang
        // sudah socket lain, dan menyambung ulang dari sini malah membunuhnya.
        if (myGen !== botGeneration) return;
        reconnectScheduled = true;
        if (connectWatchdog) clearTimeout(connectWatchdog);
        setTimeout(() => startBot().catch((e) => {
            // Tanpa catch di sini, startBot() yang reject bikin rantai reconnect
            // putus diam-diam dan bot "hidup" tapi tidak pernah nyambung lagi.
            console.error('[reconnect] startBot gagal:', e?.message || e);
            setTimeout(() => startBot().catch(() => {}), 10000);
        }), delayMs);
    };

    // Watchdog: pernah kejadian socket berhenti di 'connecting' tanpa event lanjutan,
    // jadi tidak ada yang menjadwalkan startBot() dan bot diam berhari-hari.
    const armWatchdog = (ms, fase) => {
        if (connectWatchdog) clearTimeout(connectWatchdog);
        connectWatchdog = setTimeout(() => {
            if (reconnectScheduled || myGen !== botGeneration) return;
            reconnectAttempts++;
            const backoff = Math.min(3000 * Math.pow(1.8, reconnectAttempts - 1), 60000);
            console.log(`[watchdog] Nyangkut di '${fase}' >${Math.round(ms / 1000)}s. `
                + `Paksa tutup, reconnect ke-${reconnectAttempts} dalam ${Math.round(backoff / 1000)}s...`);
            try { sock.end(new Error('connect timeout')); } catch (_) {}
            scheduleRestart(backoff);
        }, ms);
    };
    armWatchdog(CONNECT_TIMEOUT_MS, 'connecting');

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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        // Event dari socket yang sudah digantikan: abaikan seluruhnya, jangan
        // sampai ia menimpa state milik socket yang sekarang hidup.
        if (myGen !== botGeneration) return;
        if (qr) {
            currentQR = qr;
            // Nunggu QR discan itu WAJAR, bukan nyangkut — jangan diputus watchdog
            // 90 detik. Baileys punya qrTimeout sendiri yang menutup koneksi kalau
            // QR kedaluwarsa; watchdog di sini cuma jaring pengaman terakhir.
            armWatchdog(QR_WAIT_TIMEOUT_MS, 'menunggu scan QR');
        }
        if (connection === 'close') {
            if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null; }
            // Pembersihan state HARUS mendahului guard `reconnectScheduled` di bawah.
            // Dulu `return`-nya duluan, jadi kalau watchdog yang menutup socket,
            // waSocket/connectedPhone tetap menunjuk socket mati: /status & /health
            // bilang "connected" dan antrean terus menembak socket itu.
            connectedPhone = '';
            connectedAt = null;
            if (!offlineSince) offlineSince = Date.now();
            // Hanya lepas kalau socket INI yang masih terpasang — socket lama yang
            // telat mengirim 'close' jangan sampai menjatuhkan socket baru yang sehat.
            if (waSocket === sock) waSocket = null;
            // Sambungan putus sebelum sempat dianggap stabil → hitungan eskalasi
            // TIDAK jadi dinolkan.
            if (escalationResetTimer) { clearTimeout(escalationResetTimer); escalationResetTimer = null; }
            // Bersihkan timer photoBuffer agar tidak leak saat reconnect
            for (const entry of photoBuffer.values()) {
                if (entry.timer) clearTimeout(entry.timer);
            }
            photoBuffer.clear();
            conversationContext.clear();
            if (reconnectScheduled) return; // watchdog sudah menjadwalkan sambung ulang
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            // PENTING: HANYA 401 (loggedOut) yang boleh menghapus sesi. Kode lain
            // (428 gangguan sementara, 515 restartRequired yang NORMAL) cukup sambung
            // ulang dgn creds yang sama. Menghapus sesi → QR scan ulang berulang =
            // sinyal mencurigakan ke WhatsApp → risiko nomor diblokir.
            if (statusCode === 401) {
                logoutStrikes++;
                if (logoutStrikes < LOGOUT_STRIKES) {
                    // Belum tentu benar-benar dilepas dari HP. Coba lagi dengan creds
                    // yang SAMA — kalau 401-nya cuma gangguan sementara, bot pulih
                    // sendiri dan tidak ada yang perlu scan apa pun.
                    console.warn(`[reconnect] Dapat 401 (percobaan ${logoutStrikes}/${LOGOUT_STRIKES}). `
                        + 'Sesi BELUM dihapus, coba sambung ulang dengan sesi yang sama...');
                    reconnectAttempts = 0;
                    scheduleRestart(5000 * logoutStrikes);
                } else {
                    console.warn(`[reconnect] 401 berturut-turut ${logoutStrikes}x — perangkat memang `
                        + 'dilepas dari WhatsApp. Sesi dicadangkan, bot akan menampilkan QR.');
                    sessionLostAt = new Date().toISOString();
                    logoutStrikes = 0;
                    bump('sesi_hilang');
                    // WAJIB ditunggu: dulu penghapusan sesi berjalan berbarengan dengan
                    // socket baru yang sudah mulai menulis creds, jadi creds baru ikut
                    // terhapus dan QR yang barusan discan langsung hangus.
                    try { await clearAuthState(); } catch (e) { console.error('[reconnect] Gagal cadangkan sesi:', e); }
                    reconnectAttempts = 0;
                    scheduleRestart(3000);
                }
            } else if (statusCode === 515) {
                // restartRequired — normal (mis. tepat setelah pairing). Sambung ulang cepat.
                console.log('[reconnect] restartRequired (515). Sambung ulang tanpa hapus sesi...');
                reconnectAttempts = 0;
                scheduleRestart(2000);
            } else {
                // 428 & lainnya = gangguan sementara. Sambung ulang backoff, JANGAN hapus sesi.
                reconnectAttempts++;
                const backoff = Math.min(3000 * Math.pow(1.8, reconnectAttempts - 1), 60000);
                console.log(`[reconnect] Koneksi terputus (kode: ${statusCode ?? 'unknown'}). Reconnect ke-${reconnectAttempts} dalam ${Math.round(backoff/1000)}s...`);
                scheduleRestart(backoff);
            }
        } else if (connection === 'open') {
            // Wajib: kalau tidak dimatikan, watchdog ikut menembak socket yang sehat.
            if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null; }
            currentQR = '';
            connectedPhone = sock.user?.id?.split(':')[0] || '';
            connectedAt = new Date().toISOString();
            reconnectAttempts = 0;
            logoutStrikes = 0;   // sambungan sehat → hitungan 401 mulai dari nol lagi
            // Hitungan eskalasi baru boleh nol setelah sambungan terbukti bertahan
            // (lihat ESCALATION_RESET_MS), bukan pada detik 'open' ini.
            if (offlineEscalations > 0 && !escalationResetTimer) {
                escalationResetTimer = setTimeout(() => {
                    escalationResetTimer = null;
                    if (!socketAlive()) return;
                    offlineEscalations = 0;
                    saveOutageGuard();
                    console.log('[eskalasi] Sambungan stabil — hitungan restart darurat kembali ke nol.');
                }, ESCALATION_RESET_MS);
                escalationResetTimer.unref?.();
            }
            sessionLostAt = null;
            console.log('[bot] Berhasil terhubung ke WhatsApp! Nomor:', connectedPhone);
            // Putus yang baru saja berakhir dicatat, dan yang lama dilaporkan ke pemilik.
            // Sengaja dilaporkan di sini (bukan saat putus): kanalnya sendiri baru hidup
            // sekarang. Yang pendek (reconnect biasa, mis. kode 515) tidak dilaporkan
            // supaya notifikasi tidak jadi kebisingan yang akhirnya diabaikan.
            if (offlineSince) {
                const ms = Date.now() - offlineSince;
                lastOutage = { startedAt: new Date(offlineSince).toISOString(), endedAt: new Date().toISOString(), ms };
                outageCount++;
                offlineSince = null;
                bump('putus_koneksi');
                if (ms >= OFFLINE_ALERT_MS) {
                    const menit = Math.round(ms / 60000);
                    console.warn(`[alarm] Bot sempat offline ${menit} menit.`);
                    notifyOwner(`⚠️ *Bot sempat offline ${menit} menit*\n\nPutus: ${new Date(lastOutage.startedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\nPulih: ${new Date(lastOutage.endedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n\nPesan yang masuk selama itu tidak dibalas otomatis — cek inbox di dashboard.`);
                }
            }
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

            // ── Centang biru SENGAJA TIDAK dikirim ──
            // Dulu di sini ada sock.readMessages([msg.key]) yang jalan tiap pesan masuk.
            // Efeknya centang biru nongol instan, bahkan sebelum admin buka HP — malah
            // jadi penanda jelas bahwa yang jaga itu bot. Biar centang tetap abu-abu
            // sampai admin beneran membuka chatnya di HP.

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
            // (status@broadcast sudah di-`continue` di blok di atas.)
            if (!sender || sender.includes('@newsletter')) continue;

            // Reaksi emoji, hapus/edit pesan, dan coblosan poll bukan percakapan —
            // buang di sini sebelum apa pun diteruskan ke webhook.
            if (IGNORED_MESSAGE_TYPES.has(extractMessage(msg.message).type)) continue;

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
                    gForm.append('message', stripInvisible(text));
                    gForm.append('source', 'group');
                    gForm.append('group_jid', sender);
                    if (buf) gForm.append('file', new Blob([buf], { type: mime }), fname);
                    await fetch(WEBHOOK_URL, { method: 'POST', body: gForm, headers: { 'Authorization': API_TOKEN } }).catch(() => {});
                } catch (e) { console.error('[grup] error:', e.message); }
                continue;
            }

            try {
                const { type: messageType, content, rawForMedia } = extractMessage(msg.message);

                // Teks mentah dipakai untuk memutuskan gerbang bot SEBELUM media
                // di-download — pesan buat admin tak perlu ongkos unduh foto/video.
                const gateText = stripInvisible(
                    messageType === 'conversation' ? content : (content?.text || content?.caption || '')
                );
                const hasPrefix = gateText.startsWith(BOT_PREFIX);
                // Kunci sesi/sapaan pakai remoteJid apa adanya: nilai ini konsisten untuk
                // kontak yang sama (termasuk pada pesan fromMe), sementara hasil resolve
                // @lid→nomor baru tersedia belakangan dan bisa berubah di tengah jalan.
                const gateKey = sender;

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
                        // Admin sudah turun tangan → tutup sesi bot di kontak ini juga,
                        // biar bot tidak nyeletuk lagi di tengah obrolan manual.
                        botSessions.delete(gateKey);
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
                        // Balasan manual admin ikut diarsipkan, kalau tidak inbox dashboard
                        // cuma menampilkan sisi pelanggan dan riwayatnya terbaca timpang.
                        recordMessage(manualTarget, 'out', isMediaFm ? (fmText || '[media]') : fmText, 'manual');
                        bump('balas_manual');
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
                        } else if (!askedNameOnce.has(sender) && (hasPrefix || botSessionActive(gateKey))) {
                            // Hanya ditanyakan kalau pesannya memang ditujukan ke bot —
                            // pelanggan yang mau ngobrol ke admin tak perlu diminta nama.
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
                // Arsip persisten (dipakai inbox dashboard). Sengaja memakai gateText:
                // isi teks apa adanya, bukan preview terpotong seperti messageLog.
                recordMessage(cleanSender, 'in', gateText || '[media]', messageType);
                bump('masuk');

                // ── Gerbang titik ─────────────────────────────────────────────────
                // Aturannya: chat pelanggan itu milik ADMIN sampai pelanggan sendiri
                // yang memanggil bot dengan tanda titik. Pesan yang tidak lolos gerbang
                // TIDAK diteruskan ke webhook — webhook adalah otak balasan otomatis,
                // meneruskannya sama saja dengan menyuruh bot menyahut.
                if (!msg.key.fromMe) {
                    const inSession = botSessionActive(gateKey);
                    // Sesi bisa ditutup pelanggan kapan saja ("admin", "selesai", ...)
                    // tanpa menunggu BOT_SESSION_MS habis.
                    // Panggilan "min" → selalu dijawab sapaan, sesi bot (kalau ada)
                    // ditutup. Ini melewati greetedMap dengan sengaja: sapaan biasa
                    // sekali seumur kontak, sedangkan orang yang manggil "min" memang
                    // sedang minta petunjuk saat itu juga.
                    if (!hasPrefix && isAdminCall(gateText)) {
                        botSessions.delete(gateKey);
                        bump('panggil_min');
                        const lastCall = adminCallMap.get(gateKey) || 0;
                        if (Date.now() - lastCall >= ADMIN_CALL_COOLDOWN_MS) {
                            adminCallMap.set(gateKey, Date.now());
                            rememberBotSent(await sock.sendMessage(sender, { text: greetingText }));
                            recordMessage(cleanSender, 'out', greetingText, 'sapaan');
                            bump('sapaan');
                            console.log(`[gerbang] ${cleanSender} panggil admin ("${gateText}") → sapaan dikirim`);
                        } else {
                            console.log(`[gerbang] ${cleanSender} panggil admin ("${gateText}") → sapaan ditahan (cooldown)`);
                        }
                        // Tandai tersapa supaya pesan polos berikutnya tidak memicu
                        // sapaan "sekali per kontak" untuk kedua kalinya.
                        if (!greetedMap.has(gateKey)) { greetedMap.set(gateKey, Date.now()); saveGreetedMap(); }
                        continue;
                    }
                    if (inSession && !hasPrefix && BOT_END_WORDS.has(gateText.toLowerCase())) {
                        botSessions.delete(gateKey);
                        console.log(`[gerbang] ${cleanSender} menutup sesi bot ("${gateText}") → lanjut ke admin`);
                        continue;
                    }
                    if (!hasPrefix && !inSession) {
                        // Pesan polos yang sebenarnya kata perintah ("jual", "cari sepatu")
                        // dihitung terpisah. Angka inilah bukti apakah gerbang titik bikin
                        // pelanggan nyangkut — tanpa itu, melonggarkan gerbang cuma tebakan.
                        const plainCmd = plainCommandWord(gateText);
                        if (plainCmd) { bump('perintah_polos'); bump(`polos_${plainCmd}`); }
                        if (!greetedMap.has(gateKey)) {
                            greetedMap.set(gateKey, Date.now());
                            saveGreetedMap();
                            rememberBotSent(await sock.sendMessage(sender, { text: greetingText }));
                            recordMessage(cleanSender, 'out', greetingText, 'sapaan');
                            bump('sapaan');
                            console.log(`[gerbang] ${cleanSender} → chat admin, sapaan dikirim (sekali)`);
                        } else {
                            bump('didiamkan');
                            console.log(`[gerbang] ${cleanSender} → chat admin, bot diam`);
                        }
                        continue;
                    }
                    // Lolos gerbang: buka/segarkan sesi supaya pesan lanjutan (jawaban
                    // tanya-jawab, foto tanpa caption) tidak perlu bertitik lagi.
                    if (!inSession) bump('sesi_bot');
                    botSessions.set(gateKey, Date.now() + BOT_SESSION_MS);
                }

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
                            const cleanCap = stripBotPrefix(stripInvisible(entry.caption));
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
                let cleanText = stripBotPrefix(stripInvisible(text));
                // Titik telanjang tanpa perintah: jangan kirim pesan kosong ke webhook
                // (balasannya jadi ngawur) — perlakukan sebagai permintaan menu.
                if (hasPrefix && !cleanText && !hasMedia) cleanText = 'MENU';

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

                // Waktu bulat-bulat website: dari POST sampai badan balasan terbaca.
                // Tanpa angka ini, "bot lambat" tidak bisa dibedakan dari "website lambat".
                const hookStart = Date.now();
                const response = await fetch(WEBHOOK_URL, {
                    method: 'POST',
                    body: form,
                    headers: { 'Authorization': API_TOKEN }
                });
                const responseText = await response.text();
                const hookMs = Date.now() - hookStart;
                if (!response.ok) {
                    bump('webhook_gagal');
                    console.error(`Webhook error ${response.status} (${hookMs}ms): ${responseText}`);
                } else {
                    bump('webhook_ok');
                    console.log(`Webhook OK (${hookMs}ms): ${responseText}`);
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
// Stack ikut dicetak — tanpa itu, `e.message` sendirian sering tak cukup untuk tahu
// baris mana yang melempar.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack || e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e?.message || e));

// pm2 restart/stop mengirim SIGTERM. Tanpa handler ini, perubahan contactMap/chatMap
// sampai 10 detik terakhir (jeda autosave) hilang tiap kali bot di-restart.
let shuttingDown = false;
function gracefulExit(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${sig} diterima — menyimpan state sebelum keluar...`);
    saveMapToFile(contactMap, CONTACTS_FILE);
    saveMapToFile(chatMap, CHATS_FILE);
    flushMsgArchive();
    flushStats();
    Promise.allSettled([
        saveState('name_map', nameMap, NAME_MAP_FILE),
        saveState('lid_resolution_map', lidResolutionMap, LID_MAP_FILE),
        // Penulisan creds yang masih di udara HARUS mendarat dulu. Memotongnya di
        // tengah jalan meninggalkan file sesi separuh — dan sesi separuh itulah yang
        // membuat bot start berikutnya mengira dirinya instalasi baru lalu minta QR.
        flushAuthState(),
    ]).then(() => process.exit(0));
    // Kalau Supabase menggantung, jangan tahan proses selamanya.
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));

// Dengar HANYA di loopback: akses publik ditutup, semua trafik masuk lewat
// reverse-proxy nginx (HTTPS) → 127.0.0.1:3000. Bisa di-override via env BIND_HOST
// (mis. '0.0.0.0') kalau suatu saat perlu, tapi default aman.
app.listen(PORT, process.env.BIND_HOST || '127.0.0.1', () => {
    console.log(`Bot Server listening on ${process.env.BIND_HOST || '127.0.0.1'}:${PORT}`);
    // unref: pemantau tidak boleh jadi alasan proses menolak keluar saat shutdown.
    setInterval(watchProlongedOutage, 60000).unref();
    startBot().catch((e) => {
        console.error('[startBot] gagal init:', e?.message || e);
        setTimeout(() => startBot().catch(() => {}), 10000); // coba lagi 10 dtk
    });
});
