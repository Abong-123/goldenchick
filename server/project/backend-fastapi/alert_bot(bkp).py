# alert_bot.py - SUHU (multi-codenumber) + FEEDER
import os
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from telegram import Bot
from dotenv import load_dotenv
from database import SessionLocal
from models import SensorData, UserSubscription, FeederRawlog, FeederStatusLatest

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
bot = Bot(token=BOT_TOKEN)

logging.basicConfig(
    format='%(asctime)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# =====================================================
# CACHE / STATE TRACKING
# =====================================================
# Semua di-key per (codename, codenumber) karena satu codename
# bisa punya banyak MCU (suhu maupun feeder).

# --- SUHU ---
suhu_last_update   = {}   # {(codename, codenumber): datetime terakhir data masuk}
suhu_problem       = {}   # {(chat_id, codenumber): {"disconnected":bool,"power":bool,"suhu":bool}}

# --- FEEDER ---
feeder_last_seen_id = {}  # {(codename, codenumber): id terakhir rawlog yang sudah dinotifikasi}
feeder_last_stok     = {} # {(codename, codenumber): status_stok terakhir yang sudah dinotifikasi}
feeder_problem       = {} # {(chat_id, codenumber): {"disconnected": bool}}

DISCONNECT_THRESHOLD        = timedelta(minutes=3)   # dipakai untuk monitoring SUHU
FEEDER_DISCONNECT_THRESHOLD = timedelta(minutes=10)   # dipakai untuk monitoring PAKAN (data masuk tiap 5 menit)
TEMP_HYSTERESIS      = 1.0

# =====================================================
# DATABASE HELPERS
# =====================================================

def get_db():
    return SessionLocal()

def get_active_subscriptions():
    db = get_db()
    try:
        return db.query(UserSubscription).filter(UserSubscription.is_active == True).all()
    finally:
        db.close()

# ---------- SUHU ----------

def get_suhu_codenumbers(codename):
    """Semua codenumber (MCU suhu) yang pernah kirim data untuk codename ini."""
    db = get_db()
    try:
        rows = db.query(SensorData.codenumber).filter(
            SensorData.codename == codename
        ).distinct().all()
        return [r[0] for r in rows]
    finally:
        db.close()

def get_latest_suhu(codename, codenumber):
    db = get_db()
    try:
        latest = db.query(SensorData).filter(
            SensorData.codename == codename,
            SensorData.codenumber == codenumber
        ).order_by(SensorData.created_at.desc()).first()

        if latest:
            key = (codename, codenumber)
            if latest.created_at.tzinfo is None:
                suhu_last_update[key] = latest.created_at.replace(tzinfo=timezone.utc)
            else:
                suhu_last_update[key] = latest.created_at.astimezone(timezone.utc)
        return latest
    finally:
        db.close()

def is_suhu_disconnected(codename, codenumber):
    last = suhu_last_update.get((codename, codenumber))
    if not last:
        return False
    return datetime.now(timezone.utc) - last > DISCONNECT_THRESHOLD

# ---------- FEEDER ----------

def get_feeder_codenumbers(codename):
    """Gabungan codenumber dari status_latest (heartbeat) dan rawlog (event)."""
    db = get_db()
    try:
        from_status = db.query(FeederStatusLatest.codenumber).filter(
            FeederStatusLatest.codename == codename
        ).distinct().all()
        from_rawlog = db.query(FeederRawlog.codenumber).filter(
            FeederRawlog.codename == codename
        ).distinct().all()
        ids = set([r[0] for r in from_status] + [r[0] for r in from_rawlog])
        return sorted(ids)
    finally:
        db.close()

def get_feeder_status(codename, codenumber):
    """Status stok real-time dari heartbeat (feeder.status_latest), BUKAN dari rawlog."""
    db = get_db()
    try:
        return db.query(FeederStatusLatest).filter(
            FeederStatusLatest.codename == codename,
            FeederStatusLatest.codenumber == codenumber
        ).first()
    finally:
        db.close()

def is_feeder_disconnected(status_row):
    if not status_row or not status_row.updated_at:
        return True
    last = status_row.updated_at
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    else:
        last = last.astimezone(timezone.utc)
    return datetime.now(timezone.utc) - last > FEEDER_DISCONNECT_THRESHOLD

def get_new_feeder_events(codename, codenumber, after_id):
    """Ambil event dispensing baru (publish_type='event') dengan id > after_id."""
    db = get_db()
    try:
        return db.query(FeederRawlog).filter(
            FeederRawlog.codename == codename,
            FeederRawlog.codenumber == codenumber,
            FeederRawlog.publish_type == 'event',
            FeederRawlog.id > after_id
        ).order_by(FeederRawlog.id.asc()).all()
    finally:
        db.close()

def get_max_feeder_id(codename, codenumber):
    db = get_db()
    try:
        latest = db.query(FeederRawlog).filter(
            FeederRawlog.codename == codename,
            FeederRawlog.codenumber == codenumber,
            FeederRawlog.publish_type == 'event'
        ).order_by(FeederRawlog.id.desc()).first()
        return latest.id if latest else 0
    finally:
        db.close()

# =====================================================
# BASELINE — cegah spam histori lama saat bot baru start
# =====================================================

def initialize_feeder_baseline():
    """Set posisi 'sudah dibaca sampai sini' ke event TERAKHIR yang ada,
    supaya saat alert_bot baru dinyalakan tidak mengirim ulang semua histori."""
    subs = get_active_subscriptions()
    for sub in subs:
        for codenumber in get_feeder_codenumbers(sub.codename):
            key = (sub.chat_id, sub.codename, codenumber)
            if key not in feeder_last_seen_id:
                feeder_last_seen_id[key] = get_max_feeder_id(sub.codename, codenumber)
                logger.info(f"[BASELINE] {key} -> mulai dari id {feeder_last_seen_id[key]}")

# =====================================================
# ALERT CHECK
# =====================================================

async def check_alerts():
    logger.info("Checking alerts (suhu + feeder)...")
    subs = get_active_subscriptions()

    for sub in subs:
        codename = sub.codename
        chat_id  = sub.chat_id

        # =========================================================
        # SUHU — per codenumber
        # =========================================================
        for codenumber in get_suhu_codenumbers(codename):
            key_dev  = (chat_id, codename, codenumber)
            key_prob = (chat_id, codenumber)

            latest       = get_latest_suhu(codename, codenumber)
            disconnected = is_suhu_disconnected(codename, codenumber)

            if key_prob not in suhu_problem:
                suhu_problem[key_prob] = {"disconnected": False, "power": False, "suhu": False}

            # --- DISCONNECT ---
            if disconnected and not suhu_problem[key_prob]["disconnected"]:
                last_update = suhu_last_update.get(key_dev)
                if last_update:
                    last_update_str = (last_update + timedelta(hours=7)).strftime("%Y-%m-%d %H:%M:%S")
                else:
                    last_update_str = "Tidak diketahui"

                msg = (
                    f"⚫ *PERINGATAN KONEKSI SUHU - Kandang {codenumber}* ⚫\n\n"
                    f"*Status:* KONEKSI TERPUTUS\n\n"
                    f"⚠️ *Tidak ada update data dalam 3 menit terakhir!*\n\n"
                    f"🕐 *Update terakhir (WIB):* `{last_update_str}`\n\n"
                    f"*Tindakan:*\n"
                    f"  - Periksa koneksi jaringan ke MCU\n"
                    f"  - Pastikan MCU dalam keadaan menyala dan berfungsi\n"
                )
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                suhu_problem[key_prob]["disconnected"] = True
                logger.info(f"[SUHU] Disconnect sent to {chat_id} kandang {codenumber}")
                continue

            if not disconnected and suhu_problem[key_prob]["disconnected"]:
                msg = f"🟢 *KONEKSI SUHU KANDANG {codenumber} KEMBALI NORMAL!* 🟢\n\n✅ MCU sudah terhubung kembali."
                if latest:
                    msg += f"\nSuhu: `{float(latest.temperature)}°C`"
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                suhu_problem[key_prob]["disconnected"] = False
                logger.info(f"[SUHU] Reconnect sent to {chat_id} kandang {codenumber}")

            if not latest or disconnected:
                continue

            # --- POWER ERROR ---
            if latest.power_status == "error" and not suhu_problem[key_prob]["power"]:
                msg = (
                    f"🔴⚠️ *PERINGATAN GANGGUAN DAYA PENGHANGAT - Kandang {codenumber}* ⚠️🔴\n\n"
                    f"*Sistem mendeteksi gangguan pada sumber daya listrik yang mengalir ke sistem penghangat.*\n"
                    f"*Status:* `{latest.power_status.upper()}`\n\n"
                    f"Tindakan:\n"
                    f"- Periksa sambungan listrik ke penghangat\n"
                    f"- Pastikan tidak ada kabel yang longgar atau rusak\n"
                    f"- Periksa kondisi sistem PID penghangat berfungsi dengan baik\n"
                )
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                suhu_problem[key_prob]["power"] = True
                logger.info(f"[SUHU] Power error sent to {chat_id} kandang {codenumber}")

            elif latest.power_status != "error" and suhu_problem[key_prob]["power"]:
                msg = f"🟢 *SISTEM PENGHANGAT KANDANG {codenumber} KEMBALI NORMAL!* 🟢\n\n"
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                suhu_problem[key_prob]["power"] = False
                logger.info(f"[SUHU] Power normal sent to {chat_id} kandang {codenumber}")

            # --- SUHU OUT OF LIMIT ---
            temp       = float(latest.temperature)
            limit_low  = float(latest.limit_low_temp)
            limit_high = float(latest.limit_high_temp)

            limit_low_notify  = limit_low  - TEMP_HYSTERESIS
            limit_high_notify = limit_high + TEMP_HYSTERESIS

            is_out_notify     = (temp < limit_low_notify or temp > limit_high_notify)
            is_back_to_normal = (limit_low <= temp <= limit_high)

            if is_out_notify and not suhu_problem[key_prob]["suhu"]:
                emoji = "❄️" if temp < limit_low_notify else "🔥"
                if temp < limit_low_notify:
                    tindakan = "  - Periksa sistem pemanas\n  - Kurangi ventilasi"
                else:
                    tindakan = "  - Periksa sistem pendingin\n  - Tambah ventilasi"

                msg = (
                    f"{emoji} *PERINGATAN SUHU - Kandang {codenumber}* {emoji}\n\n"
                    f"*Suhu saat ini:* `{temp}°C`\n"
                    f"*Batas Normal:* `{limit_low}°C - {limit_high}°C`\n\n"
                    f"*Tindakan yang disarankan:*\n{tindakan}\n"
                )
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                suhu_problem[key_prob]["suhu"] = True
                logger.info(f"[SUHU] Out of limit sent to {chat_id} kandang {codenumber}")

            elif is_back_to_normal and suhu_problem[key_prob]["suhu"]:
                msg = (
                    f"🟢 *SUHU KANDANG {codenumber} KEMBALI NORMAL!* 🟢\n\n"
                    f"*Suhu sekarang:* `{temp}°C`\n"
                    f"*Batas Normal:* `{limit_low}°C - {limit_high}°C`\n\n"
                    f"✅ Suhu sudah kembali dalam batas normal."
                )
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                suhu_problem[key_prob]["suhu"] = False
                logger.info(f"[SUHU] Back to normal sent to {chat_id} kandang {codenumber}")

        # =========================================================
        # FEEDER — per codenumber
        # =========================================================
        for codenumber in get_feeder_codenumbers(codename):
            key_dev  = (chat_id, codename, codenumber)
            key_prob = (chat_id, codenumber)

            status_row   = get_feeder_status(codename, codenumber)
            disconnected = is_feeder_disconnected(status_row)

            if key_prob not in feeder_problem:
                feeder_problem[key_prob] = {"disconnected": False}

            # --- DISCONNECT / RECONNECT (berdasarkan heartbeat) ---
            if disconnected and not feeder_problem[key_prob]["disconnected"]:
                if status_row and status_row.updated_at:
                    last_wib = (status_row.updated_at.replace(tzinfo=timezone.utc) + timedelta(hours=7)) \
                        if status_row.updated_at.tzinfo is None \
                        else (status_row.updated_at.astimezone(timezone.utc) + timedelta(hours=7))
                    last_str = last_wib.strftime("%Y-%m-%d %H:%M:%S")
                else:
                    last_str = "Tidak diketahui"

                msg = (
                    f"⚫ *PERINGATAN KONEKSI PAKAN {codename} - Kandang {codenumber}* ⚫\n\n"
                    f"*Status:* KONEKSI TERPUTUS\n\n"
                    f"⚠️ *Tidak ada update dalam 10 menit terakhir!*\n\n"
                    f"🕐 *Update terakhir (WIB):* `{last_str}`\n\n"
                    f"*Tindakan:*\n"
                    f"  - Periksa koneksi jaringan ke alat pakan\n"
                    f"  - Pastikan alat menyala dan berfungsi\n"
                )
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                feeder_problem[key_prob]["disconnected"] = True
                logger.info(f"[FEEDER] Disconnect sent to {chat_id} kandang {codenumber}")
                continue

            if not disconnected and feeder_problem[key_prob]["disconnected"]:
                msg = f"🟢 *KONEKSI PAKAN KANDANG {codenumber} KEMBALI NORMAL!* 🟢\n\n✅ Alat sudah terhubung kembali."
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                feeder_problem[key_prob]["disconnected"] = False
                logger.info(f"[FEEDER] Reconnect sent to {chat_id} kandang {codenumber}")

            if disconnected:
                continue

            # --- STATUS STOK (dari heartbeat, bukan dari rawlog) ---
            if status_row and status_row.status_stok:
                stok_sekarang = status_row.status_stok
                stok_sebelum  = feeder_last_stok.get(key_dev)

                if stok_sebelum is not None and stok_sekarang != stok_sebelum:
                    if stok_sekarang.upper() == "HABIS":
                        msg = (
                            f"🔴 *STOK PAKAN HABIS - Kandang {codenumber}* 🔴\n\n"
                            f"Wadah pakan kandang {codenumber} sudah kosong.\n"
                            f"Segera isi ulang pakan!"
                        )
                        await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                        logger.info(f"[FEEDER] Stok habis sent to {chat_id} kandang {codenumber}")

                    elif stok_sekarang.upper() == "HAMPIR HABIS":
                        msg = (
                            f"🟡 *STOK PAKAN HAMPIR HABIS - Kandang {codenumber}* 🟡\n\n"
                            f"Segera siapkan pengisian ulang pakan."
                        )
                        await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                        logger.info(f"[FEEDER] Stok hampir habis sent to {chat_id} kandang {codenumber}")

                    elif stok_sekarang.upper() == "TERSEDIA":
                        msg = (
                            f"🟢 *STOK PAKAN KANDANG {codenumber} SUDAH DIISI!* 🟢\n\n"
                            f"Stok pakan sudah tersedia kembali."
                        )
                        await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                        logger.info(f"[FEEDER] Stok tersedia sent to {chat_id} kandang {codenumber}")

                feeder_last_stok[key_dev] = stok_sekarang

            # --- EVENT DISPENSING BARU ---
            last_id     = feeder_last_seen_id.get(key_dev, 0)
            new_events  = get_new_feeder_events(codename, codenumber, last_id)

            for row in new_events:
                waktu_wib = "-"
                if row.waktu_pakan:
                    wp = row.waktu_pakan
                    wp = wp.replace(tzinfo=timezone.utc) if wp.tzinfo is None else wp.astimezone(timezone.utc)
                    waktu_wib = (wp + timedelta(hours=7)).strftime("%Y-%m-%d %H:%M:%S")

                status_pakan = (row.status_pakan or "-").lower()
                if status_pakan == "success":
                    emoji, judul = "✅", "PEMBERIAN PAKAN BERHASIL"
                elif status_pakan == "gagal":
                    emoji, judul = "🔴", "PEMBERIAN PAKAN GAGAL"
                elif status_pakan == "tidak_sesuai":
                    emoji, judul = "🟡", "PEMBERIAN PAKAN TIDAK SESUAI TARGET"
                elif status_pakan == "tidak_selesai":
                    emoji, judul = "🟠", "PEMBERIAN PAKAN TIDAK SELESAI"
                else:
                    emoji, judul = "ℹ️", "PEMBERIAN PAKAN SELESAI"

                msg = (
                    f"{emoji} *{judul} - Kandang {codenumber}* {emoji}\n\n"
                    f"🍽️ *Jenis Pakan:* `{row.jenis_pakan or '-'}`\n"
                    f"🎯 *Target:* `{row.target_gram or 0} gram`\n"
                    f"⚖️ *Aktual:* `{row.aktual_gram or 0} gram`\n"
                    f"📉 *Selisih:* `{row.out_gram or 0} gram`\n"
                    f"🕐 *Waktu:* `{waktu_wib}` WIB"
                )
                await bot.send_message(chat_id=chat_id, text=msg, parse_mode='Markdown')
                feeder_last_seen_id[key_dev] = row.id
                logger.info(f"[FEEDER] Dispensing event sent to {chat_id} kandang {codenumber} (id={row.id})")

# =====================================================
# MAIN
# =====================================================

async def main():
    logger.info("=" * 50)
    logger.info("Alert Bot Started - Suhu (multi-kandang) + Feeder")
    logger.info("Monitoring: suhu disconnect(3m), power error, suhu limit,")
    logger.info("            feeder disconnect(10m), status stok, dispensing event")
    logger.info("=" * 50)

    initialize_feeder_baseline()

    while True:
        try:
            await check_alerts()
            await asyncio.sleep(30)
        except Exception as e:
            import traceback
            logger.error(f"Error: {e}\n{traceback.format_exc()}")
            await asyncio.sleep(30)

if __name__ == "__main__":
    print("🚀 Starting Alert Bot (Suhu multi-kandang + Feeder)...")
    asyncio.run(main())