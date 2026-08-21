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
# Cadangan ini memuat creds WhatsApp utuh — siapa pun yang bisa membacanya bisa
# memakai sesinya. Dibuat hanya untuk pemiliknya, sejak berkasnya lahir.
umask 077

SUMBER="${SUMBER:-/root/wa-bot-usu/auth_info_baileys}"
TUJUAN="${TUJUAN:-/root/cadangan-sesi-wa}"
SIMPAN="${SIMPAN:-7}"          # berapa cadangan terakhir yang ditahan
LOG="${LOG:-/root/wa-bot-usu/penjaga-bot.log}"

catat() { echo "$(date '+%Y-%m-%d %H:%M:%S') [cadangan] $*" >> "$LOG"; }

[ -d "$SUMBER" ] || { catat "GAGAL: $SUMBER tidak ada."; exit 1; }
mkdir -p "$TUJUAN"

nama="sesi-$(date '+%Y%m%d-%H%M').tgz"
if ! tar czf "$TUJUAN/$nama.tmp" -C "$(dirname "$SUMBER")" "$(basename "$SUMBER")" 2>/dev/null; then
    rm -f "$TUJUAN/$nama.tmp"
    catat "GAGAL membuat $nama."
    exit 1
fi

# Cadangan yang tidak pernah diuji bukan cadangan. Yang diperiksa bukan sekadar
# "arsipnya utuh", tapi bagian yang menentukan hidup-matinya sesi: creds.json
# masih JSON yang sah dan masih memuat kunci-kunci intinya. Arsip yang lolos
# tar tapi memuat creds separuh akan terlihat baik-baik saja sampai hari ia
# dibutuhkan.
if ! tar xzOf "$TUJUAN/$nama.tmp" "$(basename "$SUMBER")/creds.json" 2>/dev/null \
   | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{
        const c=JSON.parse(t);
        const wajib=["noiseKey","signedIdentityKey","registrationId"];
        if(!wajib.every(k=>k in c)) throw new Error("creds.json tidak lengkap");
     })' 2>/dev/null; then
    rm -f "$TUJUAN/$nama.tmp"
    catat "GAGAL: $nama dibuang — creds.json di dalamnya tidak sah."
    exit 1
fi

mv "$TUJUAN/$nama.tmp" "$TUJUAN/$nama"
catat "OK $nama ($(du -h "$TUJUAN/$nama" | cut -f1)) — creds.json terverifikasi."

# Yang lama dibuang belakangan: kalau pembuatan tadi gagal, cadangan lama justru
# satu-satunya yang tersisa dan tidak boleh ikut hilang.
ls -1t "$TUJUAN"/sesi-*.tgz 2>/dev/null | tail -n +$((SIMPAN + 1)) | while read -r usang; do
    rm -f "$usang" && catat "Buang cadangan lama: $(basename "$usang")"
done

# ── Salinan yang boleh keluar dari mesin ini ─────────────────────────────────
# Cadangan harian di atas hidup di disk yang sama dengan sesinya: kalau disk itu
# yang hilang, keduanya hilang bersamaan, dan sesi WhatsApp tidak bisa dipulihkan
# dari mana pun kecuali scan QR baru — yang berarti nomor bot mengetuk WhatsApp
# lagi, persis yang selama ini dihindari.
#
# Yang keluar SELALU terenkripsi. Isinya creds WhatsApp utuh: siapa pun yang
# memegang berkasnya bisa memakai sesinya, jadi ia tidak boleh mendarat apa
# adanya di penyimpanan orang lain. Kuncinya dibuat sekali di mesin ini dan
# TIDAK ikut terkirim — tanpa kunci itu, salinan di luar sana cuma derau.
KUNCI="${KUNCI:-/root/.kunci-cadangan-sesi}"
TUJUAN_LUAR="${TUJUAN_LUAR:-}"          # mis. user@host:/cadangan  (scp)

if [ -n "$TUJUAN_LUAR" ]; then
    if [ ! -s "$KUNCI" ]; then
        openssl rand -base64 48 > "$KUNCI" && chmod 600 "$KUNCI"
        catat "Kunci enkripsi cadangan dibuat di $KUNCI — SALIN ke tempat aman di luar server ini."
    fi
    terenkripsi="$TUJUAN/$nama.enc"
    if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
         -in "$TUJUAN/$nama" -out "$terenkripsi" -pass "file:$KUNCI" 2>/dev/null; then
        if scp -q -o BatchMode=yes -o ConnectTimeout=20 "$terenkripsi" "$TUJUAN_LUAR/" 2>/dev/null; then
            catat "OK kirim ke luar: $(basename "$terenkripsi") → $TUJUAN_LUAR"
        else
            catat "GAGAL kirim ke luar ($TUJUAN_LUAR) — dicoba lagi besok; cadangan lokal tetap ada."
        fi
        # Yang terenkripsi tidak ditahan lokal: gunanya memang untuk dikirim, dan
        # menyimpan dua bentuk dari isi yang sama cuma memperbanyak yang harus dijaga.
        rm -f "$terenkripsi"
    else
        catat "GAGAL mengenkripsi $nama — tidak ada yang dikirim keluar."
    fi
else
    # Diam-diam tidak punya salinan luar itu keadaan yang gampang terlupakan.
    catat "CATATAN: TUJUAN_LUAR belum diisi — semua cadangan masih satu disk dengan sesinya."
fi

# Cara memulihkan dari salinan terenkripsi:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in sesi-*.tgz.enc \
#     -out sesi.tgz -pass file:/root/.kunci-cadangan-sesi
#   tar xzf sesi.tgz -C /root/wa-bot-usu    # bot harus mati saat memulihkan
