# bot.py - Command handler untuk notifikasi suhu & pakan
import os
import logging
from datetime import datetime, timezone, timedelta
from telegram import (
    Update,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackContext,
    MessageHandler,
    filters,
)
from dotenv import load_dotenv

from database import SessionLocal
from models import SensorData, UserSubscription, FeederStatusLatest

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

DISCONNECT_THRESHOLD = timedelta(minutes=3)

# =====================================================
# KEYBOARD LAYOUTS
# =====================================================

MAIN_KEYBOARD = ReplyKeyboardMarkup(
    [["/help", "/subscribe"], ["/unsubscribe"]],
    resize_keyboard=True,
    one_time_keyboard=False,
)

SUBSCRIBED_KEYBOARD = ReplyKeyboardMarkup(
    [["/unsubscribe"]],
    resize_keyboard=True,
    one_time_keyboard=False,
)

# =====================================================
# DATABASE FUNCTIONS  (tidak berubah)
# =====================================================

def get_db():
    return SessionLocal()

def get_latest_sensor_data(codename: str):
    db = get_db()
    try:
        return db.query(SensorData).filter(
            SensorData.codename == codename
        ).order_by(SensorData.created_at.desc()).first()
    finally:
        db.close()

def get_latest_feeder_status(codename: str):
    db = get_db()
    try:
        return db.query(FeederStatusLatest).filter(
            FeederStatusLatest.codename == codename
        ).order_by(FeederStatusLatest.updated_at.desc()).first()
    finally:
        db.close()

def check_codename_exists(codename: str) -> bool:
    db = get_db()
    try:
        ada_suhu = db.query(SensorData).filter(SensorData.codename == codename).count() > 0
        ada_pakan = db.query(FeederStatusLatest).filter(FeederStatusLatest.codename == codename).count() > 0
        return ada_suhu or ada_pakan
    finally:
        db.close()

def save_subscription(chat_id: int, codename: str, username: str = None, first_name: str = None, last_name: str = None):
    db = get_db()
    try:
        existing = db.query(UserSubscription).filter(UserSubscription.chat_id == chat_id).first()

        if existing:
            existing.codename = codename
            existing.is_active = True
            existing.username = username
            existing.first_name = first_name
            existing.last_name = last_name
            existing.subscribed_at = datetime.now(timezone.utc)
        else:
            sub = UserSubscription(
                chat_id=chat_id,
                codename=codename,
                username=username,
                first_name=first_name,
                last_name=last_name
            )
            db.add(sub)

        db.commit()
        return True
    except Exception as e:
        db.rollback()
        logger.error(f"Error saving subscription: {e}")
        return False
    finally:
        db.close()

def get_user_subscription(chat_id: int):
    db = get_db()
    try:
        sub = db.query(UserSubscription).filter(
            UserSubscription.chat_id == chat_id,
            UserSubscription.is_active == True
        ).first()
        return {"codename": sub.codename} if sub else None
    finally:
        db.close()

def unsubscribe(chat_id: int):
    db = get_db()
    try:
        sub = db.query(UserSubscription).filter(UserSubscription.chat_id == chat_id).first()
        if sub:
            sub.is_active = False
            db.commit()
            return True
        return False
    except Exception as e:
        db.rollback()
        logger.error(f"Error unsubscribing: {e}")
        return False
    finally:
        db.close()

# =====================================================
# FUNGSI BANTU
# =====================================================

def utc_to_wib_str(utc_dt):
    if utc_dt is None:
        return "Tidak diketahui"
    if utc_dt.tzinfo is None:
        utc_dt = utc_dt.replace(tzinfo=timezone.utc)
    wib_dt = utc_dt.astimezone(timezone.utc) + timedelta(hours=7)
    return wib_dt.strftime("%Y-%m-%d %H:%M:%S")

def is_recent(dt, threshold=DISCONNECT_THRESHOLD):
    if dt is None:
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return datetime.now(timezone.utc) - dt <= threshold

def get_keyboard_for_chat(chat_id: int):
    """Tentukan keyboard mana yang harus ditampilkan berdasarkan status subscribe."""
    sub = get_user_subscription(chat_id)
    return SUBSCRIBED_KEYBOARD if sub else MAIN_KEYBOARD

# =====================================================
# PROSES SUBSCRIBE (dipakai oleh command & text handler)
# =====================================================

async def process_subscription(update: Update, context: CallbackContext, codename: str):
    chat_id = update.effective_chat.id
    user = update.effective_user
    codename = codename.strip().upper()

    if not check_codename_exists(codename):
        await update.message.reply_text(
            f"❌ *Kode alat '{codename}' tidak ditemukan!*\n\n"
            f"Pastikan kode sudah benar, atau hubungi *goldenchickapp@yahoo.com* untuk mendaftar.\n\n"
            f"Ketik ulang kode yang benar.",
            parse_mode='Markdown',
            reply_markup=ReplyKeyboardRemove()
        )
        # tetap menunggu input codename berikutnya
        context.user_data['awaiting_codename'] = True
        return

    success = save_subscription(
        chat_id=chat_id,
        codename=codename,
        username=user.username,
        first_name=user.first_name,
        last_name=user.last_name
    )

    context.user_data['awaiting_codename'] = False

    if success:
        msg = (
            f"✅ *Berhasil mendaftar notifikasi untuk kode {codename}!*\n\n"
            f"🔔 Anda akan menerima notifikasi otomatis dari:\n"
            f"  • Pengatur suhu kandang\n"
            f"  • Pemberi pakan ayam terjadwal\n\n"
            f"Gunakan /unsubscribe jika ingin berhenti."
        )
        await update.message.reply_text(msg, parse_mode='Markdown', reply_markup=SUBSCRIBED_KEYBOARD)
    else:
        await update.message.reply_text(
            "❌ Gagal mendaftarkan notifikasi. Coba lagi.",
            reply_markup=MAIN_KEYBOARD
        )

