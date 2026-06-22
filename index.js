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
        // Ubah awalan 0 menjadi 62 agar valid di WhatsApp
        if (num.startsWith('0')) {
            num = '62' + num.substring(1);
        }
        jid = num + '@s.whatsapp.net';
    }

    try {
        // FITUR BARU: Memancing koneksi WA dengan status "Sedang Mengetik..."
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
                console.log(`Menerima pesan dari ${cleanSender}`);
                
                const form = new FormData();
                form.append('sender', cleanSender);
                form.append('message', text);
                if (hasMedia && buffer) form.append('file', new Blob([buffer], { type: mimeType }), filename);

                const response = await fetch(WEBHOOK_URL, { method: 'POST', body: form });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                console.log('Webhook Response OK');
            } catch (err) {
                console.error('Error memproses pesan:', err.message);
            }
        }
    });
}
app.listen(PORT, () => { console.log(`Bot Server listening on port ${PORT}`); startBot(); });
