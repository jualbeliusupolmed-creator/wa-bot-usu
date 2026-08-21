/*
 * Utilitas murni bot — tidak menyimpan state, tidak menyentuh soket, tidak
 * menyentuh berkas.
 *
 * Ini kumpulan pertama yang dipindah keluar dari index.js, dan dipilih pertama
 * justru karena membosankan: tiap fungsi di sini menerima masukan dan
 * mengembalikan keluaran, tanpa bergantung pada apa pun yang bisa berubah.
 * Yang membosankan bisa dipindah tanpa mengubah perilaku — dan pemindahan
 * pertama sebaiknya membuktikan alat kerjanya, bukan menguji keberanian.
 *
 * Aturan berkas ini: kalau sebuah fungsi butuh `waSocket`, `settings`, `stats`,
 * atau apa pun yang bisa berubah saat bot berjalan, ia BUKAN milik sini.
 */
const crypto = require('crypto');
const { normalizeMessageContent } = require('@whiskeysockets/baileys');

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

// ── Gerbang bot ───────────────────────────────────────────────────────────────
// Default percakapan pelanggan adalah dengan ADMIN (manusia). Bot baru ikut campur
// kalau pesan diawali tanda ini. Tanpa gerbang, bot menyahut tiap chat masuk dan
// admin jadi tak leluasa membalas manual.
const BOT_PREFIX = process.env.BOT_PREFIX || '.';

// Panggilan ke admin ("min"). Bedanya dengan BOT_END_WORDS: kata di sini BUKAN cuma
// menutup sesi, tapi selalu dibalas sapaan — orang yang manggil "min" jelas sedang
// mencari manusia, jadi dia harus langsung tahu chat ini dipegang admin dan bot
// punya jalur titik sendiri. Sengaja dipisah supaya "admin"/"stop" di tengah alur
// .JUAL tetap menutup sesi tanpa memuntahkan sapaan panjang.
const ADMIN_CALL_WORDS = new Set(
    (process.env.ADMIN_CALL_WORDS || 'min,mimin')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

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

// Set berukuran terbatas (FIFO) — cegah pertumbuhan memori tak terbatas pada bot
// yang uptime-nya panjang di VPS.
function boundedSet(cap) {
  const s = new Set();
  const q = [];
  const _add = s.add.bind(s);
  s.add = (v) => { if (!s.has(v)) { q.push(v); if (q.length > cap) s.delete(q.shift()); } return _add(v); };
  return s;
}

// Tujuan setelah masuk datang dari alamat, artinya dari luar. Terima HANYA jalur
// internal: tanpa ini, /masuk?next=https://situs-jahat berubah jadi pengalihan
// terbuka yang meminjam kredibilitas domain ini.
function amanTujuan(n) {
    const t = String(n || '/');
    if (!t.startsWith('/') || t.startsWith('//')) return '/';
    return t;
}

// Permintaan ke WhatsApp yang tidak pernah dijawab. Sesekali terjadi meski sesi
// sehat (server WA rewel, jaringan setengah mati), dan tanpa batas waktu ia
// menahan satu koneksi HTTP selamanya. Lebih baik 504 yang jujur.
function dgnBatas(janji, ms = 15000, apa = 'Permintaan ke WhatsApp') {
    return Promise.race([
        janji,
        new Promise((_, tolak) => setTimeout(() => tolak(new Error(`${apa} tidak dijawab dalam ${Math.round(ms / 1000)} detik.`)), ms)),
    ]);
}

// Teks dari struktur pesan Baileys, apa pun bungkusnya.
function teksPesan(msg) {
    if (!msg) return '';
    return msg.conversation
        || msg.extendedTextMessage?.text
        || msg.imageMessage?.caption
        || msg.videoMessage?.caption
        || msg.documentMessage?.caption
        || '';
}

// ── Ekstrak isi pesan — skip metadata wrapper (messageContextInfo, dll) ───────
const META_KEYS = new Set([
    'messageContextInfo',
    'senderKeyDistributionMessage',
    'deviceSentMessage', // sudah di-unwrap Baileys saat dekripsi; jaring pengaman saja
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

module.exports = {
    SIGNAL_NOISE,
    isSignalNoise,
    safeStringify,
    INVISIBLE_RE,
    stripInvisible,
    stripBotPrefix,
    toJid,
    BOT_PREFIX,
    ADMIN_CALL_WORDS,
    isAdminCall,
    PLAIN_COMMAND_WORDS,
    plainCommandWord,
    boundedSet,
    amanTujuan,
    dgnBatas,
    teksPesan,
    META_KEYS,
    extractMessage,
};
