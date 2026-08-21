/*
 * Gerbang panel bot: token mesin, sandi manusia, kuki sesi, rem tebak-token,
 * dan dua gerbang khusus untuk jalur pemulihan.
 *
 * Dipisah dari index.js sebagai satu kesatuan, bukan sepotong-sepotong. Alasannya
 * bukan kerapian: aturan "siapa boleh masuk" yang tersebar di beberapa berkas
 * adalah aturan yang cepat atau lambat akan berbeda antar berkas — dan bedanya
 * baru ketahuan saat ada yang masuk tanpa seharusnya.
 *
 * Berbentuk pabrik (`buatGerbang`), bukan modul dengan nilai tetap, karena dua
 * hal yang dibutuhkannya baru diketahui saat bot menyala: API_TOKEN dan letak
 * folder sesi. Dan satu hal lagi terus berubah sepanjang bot hidup — keadaan
 * sesi WhatsApp — jadi ia dibaca lewat `keadaan`, objek ber-getter yang dipegang
 * index.js. Menyalinnya sebagai nilai biasa berarti gerbang pemulihan menimbang
 * keadaan bot pada saat modul ini dimuat, bukan pada saat tombolnya ditekan.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { amanTujuan } = require('./utils');

module.exports = function buatGerbang({ API_TOKEN, AUTH_DIR, keadaan }) {
    // ── Auth middleware ───────────────────────────────────────────────────────────
    // Perbandingan token dibuat waktu-konstan: `!==` biasa keluar lebih cepat pada byte
    // pertama yang beda, yang secara teori bisa dipakai menebak token per karakter.
    function tokenMatches(given) {
        const a = Buffer.from(String(given || ''));
        const b = Buffer.from(String(API_TOKEN));
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    }

    // ── Sandi panel (manusia) di samping token (mesin) ───────────────────────────
    // Token 48 karakter itu dipakai DUA hal: manusia menempelkannya ke kolom token
    // di tiap halaman, dan mesin memakainya untuk saling memanggil (situs → bot, dan
    // bot → webhook situs di lima tempat). Menggantinya dengan sandi berarti ikut
    // menurunkan autentikasi antar-server jadi satu kata yang bisa ditebak, dan
    // nilainya harus diganti serentak di Vercel atau sambungannya putus.
    //
    // Jadi keduanya hidup berdampingan: sandi untuk manusia, token tetap untuk
    // mesin. Di mana pun token diterima, sandi juga diterima.
    //
    // Nilainya HANYA dari environment. Repo ini publik — sandi yang di-commit sama
    // saja dengan diumumkan. Kalau variabelnya kosong, jalur sandi mati total dan
    // yang tersisa cuma token: gagal-tertutup, bukan gagal-terbuka.
    const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || '').trim();

    // Dibandingkan lewat digest, bukan string mentah: panjang sandi tidak boleh
    // bocor lewat lama waktu pembandingan, dan timingSafeEqual menuntut dua
    // penyangga berukuran sama.
    const cap = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest();

    function passwordMatches(given) {
        if (!PANEL_PASSWORD) return false;
        return crypto.timingSafeEqual(cap(given), cap(PANEL_PASSWORD));
    }

    // Kuki sesi supaya sandi cukup diketik SEKALI, bukan di tiap halaman. Nilainya
    // diturunkan dari API_TOKEN + sandi: tidak ada yang perlu disimpan di disk, dan
    // mengganti salah satunya otomatis mementahkan semua sesi lama.
    const KUKI_NAMA = 'panel_sesi';

    function kukiSah() {
        return crypto.createHmac('sha256', String(API_TOKEN))
            .update('panel-v1:' + PANEL_PASSWORD).digest('hex');
    }

    function kukiDari(req) {
        const mentah = req.headers.cookie || '';
        for (const bagian of mentah.split(';')) {
            const [k, ...v] = bagian.trim().split('=');
            if (k === KUKI_NAMA) return decodeURIComponent(v.join('='));
        }
        return '';
    }

    function sesiSah(req) {
        if (!PANEL_PASSWORD) return false;
        const punya = kukiDari(req);
        if (!punya) return false;
        try { return crypto.timingSafeEqual(cap(punya), cap(kukiSah())); } catch { return false; }
    }

    // Satu jawaban untuk pertanyaan "boleh masuk?", dipakai gerbang halaman maupun
    // gerbang API. Tiga jalan: kuki sesi (manusia yang sudah masuk), sandi/token di
    // header (mesin, dan curl), atau ?token= di alamat (tautan yang sudah tersebar).
    function bolehMasuk(req) {
        if (sesiSah(req)) return true;
        const h = req.headers.authorization;
        const q = req.query ? req.query.token : undefined;
        return tokenMatches(h) || tokenMatches(q) || passwordMatches(h) || passwordMatches(q);
    }

    // ── Rem percobaan token ──────────────────────────────────────────────────────
    // Satu token statis tanpa pembatasan laju artinya token boleh ditebak secepat
    // jaringan mengizinkan. Ini tidak mengubah kekuatan tokennya, tapi mengubah
    // tebakan dari "jutaan per jam" jadi segelintir — cukup untuk membuat penebakan
    // tidak praktis. Per-IP dan hanya di memori; restart membersihkannya, dan itu
    // tidak apa-apa karena serangan yang relevan berlangsung dalam hitungan menit.
    const AUTH_FAIL_MAX = Number(process.env.AUTH_FAIL_MAX || 10);

    const AUTH_FAIL_WINDOW_MS = Number(process.env.AUTH_FAIL_WINDOW_MINUTES || 5) * 60 * 1000;

    const authFails = new Map();   // ip → { count, first }

    function authBlocked(ip) {
        const rec = authFails.get(ip);
        if (!rec) return false;
        if (Date.now() - rec.first > AUTH_FAIL_WINDOW_MS) { authFails.delete(ip); return false; }
        return rec.count >= AUTH_FAIL_MAX;
    }

    function noteAuthFail(ip) {
        const rec = authFails.get(ip);
        if (!rec || Date.now() - rec.first > AUTH_FAIL_WINDOW_MS) {
            authFails.set(ip, { count: 1, first: Date.now() });
        } else {
            rec.count++;
            if (rec.count === AUTH_FAIL_MAX) console.warn(`[auth] ${ip} diblokir sementara setelah ${rec.count} token salah.`);
        }
    }

    function requireAuth(req, res, next) {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        if (authBlocked(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' });
        if (!bolehMasuk(req)) {
            noteAuthFail(ip);
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    }

    // ── Halaman laporan analisis ─────────────────────────────────────────────────
    // Ada DUA berkas, dan bedanya disengaja:
    //
    //   laporan-publik.html — /laporan, tanpa token. Temuan bisnis & performa utuh,
    //       tapi cara menembus keamanan bot dibuang. Sebuah halaman publik yang
    //       menuliskan "endpoint X cuma dijaga satu token dan tidak dibatasi laju"
    //       berhenti jadi laporan audit dan berubah jadi petunjuk serangan.
    //
    //   laporan.html — /laporan/penuh, wajib token. Versi lengkap untuk admin.
    //
    // Keduanya di root proyek, BUKAN di public/, supaya express.static tidak diam-diam
    // menyajikan versi lengkapnya ke siapa saja.
    //
    // Token boleh lewat query string KHUSUS di rute penuh: tautan yang diklik dari
    // browser tidak bisa membawa header Authorization. Konsekuensinya token ikut
    // tercatat di riwayat browser, jadi tautan /laporan/penuh jangan disebar.
    function requireAuthPage(req, res, next) {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        if (authBlocked(ip)) return res.status(429).type('html').send('<!doctype html><meta charset="utf-8"><title>429</title><body style="font:16px/1.6 system-ui;max-width:34rem;margin:18vh auto"><h1 style="font-size:1.25rem">Terlalu banyak percobaan</h1><p>Coba lagi beberapa menit lagi.</p></body>');
        if (bolehMasuk(req)) {
            // Masuk lewat ?token= / sandi di alamat: tukar jadi kuki sekalian.
            // Tanpa ini halaman lolos gerbang tapi fetch()-nya sendiri tidak —
            // /update mengambil /riwayat lewat JavaScript, dan JavaScript tidak
            // ikut membawa ?token= milik halamannya. Hasilnya halaman terbuka
            // dengan linimasa kosong, yang jauh lebih membingungkan daripada
            // ditolak terang-terangan.
            if (PANEL_PASSWORD && !sesiSah(req)) {
                res.cookie(KUKI_NAMA, kukiSah(), {
                    httpOnly: true, sameSite: 'strict', secure: true,
                    maxAge: 30 * 24 * 60 * 60 * 1000, path: '/',
                });
            }
            return next();
        }
        // Belum masuk bukan kesalahan yang perlu diomeli — antar saja ke pintunya,
        // sambil mengingat halaman yang tadi dituju supaya ia tidak hilang.
        // noteAuthFail() TIDAK dipanggil di sini: yang barusan terjadi cuma
        // "belum punya kuki", dan menghitungnya sebagai percobaan gagal akan
        // memblokir orang yang bahkan belum sempat mengetik apa pun.
        const tujuan = encodeURIComponent(req.originalUrl || '/');
        res.redirect(302, '/masuk?next=' + tujuan);
    }

    // ── Gerbang endpoint berbahaya (re-link/reset) ───────────────────────────────
    // Endpoint yang bisa MENGHAPUS SESI atau MENAUTKAN perangkat (reset/restart/
    // pairing-code) dikunci default. Selama token bot masih bisa bocor (mis. default
    // publik), tanpa gerbang ini penyerang bisa /reset → bot logout → /pairing-code →
    // ambil alih WhatsApp bisnis. Website normal TIDAK memakai endpoint ini.
    // Untuk re-link sah: set env ALLOW_RELINK=true di server sementara, lalu matikan lagi.
    function requireRelink(req, res, next) {
        if (process.env.ALLOW_RELINK === 'true') return next();
        return res.status(403).json({ error: 'Endpoint terkunci demi keamanan. Set ALLOW_RELINK=true di server bila memang mau re-link/reset.' });
    }

    // Sesi yang benar-benar tersimpan, dibaca dari disk — BUKAN dari waSocket, yang
    // null di sela sambung-ulang. `registered` sengaja tidak dipakai sebagai tanda:
    // sesi yang ditautkan lewat QR tetap `registered:false` padahal `me` sudah terisi
    // (sesi bot pertama persis begitu). Yang menandakan ada sesi adalah `me.id`.
    function sesiTersimpanAda() {
        try {
            const creds = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'));
            return !!creds?.me?.id;
        } catch (_) { return false; }
    }

    // Gerbang khusus PEMULIHAN: menautkan ulang perangkat dan membuka sesi terkunci.
    // Bedanya dengan requireRelink — yang tetap menjaga /reset dan /restart — adalah
    // apa yang sedang dijaga. Gerbang itu ada untuk melindungi sesi yang masih HIDUP:
    // /reset menghapusnya, dan itulah langkah pertama pengambilalihan. Kalau sesinya
    // memang sudah mati (belum pernah tertaut, hilang, atau ditolak WhatsApp sampai
    // terkunci), tidak ada lagi yang bisa direbut — sementara pemiliknya justru sedang
    // paling butuh jalan masuk.
    //
    // Ini menutup jebakan yang nyata terjadi: bot pertama terkunci, tombol "Buka kunci"
    // di dashboard dijawab 403, dan satu-satunya jalan keluar adalah menyunting env di
    // server lalu restart — padahal restart menghapus penanda kunci (ia cuma di memori)
    // sehingga proses baru mengulang ketukan login pada nomor yang sedang dibatasi.
    // Pemilik yang hanya memegang dashboard tidak punya jalan keluar sama sekali.
    function requirePemulihan(req, res, next) {
        if (process.env.ALLOW_RELINK === 'true') return next();
        if (keadaan.sesiTerkunci || keadaan.sessionLostAt || (!keadaan.connectedPhone && !sesiTersimpanAda())) return next();
        return res.status(403).json({ error: 'Terkunci demi keamanan: sesi bot masih hidup, '
            + 'jadi tidak ada yang perlu ditaut ulang. Set ALLOW_RELINK=true di server bila memang mau.' });
    }

    function halamanMasuk(next, galat) {
        const tujuan = amanTujuan(next);
        const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Masuk — Bot USU Polmed</title>
    <meta name="robots" content="noindex, nofollow">
    <link rel="stylesheet" href="/assets/ui.css">
    <script>try{var t=localStorage.getItem('tema');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
    </head><body>
    <div class="wrap doc" style="max-width:26rem;margin-top:14vh">
      <header style="text-align:center">
        <div class="kicker">Panel Bot</div>
        <h1 style="font-size:1.4rem">Masuk</h1>
        <p class="muted">Satu sandi untuk semua halaman panel.</p>
      </header>
      <div class="card">
        <form method="POST" action="/masuk">
          <input type="hidden" name="next" value="${esc(tujuan)}">
          <label for="sandi" class="muted" style="display:block;margin-bottom:6px;font-size:.85rem">Sandi</label>
          <input id="sandi" name="sandi" type="password" autocomplete="current-password" autofocus required
                 style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;
                        background:var(--sunk);color:var(--ink);font-size:1rem">
          ${galat ? `<p style="color:var(--bad);font-size:.85rem;margin:10px 0 0">${esc(galat)}</p>` : ''}
          <button class="btn primary wide" type="submit" style="margin-top:14px">Masuk</button>
        </form>
      </div>
      <p class="muted tiny" style="text-align:center">
        Satu-satunya halaman yang bisa dibuka tanpa sandi: <a href="/lomba">/lomba</a>.
      </p>
    </div>
    </body></html>`;
    }

    setInterval(() => {
        const now = Date.now();
        for (const [ip, rec] of authFails) if (now - rec.first > AUTH_FAIL_WINDOW_MS) authFails.delete(ip);
    }, 60000).unref();

    return {
        PANEL_PASSWORD, KUKI_NAMA,
        tokenMatches, passwordMatches, kukiSah, kukiDari, sesiSah, bolehMasuk,
        authBlocked, noteAuthFail,
        requireAuth, requireAuthPage, requireRelink, requirePemulihan,
        sesiTersimpanAda, halamanMasuk,
    };
};
