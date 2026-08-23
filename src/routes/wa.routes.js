/*
 * Rute aksi WhatsApp
 *
 * Semua yang benar-benar MENYENTUH WhatsApp: kirim pesan, siaran, grup,
 * profil, blokir, status, dan sekumpulan endpoint forensik. Dipisah dari rute
 * data panel karena cara gagalnya berbeda — yang di sini bisa gagal karena
 * soketnya mati, dan itu 503, bukan 500.
 *
 * `K` itu konteks bersama yang dipegang index.js: konstanta, fungsi pembantu,
 * dan — yang paling penting — state bot yang terus berubah, dibaca lewat
 * getter. Ditulis `K.waSocket`, bukan disalin ke variabel lokal, karena
 * soketnya diganti tiap kali bot menyambung ulang; salinan yang diambil saat
 * modul dimuat akan menunjuk ke soket yang sudah mati.
 */
const { toJid, dgnBatas } = require('../lib/utils');

module.exports = function pasangRuteWa(app, K) {
    const { requireAuth, requireAuthPage, requireRelink, requirePemulihan } = K;
    // Yang stabil diambil sekali di sini; yang berubah sepanjang bot hidup
    // TIDAK — itu dibaca lewat K.<nama> supaya selalu nilai terbaru.
    const {
        BROADCAST_MAX, GROUPS_TTL_MS, OUTBOX_MAX, OUTBOX_TTL_MS,
        bot2Siap, botSiap, broadcastTargets, bump,         enrichDicariMessage, getSavedStatuses, kickQueue, messageQueue,
        saveLidResolutionMap, saveStatus, simpanOutbox, swapLegacyGreeting,
        
    } = K;

    app.get('/groups', requireAuth, async (req, res) => {
        const fresh = req.query.fresh === '1';
        if (!fresh && K.groupsCache.data && Date.now() - K.groupsCache.at < GROUPS_TTL_MS) {
            return res.json({ groups: K.groupsCache.data, cached: true, age: Date.now() - K.groupsCache.at });
        }
        // botSiap(), bukan sekadar `waSocket`: selama menunggu QR dipindai socket-nya
        // sudah terbuka tapi belum login, dan groupFetchAllParticipating() akan
        // menggantung sampai klien menyerah — cache basi jauh lebih berguna daripada
        // permintaan yang tidak pernah dijawab.
        if (!botSiap()) {
            // Bot lagi putus? Sajikan cache lama daripada gagal total.
            if (K.groupsCache.data) return res.json({ groups: K.groupsCache.data, cached: true, stale: true, age: Date.now() - K.groupsCache.at });
            return res.status(503).json({ error: 'Bot not connected' });
        }
        try {
            const chats = await K.waSocket.groupFetchAllParticipating();
            const groups = Object.entries(chats).map(([jid, meta]) => ({
                jid,
                name: meta.subject || 'Tanpa Nama',
                participants: meta.participants?.length || 0,
                isAdmin: meta.participants?.some(p =>
                    p.id === K.waSocket.user?.id && (p.admin === 'admin' || p.admin === 'superadmin')
                ) || false,
            }));
            K.groupsCache = { at: Date.now(), data: groups };
            res.json({ groups, cached: false });
        } catch (err) {
            // Rate limit WhatsApp jangan menghapus daftar yang sudah pernah berhasil.
            if (K.groupsCache.data) {
                return res.json({ groups: K.groupsCache.data, cached: true, stale: true, error: err.message, age: Date.now() - K.groupsCache.at });
            }
            res.status(500).json({ error: err.message });
        }
    });

    // ── Send message endpoint ─────────────────────────────────────────────────────
    app.post('/send', requireAuth, async (req, res) => {
        const { target, url } = req.body;
        if (!target) return res.status(400).json({ error: 'Target required' });

        // ── Dua nomor, satu gerbang ───────────────────────────────────────────
        // Situs cuma tahu satu alamat bot, dan alamat itu menunjuk ke sini. Kalau
        // sesi WhatsApp bot INI mati sementara perangkat kedua sehat, kiriman
        // diserahkan ke sana daripada mengantre di bot yang tidak bisa mengirim.
        //
        //   perangkat: 'auto' (bawaan) — pakai bot ini; kalau tidak siap, serahkan
        //              'ini'           — jangan pernah diserahkan
        //              'lain'          — paksa lewat perangkat kedua
        //
        // X-Diteruskan menutup lingkaran: bot kedua menjalankan berkas yang sama,
        // jadi tanpa penanda ini dua bot yang sama-sama tidak siap bisa saling
        // melempar permintaan yang sama.
        const sudahDiteruskan = req.get('X-Diteruskan') === '1';
        const perangkat = String(req.body.perangkat || 'auto').toLowerCase();
        const bolehTeruskan = !sudahDiteruskan && perangkat !== 'ini';
        if (bolehTeruskan && (perangkat === 'lain' || !botSiap())) {
            const siap = await bot2Siap();
            if (siap) {
                const { perangkat: _buang, ...isi } = req.body;
                const hasil = await K.teruskanKeBot2('/send', {
                    method: 'POST', body: isi, headers: { 'X-Diteruskan': '1' },
                });
                // Sengaja TIDAK jatuh balik ke antrean lokal kalau bot kedua menolak:
                // dua jalur untuk satu pesan adalah cara paling rapi untuk mengirim
                // pesan yang sama dua kali. Yang gagal dilaporkan apa adanya.
                bump(hasil.status < 400 ? 'diteruskan_bot2' : 'teruskan_bot2_gagal');
                return res.status(hasil.status).json({
                    ...hasil.body,
                    perangkat: 'lain',
                    catatan: 'Dikirim lewat perangkat KEDUA — nomor pengirimnya berbeda '
                        + 'dari nomor bot pertama.',
                });
            }
            if (perangkat === 'lain') {
                return res.status(503).json({
                    error: 'Perangkat kedua tidak siap mengirim.', perangkat: 'lain',
                });
            }
            // 'auto' dan perangkat kedua juga tidak siap → lanjut ke jalur biasa di
            // bawah, yang akan mengantre atau menolak sesuai umur pesannya.
        }

        const jid = toJid(target);
        const message = enrichDicariMessage(swapLegacyGreeting(req.body.message, jid), jid);

        // Masa berlaku ditentukan PEMANGGIL, karena hanya dia yang tahu pesannya
        // masih berguna atau tidak kalau terlambat. Notifikasi penjualan: berhari-hari.
        // Kode OTP: beberapa menit, lewat dari itu ia sampah yang membingungkan.
        const ttlDetik = Number(req.body.ttlDetik);
        const ttl = Number.isFinite(ttlDetik) && ttlDetik > 0
            ? Math.min(ttlDetik * 1000, OUTBOX_TTL_MS)
            : OUTBOX_TTL_MS;

        // Pesan berumur pendek (OTP) yang mengantre saat bot tidak bisa mengirim
        // adalah janji yang tidak bisa ditepati: 'status: true' membuat situs
        // memberi tahu pendaftar bahwa kodenya sudah terkirim, lalu pesannya
        // kedaluwarsa di antrean tanpa seorang pun tahu. Tolak terang-terangan
        // supaya pemanggilnya bisa memilih jalan lain (mis. Fonnte). Pesan berumur
        // panjang tetap diterima — ia memang dibuat untuk menunggu.
        //
        // Syaratnya botSiap(), BUKAN cuma sesiTerkunci. Sesi terkunci adalah satu
        // dari beberapa cara bot tidak bisa mengirim; yang lain adalah belum
        // ditautkan sama sekali — dan itu keadaan yang benar-benar terjadi pada 21
        // Agustus 2026, saat dua OTP mengantre lalu dibuang kedaluwarsa sementara
        // situs sudah terlanjur bilang "OTP terkirim ke WhatsApp".
        //
        // botSiap(), bukan socketAlive(): selama menunggu dipindai, WebSocket-nya
        // sudah terbuka padahal belum ada nomor yang bisa mengirim apa pun.
        if (!botSiap() && ttl <= 15 * 60 * 1000) {
            return res.status(503).json({
                error: K.sesiTerkunci
                    ? 'Sesi WhatsApp terkunci — pesan berumur pendek tidak bisa dijanjikan sekarang.'
                    : 'Bot belum tersambung ke WhatsApp — pesan berumur pendek tidak bisa dijanjikan sekarang.',
                terkunci: K.sesiTerkunci,
                tersambung: botSiap(),
            });
        }

        // Cap antrean. Bukan cuma penjaga memori: menyemburkan ribuan pesan sekaligus
        // begitu tersambung adalah pola spam yang bisa membuat nomornya dibatasi lagi.
        if (messageQueue.length >= OUTBOX_MAX) {
            return res.status(503).json({ error: 'Antrean penuh, bot sedang tidak stabil' });
        }
        messageQueue.push({ jid, message, url, ts: Date.now(), ttl });
        simpanOutbox();
        kickQueue();
        // botSiap(), bukan socketAlive(): kabel yang tersambung ke WhatsApp tanpa
        // nomor yang login tetap tidak bisa mengirim apa pun, dan menjawab
        // tertunda:false di keadaan itu adalah kabar baik yang keliru.
        const tertunda = !botSiap();
        res.json({
            status: true,
            tertunda,
            perangkat: 'ini',
            antre: messageQueue.length,
            detail: tertunda
                ? 'Bot sedang tidak tersambung — pesan disimpan dan dikirim otomatis begitu tersambung lagi.'
                : 'Pesan ditambahkan ke antrean (Queue)',
        });
    });

    app.get('/broadcast/targets', requireAuth, (req, res) => {
        const list = broadcastTargets();
        res.json({ targets: list, count: list.length, max: BROADCAST_MAX });
    });

    app.post('/broadcast', requireAuth, (req, res) => {
        const message = String(req.body?.message || '').trim();
        const jids = Array.isArray(req.body?.jids) ? req.body.jids : [];
        if (!message) return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
        if (!jids.length) return res.status(400).json({ error: 'Pilih minimal satu tujuan' });
        if (jids.length > BROADCAST_MAX) {
            return res.status(400).json({ error: `Maksimal ${BROADCAST_MAX} tujuan sekali kirim` });
        }
        if (messageQueue.length > 100) {
            return res.status(503).json({ error: 'Antrean sedang panjang, coba lagi nanti' });
        }
        const allowed = new Set(broadcastTargets().map(t => t.jid));
        const accepted = [], rejected = [];
        for (const raw of jids) {
            const jid = String(raw || '');
            if (allowed.has(jid)) accepted.push(jid); else rejected.push(jid);
        }
        if (!accepted.length) {
            return res.status(400).json({
                error: 'Tidak ada tujuan yang valid. Hanya kontak yang pernah chat bot yang bisa dikirimi.',
                rejected,
            });
        }
        // Lewat antrean yang sama dengan balasan biasa, jadi jeda antar kontak berbeda
        // (GAP_OTHER_*) tetap berlaku — kiriman menyebar, bukan burst.
        for (const jid of accepted) messageQueue.push({ jid, message, ts: Date.now() });
        kickQueue();
        bump('broadcast', accepted.length);
        console.log(`[broadcast] ${accepted.length} tujuan diantrekan${rejected.length ? `, ${rejected.length} ditolak (bukan kontak yang pernah chat)` : ''}.`);
        res.json({ ok: true, queued: accepted.length, rejected });
    });

    // ── Profile Bot endpoint ──────────────────────────────────────────────────────
    app.get('/profile', requireAuth, (req, res) => {
        res.json({
            name: K.waSocket?.user?.name || '',
            jid: K.waSocket?.user?.id || '',
            phone: K.connectedPhone || '',
        });
    });

    app.post('/profile/name', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { name } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'name required' });
        try {
            await K.waSocket.updateProfileName(name.trim());
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/profile/status', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { status } = req.body;
        if (status === undefined) return res.status(400).json({ error: 'status required' });
        try {
            await K.waSocket.updateProfileStatus(status);
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── LID Resolution Map endpoint ───────────────────────────────────────────────
    app.get('/lid-map', requireAuth, (req, res) => {
        const entries = Array.from(K.lidResolutionMap.entries())
            .map(([lid, phone]) => ({ lid, phone }));
        res.json({ entries, count: entries.length });
    });

    app.delete('/lid-map', requireAuth, (req, res) => {
        const { lid } = req.body;
        if (!lid) return res.status(400).json({ error: 'lid required' });
        const deleted = K.lidResolutionMap.delete(lid);
        if (deleted) saveLidResolutionMap();
        res.json({ ok: deleted });
    });

    // ── Conversation Context endpoint ─────────────────────────────────────────────
    app.get('/context', requireAuth, (req, res) => {
        const now = Date.now();
        const entries = Array.from(K.conversationContext.entries()).map(([jid, history]) => ({
            jid,
            messages: history.length,
            lastTime: history[history.length - 1]?.time || 0,
            lastText: history[history.length - 1]?.text?.slice(0, 80) || '',
            lastRole: history[history.length - 1]?.role || '',
            history,
        }));
        res.json({ entries: entries.sort((a, b) => b.lastTime - a.lastTime), count: entries.length, now });
    });

    app.delete('/context', requireAuth, (req, res) => {
        const { jid } = req.body;
        if (jid) {
            K.conversationContext.delete(jid);
        } else {
            K.conversationContext.clear();
        }
        res.json({ ok: true });
    });

    // ── Blocklist endpoint ────────────────────────────────────────────────────────
    app.get('/blocklist', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        try {
            const list = await K.waSocket.fetchBlocklist();
            res.json({ blocklist: list || [] });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/blocklist/block', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { jid } = req.body;
        if (!jid) return res.status(400).json({ error: 'jid required' });
        try {
            await K.waSocket.updateBlockStatus(jid, 'block');
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/blocklist/unblock', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { jid } = req.body;
        if (!jid) return res.status(400).json({ error: 'jid required' });
        try {
            await K.waSocket.updateBlockStatus(jid, 'unblock');
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── WA Story / Status endpoint ────────────────────────────────────────────────
    app.get('/story', requireAuth, (req, res) => {
        res.json({ statuses: getSavedStatuses() });
    });

    app.post('/story', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { text, url } = req.body;
        if (!text?.trim()) return res.status(400).json({ error: 'text required' });
        try {
            const jidsSet = new Set([...chatMap.keys(), ...contactMap.keys()]);
            if (K.connectedPhone) jidsSet.add(K.connectedPhone + '@s.whatsapp.net');
            const jids = Array.from(jidsSet).filter(jid => jid.endsWith('@s.whatsapp.net'));
            
            let result;
            if (url) {
                const imgRes = await fetch(url);
                const buf = Buffer.from(await imgRes.arrayBuffer());
                result = await K.waSocket.sendMessage('status@broadcast', { image: buf, caption: text }, { statusJidList: jids });
            } else {
                result = await K.waSocket.sendMessage('status@broadcast', { text, backgroundColor: '#075E54', font: 3 }, { statusJidList: jids });
            }
        
            const now = Date.now();
            saveStatus({
                id: result?.key?.id || now.toString(),
                type: url ? 'image' : 'text',
                text,
                url,
                timestamp: now,
                expiresAt: now + 24 * 60 * 60 * 1000
            });
        
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Group management endpoints ────────────────────────────────────────────────
    app.get('/groups/:jid/invite', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const jid = decodeURIComponent(req.params.jid);
        try {
            const code = await K.waSocket.groupInviteCode(jid);
            res.json({ ok: true, link: `https://chat.whatsapp.com/${code}`, code });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/groups/create', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { name, participants } = req.body;
        if (!name?.trim() || !Array.isArray(participants) || !participants.length) {
            return res.status(400).json({ error: 'name and participants (array) required' });
        }
        try {
            const jids = participants.map(toJid);
            const result = await K.waSocket.groupCreate(name.trim(), jids);
            res.json({ ok: true, jid: result.id });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/groups/:jid/participants', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const jid = decodeURIComponent(req.params.jid);
        const { action, participants } = req.body;
        if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
            return res.status(400).json({ error: 'action: add/remove/promote/demote' });
        }
        // Dulu `participants` tidak divalidasi: kalau tidak dikirim, `.map` melempar di
        // dalam try dan klien menerima 500 padahal itu salah input (400).
        if (!Array.isArray(participants) || !participants.length) {
            return res.status(400).json({ error: 'participants (array) required' });
        }
        try {
            const jids = participants.map(toJid);
            const result = await K.waSocket.groupParticipantsUpdate(jid, jids, action);
            res.json({ ok: true, result });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Send Poll endpoint ────────────────────────────────────────────────────────
    app.post('/send-poll', requireAuth, async (req, res) => {
        const { target, name, options } = req.body;
        if (!target || !name?.trim() || !options?.length) {
            return res.status(400).json({ error: 'target, name, options required' });
        }
    
        const jid = toJid(target);

        // Cap antrean sama seperti /send: cegah burst (pola spam → risiko blokir WA).
        if (messageQueue.length > 200) {
            return res.status(503).json({ error: 'Antrean penuh, bot sedang tidak stabil' });
        }
        messageQueue.push({ jid, poll: { name: name.trim(), values: options, selectableCount: 1 }, ts: Date.now() });
        kickQueue();
        res.json({ ok: true, detail: 'Poll ditambahkan ke antrean' });
    });

    // Satu grup, lengkap dengan DAFTAR anggotanya. Beda dengan GET /groups yang
    // menyajikan `participants` sebagai ANGKA (jumlah) demi daftar yang ringan.
    // Bedanya bukan kosmetik: broadcast japri di situs mengambil daftar anggota dari
    // sini, dan ketika route ini tidak ada ia jatuh ke /groups lalu memeriksa
    // Array.isArray(participants) — yang selalu gagal karena isinya angka. Fitur itu
    // tidak pernah bisa jalan sama sekali sebelum route ini ada.
    app.get('/groups/:jid', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const jid = decodeURIComponent(req.params.jid);
        try {
            const meta = await dgnBatas(K.waSocket.groupMetadata(jid), 15000, `Metadata grup ${jid}`);
            res.json({
                jid: meta.id,
                name: meta.subject || 'Tanpa Nama',
                desc: meta.desc || '',
                owner: meta.owner || null,
                size: meta.participants?.length || 0,
                isCommunity: !!meta.isCommunity,
                linkedParent: meta.linkedParent || null,
                participants: (meta.participants || []).map((p) => ({
                    id: p.id,
                    admin: p.admin || null,
                })),
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Nomor terdaftar di WhatsApp atau tidak. Jawabannya memakai kunci `exists`
    // karena itu yang dibaca panel situs.
    app.post('/check-number', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const nomor = String(req.body?.phone || '').replace(/[^0-9]/g, '');
        if (!nomor) return res.status(400).json({ error: 'phone wajib diisi' });
        try {
            const hasil = await dgnBatas(K.waSocket.onWhatsApp(nomor), 15000, "Pemeriksaan nomor");
            const cocok = hasil?.[0];
            res.json({ exists: !!cocok?.exists, jid: cocok?.jid || null, phone: nomor });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Kehadiran (online/mengetik) tidak bisa ditanyakan langsung — WhatsApp
    // MENGIRIMKANNYA setelah kita berlangganan. Jadi: berlangganan, tunggu sebentar,
    // lalu jawab apa yang datang. Tanpa batas waktu, permintaan ini menggantung
    // selamanya untuk nomor yang kebetulan sedang offline dan tidak mengirim apa pun.
    app.post('/get-presence', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        // Diperiksa SEBELUM toJid: toJid('') menjawab '@s.whatsapp.net' yang truthy,
        // jadi memeriksa hasilnya sama saja dengan tidak memeriksa apa-apa.
        const mentah = String(req.body?.jid || req.body?.phone || '').trim();
        if (!mentah) return res.status(400).json({ error: 'jid wajib diisi' });
        const jid = toJid(mentah);
        const TUNGGU_MS = Math.min(Number(req.body?.timeoutMs) || 6000, 15000);
        try {
            let jawab = null;
            const dengar = (ev) => {
                if (ev?.id !== jid || jawab) return;
                const isi = ev.presences?.[jid] || Object.values(ev.presences || {})[0];
                if (isi) jawab = isi;
            };
            K.waSocket.ev.on('presence.update', dengar);
            await K.waSocket.presenceSubscribe(jid).catch(() => {});
            await new Promise((r) => setTimeout(r, TUNGGU_MS));
            K.waSocket.ev.off('presence.update', dengar);

            // Bio/"about" datang dari jalur lain dan tidak selalu ada — kegagalannya
            // tidak boleh menghapus hasil kehadiran yang barusan ditunggu.
            let about = null;
            try {
                const st = await K.waSocket.fetchStatus(jid);
                about = st?.[0]?.status?.status || null;
            } catch (_) {}

            res.json({
                jid,
                // Tidak ada kabar BUKAN berarti offline: WhatsApp hanya mengirim
                // kehadiran orang yang mengizinkannya. Katakan apa adanya.
                presence: jawab?.lastKnownPresence || null,
                lastSeen: jawab?.lastSeen || null,
                about,
                keterangan: jawab ? null : `Tidak ada kabar kehadiran dalam ${Math.round(TUNGGU_MS / 1000)} detik `
                    + '— nomor ini mungkin menyembunyikan status online-nya, atau memang sedang tidak aktif.',
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Setelan privasi akun bot. Nama medannya mengikuti panel situs
    // (lastSeen/profilePhoto/status/readReceipts), bukan nama Baileys.
    app.post('/set-privacy', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { lastSeen, profilePhoto, status, readReceipts } = req.body || {};
        const SAH = new Set(['all', 'contacts', 'contact_blacklist', 'none']);
        // Panel memakai "everyone"; WhatsApp menyebutnya "all".
        const nilai = (v) => (v === 'everyone' ? 'all' : v);
        try {
            const dikerjakan = [];
            if (lastSeen !== undefined) {
                if (!SAH.has(nilai(lastSeen))) return res.status(400).json({ error: `lastSeen tidak sah: ${lastSeen}` });
                await K.waSocket.updateLastSeenPrivacy(nilai(lastSeen)); dikerjakan.push('lastSeen');
            }
            if (profilePhoto !== undefined) {
                if (!SAH.has(nilai(profilePhoto))) return res.status(400).json({ error: `profilePhoto tidak sah: ${profilePhoto}` });
                await K.waSocket.updateProfilePicturePrivacy(nilai(profilePhoto)); dikerjakan.push('profilePhoto');
            }
            if (status !== undefined) {
                if (!SAH.has(nilai(status))) return res.status(400).json({ error: `status tidak sah: ${status}` });
                await K.waSocket.updateStatusPrivacy(nilai(status)); dikerjakan.push('status');
            }
            if (readReceipts !== undefined) {
                await K.waSocket.updateReadReceiptsPrivacy(readReceipts ? 'all' : 'none'); dikerjakan.push('readReceipts');
            }
            if (!dikerjakan.length) return res.status(400).json({ error: 'Tidak ada setelan yang dikirim.' });
            res.json({ ok: true, diubah: dikerjakan });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Perangkat/sesi yang sedang dipakai bot ini. WhatsApp tidak membuka daftar
    // perangkat tertaut lewat protokol yang dipakai Baileys, jadi yang dijawab di
    // sini adalah sesi INI apa adanya — bukan daftar semua perangkat di HP. Lebih
    // baik satu baris yang benar daripada daftar karangan yang terlihat meyakinkan.
    app.post('/session/devices', requireAuth, (req, res) => {
        const creds = K.waSocket?.authState?.creds || {};
        res.json({
            keterangan: 'WhatsApp tidak membuka daftar perangkat tertaut lewat protokol ini. '
                + 'Yang di bawah adalah sesi bot ini sendiri; daftar lengkap ada di HP '
                + '(WhatsApp → Perangkat tertaut).',
            devices: [{
                jid: creds.me?.id || null,
                nama: creds.me?.name || null,
                platform: creds.platform || null,
                registered: !!creds.registered,
                tersambung: !!(K.waSocket && K.connectedPhone),
                tersambungSejak: K.connectedAt || null,
            }],
        });
    });

    // Kirim pesan Baileys apa adanya. Ini pintu belakang yang sengaja dibiarkan
    // terbuka untuk admin: bentuk pesan WhatsApp jauh lebih banyak daripada yang
    // pantas dijadikan endpoint sendiri-sendiri. Tidak lewat antrean — pemakainya
    // satu orang yang sedang menatap layar, bukan lonjakan otomatis.
    app.post('/send-raw', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { jid, target, message, ...sisa } = req.body || {};
        const tujuan = jid || target;
        if (!tujuan) return res.status(400).json({ error: 'jid wajib diisi' });
        // `message` boleh berupa objek pesan Baileys utuh; kalau tidak ada, sisa
        // medan di badan dipakai apa adanya (mis. {text: "..."}).
        const isi = message && typeof message === 'object' ? message : sisa;
        if (!isi || !Object.keys(isi).length) return res.status(400).json({ error: 'message (objek pesan Baileys) wajib diisi' });
        try {
            const hasil = await K.waSocket.sendMessage(toJid(tujuan), isi);
            res.json({ ok: true, id: hasil?.key?.id || null });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Posting ke Saluran (channel/newsletter). JID-nya berakhiran @newsletter dan
    // TIDAK boleh lewat toJid() — itu mengubah apa pun jadi nomor @s.whatsapp.net.
    app.post('/channel/send', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { jid, message, url } = req.body || {};
        if (!jid || !String(jid).endsWith('@newsletter')) {
            return res.status(400).json({ error: 'jid saluran wajib diisi (berakhiran @newsletter)' });
        }
        if (!String(message || '').trim()) return res.status(400).json({ error: 'message wajib diisi' });
        const teks = url ? `${String(message).trim()}\n\n${url}` : String(message).trim();
        try {
            const hasil = await K.waSocket.sendMessage(jid, { text: teks });
            res.json({ ok: true, id: hasil?.key?.id || null });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Komunitas ────────────────────────────────────────────────────────────────
    // Komunitas adalah grup induk: di daftar grup ia muncul dengan isCommunity,
    // dan grup yang bernaung di bawahnya menyebut induknya lewat linkedParent.
    app.post('/community/list', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        try {
            const semua = await dgnBatas(K.waSocket.groupFetchAllParticipating(), 20000, "Daftar grup");
            const komunitas = Object.entries(semua)
                .filter(([, m]) => m.isCommunity)
                .map(([jid, m]) => ({
                    jid,
                    name: m.subject || 'Tanpa Nama',
                    desc: m.desc || '',
                    // Sub-grup dihitung dari daftar yang sama — tidak perlu satu
                    // panggilan jaringan lagi per komunitas.
                    subGrup: Object.entries(semua)
                        .filter(([, g]) => g.linkedParent === jid)
                        .map(([gj, g]) => ({ jid: gj, name: g.subject || 'Tanpa Nama' })),
                }));
            res.json({ communities: komunitas });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/community/create', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const nama = String(req.body?.name || '').trim();
        if (!nama) return res.status(400).json({ error: 'name wajib diisi' });
        try {
            const hasil = await K.waSocket.communityCreate(nama, String(req.body?.desc || '').trim());
            res.json({ ok: true, jid: hasil?.id || null, name: hasil?.subject || nama });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/community/link-group', requireAuth, async (req, res) => {
        if (!botSiap()) return res.status(503).json({ error: 'Bot not connected' });
        const { communityJid, groupJid } = req.body || {};
        if (!communityJid || !groupJid) return res.status(400).json({ error: 'communityJid dan groupJid wajib diisi' });
        try {
            // Urutan argumen Baileys: (grup, induk). Tertukar = grup induk yang
            // dicoba ditautkan ke dalam sub-grupnya, dan pesan galatnya menyesatkan.
            await K.waSocket.communityLinkGroup(groupJid, communityJid);
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
};
