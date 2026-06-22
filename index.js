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

// ── Newsletters / Channels endpoint ──────────────────────────────────────────
app.get('/newsletters', requireAuth, async (req, res) => {
    if (!waSocket) return res.status(503).json({ error: 'Bot not connected' });
    try {
        const newsletters = await waSocket.newsletterSubscribed();
        const list = (newsletters || []).map(n => ({
            jid: n.id,
            name: n.name || 'Tanpa Nama',
            description: n.description || '',
            subscribers: n.subscriberCount || 0,
        }));
        res.json({ newsletters: list });
    } catch (err) {
        res.json({ newsletters: [], note: 'Fitur newsletter belum tersedia di versi Baileys ini.' });
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

// ── Reset / Hapus sesi (GET untuk browser, POST untuk API) ───────────────────
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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) currentQR = qr;
        if (connection === 'close') {
            connectedPhone = '';
            connectedAt = null;
            if (lastDisconnect.error?.output?.statusCode !== 401) startBot();
            else {
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
                const messageType = Object.keys(msg.message)[0];
                let text = '', hasMedia = false, buffer = null, mimeType = '', filename = '';

                if (messageType === 'conversation') text = msg.message.conversation;
                else if (messageType === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
                else if (messageType === 'imageMessage') {
                    hasMedia = true;
                    text = msg.message.imageMessage.caption || '';
                    mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
                    filename = 'image.jpg';
                    buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                } else continue;

                const cleanSender = sender.split('@')[0].split(':')[0];
                console.log(`Pesan dari ${cleanSender} | type: ${messageType}`);

                // Simpan ke in-memory log (max 100)
                messageLog.unshift({
                    sender: cleanSender,
                    type: messageType,
                    preview: text?.slice(0, 100) || '[media]',
                    time: new Date().toISOString(),
                });
                if (messageLog.length > 100) messageLog.pop();

                const form = new FormData();
                form.append('sender', cleanSender);
                form.append('message', text);
                if (hasMedia && buffer) form.append('file', new Blob([buffer], { type: mimeType }), filename);

                const response = await fetch(WEBHOOK_URL, { method: 'POST', body: form });
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
