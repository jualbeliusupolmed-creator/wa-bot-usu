/*
 * Antrean kirim milik bot ini
 *
 * Dua antrean berbeda, dan bedanya penting: /antrean/data dan
 * /antrean/kirim adalah PROXY ke situs (pemilik antreannya tabel wa_outbox di
 * Supabase, dan VPS ini sengaja tidak punya kredensialnya), sedangkan
 * /antrean/lokal adalah antrean kirim milik proses ini sendiri.
 *
 * `K` itu konteks bersama yang dipegang index.js: konstanta, fungsi pembantu,
 * dan — yang paling penting — state bot yang terus berubah, dibaca lewat
 * getter. Ditulis `K.waSocket`, bukan disalin ke variabel lokal, karena
 * soketnya diganti tiap kali bot menyambung ulang; salinan yang diambil saat
 * modul dimuat akan menunjuk ke soket yang sudah mati.
 */
module.exports = function pasangRuteAntrean(app, K) {
    const { requireAuth, requireAuthPage, requireRelink, requirePemulihan } = K;
    // Yang stabil diambil sekali di sini; yang berubah sepanjang bot hidup
    // TIDAK — itu dibaca lewat K.<nama> supaya selalu nilai terbaru.
    const {
        DIBUANG_TTL_MS, OUTBOX_MAX, OUTBOX_TTL_MS, SITUS_OUTBOX,
        TTL_BALASAN_MS, botSiap, idTugas, kickQueue,
        messageQueue, simpanDibuang, simpanOutbox, socketAlive,
        terusanOutbox,
    } = K;

    app.get('/antrean/data', requireAuth, (req, res) => {
        const status = encodeURIComponent(String(req.query.status || 'tertunda'));
        return terusanOutbox(req, res, { url: `${SITUS_OUTBOX}?status=${status}&limit=200`, method: 'GET' });
    });

    app.post('/antrean/kirim', requireAuth, (req, res) => {
        return terusanOutbox(req, res, {
            url: SITUS_OUTBOX,
            method: 'POST',
            body: JSON.stringify(req.body || {}),
        });
    });

    app.get('/antrean/lokal', requireAuth, (req, res) => {
        const sekarang = Date.now();
        const items = messageQueue.map((t) => ({
            id: idTugas(t),
            jid: t.jid,
            message: t.poll ? `[poll] ${t.poll.name || ''}` : (t.message || ''),
            url: t.url || null,
            ts: t.ts || null,
            kedaluwarsa: (t.ts || sekarang) + (t.ttl || TTL_BALASAN_MS),
            percobaan: t.attempts || 0,
            grup: String(t.jid || '').includes('@g.us'),
        }));
        simpanOutbox();
        // Buang catatan yang sudah lewat 14 hari sebelum menjawab, supaya daftarnya
        // tidak pelan-pelan jadi arsip yang tak pernah dibaca.
        const batasCatatan = Date.now() - DIBUANG_TTL_MS;
        if (K.dibuangList.some((d) => (d.dibuangAt || 0) < batasCatatan)) {
            K.dibuangList = K.dibuangList.filter((d) => (d.dibuangAt || 0) >= batasCatatan);
            simpanDibuang();
        }
        res.json({
            ok: true,
            // Kenapa antreannya belum berangkat — pertanyaan pertama siapa pun yang
            // melihat daftar ini, dan jawabannya tidak boleh perlu dicari di halaman lain.
            siap: botSiap(),
            tersambung: socketAlive(),
            menungguPindai: K.menungguPindai,
            terkunci: K.sesiTerkunci,
            sebab: botSiap() ? null
                : K.sesiTerkunci ? 'Sesi WhatsApp terkunci — perlu dibuka dari dashboard.'
                : K.menungguPindai ? 'Perangkat belum tertaut — QR/pairing menunggu dipindai.'
                : 'WhatsApp belum tersambung.',
            tertunda: items.length,
            items,
            // Bukan antrean: pesan yang sudah TIDAK akan berangkat sendiri. Dipajang
            // supaya kehilangan yang sudah terjadi tetap punya jejak yang bisa dilihat.
            dibuang: K.dibuangList.slice(0, 50),
            dibuangTotal: K.dibuangList.length,
        });
    });

    // Yang bisa dilakukan di sini cuma dua, dan keduanya jujur soal batasnya:
    // "kirim sekarang" hanya membangunkan antrean (pengirimannya tetap butuh WA
    // tersambung — tidak ada tombol yang bisa menyambungkannya), dan "hapus"
    // membuang pesan yang memang sudah tidak pantas berangkat.
    app.post('/antrean/lokal', requireAuth, (req, res) => {
        const b = req.body || {};
        if (b.hapus) {
            const sebelum = messageQueue.length;
            const sisa = messageQueue.filter((t) => idTugas(t) !== String(b.hapus));
            messageQueue.length = 0;
            messageQueue.push(...sisa);
            simpanOutbox();
            return res.json({ ok: true, dihapus: sebelum - messageQueue.length, sisa: messageQueue.length });
        }
        if (b.hapus_semua) {
            const dihapus = messageQueue.length;
            messageQueue.length = 0;
            simpanOutbox();
            return res.json({ ok: true, dihapus, sisa: 0 });
        }
        // Kirim ulang satu pesan yang sudah dibuang: masuk ke antrean sebagai pesan
        // BARU (ts sekarang), karena kalau ts lamanya ikut, ia langsung dibuang lagi
        // oleh pemeriksaan kedaluwarsa yang sama yang membuangnya pertama kali.
        if (b.ulang) {
            const c = K.dibuangList.find((d) => d.id === String(b.ulang));
            if (!c) return res.status(404).json({ error: 'Catatan tidak ditemukan.' });
            if (messageQueue.length >= OUTBOX_MAX) {
                return res.status(503).json({ error: 'Antrean penuh — coba lagi setelah antrean berkurang.' });
            }
            messageQueue.push({ jid: c.jid, message: c.message, url: c.url || undefined, ts: Date.now(), ttl: OUTBOX_TTL_MS });
            K.dibuangList = K.dibuangList.filter((d) => d.id !== c.id);
            simpanOutbox();
            simpanDibuang();
            kickQueue();
            return res.json({ ok: true, diantrekan: 1, sisa: messageQueue.length, siap: botSiap() });
        }
        if (b.hapus_catatan) {
            const sebelum = K.dibuangList.length;
            K.dibuangList = K.dibuangList.filter((d) => d.id !== String(b.hapus_catatan));
            simpanDibuang();
            return res.json({ ok: true, dihapusCatatan: sebelum - K.dibuangList.length });
        }
        if (b.bersihkan_catatan) {
            const dihapusCatatan = K.dibuangList.length;
            K.dibuangList = [];
            simpanDibuang();
            return res.json({ ok: true, dihapusCatatan });
        }
        if (b.kirim) {
            if (!botSiap()) {
                return res.status(409).json({
                    error: 'WhatsApp belum tersambung — antrean tetap disimpan dan berangkat sendiri begitu tersambung.',
                });
            }
            kickQueue();
            return res.json({ ok: true, dibangunkan: true, sisa: messageQueue.length });
        }
        return res.status(400).json({ error: 'Sebutkan hapus, hapus_semua, kirim, ulang, hapus_catatan, atau bersihkan_catatan.' });
    });
};
