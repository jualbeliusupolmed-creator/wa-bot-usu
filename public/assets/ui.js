/* ==========================================================================
   Perkakas tampilan bersama — bot.jualbeliusupolmed.web.id

   Tiga tugas, semuanya supaya tiap halaman tidak perlu mengulang dirinya:
     1. menyuntik bilah navigasi yang sama persis di semua halaman,
     2. mengganti ikon <i class="fa-..."> jadi SVG sebaris (Font Awesome dari
        CDN dilepas: ~90 KB CSS + font hilang dari tiap muat halaman),
     3. tombol terang/gelap yang diingat browser.

   Berkas ini di-cache sekali dan dipakai ulang oleh semua halaman.
   ========================================================================== */
(function () {
  'use strict';

  /* ── 1. ikon ──────────────────────────────────────────────────────────
     Digambar ulang bergaya garis 24×24 (mengikuti bahasa visual s.id),
     bukan ditarik dari CDN. Kunci = nama Font Awesome yang sudah dipakai
     di markup, supaya halaman lama tidak perlu diubah satu per satu. */
  var P = {
    gauge:        '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-5"/>',
    'chart-column':'<path d="M18 20V8M12 20V4M6 20v-7"/>',
    'square-poll-vertical':'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 17v-4M12 17V7M16 17v-6"/>',
    comments:     '<path d="M21 14a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    'comment-dots':'<path d="M21 14a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><path d="M8.5 9.5h.01M12 9.5h.01M15.5 9.5h.01"/>',
    inbox:        '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1z"/>',
    terminal:     '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    qrcode:       '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14h1M14 20h3M20 17v4"/>',
    lock:         '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    plug:         '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
    link:         '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    database:     '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M20 5v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V5"/><path d="M20 12c0 1.7-3.6 3-8 3s-8-1.3-8-3"/>',
    'id-card':    '<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8.5" cy="11" r="2.5"/><path d="M4.5 17c.8-1.7 2.3-2.5 4-2.5s3.2.8 4 2.5M15 9h4M15 13h4"/>',
    'mobile-screen':'<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    'mobile-screen-button':'<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    'phone-volume':'<path d="M14 4a6 6 0 0 1 6 6M14 8a2 2 0 0 1 2 2"/><path d="M10 4H6a2 2 0 0 0-2 2c0 8 6 14 14 14a2 2 0 0 0 2-2v-4l-4-2-2 2a12 12 0 0 1-6-6l2-2z"/>',
    bullhorn:     '<path d="m3 11 15-6v14L3 14z"/><path d="M3 11H2v3h1M11 17a3 3 0 0 1-5-1"/>',
    'calendar-day':'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h4v4H8z"/>',
    'circle-check':'<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    'circle-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    'circle-play': '<circle cx="12" cy="12" r="9"/><path d="m10 9 5 3-5 3z"/>',
    'clipboard-list':'<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M8 11h8M8 15h5"/>',
    'diagram-project':'<rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v6a3 3 0 0 0 3 3H14"/>',
    'door-open':  '<path d="M13 4.5v15l-7-1.5V6z"/><path d="M13 5h4a1 1 0 0 1 1 1v14M3 20h18"/><path d="M10 12v.01"/>',
    'list-check': '<path d="M11 6h10M11 12h10M11 18h10"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
    'right-from-bracket':'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    'triangle-exclamation':'<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z"/><path d="M12 9v4M12 17h.01"/>',
    whatsapp:     '<path d="M3 21l1.6-4.5A8.5 8.5 0 1 1 7.8 20z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5.6 0 1-.5 1-1l-1.5-.8-1 .8a5 5 0 0 1-2.5-2.5l.8-1L10.5 9c-.5 0-1.5.1-1.5.5z"/>',
    ban:          '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    spinner:      '<path d="M12 3a9 9 0 1 0 9 9" />',
    key:          '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2M17 6l2 2M14 9l2 2"/>',
    gear:         '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    sun:          '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon:         '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    'chevron-down':'<path d="m6 9 6 6 6-6"/>',
    shield:       '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    server:       '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    'file-text':   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/>',
    trophy:       '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.45 1-1 1H8c-.55 0-1 .45-1 1v1c0 .55.45 1 1 1h8c.55 0 1-.45 1-1v-1c0-.55-.45-1-1-1h-1c-.55 0-1-.45-1-1v-2.34M18 4H6v7a6 6 0 0 0 12 0V4z"/>',
    bars:         '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
    xmark:        '<path d="M18 6 6 18M6 6l12 12"/>'
  };

  /* Nama Font Awesome yang tidak punya gambar sendiri diarahkan ke yang mirip. */
  var ALIAS = { 'chart-simple': 'chart-column', 'comment': 'comment-dots', 'phone': 'phone-volume' };

  function svg(name, cls) {
    var d = P[ALIAS[name] || name];
    if (!d) return '';
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
           'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }

  /* Menukar <i class="fa-solid fa-gauge"> jadi SVG sebaris. Markup lama tetap
     berlaku — termasuk yang dibuat JavaScript halaman setelah muat. */
  function ikon(akar) {
    var n = (akar || document).querySelectorAll('i[class*="fa-"]:not([data-ic])');
    for (var i = 0; i < n.length; i++) {
      var el = n[i], nama = null, c = el.className.split(/\s+/);
      for (var j = 0; j < c.length; j++) {
        if (c[j].indexOf('fa-') === 0) {
          var k = c[j].slice(3);
          if (k !== 'solid' && k !== 'brands' && k !== 'regular' && k !== 'spin' && k !== 'fw') { nama = k; break; }
        }
      }
      el.setAttribute('data-ic', nama || '');
      var g = nama ? svg(nama) : '';
      if (g) el.innerHTML = g;
      else el.style.display = 'none';
    }
  }

  /* ── 2. tema ───────────────────────────────────────────────────────── */
  function temaSekarang() {
    try { return localStorage.getItem('tema') || 'auto'; } catch (e) { return 'auto'; }
  }
  function setTema(t) {
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try { t === 'auto' ? localStorage.removeItem('tema') : localStorage.setItem('tema', t); } catch (e) {}
    var b = document.querySelector('.nav-toggle');
    if (b) b.innerHTML = svg(gelap() ? 'sun' : 'moon');
  }
  function gelap() {
    var t = temaSekarang();
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /* ── 3. struktur navigasi terkelompok (minimalis & rapi) ─────────────── */
  var STRUKTUR_NAV = [
    {
      kategori: 'Operasi',
      ikon: 'gauge',
      items: [
        { u: '/',             t: 'Dashboard',         d: 'Status real-time, chat & broadcast', ic: 'gauge' },
        { u: '/home',         t: 'Panel Kontrol',     d: 'Sakelar, fungsi & data JSON',        ic: 'gear' },
        { u: '/antrean',      t: 'Antrean Outbox',    d: 'Pesan tertunda / kirim manual',      ic: 'inbox' },
        { u: '/laporan',      t: 'Laporan Bot',       d: 'Ringkasan kesehatan harian',         ic: 'clipboard-list' }
      ]
    },
    {
      kategori: 'Server & Infra',
      ikon: 'server',
      items: [
        { u: '/infrastruktur', t: 'Infrastruktur & Kunci', d: 'VPS, SSH, Vercel, Supabase & Token', ic: 'key' },
        { u: '/jalankan',      t: 'Migrasi Database',      d: 'SQL migrasi siap salin',              ic: 'database' }
      ]
    },
    {
      kategori: 'Dokumen & Audit',
      ikon: 'shield',
      items: [
        { u: '/progres',        t: 'Progres Proyek',    d: 'Roadmap & pencapaian sistem',         ic: 'chart-column' },
        { u: '/progres-claude', t: 'Audit Keamanan',    d: 'Laporan temuan & mitigasi celah',     ic: 'shield' },
        { u: '/update',         t: 'Catatan Perubahan', d: 'Riwayat komit & perbaikan fitur',     ic: 'file-text' },
        { u: '/projek',         t: 'Arsitektur Proyek', d: 'Cerita & blueprint teknis',           ic: 'diagram-project' }
      ]
    },
    {
      kategori: 'Lomba',
      ikon: 'trophy',
      u: '/lomba',
      badge: 'Publik'
    }
  ];

  var HALAMAN_TAMU = [
    { u: 'https://www.jualbeliusupolmed.web.id', t: 'Situs utama', ic: 'link' },
    { u: '#presentasi', t: 'Presentasi', ic: 'clipboard-list' },
    { u: '#demo',       t: 'Demo',       ic: 'gauge' },
    { u: 'https://github.com/jualbeliusupolmed-creator', t: 'Kode', ic: 'terminal' }
  ];

  function nav() {
    if (document.querySelector('.nav')) return;
    var jalur = location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    if (jalur === '/dashboard') jalur = '/';
    var tamu = jalur === '/lomba' || jalur === '/tutor';
    var rumahTamu = jalur === '/tutor' ? '/tutor' : '/lomba';

    var el = document.createElement('nav');
    el.className = 'nav';

    var h = '<div class="nav-in">';
    h += '<a class="nav-brand" href="' + (tamu ? rumahTamu : '/') + '"><span class="nav-mark">JB</span>' +
         '<span>' + (tamu ? 'Jual Beli USU&nbsp;Polmed' : 'Bot USU&nbsp;Polmed') + '</span></a>';

    h += '<div class="nav-links">';
    if (tamu) {
      for (var i = 0; i < HALAMAN_TAMU.length; i++) {
        var tm = HALAMAN_TAMU[i];
        h += '<a href="' + tm.u + '">' + svg(tm.ic) + ' ' + tm.t + '</a>';
      }
    } else {
      for (var g = 0; g < STRUKTUR_NAV.length; g++) {
        var grp = STRUKTUR_NAV[g];
        if (grp.u) {
          // Link tunggal (seperti Lomba)
          var isActive = grp.u === jalur;
          h += '<a href="' + grp.u + '"' + (isActive ? ' aria-current="page"' : '') + '>' +
               svg(grp.ikon) + ' ' + grp.kategori + (grp.badge ? ' <span class="nav-badge-accent">' + grp.badge + '</span>' : '') + '</a>';
        } else {
          // Dropdown Group
          var adaAktif = grp.items.some(function(it) { return it.u === jalur; });
          h += '<div class="nav-group">';
          h += '<button type="button" class="nav-btn' + (adaAktif ? ' is-active' : '') + '">' +
               svg(grp.ikon) + ' ' + grp.kategori + ' ' + svg('chevron-down', 'chevron') + '</button>';
          h += '<div class="nav-dropdown">';
          for (var k = 0; k < grp.items.length; k++) {
            var item = grp.items[k];
            var itAktif = item.u === jalur;
            h += '<a href="' + item.u + '" class="nav-item' + (itAktif ? ' active' : '') + '">' +
                 '<div class="nav-item-icon">' + svg(item.ic) + '</div>' +
                 '<div class="nav-item-text"><div class="nav-item-title">' + item.t + '</div><div class="nav-item-desc">' + item.d + '</div></div>' +
                 '</a>';
          }
          h += '</div></div>';
        }
      }
    }
    h += '</div>';

    // Sisi kanan: Theme Toggle + Mobile Menu Toggle
    h += '<div class="nav-end">' +
         '<button class="nav-toggle" type="button" title="Ganti tema" aria-label="Ganti tema"></button>' +
         '<button class="nav-mobile-toggle" type="button" aria-label="Menu">' + svg('bars') + '</button>' +
         '</div>';

    h += '</div>';

    // Mobile Drawer
    h += '<div class="nav-mobile-drawer">';
    if (tamu) {
      h += '<div class="nav-mob-list">';
      for (var i = 0; i < HALAMAN_TAMU.length; i++) {
        var tm = HALAMAN_TAMU[i];
        h += '<a href="' + tm.u + '" class="nav-item"><div class="nav-item-icon">' + svg(tm.ic) + '</div><div class="nav-item-title">' + tm.t + '</div></a>';
      }
      h += '</div>';
    } else {
      for (var g = 0; g < STRUKTUR_NAV.length; g++) {
        var grp = STRUKTUR_NAV[g];
        if (grp.u) {
          h += '<div style="margin-top:4px;"><a href="' + grp.u + '" class="nav-item' + (grp.u === jalur ? ' active' : '') + '">' +
               '<div class="nav-item-icon">' + svg(grp.ikon) + '</div><div class="nav-item-title">' + grp.kategori + '</div></a></div>';
        } else {
          h += '<div><div class="nav-mob-cat">' + grp.kategori + '</div><div class="nav-mob-list">';
          for (var k = 0; k < grp.items.length; k++) {
            var itm = grp.items[k];
            h += '<a href="' + itm.u + '" class="nav-item' + (itm.u === jalur ? ' active' : '') + '">' +
                 '<div class="nav-item-icon">' + svg(itm.ic) + '</div>' +
                 '<div class="nav-item-text"><div class="nav-item-title">' + itm.t + '</div><div class="nav-item-desc">' + itm.d + '</div></div></a>';
          }
          h += '</div></div>';
        }
      }
    }
    h += '</div>';

    el.innerHTML = h;
    document.body.insertBefore(el, document.body.firstChild);
    document.body.classList.add('has-nav');

    // Bind event
    var bTema = el.querySelector('.nav-toggle');
    bTema.innerHTML = svg(gelap() ? 'sun' : 'moon');
    bTema.addEventListener('click', function () { setTema(gelap() ? 'light' : 'dark'); });

    var bMob = el.querySelector('.nav-mobile-toggle');
    var drawer = el.querySelector('.nav-mobile-drawer');
    bMob.addEventListener('click', function () {
      var isOpen = drawer.classList.toggle('open');
      bMob.innerHTML = svg(isOpen ? 'xmark' : 'bars');
    });

    // Mobile drawer auto-close saat link diklik
    drawer.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        drawer.classList.remove('open');
        bMob.innerHTML = svg('bars');
      });
    });
  }

  /* ── jalan ─────────────────────────────────────────────────────────── */
  function mulai() {
    nav();
    ikon(document);
    if (window.MutationObserver) {
      new MutationObserver(function (m) {
        for (var i = 0; i < m.length; i++) if (m[i].addedNodes.length) { ikon(document); return; }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mulai);
  else mulai();

  window.UI = { ikon: ikon, svg: svg, setTema: setTema };
})();
