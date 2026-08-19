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

catat "AMBANG TERCAPAI ($n × $jenis) — pm2 restart $APP"
if pm2 restart "$APP" --update-env >> "$LOG" 2>&1; then
    catat "pm2 restart selesai."
else
    catat "pm2 restart GAGAL — coba pm2 start."
    pm2 start "$STATE_DIR/index.js" --name "$APP" >> "$LOG" 2>&1 && catat "pm2 start selesai."
fi
echo "$sekarang" > "$TERAKHIR_FILE"
echo 0 > "$HITUNG_FILE"
