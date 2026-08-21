/*
 * Rute data panel
 *
 * Status, QR, statistik, pengaturan, log — semua yang dibaca dashboard bot
 * untuk menggambar dirinya. Tidak ada yang mengirim pesan WhatsApp dari sini.
 *
 * `K` itu konteks bersama yang dipegang index.js: konstanta, fungsi pembantu,
 * dan — yang paling penting — state bot yang terus berubah, dibaca lewat
 * getter. Ditulis `K.waSocket`, bukan disalin ke variabel lokal, karena
 * soketnya diganti tiap kali bot menyambung ulang; salinan yang diambil saat
 * modul dimuat akan menunjuk ke soket yang sudah mati.
 */
const QRCode = require('qrcode');

const { BOT_PREFIX, ADMIN_CALL_WORDS } = require('../lib/utils');

module.exports = function pasangRutePanel(app, K) {
    const { requireAuth, requireAuthPage, requireRelink, requirePemulihan } = K;
    // Yang stabil diambil sekali di sini; yang berubah sepanjang bot hidup
    // TIDAK — itu dibaca lewat K.<nama> supaya selalu nilai terbaru.
    const {
         DEFAULT_GREETING, GREETING_MAX, KUNCI_SESI,
        MODUL_BAWAAN, MSG_ARCHIVE_CAP, OWNER_NUMBER, PINDAI_RETRY_MS,
        WEBHOOK_URL, ambangEskalasiMs, bangunkanPindai, bersihkanModul,
        botSiap, getSavedNewsletters, kunciRetryMs, messageQueue,
        nomorAlarm, nomorCadangan, normalisasiNomor, saveLidResolutionMap,
        saveNewsletter, saveSettings, semuaModul, statsDay,
        systemLogs,
    } = K;

    // ── Health check (public, untuk Railway health check) ────────────────────────
    app.get('/health', (req, res) => {
        // Definisinya disamakan persis dengan /status — dulu /health cuma cek `waSocket`
        // tanpa `connectedPhone`, jadi bisa bilang sehat padahal login belum selesai.
        const isConnected = !!(K.waSocket && K.connectedPhone && !K.currentQR);
        // Endpoint publik — JANGAN bocorkan nomor telepon di sini.
        res.status(isConnected ? 200 : 503).json({
            ok: isConnected,
            uptime: Math.floor(process.uptime()),
            // Dibaca penjaga-bot.sh: sesi terkunci berarti yang dibutuhkan tangan
            // manusia, dan restart proses hanya menambah ketukan yang sia-sia.
            terkunci: K.sesiTerkunci,
            // Sama alasannya: perangkat belum tertaut dan bot sedang diam menunggu
            // ada yang memindai. Proses baru tidak memindai QR-nya sendiri.
            menungguPindai: K.menungguPindai,
        });
    });

    // ── QR JSON endpoint (untuk admin panel web) ─────────────────────────────────
    app.get('/qr', requireAuth, async (req, res) => {
        if (!K.currentQR) {
            // Membuka kartu QR itu sendiri tandanya: kalau bot sedang diam menunggu
            // ditautkan, permintaan inilah yang membangunkannya. Dulu di sini selalu
            // dijawab `connected: true` — padahal "tidak ada QR" juga berarti belum
            // tersambung sama sekali, dan dashboard jadi tidak bisa membedakannya.
            const dibangunkan = bangunkanPindai();
            const tersambung = !!(K.waSocket && K.connectedPhone);
            return res.json({ qr: null, connected: tersambung, menyiapkan: dibangunkan || !tersambung });
        }
        try {
            const qrImage = await QRCode.toDataURL(K.currentQR, { width: 300 });
            res.json({ qr: qrImage, connected: false });
        } catch (err) {
            res.status(500).json({ error: 'Gagal generate QR' });
        }
    });

    // ── Status endpoint ───────────────────────────────────────────────────────────
    app.get('/status', requireAuth, (req, res) => {
        // Konversi eksplisit ke boolean agar tidak pernah null/undefined
        const isConnected = !!(K.waSocket && K.connectedPhone && !K.currentQR);
        res.json({
            connected: isConnected,
            phone: K.connectedPhone || null,
            connectedAt: K.connectedAt || null,
            hasQR: !!K.currentQR,
            qr: K.currentQR, // Tambahkan raw QR string agar bisa di-debug jika perlu
            uptime: Math.floor(process.uptime()),
            webhookUrl: WEBHOOK_URL,
            queueLength: messageQueue.length,
            // Kesehatan koneksi — supaya bot mati tidak perlu ditemukan lewat `pm2 logs`.
            offlineSince: K.offlineSince ? new Date(K.offlineSince).toISOString() : null,
            lastOutage: K.lastOutage,
            outageCount: K.outageCount,
            reconnectAttempts: K.reconnectAttempts,
            // Restart darurat karena padam berkepanjangan: 0 = belum pernah, angka naik
            // = bot sedang berjuang. Ambangnya ikut dilaporkan supaya jelas kapan
            // eskalasi berikutnya jatuh tanpa perlu menghitung sendiri.
            offlineEscalations: K.offlineEscalations,
            escalationThresholdMinutes: Math.round(ambangEskalasiMs() / 60000),
            // Kapan perangkat terakhir benar-benar dilepas WhatsApp (butuh scan ulang).
            // null artinya sesi masih utuh — putus koneksi biasa tidak mengisi ini.
            sessionLostAt: K.sessionLostAt,
            sesiTerkunci: K.sesiTerkunci,
            kunciSesiAktif: KUNCI_SESI,
            kunciRetryMenit: Math.round(kunciRetryMs() / 60000),
            // Perangkat belum tertaut dan bot berhenti mengetuk sampai ada yang siap
            // memindai. Dashboard memakai ini untuk menawarkan tombol "Tampilkan QR".
            menungguPindai: K.menungguPindai,
            siklusQrSiaSia: K.siklusQrSiaSia,
            pindaiRetryMenit: Math.round(PINDAI_RETRY_MS / 60000),
            logoutStrikes: K.logoutStrikes,
            // Ringkasan hari ini, biar dashboard tidak perlu dua panggilan untuk kartu utama.
            today: K.stats.daily[statsDay()] || {},
            archiveCount: K.msgArchive.length,
            chatCount: K.chatMap.size,
            greetingCustom: K.greetingText !== DEFAULT_GREETING,
            // Berapa kali sapaan lama website dicegat sejak proses hidup. Angka yang
            // mandek di 0 padahal sapaan lama masih muncul di HP = penandanya meleset.
            legacyGreetingSwaps: K.legacyGreetingSwaps,
        });
    });

    // ── Logs endpoint ─────────────────────────────────────────────────────────────
    app.get('/logs', requireAuth, (req, res) => {
        res.json({ logs: systemLogs });
    });

    // ── Resolve @lid → nomor (admin) ─────────────────────────────────────────────
    // Untuk migrasi data lama ber-key LID: tanya pemetaan LID↔nomor langsung ke
    // WhatsApp (getPNForLID). Hasil dipakai POST /api/admin/migrate-lid di website.
    app.get('/resolve-lid', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot belum tersambung' });
        const digits = String(req.query.lid || '').split('@')[0].replace(/\D/g, '');
        if (!digits) return res.status(400).json({ error: 'param ?lid= wajib' });
        const lidJid = digits + '@lid';
        const cached = K.lidMap.get(lidJid) || K.lidResolutionMap.get(lidJid) || null;
        let phone = cached;
        if (!phone) {
            try {
                const pn = await K.waSocket.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
                if (pn && pn.endsWith('@s.whatsapp.net')) phone = pn;
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }
        if (phone && !K.lidResolutionMap.has(lidJid)) { K.lidResolutionMap.set(lidJid, phone); saveLidResolutionMap(); }
        res.json({ lid: lidJid, phone: phone || null, source: phone ? (cached ? 'cache' : 'query') : null });
    });

    // ── Chats / Kontak endpoint ───────────────────────────────────────────────────
    app.get('/chats', requireAuth, (req, res) => {
        // Tetap kembalikan data dari cache meski bot sedang reconnecting
        const list = Array.from(K.chatMap.values())
            .filter(c => c.jid.endsWith('@s.whatsapp.net') || c.jid.endsWith('@lid'))
            .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
        res.json({ chats: list, connected: !!(K.waSocket && K.connectedPhone) });
    });

    // ── Messages endpoint (riwayat pesan per JID dari arsip persisten) ───────────
    // Dulu endpoint ini membaca messageLog (100 entri, in-memory, semua ditandai
    // fromMe:false). Sekarang dari msgArchive: dua arah, isi penuh, selamat dari restart.
    app.get('/messages', requireAuth, (req, res) => {
        const { jid } = req.query;
        if (!jid) return res.status(400).json({ error: 'jid required' });
        const limit = Math.min(Number(req.query.limit) || 200, 500);
        const msgs = K.msgArchive
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
        const days = Object.keys(K.stats.daily).sort();
        res.json({
            total: K.stats.total,
            today: K.stats.daily[statsDay()] || {},
            daily: K.stats.daily,
            days,
            archive: { messages: K.msgArchive.length, cap: MSG_ARCHIVE_CAP },
            since: days[0] || statsDay(),
        });
    });

    // ── Pengaturan sapaan ────────────────────────────────────────────────────────
    app.get('/settings', requireAuth, (req, res) => {
        res.json({
            greeting: K.greetingText,
            isCustom: K.greetingText !== DEFAULT_GREETING,
            default: DEFAULT_GREETING,
            adminCallWords: [...ADMIN_CALL_WORDS],
            botPrefix: BOT_PREFIX,
            max: GREETING_MAX,
            ownerNumber: nomorAlarm(),
            // Dibedakan supaya dashboard bisa jujur: kotak yang terlihat terisi tapi
            // nilainya datang dari env bukan berarti sudah pernah disimpan di sini.
            ownerFromEnv: !K.settings.ownerNumber && !!OWNER_NUMBER,
            backupAdmin: nomorCadangan(),
        });
    });

    // Kedua nomor disimpan lewat satu endpoint: keduanya bagian dari satu keputusan
    // ("siapa yang dihubungi kalau bot bermasalah"), dan menyimpannya sekali jalan
    // menghindari keadaan setengah tersimpan.
    app.post('/settings/nomor', requireAuth, (req, res) => {
        const hasil = {};
        for (const [field, kunci, label] of [
            ['owner', 'ownerNumber', 'Nomor alarm'],
            ['cadangan', 'backupAdmin', 'Nomor cadangan'],
        ]) {
            if (!(field in (req.body || {}))) continue;
            const nomor = normalisasiNomor(req.body[field]);
            if (nomor === null) return res.status(400).json({ error: `${label} tidak sah — pakai format 62xxx atau 08xxx.` });
            if (nomor) K.settings[kunci] = nomor; else delete K.settings[kunci];
            hasil[kunci] = nomor;
        }
        saveSettings();
        console.log(`[settings] Nomor penting diubah dari dashboard: ${JSON.stringify(hasil)}`);
        res.json({ ok: true, ownerNumber: nomorAlarm(), backupAdmin: nomorCadangan() });
    });

    // ── Modul bot (panggilan, anti-ban, forensik) ────────────────────────────────
    // Ini jendela yang dipakai panel "WhatsApp Bot" di situs. Sebelumnya panel itu
    // menyimpan setelannya ke Supabase dan berhenti di sana; sekarang setelannya
    // mendarat di sini, di proses yang benar-benar memegang koneksi WhatsApp.
    app.get('/modul', requireAuth, (req, res) => {
        res.json({ ok: true, modul: semuaModul(), bawaan: MODUL_BAWAAN });
    });

    app.post('/modul', requireAuth, (req, res) => {
        const masuk = req.body || {};
        // Panel bisa mengirim satu kelompok saja ({panggilan:{...}}) atau beberapa
        // sekaligus. Yang tidak dikirim tidak disentuh — dulu tiap panel menimpa
        // seluruh isi `bot_modules`, jadi menyimpan Anti-Ban menghapus setelan
        // Panggilan yang baru saja disimpan sebelahnya.
        const diubah = [];
        K.settings.modul = K.settings.modul || {};
        for (const nama of Object.keys(MODUL_BAWAAN)) {
            if (!(nama in masuk)) continue;
            const bersih = bersihkanModul(nama, masuk[nama]);
            if (!bersih) return res.status(400).json({ error: `Isi modul "${nama}" tidak sah.` });
            K.settings.modul[nama] = { ...(K.settings.modul[nama] || {}), ...bersih };
            diubah.push(nama);
        }
        if (!diubah.length) return res.status(400).json({ error: 'Tidak ada modul yang dikenali di badan permintaan.' });
        saveSettings();
        console.log(`[modul] Diubah dari panel: ${diubah.join(', ')}`);
        res.json({ ok: true, modul: semuaModul(), diubah });
    });

    // ── Kontak admin untuk situs (publik) ────────────────────────────────────────
    // Situs jualbeliusupolmed dipasang di Vercel, jadi ia tidak bisa mengintip
    // proses ini; endpoint inilah jendelanya. Sengaja TIDAK memuat nomor utama —
    // situs sudah tahu nomornya sendiri, dan /health pun dijaga tidak membocorkan
    // nomor bot. Yang dibagikan cuma dua hal yang memang perlu diketahui publik:
    // bot sedang sehat atau tidak, dan ke mana harus lari kalau tidak.
    app.get('/kontak-admin', (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');   // dibaca dari domain situs
        res.set('Cache-Control', 'no-store');          // situs yang mengatur cache-nya
        res.json({
            sehat: !!(K.waSocket && K.connectedPhone && !K.currentQR),
            cadangan: nomorCadangan() || null,
        });
    });

    app.post('/settings/greeting', requireAuth, (req, res) => {
        const text = String(req.body?.text ?? '');
        if (!text.trim()) return res.status(400).json({ error: 'Teks sapaan tidak boleh kosong' });
        if (text.length > GREETING_MAX) return res.status(400).json({ error: `Maksimal ${GREETING_MAX} karakter` });
        K.greetingText = text;
        K.settings.greeting = text;
        saveSettings();
        console.log(`[settings] Sapaan diubah dari dashboard (${text.length} karakter).`);
        res.json({ ok: true, greeting: K.greetingText });
    });

    app.post('/settings/greeting/reset', requireAuth, (req, res) => {
        K.greetingText = DEFAULT_GREETING;
        delete K.settings.greeting;
        saveSettings();
        console.log('[settings] Sapaan dikembalikan ke bawaan.');
        res.json({ ok: true, greeting: K.greetingText });
    });

    app.get('/newsletters', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        res.json({ newsletters: getSavedNewsletters() });
    });

    app.post('/newsletters/add', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { invite } = req.body;
        if (!invite) return res.status(400).json({ error: 'Invite link required' });
        try {
            let code = invite;
            if (invite.includes('whatsapp.com/channel/')) {
                code = invite.split('whatsapp.com/channel/')[1].split('?')[0].split('/')[0];
            }
            const meta = await K.waSocket.newsletterMetadata('invite', code);
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
        res.json({ logs: K.messageLog });
    });
};
