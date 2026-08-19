#!/usr/bin/env bash
# Cadangan harian folder sesi WhatsApp.
#
# Sesi yang hilang tidak bisa dipulihkan dari mana pun kecuali salinan: tidak ada
# server WhatsApp yang mau mengembalikannya, dan satu-satunya jalan lain adalah
# scan QR — persis yang mau dihindari. Folder sesi cuma ~7 MB setelah pemetaan LID
# disatukan, jadi menyimpan seminggu penuh nyaris tidak berbiaya.
#
# Cadangan diambil dengan bot TETAP JALAN. Yang mahal kalau tertangkap separuh
# tulis cuma creds.json, dan itu sudah ditulis atomik (tmp → rename) plus punya
# creds.bak.json di folder yang sama — jadi salinan selalu memuat setidaknya satu
# creds yang utuh.
set -uo pipefail

SUMBER="${SUMBER:-/root/wa-bot-usu/auth_info_baileys}"
TUJUAN="${TUJUAN:-/root/cadangan-sesi-wa}"
SIMPAN="${SIMPAN:-7}"          # berapa cadangan terakhir yang ditahan
LOG="${LOG:-/root/wa-bot-usu/penjaga-bot.log}"

catat() { echo "$(date '+%Y-%m-%d %H:%M:%S') [cadangan] $*" >> "$LOG"; }

[ -d "$SUMBER" ] || { catat "GAGAL: $SUMBER tidak ada."; exit 1; }
mkdir -p "$TUJUAN"

nama="sesi-$(date '+%Y%m%d-%H%M').tgz"
if tar czf "$TUJUAN/$nama.tmp" -C "$(dirname "$SUMBER")" "$(basename "$SUMBER")" 2>/dev/null; then
    mv "$TUJUAN/$nama.tmp" "$TUJUAN/$nama"
    catat "OK $nama ($(du -h "$TUJUAN/$nama" | cut -f1))"
else
    rm -f "$TUJUAN/$nama.tmp"
    catat "GAGAL membuat $nama."
    exit 1
fi

# Yang lama dibuang belakangan: kalau pembuatan tadi gagal, cadangan lama justru
# satu-satunya yang tersisa dan tidak boleh ikut hilang.
ls -1t "$TUJUAN"/sesi-*.tgz 2>/dev/null | tail -n +$((SIMPAN + 1)) | while read -r usang; do
    rm -f "$usang" && catat "Buang cadangan lama: $(basename "$usang")"
done
