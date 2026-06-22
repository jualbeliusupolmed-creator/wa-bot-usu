const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const express = require('express');
const qrcodeTerm = require('qrcode-terminal');
const QRCode = require('qrcode');

const WEBHOOK_URL = 'https://jualbeliusupolmed.vercel.app/api/wa/baileys';
const API_TOKEN = process.env.API_TOKEN || 'jualbeliusu_rahasia';
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';

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
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });
    
    waSocket = sock;

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode("62895429126232");
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log('\n===================================================');
                console.log('🔥 KODE PAIRING ANDA: ' + code + ' 🔥');
                console.log('Buka WA di HP > Tautkan Perangkat > Tautkan dgn Nomor Telepon');
                console.log('Masukkan 8 kode huruf di atas untuk terhubung!');
                console.log('===================================================\n');
            } catch (err) {
                console.log('Gagal meminta pairing code:', err.message);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== 401;
            console.log('Koneksi terputus. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            } else {
                console.log('Sesi tertolak (401). Menghapus auth_info dan merestart mesin...');
                const fs = require('fs');
                if (fs.existsSync(AUTH_DIR)) {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                }
                process.exit(1); // Paksa Railway merestart container
            }
        } else if (connection === 'open') {
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
                    const blob = new Blob([buffer], { type: mimeType });
                    form.append('file', blob, filename);
                }

                const response = await fetch(WEBHOOK_URL, {
                    method: 'POST',
                    body: form
                });
                
                if (!response.ok) {
                    const errText = await response.text().catch(() => 'No text');
                    throw new Error(`Request failed with status code ${response.status}: ${errText}`);
                }
                
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