# =====================================================
# TELEGRAM COMMAND HANDLERS
# =====================================================

async def start(update: Update, context: CallbackContext):
    """Handler /start"""
    user = update.effective_user
    context.user_data['awaiting_codename'] = False

    welcome_msg = (
        f"👋 Halo *{user.first_name}*!\n\n"
        f"🐔 *Golden Chick Notification Bot*\n\n"
        f"Bot ini terintegrasi dengan alat yang terdaftar pada situs "
        f"*goldenchick.my.id* — mengirimkan notifikasi otomatis untuk "
        f"pengatur suhu kandang dan pemberi pakan ayam terjadwal.\n\n"
        f"📌 *Cara Pakai:*\n"
        f"• `/subscribe <kode>` - Daftarkan notifikasi untuk kode alat Anda\n"
        f"• `/unsubscribe` - Berhenti menerima notifikasi\n"
        f"• `/help` - Bantuan lengkap\n\n"
        f"📩 Belum punya kode alat? Hubungi kami di "
        f"*goldenchickapp@yahoo.com* untuk mendaftar."
    )

    keyboard = get_keyboard_for_chat(update.effective_chat.id)
    await update.message.reply_text(welcome_msg, parse_mode='Markdown', reply_markup=keyboard)

async def help_command(update: Update, context: CallbackContext):
    """Handler /help"""
    help_msg = (
        "📖 *Panduan Golden Chick Notification Bot*\n\n"
        "`/subscribe <kode>` - Daftarkan notifikasi untuk kode alat Anda\n"
        "`/unsubscribe` - Berhenti menerima notifikasi\n"
        "`/help` - Bantuan ini\n\n"
        "*Contoh:* `/subscribe NJYF1`\n\n"
        "📩 Belum punya kode alat? Hubungi *goldenchickapp@yahoo.com*"
    )
    keyboard = get_keyboard_for_chat(update.effective_chat.id)
    await update.message.reply_text(help_msg, parse_mode='Markdown', reply_markup=keyboard)

async def subscribe_command(update: Update, context: CallbackContext):
    """Handler /subscribe - daftarkan notifikasi untuk kode alat"""

    # Kasus 1: user langsung ketik /subscribe NJYF1
    if context.args:
        await process_subscription(update, context, context.args[0])
        return

    # Kasus 2: tombol /subscribe ditekan tanpa argumen
    # -> sembunyikan keyboard, minta ketik codename manual
    context.user_data['awaiting_codename'] = True
    await update.message.reply_text(
        "🔤 Silakan ketik *kode alat* Anda sekarang:\n\nContoh: `NJYF1`",
        parse_mode='Markdown',
        reply_markup=ReplyKeyboardRemove()
    )

async def unsubscribe_command(update: Update, context: CallbackContext):
    """Handler /unsubscribe - berhenti dari notifikasi"""
    chat_id = update.effective_chat.id
    context.user_data['awaiting_codename'] = False
    subscription = get_user_subscription(chat_id)

    if not subscription:
        await update.message.reply_text("❌ Anda belum terdaftar!", reply_markup=MAIN_KEYBOARD)
        return

    codename = subscription["codename"]
    success = unsubscribe(chat_id)

    if success:
        await update.message.reply_text(
            f"✅ *Berhenti dari notifikasi kode {codename}!*",
            parse_mode='Markdown',
            reply_markup=MAIN_KEYBOARD
        )
    else:
        await update.message.reply_text("❌ Gagal berhenti.", reply_markup=SUBSCRIBED_KEYBOARD)

async def handle_text(update: Update, context: CallbackContext):
    """Tangkap teks biasa (bukan command) — dipakai untuk input codename setelah /subscribe."""
    if context.user_data.get('awaiting_codename'):
        await process_subscription(update, context, update.message.text)
        return

    # teks lain yang tidak dikenali
    keyboard = get_keyboard_for_chat(update.effective_chat.id)
    await update.message.reply_text(
        "❓ Perintah tidak dikenali. Gunakan tombol di bawah atau ketik /help.",
        reply_markup=keyboard
    )

# =====================================================
# MAIN
# =====================================================

def main():
    """Jalankan bot command handler"""
    if not BOT_TOKEN:
        logger.error("BOT_TOKEN tidak ditemukan di .env")
        return

    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("subscribe", subscribe_command))
    app.add_handler(CommandHandler("unsubscribe", unsubscribe_command))

    # tangkap teks biasa (untuk input codename setelah /subscribe ditekan)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    logger.info("🤖 Bot Command Handler Started!")
    logger.info("📋 Available commands: /start, /help, /subscribe, /unsubscribe")

    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()