#!/usr/bin/env bash
# Penjaga bot: satu-satunya pihak yang benar-benar MENELEPON /health.
#
# Kenapa perlu, padahal bot sudah bisa restart sendiri? Karena restart-diri itu
# dijalankan oleh proses yang sedang bermasalah. Kalau yang macet justru event
# loop, timer, atau server HTTP-nya, tidak ada satu pun kode di dalam sana yang
# masih sanggup menyelamatkan dirinya. Skrip ini duduk di luar proses.
#
# Dua jenis kegagalan dibedakan, karena artinya beda:
#   - HTTP tidak menjawab sama sekai (koneksi ditolak/timeout) → prosesnya yang
#     rusak, tidak ada gunanya menunggu lama. Ambang pendek.
#   - Menjawab 503 (proses hidup, WhatsApp-nya putus) → eskalasi di dalam bot
#     sudah menangani ini di menit ke-8. Penjaga cuma jaring terakhir kalau
#     eskalasi itu sendiri gagal, jadi ambangnya sengaja lebih panjang.
set -uo pipefail

APP="${APP:-wa-bot-usu}"
# Cara sah menghidupkan ulang: skrip yang membawa env (API_TOKEN dkk). Lihat
# catatan di bagian restart, paling bawah, soal kenapa `pm2 restart --update-env`
# dari cron justru mematikan bot yang mau diselamatkan.
#
# Menunjuk langsung ke skrip di dalam repo, bukan ke /root/jalankan-bot-1.sh yang
# sekarang cuma penerus. Alasannya: yang dipanggil penjaga tiap 2 menit sebaiknya
# berkas yang ikut terlacak git — kalau isinya berubah, perubahannya kelihatan di
# `git diff`, bukan cuma di ingatan orang yang menyuntingnya.
SKRIP_JALAN="${SKRIP_JALAN:-/root/wa-bot-usu/jalankan.sh}"
URL="${URL:-http://127.0.0.1:3000/health}"
STATE_DIR="${STATE_DIR:-/root/wa-bot-usu}"
GAGAL_MATI="${GAGAL_MATI:-2}"      # ×2 menit  → restart setelah ~4 menit tak menjawab
GAGAL_503="${GAGAL_503:-8}"        # ×2 menit  → restart setelah ~16 menit WA putus
JEDA_RESTART_DETIK="${JEDA_RESTART_DETIK:-600}"   # jangan menendang lebih sering dari ini

HITUNG_FILE="$STATE_DIR/.penjaga-hitung"
TERAKHIR_FILE="$STATE_DIR/.penjaga-restart-terakhir"
LOG="$STATE_DIR/penjaga-bot.log"

catat() {
    # Dipanggil tiap dua menit selamanya: tanpa batas ukuran, log ini pelan-pelan
    # jadi masalah yang seharusnya ia laporkan. 1 MB ≈ puluhan ribu baris.
    if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
        tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    fi
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

jawaban=$(curl -s -m 10 -w '\n%{http_code}' "$URL" 2>/dev/null)
rc=$?
kode=$(printf '%s' "$jawaban" | tail -n1)
badan=$(printf '%s' "$jawaban" | sed '$d')

# Sesi terkunci = WhatsApp menolak sesi ini dan bot sengaja menahannya sampai ada
# orang yang memeriksa daftar perangkat di HP. Restart tidak menyembuhkan itu; ia
# cuma menambah ketukan ke nomor yang sedang ditolak. Jadi penjaga mundur.
if printf '%s' "$badan" | grep -q '"terkunci":true'; then
    catat "Sesi TERKUNCI — butuh tindakan manusia (buka kunci di dashboard). Penjaga tidak me-restart."
    echo 0 > "$HITUNG_FILE"
    exit 0
fi

# Perangkat belum tertaut dan bot sengaja berhenti menampilkan QR karena tidak ada
# yang memindainya. Proses baru tidak akan memindai QR-nya sendiri: restart di sini
# cuma menyalakan lagi ketukan login yang barusan sengaja dihentikan.
if printf '%s' "$badan" | grep -q '"menungguPindai":true'; then
    catat "Menunggu DIPINDAI — perangkat belum tertaut (tekan 'Tampilkan QR' di dashboard). Penjaga tidak me-restart."
    echo 0 > "$HITUNG_FILE"
    exit 0
fi

if [ "$rc" -eq 0 ] && [ "$kode" = "200" ]; then
    # Sehat: hitungan dinolkan, dan pemulihan dicatat hanya kalau sempat gagal.
    if [ -s "$HITUNG_FILE" ] && [ "$(cat "$HITUNG_FILE")" != "0" ]; then
        catat "PULIH setelah $(cat "$HITUNG_FILE") kali gagal berturut-turut."
    fi
    echo 0 > "$HITUNG_FILE"
    exit 0
fi

if [ "$rc" -ne 0 ]; then jenis="mati"; ambang="$GAGAL_MATI"; sebab="tidak menjawab (curl rc=$rc)"
else                     jenis="503";  ambang="$GAGAL_503";  sebab="HTTP $kode"; fi

n=$(( $(cat "$HITUNG_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$HITUNG_FILE"
catat "GAGAL ke-$n ($jenis): $sebab"

[ "$n" -ge "$ambang" ] || exit 0

# Jangan menendang beruntun: proses yang baru bangun butuh waktu untuk login,
# dan restart berulang-ulang justru pola yang bikin nomor dicurigai WhatsApp.
sekarang=$(date +%s)
lalu=$(cat "$TERAKHIR_FILE" 2>/dev/null || echo 0)
if [ $(( sekarang - lalu )) -lt "$JEDA_RESTART_DETIK" ]; then
    catat "Ambang tercapai tapi baru $(( (sekarang - lalu) / 60 )) menit sejak restart terakhir — tunggu."
    exit 0
fi

# `pm2 restart --update-env` mengambil env dari shell PEMANGGIL — dan pemanggil di
# sini cron, yang env-nya nyaris kosong. Tanpa API_TOKEN bot berhenti sendiri
# (fail-closed di index.js), pm2 menghidupkannya lagi, dan ia mati lagi: penjaga
# yang seharusnya menyelamatkan justru mengubah padam sementara jadi padam total.
# Jadi: pakai skrip jalankan yang memang membawa env, dan kalau tidak ada, restart
# TANPA --update-env supaya env yang sudah tersimpan di pm2 dipertahankan.
catat "AMBANG TERCAPAI ($n × $jenis) — menghidupkan ulang $APP"
if [ -x "$SKRIP_JALAN" ]; then
    if "$SKRIP_JALAN" >> "$LOG" 2>&1; then
        catat "$SKRIP_JALAN selesai."
    else
        catat "$SKRIP_JALAN GAGAL — coba pm2 restart tanpa --update-env."
        pm2 restart "$APP" >> "$LOG" 2>&1 && catat "pm2 restart selesai."
    fi
elif pm2 restart "$APP" >> "$LOG" 2>&1; then
    catat "pm2 restart selesai (tanpa $SKRIP_JALAN)."
else
    # Jalan terakhir: proses belum terdaftar di pm2 sama sekali. Env-nya ikut apa
    # yang ada di cron, jadi ini memang bisa gagal fail-closed — tapi tidak
    # mencobanya berarti bot yang hilang dari pm2 tidak pernah kembali.
    catat "pm2 restart GAGAL — coba pm2 start."
    pm2 start "$STATE_DIR/index.js" --name "$APP" >> "$LOG" 2>&1 && catat "pm2 start selesai."
fi
echo "$sekarang" > "$TERAKHIR_FILE"
echo 0 > "$HITUNG_FILE"
