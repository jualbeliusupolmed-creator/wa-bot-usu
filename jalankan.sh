#!/bin/bash
# Menjalankan/menghidupkan-ulang bot PERTAMA (wa-bot-usu, nomor WA utama).
#
# INI SATU-SATUNYA cara sah menghidupkan bot pertama. `pm2 restart wa-bot-usu`
# telanjang mengambil env dari shell saat itu — dari cron env itu nyaris kosong,
# dan tanpa API_TOKEN bot berhenti sendiri (fail-closed, index.js:85). Penjaga
# yang seharusnya menyelamatkan justru mengubah padam sementara jadi padam total.
#
# Kembarannya untuk bot kedua: /root/wa-bot-2/jalankan.sh (beda DATA_DIR + PORT).
# /root/jalankan-bot-1.sh cuma penerus ke berkas ini, supaya jalan lama tetap benar.
#
# SATU NILAI, SATU BERKAS. Tiap rahasia dibaca dari tempat simpannya sendiri dan
# tidak pernah disalin ke berkas kedua: salinan kedua hanya menunggu untuk basi,
# dan yang basi itu baru ketahuan sebagai 401 yang tidak ada penjelasannya.
set -euo pipefail
D=/root/wa-bot-usu
cd "$D"

export DATA_DIR="$D"
export PORT="${PORT:-3000}"
# Nomor ini pernah dibatasi WhatsApp; jangan mengetuk login lebih sering dari
# perlunya. Kembalikan ke bawaan (10) begitu pembatasannya dicabut.
export KUNCI_RETRY_MINUTES="${KUNCI_RETRY_MINUTES:-60}"

# Repo bot ini publik, jadi rahasianya tidak boleh ada di dalam kode maupun di
# dalam skrip yang ikut ter-commit. Berkasnya ada di VPS saja, mode 600.
export API_TOKEN="$(cat /root/.api_token_bot1)"

# Sandi panel (untuk manusia). WAJIB ada di sini: penjaga-bot.sh me-restart lewat
# skrip ini, jadi kalau barisnya hilang, sandinya lenyap pada restart otomatis
# pertama dan tidak ada yang tahu kenapa. Kalau berkasnya tidak ada, bot tetap
# jalan dan yang berlaku cuma token — gagal-tertutup, bukan gagal-terbuka.
if [ -s /root/.sandi-panel ]; then
    PANEL_PASSWORD="$(cat /root/.sandi-panel)"
    export PANEL_PASSWORD
fi

# Token bot kedua, supaya dashboard bot pertama bisa memperlihatkan DUA perangkat
# lewat /perangkat2/*. Kalau berkasnya belum ada, bot pertama tetap jalan dan
# panel kedua sekadar tidak muncul.
if [ -s /root/wa-bot-2/api_token ]; then
    BOT2_TOKEN="$(cat /root/wa-bot-2/api_token)"
    export BOT2_TOKEN
fi
export BOT2_URL="${BOT2_URL:-http://127.0.0.1:3001}"

# WEBHOOK_URL sengaja TIDAK diisi di sini. Bawaannya sudah alamat produksi
# (index.js:61); mengulangnya di skrip cuma membuat dua sumber untuk satu nilai.
# Isi lewat env hanya kalau memang mau menunjuk ke situs lain.

: "${API_TOKEN:?API_TOKEN kosong — periksa /root/.api_token_bot1}"

if pm2 describe wa-bot-usu >/dev/null 2>&1; then
    pm2 restart wa-bot-usu --update-env
else
    pm2 start "$D/index.js" --name wa-bot-usu --update-env
fi
pm2 save >/dev/null
