const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://www.jualbeliusupolmed.web.id/api/wa/baileys';
const API_TOKEN = process.env.API_TOKEN || 'jualbeliusu_rahasia';
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';


const app = express();
app.use(express.json());

let waSocket = null;
let currentQR = '';
let connectedPhone = '';
let connectedAt = null;
let messageLog = []; // in-memory log (max 100 entries)
let contactMap = new Map(); // jid → { jid, name }
let chatMap = new Map();    // jid → { jid, name, lastTime, preview }

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.headers.authorization !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ── QR Page (public) ─────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
    if (!currentQR) return res.send('<p>Bot terhubung!</p>');
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`<img src="${qrImage}" />`);
    } catch (err) { res.status(500).send('Error'); }
});

// ── Status endpoint ───────────────────────────────────────────────────────────
app.get('/status', requireAuth, (req, res) => {
    const isConnected = waSocket && !currentQR;
    res.json({
        connected: isConnected,
        phone: connectedPhone || null,
        connectedAt: connectedAt || null,
        hasQR: !!currentQR,
        uptime: Math.floor(process.uptime()),
        webhookUrl: WEBHOOK_URL,
    });
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
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    const list = Array.from(chatMap.values())
        .filter(c => c.jid.endsWith('@s.whatsapp.net') || c.jid.endsWith('@lid'))
        .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    res.json({ chats: list });
});

// ── Newsletters / Channels endpoint ──────────────────────────────────────────
const NEWSLETTER_FILE = 'newsletters.json';
function getSavedNewsletters() {
    const fs = require('fs');
    if (fs.existsSync(NEWSLETTER_FILE)) {
        try { return JSON.parse(fs.readFileSync(NEWSLETTER_FILE, 'utf-8')); } catch(e) {}
    }
    return [];
}
function saveNewsletter(data) {
    const fs = require('fs');
    const list = getSavedNewsletters();
    if (!list.find(n => n.jid === data.jid)) {
        list.push(data);
        fs.writeFileSync(NEWSLETTER_FILE, JSON.stringify(list));
    }
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
    setTimeout(() => process.exit(0), 1000);
});

// ── Reset / Hapus sesi ────────────────────────────────────────────────────────
app.get('/reset', (req, res) => {
    const fs = require('fs');
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.send('Sesi dihapus. Restarting...');
    setTimeout(() => process.exit(1), 1000);
});

app.post('/reset', requireAuth, (req, res) => {
    const fs = require('fs');
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.json({ ok: true, message: 'Sesi dihapus. Bot akan restart...' });
    setTimeout(() => process.exit(1), 1000);
});

// ── Send message endpoint ─────────────────────────────────────────────────────
app.post('/send', requireAuth, async (req, res) => {
    const { target, message, url } = req.body;
    if (!target || !waSocket) return res.status(400).json({ error: 'Target or WA not ready' });

    let jid = String(target);
    if (!jid.includes('@')) {
        let num = jid.replace(/[^0-9]/g, '');
        if (num.startsWith('0')) num = '62' + num.substring(1);
        jid = num + '@s.whatsapp.net';
    }

    try {
        await waSocket.presenceSubscribe(jid);
        await waSocket.sendPresenceUpdate('composing', jid);

        let result;
        if (url) {
            result = await waSocket.sendMessage(jid, { image: { url: url }, caption: message });
        } else {
            result = await waSocket.sendMessage(jid, { text: message });
        }
        console.log("Send Result for " + jid + ":", result?.key?.id);
        res.json({ status: true, detail: 'Message sent successfully' });
    } catch (err) {
        res.status(500).json({ status: false, reason: err.message });
    }
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
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop')
    });
    waSocket = sock;
    sock.ev.on('creds.update', saveCreds);

    // Bangun daftar kontak & chat dari event Baileys (pengganti makeInMemoryStore)
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.id) contactMap.set(c.id, { jid: c.id, name: c.name || c.notify || c.verifiedName || '' });
        }
    });
    sock.ev.on('contacts.update', (updates) => {
        for (const u of updates) {
            if (!u.id) continue;
            const existing = contactMap.get(u.id) || { jid: u.id, name: '' };
            contactMap.set(u.id, { ...existing, name: u.name || u.notify || u.verifiedName || existing.name });
        }
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
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) currentQR = qr;
        if (connection === 'close') {
            connectedPhone = '';
            connectedAt = null;
            if (lastDisconnect.error?.output?.statusCode !== 401) {
                console.log('Koneksi terputus. Exiting process agar di-restart oleh PM2/Docker...');
                process.exit(1);
            } else {
                require('fs').rmSync(AUTH_DIR, { recursive: true, force: true });
                process.exit(1);
            }
        } else if (connection === 'open') {
            currentQR = '';
            connectedPhone = sock.user?.id?.split(':')[0] || '';
            connectedAt = new Date().toISOString();
            console.log('Berhasil terhubung ke WhatsApp! Nomor:', connectedPhone);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const sender = msg.key.remoteJid;

            if (!sender || sender.includes('@g.us') || sender === 'status@broadcast' || sender.includes('@newsletter')) continue;

            try {
                const { type: messageType, content, rawForMedia } = extractMessage(msg.message);

                // Kirim full JID ke Vercel (strip device suffix :N saja, pertahankan @domain)
                // "628xxx:15@s.whatsapp.net" → "628xxx@s.whatsapp.net"
                // "18318xxx@lid" → "18318xxx@lid"
                const cleanSender = sender.replace(/:(\d+)(?=@)/, '');

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
                } else {
                    // Stiker, audio, video, dokumen → balas dengan petunjuk
                    text = 'non-text message';
                }

                // Strip BOM dan invisible chars agar FormData tidak gagal encode
                const cleanText = (text || '').replace(/[﻿​-‍⁠­]/g, '').trim();

                const form = new FormData();
                form.append('sender', cleanSender);
                form.append('message', cleanText);
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
                }
            } catch (err) {
                console.error('Error memproses pesan:', err.message);
            }
        }
    });
}

app.listen(PORT, () => { console.log(`Bot Server listening on port ${PORT}`); startBot(); });
