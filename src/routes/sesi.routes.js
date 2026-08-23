/*
 * Rute sesi & perangkat
 *
 * Menautkan ulang, mereset, membuka kunci, dan jendela ke bot kedua. Semua
 * yang bisa memutus atau memulihkan sambungan WhatsApp tinggal di sini, dan
 * semuanya lewat requireRelink atau requirePemulihan.
 *
 * `K` itu konteks bersama yang dipegang index.js: konstanta, fungsi pembantu,
 * dan — yang paling penting — state bot yang terus berubah, dibaca lewat
 * getter. Ditulis `K.waSocket`, bukan disalin ke variabel lokal, karena
 * soketnya diganti tiap kali bot menyambung ulang; salinan yang diambil saat
 * modul dimuat akan menunjuk ke soket yang sudah mati.
 */
module.exports = function pasangRuteSesi(app, K) {
    const { requireAuth, requireAuthPage, requireRelink, requirePemulihan } = K;
    // Yang stabil diambil sekali di sini; yang berubah sepanjang bot hidup
    // TIDAK — itu dibaca lewat K.<nama> supaya selalu nilai terbaru.
    const {
        BOT2_TOKEN, bangunkanPindai, bump, exitAfterFlush,
        teruskanKeBot2,
    } = K;

    // ── Restart endpoint ──────────────────────────────────────────────────────────
    app.post('/restart', requireAuth, requireRelink, (req, res) => {
        res.json({ ok: true, message: 'Bot akan restart dalam 1 detik...' });
        setTimeout(() => exitAfterFlush(1), 1000);
    });

    // ── Reset / Hapus sesi ────────────────────────────────────────────────────────
    //
    // GET di sini SENGAJA tidak lagi mengerjakan apa pun. Sampai 23 Agustus 2026 ia
    // membuang sesi WhatsApp seketika — tanpa konfirmasi, tanpa badan permintaan
    // yang perlu benar. Satu GET dengan token yang sah sudah cukup, dan itu
    // betul-betul terjadi pukul 02:58 malam itu: sebuah pemeriksaan yang dikira
    // cuma menanyakan keadaan gerbang justru mencabut sesi bot kedua. Yang
    // menyelamatkannya cuma clearAuthState() yang MEMINDAHKAN sesi ke folder .bak.
    //
    // GET seharusnya aman dibaca berkali-kali oleh siapa pun — peramban yang
    // melakukan prefetch, pemindai tautan, riwayat, seseorang yang menekan Enter
    // dua kali di bilah alamat. Aksi yang tidak bisa dibatalkan tidak boleh berada
    // di belakang kata kerja yang artinya "ambilkan".
    //
    // Tidak ada pemanggil yang hilang karenanya: dashboard tidak pernah memakai
    // jalur GET ini, dan POST /reset di bawah tetap apa adanya.
    app.get('/reset', requireAuth, requireRelink, (req, res) => {
        res.status(405).json({
            error: 'GET /reset tidak menghapus apa pun. Aksi yang tidak bisa dibatalkan '
                + 'tidak boleh dijalankan oleh permintaan GET.',
            caraBenar: 'POST /reset dengan token yang sama.',
            akibat: 'Sesi WhatsApp dipindah ke folder .bak- lalu bot restart dan meminta '
                + 'QR baru. Jangan lakukan kalau nomornya sedang dibatasi WhatsApp.',
        });
    });

    app.post('/reset', requireAuth, requireRelink, async (req, res) => {
        try { await K.clearAuthState(); } catch (e) { console.error('[reset] gagal hapus sesi:', e); }
        res.json({ ok: true, message: 'Sesi dihapus. Bot akan restart...' });
        setTimeout(() => exitAfterFlush(1), 1000);
    });

    // ── Buka kunci sesi ──────────────────────────────────────────────────────────
    // Satu-satunya jalan sah membuang sesi yang sedang dikunci. Gerbangnya BUKAN
    // ALLOW_RELINK melainkan requirePemulihan: yang dibuang di sini adalah sesi yang
    // sudah ditolak WhatsApp berulang kali, jadi sesi hidup — hal yang dijaga
    // ALLOW_RELINK — memang sudah tidak ada. Lihat catatan di requirePemulihan.
    app.post('/sesi/buka-kunci', requireAuth, requirePemulihan, async (req, res) => {
        if (!K.sesiTerkunci) return res.status(400).json({ error: 'Sesi sedang tidak terkunci.' });
        console.warn('[sesi] Kunci dibuka dari dashboard — sesi dicadangkan, bot akan menampilkan QR.');
        K.sessionLostAt = new Date().toISOString();
        K.sesiTerkunci = false;
        K.kunciSiklus = 0;
        bump('sesi_hilang');
        try { await K.clearAuthState(); } catch (e) { console.error('[sesi] gagal cadangkan sesi:', e); }
        res.json({ ok: true, message: 'Kunci dibuka. Bot restart dan akan menampilkan QR.' });
        setTimeout(() => exitAfterFlush(1), 1000);
    });

    app.get('/perangkat2/status', requireAuth, async (req, res) => {
        const hasil = await teruskanKeBot2('/status');
        res.status(hasil.status).json({ ...hasil.body, adaBot2: !!BOT2_TOKEN });
    });

    app.get('/perangkat2/qr', requireAuth, async (req, res) => {
        const hasil = await teruskanKeBot2('/qr');
        res.status(hasil.status).json(hasil.body);
    });

    // Sengaja TANPA requirePemulihan, dan ini perlu ditulis karena kembarannya di
    // bawah (/pairing-code milik bot pertama) memakainya — ketidaksimetrisan yang
    // kalau dibiarkan tanpa keterangan akan dibaca orang berikutnya sebagai lubang.
    //
    // Alasannya: requirePemulihan menimbang keadaan sesi bot INI (sesiTerkunci,
    // connectedPhone, sesiTersimpanAda) — variabel milik proses pertama. Memasangnya
    // di sini berarti menaut-ulang bot KEDUA dijaga oleh keadaan bot PERTAMA, dua
    // hal yang tidak berhubungan sama sekali.
    //
    // Gerbangnya ada, cuma bukan di sini: bot kedua menjalankan berkas yang sama
    // persis (lihat /root/wa-bot-2/jalankan.sh — beda DATA_DIR dan PORT saja), jadi
    // /pairing-code di sana melewati requirePemulihan-nya sendiri, menimbang
    // sesinya sendiri. Rute ini cuma penerus, dan requireAuth di depannya sudah
    // menuntut token yang sama dengan seluruh panel.
    app.post('/perangkat2/pairing-code', requireAuth, async (req, res) => {
        const hasil = await teruskanKeBot2('/pairing-code', { method: 'POST', body: { phone: req.body?.phone } });
        res.status(hasil.status).json(hasil.body);
    });

    // ── Pairing Code endpoint ─────────────────────────────────────────────────────
    app.post('/pairing-code', requireAuth, requirePemulihan, async (req, res) => {
        try {
            const { phone } = req.body;
            if (!phone) return res.status(400).json({ error: 'Nomor HP wajib diisi' });
        
            if (!K.waSocket) {
                // Minta kode pairing = ada orang yang sedang menautkan. Bangunkan dulu,
                // lalu minta ia mencoba lagi sebentar — soket baru butuh beberapa detik.
                const dibangunkan = bangunkanPindai();
                return res.status(503).json({ error: dibangunkan
                    ? 'Bot tadi diam menunggu ditautkan. Koneksi sedang disiapkan — coba lagi ~15 detik.'
                    : 'Bot sedang tidak aktif/terhubung' });
            }
        
            if (K.waSocket.authState.creds.registered || K.connectedPhone) {
                return res.status(400).json({ error: 'Bot sudah login dan terdaftar' });
            }
        
            // Bersihkan nomor (hilangkan +, spasi, -) dan ganti awalan 0 menjadi 62
            let cleanPhone = phone.replace(/[^0-9]/g, '');
            if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
        
            // Request kode pairing ke Baileys
            let code = await K.waSocket.requestPairingCode(cleanPhone);
        
            // Format kode agar lebih mudah dibaca, misalnya: "ABCD-EFGH"
            code = code?.match(/.{1,4}/g)?.join('-') || code;
        
            res.json({ ok: true, code });
        } catch (e) {
            console.error('Error request pairing code:', e);
            res.status(500).json({ error: e.message || 'Gagal meminta kode pairing' });
        }
    });
};
