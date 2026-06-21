const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const express = require('express');
const qrcode = require('qrcode-terminal');
const FormData = require('form-data');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://www.jualbeliusupolmed.web.id/api/wa/baileys';
const API_TOKEN = process.env.API_TOKEN || 'jualbeliusu_rahasia';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

let waSocket = null;

// API untuk mengirim pesan (sebagai pengganti API Fonnte)
app.post('/send', async (req, res) => {
    if (req.headers.authorization !== API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Sesuaikan format body dengan format yang biasa dipakai Fonnte
    const target = req.body.target; 
    const message = req.body.message || '';
    const url = req.body.url;

    if (!target || !waSocket) {
        return res.status(400).json({ error: 'Target or WA not ready' });
    }

    // Format WA number (e.g., 6281234567890 -> 6281234567890@s.whatsapp.net)
    const jid = target.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

    try {
        if (url) {
            await waSocket.sendMessage(jid, { image: { url: url }, caption: message });
        } else {
            await waSocket.sendMessage(jid, { text: message });
        }
        res.json({ status: true, detail: 'Message sent successfully' });
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ status: false, reason: err.message });
    }
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['Jual Beli USU Bot', 'Chrome', '1.0.0']
    });
    
    waSocket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('=============== SCAN QR CODE INI ===============');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
            console.log('Koneksi terputus. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Berhasil terhubung ke WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const sender = msg.key.remoteJid;
            
            // Abaikan dari grup atau status
            if (!sender || sender.includes('@g.us') || sender === 'status@broadcast') continue;

            try {
                const messageType = Object.keys(msg.message)[0];
                let text = '';
                let hasMedia = false;
                let buffer = null;
                let mimeType = '';
                let filename = '';

                if (messageType === 'conversation') {
                    text = msg.message.conversation;
                } else if (messageType === 'extendedTextMessage') {
                    text = msg.message.extendedTextMessage.text;
                } else if (messageType === 'imageMessage') {
                    hasMedia = true;
                    text = msg.message.imageMessage.caption || '';
                    mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
                    filename = 'image.jpg';
                    buffer = await downloadMediaMessage(msg, 'buffer', {}, { 
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    });
                } else {
                    continue; // Abaikan stiker, vn, dll
                }

                // Format sender number
                const cleanSender = sender.split('@')[0];

                console.log(`Menerima pesan dari ${cleanSender}`);
                
                const form = new FormData();
                form.append('sender', cleanSender);
                form.append('message', text);

                if (hasMedia && buffer) {
                    form.append('file', buffer, {
                        filename: filename,
                        contentType: mimeType
                    });
                }

                // Tembak Webhook Jual Beli USU
                const response = await axios.post(WEBHOOK_URL, form, {
                    headers: {
                        ...form.getHeaders()
                    }
                });

                console.log('Webhook Response OK');

            } catch (err) {
                console.error('Error memproses pesan:', err.message);
            }
        }
    });
}

// Start Express Server
app.listen(PORT, () => {
    console.log(`Bot Server listening on port ${PORT}`);
    startBot();
});
