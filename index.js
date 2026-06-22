const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

const WEBHOOK_URL = 'https://jualbeliusupolmed.vercel.app/api/wa/baileys';
const API_TOKEN = process.env.API_TOKEN || 'jualbeliusu_rahasia';
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';

const app = express();
app.use(express.json());

let waSocket = null;
let currentQR = '';

app.get('/', async (req, res) => {
    if (!currentQR) return res.send('<p>Bot terhubung!</p>');
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`<img src="${qrImage}" />`);
    } catch (err) { res.status(500).send('Error'); }
});

app.get('/reset', (req, res) => {
    const fs = require('fs');
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.send('Sesi dihapus. Restarting...');
    setTimeout(() => process.exit(1), 1000);
});

app.post('/send', async (req, res) => {
    if (req.headers.authorization !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

    const { target, message, url } = req.body;
    if (!target || !waSocket) return res.status(400).json({ error: 'Target or WA not ready' });

    let jid = String(target);
    if (!jid.includes('@')) {
        let num = jid.replace(/[^0-9]/g, '');
        if (num.startsWith('0')) {
            num = '62' + num.substring(1);
        }
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

// Ambil isi pesan aktual — skip metadata wrapper seperti messageContextInfo
function extractMessage(rawMessage) {
    if (!rawMessage) return { type: '', content: null, rawForMedia: rawMessage };

    // Unwrap ephemeral / view-once
    const inner = rawMessage.ephemeralMessage?.message
        || rawMessage.viewOnceMessage?.message
        || rawMessage.viewOnceMessageV2?.message?.viewOnceMessage?.message
        || rawMessage;

    // Keys yang bukan isi pesan
    const META_KEYS = new Set([
        'messageContextInfo',
        'senderKeyDistributionMessage',
        'deviceSentMessage',
    ]);

    const type = Object.keys(inner).find(k => !META_KEYS.has(k)) || '';
    return { type, content: inner[type], rawForMedia: rawMessage };
}

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
            if (lastDisconnect.error?.output?.statusCode !== 401) startBot();
            else {
                require('fs').rmSync(AUTH_DIR, { recursive: true, force: true });
                process.exit(1);
            }
        } else if (connection === 'open') {
            currentQR = '';
            console.log('Berhasil terhubung ke WhatsApp!');
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
                console.log(`Pesan dari ${sender} | type: ${messageType}`);

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
                    // Tipe lain (stiker, audio, video, dokumen, dll) — balas dengan petunjuk
                    text = 'non-text message';
                }

                // Kirim full JID ke Vercel (strip device suffix :N saja, pertahankan @domain)
                // Contoh: "6281234567890:15@s.whatsapp.net" → "6281234567890@s.whatsapp.net"
                //         "18318723407966@lid" → "18318723407966@lid"
                const cleanSender = sender.replace(/:(\d+)(?=@)/, '');
                // Strip BOM dan invisible chars agar FormData tidak gagal encode
                const cleanText = text.replace(/[​-‍﻿⁠]/g, '').trim();

                const form = new FormData();
                form.append('sender', cleanSender);
                form.append('message', cleanText);
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
