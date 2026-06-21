const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const express = require('express');
const qrcodeTerm = require('qrcode-terminal');
const QRCode = require('qrcode');
const FormData = require('form-data');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://www.jualbeliusupolmed.web.id/api/wa/baileys';
const API_TOKEN = process.env.API_TOKEN || 'jualbeliusu_rahasia';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

let waSocket = null;
let currentQR = '';

// Halaman utama untuk melihat QR Code
app.get('/', async (req, res) => {
    if (!currentQR) {
        return res.send(`
            <body style="font-family: sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#f0f2f5;">
                <div style="text-align:center; background:white; padding:40px; border-radius:10px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">
                    <h2>WhatsApp Bot Status</h2>
                    <p style="color: green; font-weight: bold;">Bot sudah terhubung ke WhatsApp!</p>
                    <p>Tidak perlu scan QR lagi.</p>
                </div>
            </body>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <body style="font-family: sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#f0f2f5;">
                <div style="text-align:center; background:white; padding:40px; border-radius:10px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">
                    <h2>Scan QR Code WhatsApp</h2>
                    <p>Buka WA di HP Admin > Tautkan Perangkat</p>
                    <img src="${qrImage}" style="width: 300px; height: 300px; border: 1px solid #ccc; padding: 10px; border-radius: 10px;" />
                    <p style="color: #666; font-size: 14px;">Refresh halaman ini jika QR kedaluwarsa</p>
                </div>
            </body>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR');
    }
});

// API untuk mengirim pesan (sebagai pengganti API Fonnte)
app.post('/send', async (req, res) => {
    if (req.headers.authorization !== API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const target = req.body.target; 
    const message = req.body.message || '';
    const url = req.body.url;

    if (!target || !waSocket) {
        return res.status(400).json({ error: 'Target or WA not ready' });
    }

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
        printQRInTerminal: false,
        browser: ['Jual Beli USU Bot', 'Chrome', '1.0.0']
    });
    
    waSocket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr; // Simpan QR untuk web
            console.log('=============== QR CODE TERSEDIA ===============');
            console.log('Buka URL aplikasi ini di browser untuk scan QR Code!');
            qrcodeTerm.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
            console.log('Koneksi terputus. Reconnecting:', shouldReconnect);
            currentQR = '';
            if (shouldReconnect) startBot();
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
                    continue; 
                }

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

                const response = await axios.post(WEBHOOK_URL, form, {
                    headers: { ...form.getHeaders() }
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
