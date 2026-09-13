module.exports = function createMessageHandler(sock, K, deps) {
    const {
        processedMsgIds,
        IGNORED_MESSAGE_TYPES,
        botSentIds,
        botSessions,
        recordMessage,
        nameMap,
        askedNameOnce,
        rememberBotSent,
        migratedLids,
        contactMap,
        photoBuffer,
        saveNameMap,
        saveStatus,
        downloadMediaMessage,
        pino,
        FormData,
        Blob,
        fetch,
        tandaiPerangkat,
        stripBotPrefix,
        stripInvisible,
        plainCommandWord,
        isAdminCall,
        botSessionActive,
        extractMessage,
        addToContext,
        adminCallMap,
        greetedMap,
        saveGreetedMap,
        markStateDirty
    } = deps;

    return async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;
            const sender = msg.key.remoteJid;

            // ── Anti-dobel: skip kalau ID pesan ini sudah pernah diproses ──
            if (msg.key.id) {
                if (processedMsgIds.has(msg.key.id)) continue;
                processedMsgIds.add(msg.key.id);
                if (processedMsgIds.size > 800) processedMsgIds.delete(processedMsgIds.values().next().value);
            }

            // ── Centang biru SENGAJA TIDAK dikirim ──
            // Dulu di sini ada sock.readMessages([msg.key]) yang jalan tiap pesan masuk.
            // Efeknya centang biru nongol instan, bahkan sebelum admin buka HP — malah
            // jadi penanda jelas bahwa yang jaga itu bot. Biar centang tetap abu-abu
            // sampai admin beneran membuka chatnya di HP.

            // ── Tangkap Status WA dari HP Sendiri (Manual Post) ──
            if (sender === 'status@broadcast') {
                const isMyStatus = msg.key.fromMe || (msg.key.participant && msg.key.participant === K.connectedPhone + '@s.whatsapp.net');
                if (isMyStatus) {
                    try {
                        const { type: msgType, content: msgContent, rawForMedia } = extractMessage(msg.message);
                        const isVideo = msgType === 'videoMessage';
                        const isImage = msgType === 'imageMessage';
                        const text = msgType === 'extendedTextMessage' ? msgContent?.text || '' : msgContent?.caption || '';
                        
                        let url = null;
                        if (isImage) {
                            try {
                                const buf = await downloadMediaMessage({ ...msg, message: rawForMedia }, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                                url = 'data:image/jpeg;base64,' + buf.toString('base64');
                            } catch (e) { console.error('[status] Gagal download gambar status manual:', e.message); }
                        }

                        const typeLabel = isImage ? 'image' : isVideo ? 'video' : 'text';
                        const now = Date.now();
                        saveStatus({
                            id: msg.key.id,
                            type: typeLabel,
                            text: text,
                            url: url,
                            timestamp: now,
                            expiresAt: now + 24 * 60 * 60 * 1000
                        });
                    } catch(e) { console.error('[status] Error:', e.message); }
                }
                continue; // Jangan proses status orang lain atau diri sendiri sebagai chat biasa
            }

            // if (msg.key.fromMe) continue; // Allow fromMe for admin takeover
            // (status@broadcast sudah di-`continue` di blok di atas.)
            if (!sender || sender.includes('@newsletter')) continue;

            // Reaksi emoji, hapus/edit pesan, dan coblosan poll bukan percakapan —
            // buang di sini sebelum apa pun diteruskan ke webhook.
            if (IGNORED_MESSAGE_TYPES.has(extractMessage(msg.message).type)) continue;

            // ── Pesan dari grup marketplace → kirim ke webhook untuk diindeks ──
            if (sender.includes('@g.us')) {
                if (!K.MARKETPLACE_GROUP_JID || sender !== K.MARKETPLACE_GROUP_JID) continue;
                try {
                    const { type: msgType, content: msgContent, rawForMedia: rawFM } = extractMessage(msg.message);
                    const text = msgType === 'conversation' ? msgContent
                        : msgType === 'extendedTextMessage' ? msgContent?.text || ''
                        : msgContent?.caption || '';
                    if (!text && msgType !== 'imageMessage') continue; // skip stiker/audio grup

                    let buf = null, mime = '', fname = '';
                    if (msgType === 'imageMessage') {
                        mime = msgContent?.mimetype || 'image/jpeg'; fname = 'image.jpg';
                        buf = await downloadMediaMessage({ ...msg, message: rawFM }, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                    }

                    const rawParticipant = (msg.key.participant || sender).replace(/:(\d+)(?=@)/, '');
                    let senderInGroup = rawParticipant;
                    if (rawParticipant.endsWith('@lid')) {
                        const pAlt = (msg.key.participantAlt || '').endsWith('@s.whatsapp.net') ? msg.key.participantAlt : null;
                        senderInGroup = pAlt || K.lidMap.get(rawParticipant) || K.lidResolutionMap.get(rawParticipant) || null;
                        if (!senderInGroup) {
                            try {
                                const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(rawParticipant);
                                senderInGroup = (pn && pn.endsWith('@s.whatsapp.net')) ? pn : rawParticipant;
                            } catch { senderInGroup = rawParticipant; }
                        }
                        if (senderInGroup !== rawParticipant && K.lidResolutionMap.get(rawParticipant) !== senderInGroup) {
                            K.lidResolutionMap.set(rawParticipant, senderInGroup);
                            K.saveLidResolutionMap();
                        }
                    }
                    const gForm = new FormData();
                    gForm.append('sender', senderInGroup);
                    gForm.append('message', stripInvisible(text));
                    gForm.append('source', 'group');
                    gForm.append('group_jid', sender);
                    if (buf) gForm.append('file', new Blob([buf], { type: mime }), fname);
                    await fetch(K.WEBHOOK_URL, { method: 'POST', body: tandaiPerangkat(gForm), headers: { 'Authorization': process.env.WEBHOOK_TOKEN } }).catch(() => {});
                } catch (e) { console.error('[grup] error:', e.message); }
                continue;
            }

            try {
                const { type: messageType, content, rawForMedia } = extractMessage(msg.message);

                // Teks mentah dipakai untuk memutuskan gerbang bot SEBELUM media
                // di-download — pesan buat admin tak perlu ongkos unduh foto/video.
                const gateText = stripInvisible(
                    messageType === 'conversation' ? content : (content?.text || content?.caption || '')
                );
                const hasPrefix = gateText.startsWith(K.BOT_PREFIX);
                // Kunci sesi/sapaan pakai remoteJid apa adanya: nilai ini konsisten untuk
                // kontak yang sama (termasuk pada pesan fromMe), sementara hasil resolve
                // @lid→nomor baru tersedia belakangan dan bisa berubah di tengah jalan.
                const gateKey = sender;

                // ── Pesan fromMe (terkirim dari nomor ini sendiri) ────────────────
                // 1) Echo balasan BOT sendiri → abaikan total (sudah tercatat via
                //    sendWa di webhook; kalau diteruskan malah dianggap balasan manual).
                // 2) Ketikan MANUAL owner (HP/WA Web) tanpa '#' → jangan diproses
                //    sebagai chat, tapi teruskan ke webhook dengan fromMe=true sebagai
                //    sinyal "owner lagi turun tangan" → bot senyap otomatis di kontak
                //    ini. Pesan '#...' = perintah takeover, biarkan lanjut ke pipeline.
                if (msg.key.fromMe) {
                    if (botSentIds.has(msg.key.id)) continue;
                    const fmText = ((messageType === 'conversation' ? content : (content?.text || content?.caption || '')) || '').trim();
                    if (!fmText.startsWith('#')) {
                        // Admin sudah turun tangan → tutup sesi bot di kontak ini juga,
                        // biar bot tidak nyeletuk lagi di tengah obrolan manual.
                        botSessions.delete(gateKey);
                        let manualTarget = sender;
                        if (sender.endsWith('@lid')) {
                            const altFm = (msg.key.remoteJidAlt || '').endsWith('@s.whatsapp.net') ? msg.key.remoteJidAlt : null;
                            manualTarget = altFm || K.lidMap.get(sender) || K.lidResolutionMap.get(sender) || sender;
                        }
                        const isMediaFm = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType);
                        const fmForm = new FormData();
                        fmForm.append('sender', manualTarget);
                        fmForm.append('message', fmText.slice(0, 1500));
                        fmForm.append('fromMe', 'true');
                        if (isMediaFm) fmForm.append('manual_media', '1');
                        fetch(K.WEBHOOK_URL, { method: 'POST', body: tandaiPerangkat(fmForm), headers: { 'Authorization': process.env.WEBHOOK_TOKEN } }).catch(() => {});
                        // Balasan manual admin ikut diarsipkan, kalau tidak inbox dashboard
                        // cuma menampilkan sisi pelanggan dan riwayatnya terbaca timpang.
                        recordMessage(manualTarget, 'out', isMediaFm ? (fmText || '[media]') : fmText, 'manual');
                        K.bump('balas_manual');
                        console.log(`[owner-manual] Balasan manual ke ${manualTarget} → sinyal senyap dikirim ke webhook`);
                        continue;
                    }
                }

                // Resolve @lid JID ke phone JID agar nomor konsisten dengan website
                // Urutan prioritas: lidMap (dari contacts sync) > lidResolutionMap (konfirmasi manual)
                let resolvedSender = sender;
                if (sender.endsWith('@lid')) {
                    const { type: mType, content: mContent } = extractMessage(msg.message);
                    const rawText = (mType === 'conversation' ? mContent : mContent?.text || '').trim();

                    // Fitur Reset Nomor/nama (bisa dipanggil kapan saja)
                    if (rawText.toLowerCase() === 'reset nomor') {
                        K.lidResolutionMap.delete(sender);
                        K.saveLidResolutionMap();
                        nameMap.delete(sender);
                        saveNameMap();
                        askedNameOnce.delete(sender);
                        rememberBotSent(await sock.sendMessage(sender, { text: "🔄 Oke, data kamu sudah di-reset." }));
                        continue;
                    }

                    // (fromMe tanpa '#' sudah ditangani lebih awal sebagai sinyal
                    //  balasan manual owner — yang sampai sini hanya '#takeover'.)

                    // Nomor asli user @lid TIDAK perlu ditanya: WhatsApp menyediakannya.
                    // Prioritas: remoteJidAlt (pesan) > lidMap (contacts) > lidResolutionMap (cache)
                    //          > getPNForLID (query langsung ke pemetaan LID↔nomor Baileys v7).
                    const altJid = msg.key.remoteJidAlt || '';
                    const fromAlt = altJid.endsWith('@s.whatsapp.net') ? altJid : null;
                    let resolvedNum = fromAlt || K.lidMap.get(sender) || K.lidResolutionMap.get(sender) || null;
                    // Sumber terkuat: tanya langsung ke WhatsApp. Ini yang bikin nomor "selalu
                    // ketahuan" walau field pesan kebetulan tak memuatnya.
                    let fromQuery = null;
                    if (!resolvedNum) {
                        try {
                            const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(sender);
                            if (pn && pn.endsWith('@s.whatsapp.net')) { fromQuery = pn; resolvedNum = pn; }
                        } catch (e) { console.warn(`[lid-resolve] getPNForLID gagal utk ${sender}: ${e.message}`); }
                    }
                    if (resolvedNum) {
                        resolvedSender = resolvedNum;
                        // Persist mapping yang baru dipelajari (dari alt/query) agar konsisten
                        // & tak perlu query ulang tiap pesan.
                        const learned = fromAlt || fromQuery;
                        if (learned && K.lidResolutionMap.get(sender) !== learned) {
                            K.lidResolutionMap.set(sender, learned);
                            K.saveLidResolutionMap();
                        }
                        const src = fromAlt ? 'alt' : K.lidMap.get(sender) ? 'contacts' : fromQuery ? 'query' : 'manual';
                        console.log(`[lid-resolve] ${sender} → ${resolvedNum} (${src})`);
                    }

                    // Nama diambil OTOMATIS dari pushName WhatsApp. Kalau pushName benar-benar
                    // kosong, tanya SEKALI saja (arahkan ke command NAMA) — tidak loop, tidak nebak.
                    // Jangan pernah untuk fromMe: pushName pesan fromMe = nama OWNER sendiri,
                    // bukan nama kontak (bisa nyangkut jadi nama pelanggan).
                    if (!msg.key.fromMe && !nameMap.get(sender)) {
                        const pushName = (msg.pushName || '').trim();
                        if (pushName) {
                            nameMap.set(sender, pushName.slice(0, 50));
                            saveNameMap();
                        } else if (!askedNameOnce.has(sender) && (hasPrefix || botSessionActive(gateKey))) {
                            // Hanya ditanyakan kalau pesannya memang ditujukan ke bot —
                            // pelanggan yang mau ngobrol ke admin tak perlu diminta nama.
                            askedNameOnce.add(sender);
                            rememberBotSent(await sock.sendMessage(sender, { text: "👋 Halo! Aku belum tau namamu. Ketik *NAMA [namamu]* ya, contoh: *NAMA Budi*." }));
                            // tidak 'continue' — pesan tetap diteruskan & diproses
                        }
                    }
                }
                const cleanSender = resolvedSender.replace(/:(\d+)(?=@)/, '');

                // Kalau sender asli @lid dan kini sudah jadi nomor, kirim penanda `prev_lid`
                // SEKALI agar website memigrasi data lama (seller_wa=LID → nomor) — cegah "double".
                const originLidDigits = sender.endsWith('@lid') ? sender.split('@')[0].replace(/:\d+$/, '') : null;
                const prevLid = (originLidDigits && cleanSender.endsWith('@s.whatsapp.net') && !migratedLids.has(sender))
                    ? originLidDigits : null;
                if (prevLid) migratedLids.add(sender);

                console.log(`Pesan dari ${cleanSender} | type: ${messageType}`);

                // Update chatMap dari pesan masuk (pastikan selalu ada entry)
                const existingChat = K.chatMap.get(cleanSender) || { jid: cleanSender, name: '', lastTime: 0, preview: '' };
                const contactName = contactMap.get(cleanSender)?.name || contactMap.get(sender)?.name || '';
                K.chatMap.set(cleanSender, {
                    ...existingChat,
                    jid: cleanSender,
                    name: contactName || existingChat.name,
                    lastTime: Date.now(),
                    preview: (typeof content === 'string' ? content : content?.text || '[media]')?.slice(0, 60) || '',
                });
                markStateDirty();
                // Batas ukuran chatMap: hapus entry terlama jika melebihi 2000
                if (K.chatMap.size > 2000) {
                    const oldest = [...K.chatMap.entries()].sort((a, b) => a[1].lastTime - b[1].lastTime)[0];
                    if (oldest) K.chatMap.delete(oldest[0]);
                }

                // Simpan ke in-memory log (max 100)
                K.messageLog.unshift({
                    sender: cleanSender,
                    type: messageType,
                    preview: (typeof content === 'string' ? content : content?.text || '[media]')?.slice(0, 100),
                    time: new Date().toISOString(),
                });
                if (K.messageLog.length > 100) K.messageLog.pop();
                // Arsip persisten (dipakai inbox dashboard). Sengaja memakai gateText:
                // isi teks apa adanya, bukan preview terpotong seperti messageLog.
                recordMessage(cleanSender, 'in', gateText || '[media]', messageType);
                K.bump('masuk');

                // ── Gerbang titik ─────────────────────────────────────────────────
                // Aturannya: chat pelanggan itu milik ADMIN sampai pelanggan sendiri
                // yang memanggil bot dengan tanda titik. Pesan yang tidak lolos gerbang
                // TIDAK diteruskan ke webhook — webhook adalah otak balasan otomatis,
                // meneruskannya sama saja dengan menyuruh bot menyahut.
                if (!msg.key.fromMe) {
                    const inSession = botSessionActive(gateKey);
                    // Sesi bisa ditutup pelanggan kapan saja ("admin", "selesai", ...)
                    // tanpa menunggu BOT_SESSION_MS habis.
                    // Panggilan "min" → selalu dijawab sapaan, sesi bot (kalau ada)
                    // ditutup. Ini melewati greetedMap dengan sengaja: sapaan biasa
                    // sekali seumur kontak, sedangkan orang yang manggil "min" memang
                    // sedang minta petunjuk saat itu juga.
                    if (!hasPrefix && isAdminCall(gateText)) {
                        botSessions.delete(gateKey);
                        K.bump('panggil_min');
                        const lastCall = adminCallMap.get(gateKey) || 0;
                        if (Date.now() - lastCall >= K.ADMIN_CALL_COOLDOWN_MS) {
                            adminCallMap.set(gateKey, Date.now());
                            rememberBotSent(await sock.sendMessage(sender, { text: K.greetingText }));
                            recordMessage(cleanSender, 'out', K.greetingText, 'sapaan');
                            K.bump('sapaan');
                            console.log(`[gerbang] ${cleanSender} panggil admin ("${gateText}") → sapaan dikirim`);
                        } else {
                            console.log(`[gerbang] ${cleanSender} panggil admin ("${gateText}") → sapaan ditahan (cooldown)`);
                        }
                        // Tandai tersapa supaya pesan polos berikutnya tidak memicu
                        // sapaan "sekali per kontak" untuk kedua kalinya.
                        if (!greetedMap.has(gateKey)) { greetedMap.set(gateKey, Date.now()); saveGreetedMap(); }
                        continue;
                    }
                    const BOT_END_WORDS = new Set(['admin', 'stop', 'selesai']); // Local fallback if not passed
                    if (inSession && !hasPrefix && BOT_END_WORDS.has(gateText.toLowerCase())) {
                        botSessions.delete(gateKey);
                        console.log(`[gerbang] ${cleanSender} menutup sesi bot ("${gateText}") → lanjut ke admin`);
                        continue;
                    }
                    if (!hasPrefix && !inSession) {
                        const plainCmd = plainCommandWord(gateText);
                        if (plainCmd) {
                            K.bump('perintah_polos');
                            K.bump(`polos_${plainCmd}`);
                            // Perintah polos diizinkan membuka sesi dan diproses langsung tanpa wajib tanda titik '.'
                            console.log(`[gerbang] ${cleanSender} kirim perintah polos "${plainCmd}" → buka sesi & proses`);
                        } else if (!greetedMap.has(gateKey)) {
                            greetedMap.set(gateKey, Date.now());
                            saveGreetedMap();
                            rememberBotSent(await sock.sendMessage(sender, { text: K.greetingText }));
                            recordMessage(cleanSender, 'out', K.greetingText, 'sapaan');
                            K.bump('sapaan');
                            // BUKA sesi bot 15 menit agar pesan balasan pengguna berikutnya langsung dijawab!
                            botSessions.set(gateKey, Date.now() + (15 * 60 * 1000));
                            console.log(`[gerbang] ${cleanSender} → chat baru, sapaan dikirim & sesi bot aktif`);
                            continue;
                        } else {
                            K.bump('didiamkan');
                            console.log(`[gerbang] ${cleanSender} → chat admin, bot diam (tanpa titik / perintah)`);
                            continue;
                        }
                    }
                    // Lolos gerbang: buka/segarkan sesi supaya pesan lanjutan (jawaban
                    // tanya-jawab, foto tanpa caption) tidak perlu bertitik lagi.
                    if (!inSession) K.bump('sesi_bot');
                    botSessions.set(gateKey, Date.now() + (15 * 60 * 1000));
                }

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

                    // ── Multi-foto: buffer 4 detik sebelum kirim ke webhook ──
                    {
                        const existing = photoBuffer.get(cleanSender);
                        if (existing) clearTimeout(existing.timer);
                        const entry = existing || { images: [], caption: '', fromMe: msg.key.fromMe };
                        entry.images.push({ buf: buffer, mime: mimeType });
                        if (text && !entry.caption) entry.caption = text;

                        entry.timer = setTimeout(async () => {
                            photoBuffer.delete(cleanSender);
                            const cleanCap = stripBotPrefix(stripInvisible(entry.caption));
                            const ctx = addToContext(cleanSender, 'user', cleanCap || '[foto]');
                            const pForm = new FormData();
                            pForm.append('sender', cleanSender);
                            pForm.append('message', cleanCap);
                            pForm.append('context', JSON.stringify(ctx.slice(0, -1)));
                            const storedNameP = nameMap.get(cleanSender) || (msg.pushName || '').trim();
                            if (storedNameP) pForm.append('profile_name', storedNameP);
                            if (prevLid) pForm.append('prev_lid', prevLid);
                            pForm.append('fromMe', entry.fromMe ? 'true' : 'false');
                            entry.images.forEach((img, i) => {
                                pForm.append('file', new Blob([img.buf], { type: img.mime }), `image${i + 1}.jpg`);
                            });
                            try {
                                const pResp = await fetch(K.WEBHOOK_URL, { method: 'POST', body: tandaiPerangkat(pForm), headers: { 'Authorization': process.env.WEBHOOK_TOKEN } });
                                const pText = await pResp.text();
                                if (!pResp.ok) { console.error(`Webhook error ${pResp.status}: ${pText}`); }
                                else {
                                    console.log(`Webhook OK (${entry.images.length} foto): ${pText}`);
                                    try { const p = JSON.parse(pText); if (p.bot_reply) addToContext(cleanSender, 'bot', p.bot_reply); } catch (_) {}
                                }
                            } catch (e) { console.error('Error kirim foto buffer:', e.message); }
                        }, 4000);

                        photoBuffer.set(cleanSender, entry);
                        K.messageLog.unshift({ sender: cleanSender, type: messageType, preview: `[${entry.images.length} foto] ${text || ''}`.trim().slice(0, 100), time: new Date().toISOString() });
                        if (K.messageLog.length > 100) K.messageLog.pop();
                        continue; // skip webhook send di bawah, sudah ditangani timer
                    }
                } else if (messageType === 'videoMessage') {
                    hasMedia = true;
                    text = content?.caption || '';
                    mimeType = content?.mimetype || 'video/mp4';
                    filename = 'video.mp4';
                    buffer = await downloadMediaMessage(
                        { ...msg, message: rawForMedia },
                        'buffer', {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );
                } else if (messageType === 'documentMessage') {
                    hasMedia = true;
                    text = content?.caption || content?.fileName || '';
                    mimeType = content?.mimetype || 'application/octet-stream';
                    filename = content?.fileName || 'document';
                    buffer = await downloadMediaMessage(
                        { ...msg, message: rawForMedia },
                        'buffer', {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );
                } else if (messageType === 'audioMessage') {
                    hasMedia = true;
                    text = '';
                    mimeType = content?.mimetype || 'audio/ogg; codecs=opus';
                    filename = 'audio.ogg';
                    buffer = await downloadMediaMessage(
                        { ...msg, message: rawForMedia },
                        'buffer', {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );
                } else {
                    // Stiker dan tipe lain yang tidak didukung
                    text = 'non-text message';
                }

                // Strip BOM dan invisible chars agar FormData tidak gagal encode
                let cleanText = stripBotPrefix(stripInvisible(text));
                // Titik telanjang tanpa perintah: jangan kirim pesan kosong ke webhook
                // (balasannya jadi ngawur) — perlakukan sebagai permintaan menu.
                if (hasPrefix && !cleanText && !hasMedia) cleanText = 'MENU';

                // Bangun context percakapan (kirim sebagai JSON ke webhook)
                const contextHistory = addToContext(cleanSender, 'user', cleanText || `[${messageType}]`);

                const form = new FormData();
                form.append('sender', cleanSender);
                form.append('message', cleanText);
                form.append('context', JSON.stringify(contextHistory.slice(0, -1))); // kirim history sebelum pesan ini
                const storedName = nameMap.get(cleanSender) || (msg.pushName || '').trim();
                if (storedName) form.append('profile_name', storedName);
                if (prevLid) form.append('prev_lid', prevLid);
                form.append('fromMe', msg.key.fromMe ? 'true' : 'false');
                if (hasMedia && buffer) form.append('file', new Blob([buffer], { type: mimeType }), filename);

                // Waktu bulat-bulat website: dari POST sampai badan balasan terbaca.
                // Tanpa angka ini, "bot lambat" tidak bisa dibedakan dari "website lambat".
                const hookStart = Date.now();
                const response = await fetch(K.WEBHOOK_URL, {
                    method: 'POST',
                    body: tandaiPerangkat(form),
                    headers: { 'Authorization': process.env.WEBHOOK_TOKEN }
                });
                const responseText = await response.text();
                const hookMs = Date.now() - hookStart;
                if (!response.ok) {
                    K.bump('webhook_gagal');
                    console.error(`Webhook error ${response.status} (${hookMs}ms): ${responseText}`);
                } else {
                    K.bump('webhook_ok');
                    console.log(`Webhook OK (${hookMs}ms): ${responseText}`);
                    // Simpan balasan bot ke context
                    try {
                        const parsed = JSON.parse(responseText);
                        if (parsed.bot_reply) {
                            addToContext(cleanSender, 'bot', parsed.bot_reply);
                            // Catatan: untuk @lid + fromMe, webhook sudah kirim via sendWa→Baileys
                            // Tidak perlu kirim ulang via sock.sendMessage (akan dobel)
                        }
                    } catch (_) {}
                }
            } catch (err) {
                console.error('Error memproses pesan:', err.message);
            }
        }
    };
};
