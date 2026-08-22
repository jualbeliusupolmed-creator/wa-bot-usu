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
        const kode = isConnected ? 200 : 503;
        // Endpoint publik — JANGAN bocorkan nomor telepon di sini.
        const badan = {
            ok: isConnected,
            uptime: Math.floor(process.uptime()),
            // Dibaca penjaga-bot.sh: sesi terkunci berarti yang dibutuhkan tangan
            // manusia, dan restart proses hanya menambah ketukan yang sia-sia.
            terkunci: K.sesiTerkunci,
            // Sama alasannya: perangkat belum tertaut dan bot sedang diam menunggu
            // ada yang memindai. Proses baru tidak memindai QR-nya sendiri.
            menungguPindai: K.menungguPindai,
        };

        // Peramban dapat tampilan, mesin tetap dapat JSON yang sama persis.
        //
        // URUTAN DAFTARNYA YANG MENENTUKAN, dan ini bukan gaya penulisan:
        // `curl` mengirim `Accept: */*`, yang cocok dengan dua-duanya — dan
        // `req.accepts()` memulangkan yang PERTAMA disebut kalau klien tidak
        // punya preferensi. Jadi 'json' harus di depan. Peramban menyebut
        // `text/html` dengan bobot lebih tinggi, jadi dia yang dapat halaman.
        //
        // Yang dijaga di sini: penjaga-bot.sh membaca badan respons mentah-mentah
        // dengan `grep -q '"terkunci":true'`. Satu baris HTML yang bocor ke
        // jawaban untuk curl akan membuat penjaganya salah membaca — dan penjaga
        // yang salah membaca itu me-restart bot yang justru sedang menunggu tangan
        // manusia. Karena itu HTML-nya hanya keluar pada permintaan yang secara
        // eksplisit lebih memilih text/html.
        if (req.accepts(['json', 'html']) !== 'html') {
            return res.status(kode).json(badan);
        }
        res.status(kode).type('html').send(halamanKesehatan(badan));
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

/*
 * Tampilan /health untuk mata manusia.
 *
 * Sengaja tanpa berkas luar — tidak ada <link>, tidak ada <script src>. Halaman
 * yang tugasnya menjawab "botnya hidup atau tidak" tidak boleh ikut mati gara-gara
 * satu berkas rupa gagal dimuat.
 *
 * Isinya persis field yang sama dengan versi JSON-nya, tidak lebih: endpoint ini
 * publik tanpa sandi, jadi nomor telepon, nama kontak, dan isi pesan TIDAK boleh
 * mampir ke sini — sama seperti aturan di handler-nya.
 */
function halamanKesehatan({ ok, uptime, terkunci, menungguPindai }) {
    // Tiga keadaan tidak-sehat yang beda tindakannya, jadi dibedakan di layar juga:
    // yang dua butuh tangan manusia, yang satu biasanya pulih sendiri.
    let nada = 'baik', judul = 'Tersambung', jelas = 'Bot terhubung ke WhatsApp dan siap menerima pesan.';
    if (!ok && terkunci) {
        nada = 'awas'; judul = 'Sesi terkunci';
        jelas = 'WhatsApp menolak sesi ini. Restart tidak menyembuhkannya — buka kunci dari dashboard, lalu periksa daftar perangkat tertaut di HP.';
    } else if (!ok && menungguPindai) {
        nada = 'awas'; judul = 'Belum tertaut';
        jelas = 'Perangkat belum dipindai, jadi bot sengaja diam dan tidak mengetuk WhatsApp berulang kali. Tautkan dari dashboard kalau memang perangkatnya sudah dilepas.';
    } else if (!ok) {
        nada = 'buruk'; judul = 'Terputus';
        jelas = 'Bot sedang tidak terhubung ke WhatsApp. Penjaga memeriksanya tiap dua menit dan menyambung ulang sendiri.';
    }

    const j = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const lama = j ? `${j} jam ${m} menit` : `${m} menit`;
    const ya = (v) => (v ? 'ya' : 'tidak');

    return `<!doctype html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="20">
<title>Status bot — ${judul}</title>
<style>
:root{--bg:#f6f7f9;--kartu:#fff;--tinta:#111;--redup:#5b6470;--garis:#e3e6ea;
      --baik:#0f7b3f;--awas:#9a6200;--buruk:#b3261e}
@media (prefers-color-scheme:dark){
:root{--bg:#0e1116;--kartu:#161a21;--tinta:#e9edf2;--redup:#9aa4b2;--garis:#262c36;
      --baik:#4ade80;--awas:#fbbf24;--buruk:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
     background:var(--bg);color:var(--tinta);
     font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.kartu{width:100%;max-width:460px;background:var(--kartu);border:1px solid var(--garis);
       border-radius:14px;padding:26px 24px}
.atas{font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:var(--redup)}
h1{margin:.5rem 0 0;font-size:1.55rem;display:flex;align-items:center;gap:.55rem}
.titik{width:12px;height:12px;border-radius:50%;flex:none}
.baik .titik{background:var(--baik)} .awas .titik{background:var(--awas)} .buruk .titik{background:var(--buruk)}
.baik h1{color:var(--baik)} .awas h1{color:var(--awas)} .buruk h1{color:var(--buruk)}
p.jelas{margin:.7rem 0 0;color:var(--redup)}
dl{margin:20px 0 0;padding-top:16px;border-top:1px solid var(--garis);
   display:grid;grid-template-columns:1fr auto;gap:.5rem 1rem;font-size:.93rem}
dt{color:var(--redup)} dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.kaki{margin:20px 0 0;padding-top:14px;border-top:1px solid var(--garis);
      font-size:.82rem;color:var(--redup)}
a{color:inherit}
code{font-size:.85em;background:var(--bg);padding:1px 5px;border-radius:4px}
</style></head>
<body><div class="kartu ${nada}">
  <div class="atas">Bot WhatsApp · jualbeliusupolmed</div>
  <h1><span class="titik"></span>${judul}</h1>
  <p class="jelas">${jelas}</p>
  <dl>
    <dt>Hidup sejak</dt><dd>${lama} lalu</dd>
    <dt>Sesi terkunci</dt><dd>${ya(terkunci)}</dd>
    <dt>Menunggu dipindai</dt><dd>${ya(menungguPindai)}</dd>
  </dl>
  <p class="kaki">Halaman ini menyegarkan diri tiap 20 detik. Alamat yang sama
  memulangkan JSON untuk mesin — itu yang dibaca penjaga bot tiap dua menit.
  Kendalinya ada di <a href="/home">panel</a> (perlu sandi).</p>
</div></body></html>`;
}
