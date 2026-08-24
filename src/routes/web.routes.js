/*
 * Rute halaman panel bot — semua yang menjawab dengan HTML, plus pintu masuk
 * dan pintu keluarnya.
 *
 * Dipisah dari rute data (API) dengan alasan yang sederhana: yang di sini
 * melayani MANUSIA dengan peramban, yang di sana melayani MESIN dengan token.
 * Keduanya punya cara gagal yang berbeda — halaman yang menolak sebaiknya
 * mengantar orang ke pintunya, sedangkan API yang menolak sebaiknya menjawab
 * 401 dan diam. Mencampur keduanya di satu berkas membuat orang menyalin pola
 * yang salah ke rute berikutnya.
 *
 * `AKAR` dioper, bukan memakai __dirname: __dirname di berkas ini menunjuk ke
 * src/routes/, sedangkan seluruh berkas halaman tinggal di akar proyek. Ini
 * satu-satunya hal yang berubah saat kode ini pindah ke sini, dan kalau
 * terlewat, setiap halaman menjawab 404 tanpa satu pun galat.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('node:child_process');

const { amanTujuan } = require('../lib/utils');

module.exports = function pasangRuteHalaman(app, ctx) {
    const {
        AKAR, WEBHOOK_URL, API_TOKEN, REPO_BOT, REPO_SITUS,
        PANEL_PASSWORD, KUKI_NAMA,
        requireAuthPage, bolehMasuk, halamanMasuk,         authBlocked, noteAuthFail, passwordMatches, kukiSah,
    } = ctx;

    const RIWAYAT_TTL_MS = Number(process.env.RIWAYAT_TTL_MENIT || 10) * 60 * 1000;

    let riwayatCache = { pada: 0, data: null };

    function riwayatBot(batas = 200) {
        return new Promise((resolve) => {
            // %x1f dan %x1e: pemisah unit & rekaman ASCII. Baris commit di repo ini
            // memuat baris kosong, tanda hubung, dan tabel — pemisah yang "kelihatan"
            // seperti --- pasti cepat atau lambat muncul di dalam pesan commit sendiri.
            execFile('git', ['-C', AKAR, 'log', `-n${batas}`, '--no-color',
                '--pretty=format:%H%x1f%aI%x1f%s%x1f%b%x1e'],
            { maxBuffer: 8 * 1024 * 1024, timeout: 8000 }, (err, stdout) => {
                if (err) return resolve([]);
                resolve(String(stdout).split('\x1e').map((e) => e.trim()).filter(Boolean).map((entri) => {
                    const [sha, tanggal, judul, isi] = entri.split('\x1f');
                    return {
                        sha: (sha || '').slice(0, 7), tanggal, judul,
                        isi: (isi || '').trim(), repo: 'bot',
                        url: `https://github.com/${REPO_BOT}/commit/${sha}`,
                    };
                }));
            });
        });
    }

    async function riwayatSitus(batas = 100) {
        // Tanpa token: 60 permintaan per jam per IP. Cukup, karena hasilnya di-cache.
        const res = await fetch(`https://api.github.com/repos/${REPO_SITUS}/commits?per_page=${batas}`, {
            headers: { 'User-Agent': 'wa-bot-usu', Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        const data = await res.json();
        return (Array.isArray(data) ? data : []).map((c) => {
            const pesan = String(c?.commit?.message || '');
            const pisah = pesan.indexOf('\n');
            return {
                sha: String(c.sha || '').slice(0, 7),
                tanggal: c?.commit?.author?.date || c?.commit?.committer?.date || null,
                judul: pisah === -1 ? pesan : pesan.slice(0, pisah),
                isi: pisah === -1 ? '' : pesan.slice(pisah + 1).trim(),
                repo: 'situs',
                url: c.html_url || `https://github.com/${REPO_SITUS}/commit/${c.sha}`,
            };
        });
    }

    // ── Pintu masuk panel ────────────────────────────────────────────────────────
    // Sebelum ini setiap halaman meminta token 48 karakter ditempel sendiri-sendiri.
    // Sekarang sandi diketik SEKALI di sini dan kukinya berlaku untuk semua halaman
    // maupun semua panggilan API dari halaman itu.
    //
    // Rutenya sendiri publik — pintu yang butuh kunci untuk dilihat bukan pintu.
    app.get('/masuk', (req, res) => {
        if (bolehMasuk(req)) return res.redirect(302, amanTujuan(req.query.next));
        res.type('html').send(halamanMasuk(req.query.next, null));
    });

    app.post('/masuk', (req, res) => {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        if (authBlocked(ip)) return res.status(429).type('html').send(halamanMasuk(req.body?.next, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.'));

        if (!PANEL_PASSWORD) {
            return res.status(503).type('html').send(halamanMasuk(req.body?.next, 'Sandi panel belum dipasang di server (PANEL_PASSWORD kosong). Sementara ini pakai token.'));
        }
        if (!passwordMatches(req.body?.sandi)) {
            noteAuthFail(ip);
            return res.status(401).type('html').send(halamanMasuk(req.body?.next, 'Sandi salah.'));
        }
        res.cookie(KUKI_NAMA, kukiSah(), {
            httpOnly: true,          // JavaScript halaman tidak perlu membacanya
            sameSite: 'strict',      // kuki tidak ikut permintaan dari situs lain (anti-CSRF)
            secure: true,            // hanya lewat https; seluruh panel memang di balik nginx TLS
            maxAge: 30 * 24 * 60 * 60 * 1000,
            path: '/',
        });
        res.redirect(302, amanTujuan(req.body?.next));
    });

    app.get('/keluar', (req, res) => {
        res.clearCookie(KUKI_NAMA, { path: '/' });
        res.redirect(302, '/masuk');
    });

    // ── QR Page (public) ─────────────────────────────────────────────────────────
    app.get('/', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'halaman', 'dashboard.html'));
    });

    // ── Beranda (public) ─────────────────────────────────────────────────────────
    // Daftar tombol ke semua halaman & endpoint. Halamannya sendiri publik; data
    // yang butuh token tetap diambil lewat fetch ber-Authorization dari browser.
    app.get('/home', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'halaman', 'home.html'));
    });

    // ── Halaman catatan proyek (public) ──────────────────────────────────────────
    // Halaman baca panjang berisi detail proyek: masalah yang diangkat, arsitektur
    // dua-pintu (web + WhatsApp), keputusan desain gerbang titik, dan jejak perbaikan
    // keandalan. Sengaja disajikan dari bot, bukan dari situs utama — halaman yang
    // menceritakan bot ini pantas dilayani oleh bot itu sendiri.
    app.get('/projek', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'halaman', 'projek.html'));
    });

    app.get('/update', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'halaman', 'update.html'));
    });

    // ── Halaman audit (butuh sandi) ──────────────────────────────────────────────
    // Dua halaman, dua sudut pandang atas audit yang sama. Dua-duanya BERGERBANG,
    // dan itu bukan kehati-hatian berlebihan: isinya menyebut endpoint yang belum
    // dijaga dan kredensial yang belum dirotasi. Daftar seperti itu adalah peta
    // serangan yang sudah jadi.
    //
    // progres.html sempat tinggal di public/ pada 21 Agustus 2026 — dan express.static
    // melayani apa pun di sana tanpa gerbang, jadi selama beberapa menit halaman itu
    // menyajikan sandi admin ke siapa saja yang mengetik alamatnya. Berkasnya
    // dipindah ke halaman/, yang tidak disajikan static. Jangan pernah menaruh berkas
    // bergerbang di public/.
    app.get('/progres', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'halaman', 'progres.html'));
    });

    app.get('/progres-claude', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'halaman', 'progres-claude.html'));
    });

    // Temuan keamanannya TIDAK ditulis di dalam HTML-nya: berkas HTML ikut git, dan
    // repo ini publik. Ia tinggal di catatan/ yang sengaja di-.gitignore, dan diambil
    // halamannya saat dibuka. Konsekuensinya jujur: VPS yang baru di-deploy tidak
    // punya salinannya, dan halamannya memang mengatakan itu apa adanya.
    app.get('/progres-claude/temuan', requireAuthPage, (req, res) => {
        const berkas = path.join(AKAR, 'catatan', 'temuan-keamanan.md');
        if (!fs.existsSync(berkas)) return res.status(404).type('text/plain; charset=utf-8').send('');
        res.type('text/plain; charset=utf-8').send(fs.readFileSync(berkas, 'utf8'));
    });

    app.get('/lomba', (req, res) => {
        res.sendFile(path.join(AKAR, 'public', 'lomba.html'));
    });

    // Tutorial publik untuk pengguna Menfess dan alur moderasi yang aman.
    // Tidak ada kredensial, data percakapan, atau endpoint internal di halaman ini.
    app.get('/tutor', (req, res) => {
        res.sendFile(path.join(AKAR, 'public', 'tutor.html'));
    });

    // ── Panel bot versi demo (public) ────────────────────────────────────────────
    // Berkas yang SAMA dengan /dashboard — bukan salinan.
    //
    // Panel ini bagian yang paling banyak menjelaskan cara kerja bot, dan ia justru
    // yang paling tidak bisa diperlihatkan: bergerbang sandi, dan isinya nomor serta
    // isi percakapan orang sungguhan. Jadi yang dibuka kembarannya: halaman yang
    // sama, data karangan.
    //
    // Yang membuatnya aman ada di halamannya, bukan di sini. Saat dibuka lewat
    // /demo, api() dan post() di dashboard.html tidak pernah memanggil jaringan —
    // jawabannya dirakit di dalam halaman. Jadi tidak ada satu pun endpoint bot yang
    // bisa disentuh dari sana, bahkan dari konsol peramban. Gerbang requireAuth di
    // endpoint-endpoint itu pun tetap berdiri seperti biasa, sebagai lapis kedua.
    app.get('/demo', (req, res) => {
        res.sendFile(path.join(AKAR, 'halaman', 'dashboard.html'));
    });

    // ── Migrasi database, siap salin (butuh token) ───────────────────────────────
    // Berkas migrasi gabungan itu 1.469 baris; menyalinnya dari terminal atau dari
    // tampilan berkas di GitHub selalu meleset sebagian. Halaman ini menyajikannya
    // dengan satu tombol salin, dan mengambil isinya lewat fetch() saat dibuka
    // supaya tidak ada salinan kedua yang perlahan berbeda dari yang di repo.
    //
    // Berkasnya SENGAJA tidak tinggal di public/. express.static melayani apa pun
    // di sana tanpa melewati gerbang mana pun, jadi menaruh migrasi.sql di public/
    // sambil memasang requireAuthPage di rute ini akan menghasilkan gerbang yang
    // bisa dilewati hanya dengan mengetik /migrasi.sql. Berkasnya di migrasi/,
    // di luar jangkauan static, dan satu-satunya jalan masuk adalah rute ini.
    //
    // Halaman ini membawa nama tabel, nama kolom, dan bentuk seluruh basis data —
    // peta yang mempersingkat pekerjaan siapa pun yang mencari celah. Token, dan
    // tetap noindex.
    app.get('/jalankan', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'jalankan.html'));
    });

    app.get('/antrean', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'antrean.html'));
    });

    app.get('/riwayat', requireAuthPage, async (req, res) => {
        if (riwayatCache.data && Date.now() - riwayatCache.pada < RIWAYAT_TTL_MS) {
            return res.json({ ...riwayatCache.data, dariCache: true });
        }
        const bot = await riwayatBot();
        let situs = [];
        let galatSitus = null;
        try {
            situs = await riwayatSitus();
        } catch (e) {
            galatSitus = e.message;
            // GitHub mati bukan alasan menampilkan halaman kosong: riwayat situs yang
            // terakhir berhasil diambil masih jauh lebih berguna daripada tidak ada.
            if (riwayatCache.data?.situs?.length) situs = riwayatCache.data.situs;
        }
        const data = { bot, situs, galatSitus, diambil: new Date().toISOString() };
        riwayatCache = { pada: Date.now(), data };
        res.json({ ...data, dariCache: false });
    });

    // Versi lengkap — admin saja.
    app.get('/laporan/penuh', requireAuthPage, (req, res) => {
        res.sendFile(path.join(AKAR, 'laporan.html'));
    });

    // Versi publik — tanpa token, boleh dibagikan.
    app.get('/laporan', requireAuthPage, (req, res) => {
        // Dulu di sini ada percabangan tamu/admin, karena halamannya publik. Sejak
        // seluruh panel butuh sandi, siapa pun yang sampai ke baris ini SUDAH admin —
        // percabangan itu tinggal jebakan: sesi berkuki lolos gerbang lalu gagal di
        // pemeriksaan token dan disuguhi versi publik seolah ia orang asing.
        res.sendFile(path.join(AKAR, 'laporan.html'));
    });

    // Menebak '/laporan.html' itu refleks yang wajar — dan tanpa ini jawabannya cuma
    // "Cannot GET" dari Express, yang bikin orang mengira halamannya belum ada.
    app.get('/laporan.html', requireAuthPage, (req, res) => {
        const q = req.query.token ? '?token=' + encodeURIComponent(req.query.token) : '';
        res.redirect(301, '/laporan' + q);
    });
};
