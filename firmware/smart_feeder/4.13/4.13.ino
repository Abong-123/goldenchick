#define MODE_ONLINE
// #define MODE_OFFLINE

/**************
 * SMART FEEDER — ESP32-S3 — v4.10
 * component: HX711 + Servo Gate + Servo Dorong + Ultrasonik HC-SR04 + LCD 20x4 I2C + Keypad I2C (PCF8574)
 * feature stack: WiFi SoftAP Provisioning (manual via keypad) + MQTT Settings
 * board: ESP32-S3 N16R8
 * 
 * === IDENTITAS DEVICE ===
 * Ganti CODENAME dan CODENUMBER sesuai device
 * 
 * === PIN MAPPING ===
 *  SDA        → GPIO 8
 * SCL        → GPIO 9
 * SERVO_GATE → GPIO 17
 * SERVO_DORONG → GPIO 18
 * HX711_DOUT → GPIO 5
 * HX711_SCK  → GPIO 4
 * TRIG       → GPIO 6
 * ECHO       → GPIO 7
 * 
 * === PROVISIONING ===
 * - PoP (PIN)     : lihat variabel `pop`
 * - Nama AP       : "pakan-<CODENAME>-<CODENUMBER>" (unik per device)
 * - App           : ESP SoftAP Provisioning (Android/iOS)
 * - Trigger awal  : otomatis, HANYA kalau NVS WiFi kosong
 * - Trigger ulang : keypad [D] lalu konfirmasi [#] (manual, kapan saja)
 * 
 * === CATATAN UPLOAD (Arduino IDE) ===
 * Library yang wajib di-install via Library Manager:
 *   - "HX711_ADC"          oleh Olav Kallhovd
 *   - "RTClib"             oleh Adafruit
 *   - "LiquidCrystal_I2C"  oleh Frank de Brabander
 *   - "Keypad_I2C"         oleh joeyoung (atau "Keypad" + soft I2C)
 *   - "ESP32Servo"         oleh Kevin Harrington
 *   - "PubSubClient"       oleh Nick O'Leary
 *   - "ArduinoJson"        oleh Benoit Blanchon
 *   - "WiFiProv"           (bawaan ESP32, tidak perlu install)
 *   - "LittleFS"           (bawaan ESP32, tidak perlu install)
 * 
 * Opsi penting di Tools:
 *   - USB CDC On Boot    → Enable (WAJIB untuk ESP32-S3 native USB)
 *     (kalau tidak di-enable, Serial monitor tidak akan muncul)
 *   - USB Mode           → "Hardware CDC and JTAG" (default aman)
 *   - Flash Size         → Sesuaikan dengan board (min. 4MB)
 *   - Partition Scheme   → "Default 4MB with spiffs" 
 *                           atau "Minimal SPIFFS" jika butuh ruang
 * 
 * 
 * ==== CATATAN TAMBAHAN ========
 * ----- LOGIKA MULTI-SESI (Kapasitas Wadah Timbang Terbatas) -------
 * Karena load cell hanya mampu menampung 100g, pemberian pakan dibagi sesi:
 * 1. Buka gate → timbang hingga target sesi tercapai → tutup gate
 * 2. Dorong pakan ke wadah ayam (kosongkan timbangan)
 * 3. Ulangi hingga total kebutuhan terpenuhi
 * 4. Jika stok HABIS di tengah sesi → berhenti total (hindari gate terbuka sia-sia)
 **************/

#ifdef MODE_ONLINE
  #include <WiFi.h>
  #include <WiFiProv.h>
  #include <esp_wifi.h>
  #include <Preferences.h>
  #include <PubSubClient.h>
  #include <ArduinoJson.h>   // parsing payload JSON setting dari server (subscribe)
  #include <time.h>
  #include <LittleFS.h>   //  buffer offline event-driven
#endif

#include <Wire.h>
#include <RTClib.h>
#include <ESP32Servo.h>
#include <HX711_ADC.h>
#include <LiquidCrystal_I2C.h>
#include <Keypad.h>
#include <Keypad_I2C.h>

#define SERVO_GATE_PIN   17
#define SERVO_DORONG_PIN 18
#define HX711_DOUT        5
#define HX711_SCK         4
#define TRIG_PIN          6
#define ECHO_PIN          7

Servo servoGate;
Servo servo360;

#define GATE_TUTUP   40
#define PUTAR_KIRI   35
#define STOP_SERVO   95
#define PUTAR_KANAN 150

int jenisPakan = 3;
int gateBuka   = 19;
int waktuPemberian = 2;

const char* codeName   = "your-codename";
const int   codeNumber = 1;

String modePakan = "auto";

int   jumlahAyam   = 5;
float pakanPerAyam = 40.0;

struct Jadwal { int jam; int menit; };

Jadwal jadwalPakan[4] = {
    {6, 0},
    {11, 0},
    {15, 0},
    {18, 0}
};

bool sudahJalan[4] = {false, false, false, false};

String waktuPakanAktif = "";

HX711_ADC LoadCell(HX711_DOUT, HX711_SCK);
float calibrationValue = 428.4;

const float kapasitasSesi   = 100.0;
const float kompensasiTutup = 1.0;

float totalKebutuhan = 0;
float totalTerkirim  = 0;
int   nomorSesi      = 1;

unsigned long waktuMulai   = 0;
unsigned long waktuSelesai = 0;
unsigned long lastPrint    = 0;

float targetSesiData[20];
float beratAkhirData[20];
float waktuData[20];
float errorData[20];

RTC_DS3231 rtc;
LiquidCrystal_I2C lcd(0x27, 20, 4);

#define I2C_KEYPAD_ADDR 0x20
const byte ROWS = 4;
const byte COLS = 4;
char keys[ROWS][COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};
byte rowPins[ROWS] = {7, 6, 5, 4};
byte colPins[COLS] = {3, 2, 1, 0};
Keypad_I2C keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS, I2C_KEYPAD_ADDR);

float  jarakUltrasonik = 0;
String statusPakan     = "TERSEDIA";   // status STOK (TERSEDIA/HAMPIR HABIS/HABIS) — beda dgn status_pakan di payload MQTT

//   "selesai"       : dispensing jalan sampai target tercapai (dalam
//                      toleransi loop), status_pakan final ditentukan
//                      dari out_gram (berhasil / tidak_sesuai)
//   "dibatalkan"    : stok sudah HABIS SEBELUM dispensing mulai sama
//                      sekali
//   "tidak_selesai" : dispensing sudah berjalan, tapi stok jadi HABIS
//                      DI TENGAH proses, berhenti sebelum target tercapai
String lastEventType = "selesai";

Preferences prefsPakan;

String lastSettingsTimestamp = "";

unsigned long lastSettingsEpoch = 0;

char sumberSettingTerakhir = 'M';

long daysFromCivil(int y, int m, int d) {
  y -= (m <= 2) ? 1 : 0;
  long era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = (unsigned)(y - era * 400);                 // [0, 399]
  unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1; // [0, 365]
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;      // [0, 146096]
  return era * 146097L + (long)doe - 719468L;
}


bool parseISO8601ToEpoch(const String &iso, long &epochOut) {
  if (iso.length() < 19) return false;   

  int year   = iso.substring(0, 4).toInt();
  int month  = iso.substring(5, 7).toInt();
  int day    = iso.substring(8, 10).toInt();
  int hour   = iso.substring(11, 13).toInt();
  int minute = iso.substring(14, 16).toInt();
  int second = iso.substring(17, 19).toInt();

  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 60) {
    return false;
  }

  int idx = 19;
  if (idx < (int)iso.length() && iso.charAt(idx) == '.') {
    idx++;
    while (idx < (int)iso.length() && isDigit(iso.charAt(idx))) idx++;
  }

  long offsetSeconds = 0;   // offset yg tertulis di teks, mis +07:00 -> +25200
  if (idx < (int)iso.length()) {
    char c = iso.charAt(idx);
    if (c == 'Z' || c == 'z') {
      offsetSeconds = 0;
    } else if ((c == '+' || c == '-') && idx + 5 < (int)iso.length()) {
      int offHour = iso.substring(idx + 1, idx + 3).toInt();
      int offMin  = iso.substring(idx + 4, idx + 6).toInt();
      offsetSeconds = offHour * 3600L + offMin * 60L;
      if (c == '-') offsetSeconds = -offsetSeconds;
    }
  }

  long days = daysFromCivil(year, month, day);
  long localSeconds = days * 86400L + (long)hour * 3600L + (long)minute * 60L + (long)second;
  epochOut = localSeconds - offsetSeconds;   // UTC = waktu-lokal-di-teks - offset
  return true;
}

void saveSettingPakan(String timestamp = "", char sumber = 'M') {
  prefsPakan.begin("pakan_cfg", false);
  prefsPakan.putInt("jmlAyam",   jumlahAyam);
  prefsPakan.putFloat("pakanEk", pakanPerAyam);
  prefsPakan.putInt("jenis",     jenisPakan);
  prefsPakan.putInt("freq",      waktuPemberian);
  prefsPakan.putInt("j0jam",     jadwalPakan[0].jam);
  prefsPakan.putInt("j0mnt",     jadwalPakan[0].menit);
  prefsPakan.putInt("j1jam",     jadwalPakan[1].jam);
  prefsPakan.putInt("j1mnt",     jadwalPakan[1].menit);
  prefsPakan.putInt("j2jam",     jadwalPakan[2].jam);
  prefsPakan.putInt("j2mnt",     jadwalPakan[2].menit);
  prefsPakan.putInt("j3jam",     jadwalPakan[3].jam);
  prefsPakan.putInt("j3mnt",     jadwalPakan[3].menit);
  if (timestamp.length() > 0) {
    long epochParsed = 0;
    if (parseISO8601ToEpoch(timestamp, epochParsed)) {
      prefsPakan.putString("cfgts",    timestamp);
      prefsPakan.putULong("cfgepoch",  (unsigned long)epochParsed);
      lastSettingsTimestamp = timestamp;
      lastSettingsEpoch     = (unsigned long)epochParsed;

    
      prefsPakan.putChar("cfgsrc", sumber);
      sumberSettingTerakhir = sumber;
    } else {
      Serial.print("[NVS] WARNING: timestamp '"); Serial.print(timestamp);
      Serial.println("' tidak valid, penanda LWW TIDAK diupdate");
    }
  }
  prefsPakan.end();
  Serial.println("[NVS] Setting pakan disimpan ke flash");
}

void loadSettingPakan() {
  prefsPakan.begin("pakan_cfg", true);
  // "jmlAyam" dipakai sebagai penanda "sudah pernah disimpan belum".
  int savedJumlahAyam = prefsPakan.getInt("jmlAyam", -1);

  if (savedJumlahAyam < 0) {
    prefsPakan.end();
    Serial.println("[NVS] Belum ada setting tersimpan, pakai default");
    return;
  }

  jumlahAyam     = savedJumlahAyam;
  pakanPerAyam   = prefsPakan.getFloat("pakanEk", pakanPerAyam);
  jenisPakan     = prefsPakan.getInt("jenis",     jenisPakan);
  waktuPemberian = prefsPakan.getInt("freq",      waktuPemberian);

  jadwalPakan[0].jam   = prefsPakan.getInt("j0jam", jadwalPakan[0].jam);
  jadwalPakan[0].menit = prefsPakan.getInt("j0mnt", jadwalPakan[0].menit);
  jadwalPakan[1].jam   = prefsPakan.getInt("j1jam", jadwalPakan[1].jam);
  jadwalPakan[1].menit = prefsPakan.getInt("j1mnt", jadwalPakan[1].menit);
  jadwalPakan[2].jam   = prefsPakan.getInt("j2jam", jadwalPakan[2].jam);
  jadwalPakan[2].menit = prefsPakan.getInt("j2mnt", jadwalPakan[2].menit);
  jadwalPakan[3].jam   = prefsPakan.getInt("j3jam", jadwalPakan[3].jam);
  jadwalPakan[3].menit = prefsPakan.getInt("j3mnt", jadwalPakan[3].menit);

  lastSettingsTimestamp = prefsPakan.getString("cfgts", "");
  lastSettingsEpoch     = prefsPakan.getULong("cfgepoch", 0);
  sumberSettingTerakhir = prefsPakan.getChar("cfgsrc", 'M');   // [BARU v4.10]

  prefsPakan.end();

  Serial.println("[NVS] Setting pakan terakhir berhasil di-load:");
  Serial.print("  Jumlah Ayam : "); Serial.println(jumlahAyam);
  Serial.print("  Pakan/ekor  : "); Serial.println(pakanPerAyam);
  Serial.print("  Jenis Pakan : "); Serial.println(jenisPakan);
  Serial.print("  Frekuensi   : "); Serial.println(waktuPemberian);
}

#ifdef MODE_ONLINE
  // =====================
  // WIFI PROVISIONING (SoftAP) — pola sama seperti alat suhu (proven)
  // =====================
  Preferences preferences;

  const char* pop         = "your-pin";        // PIN provisioning
  String      serviceName;                  // diisi di setup(): "pakan-<codeName>-<codeNumber>"
  const char* service_key = NULL;            // NULL = AP tanpa password

  bool provisioningMode = false;
  bool wifiConnected    = false;
  bool ntpSynced        = false;

  unsigned long lastWifiRetry = 0;
  const unsigned long WIFI_RETRY_INTERVAL = 15000; // retry senyap tiap 15 detik

  unsigned long confirmProvUntil = 0;
  const unsigned long CONFIRM_PROV_TIMEOUT = 5000; // 5 detik utk konfirmasi

  // =====================
  // MQTT
  // =====================
  const char* MQTT_BROKER   = "your-mqtt-broker-ip-or-domain";
  const int   MQTT_PORT     = 1883;
  const char* MQTT_USER     = "your-mqtt-username";
  const char* MQTT_PASSWORD = "your-mqtt-password";
  const char* MQTT_TOPIC    = "feeder/rawlog";
  // [BARU v4.13] Topic untuk laporan setiap kali setting disimpan/diubah lewat keypad.
  const char* SETTINGS_REPORT_TOPIC = "feeder/settings/report";
  String mqttClientId;

  String mqttSettingsTopic;

  // =====================
  // NTP — WIB UTC+7
  // =====================
  const char* NTP_SERVER = "pool.ntp.org";
  const long  GMT_OFFSET = 7 * 3600;
  const int   DST_OFFSET = 0;


  const unsigned long SEND_INTERVAL_MS = 300000;   // 5 menit
  unsigned long lastSendTime = 0;

  // Data terakhir dispensing
  float lastTargetGram = 0;
  float lastAktualGram = 0;
  float lastOutGram = 0;
  String lastWaktuPakan = "";
  String lastJenisPakan = "";

  // MQTT Client
  WiFiClient   wifiClient;
  PubSubClient mqtt(wifiClient);
  unsigned long lastReconnect = 0;

  // =====================
  // [BARU v4.9] BUFFER OFFLINE (LittleFS)
  // =====================
  const char* BUFFER_FILE = "/buffer.log";
  const unsigned long BUFFER_MAX_AGE_SEC = 24UL * 3600UL; // 24 jam
  const unsigned long BUFFER_FLUSH_DELAY_MS = 1500; // jeda antar publish saat flush

  bool wasMqttConnected = false;
  bool pendingSettingsReport = false;
#endif

enum MenuState {
  MENU_HOME,
  MENU_SETTING_AYAM,
  MENU_SETTING_BERAT,
  MENU_SETTING_PAKAN,
  MENU_SETTING_FREKUENSI,
  MENU_SETTING_WAKTU1,
  MENU_SETTING_WAKTU2,
  MENU_SETTING_WAKTU3,
  MENU_SETTING_WAKTU4,
  MENU_SETTING_CONFIRM,
  MENU_DATA,
  MENU_DISPENSING,
  MENU_MANUAL_CONFIRM,   // pengganti while(true) blocking mode manual
  MENU_CONFIRM_PROV      // konfirmasi sebelum masuk provisioning WiFi
};

MenuState menuState   = MENU_HOME;
String    inputBuffer = "";

int   tempJumlahAyam   = 0;
float tempPakanPerAyam = 0;
int   tempJenisPakan   = 1;
int   tempWaktuPemberian = 2;
int   tempJam1 = 0, tempMenit1 = 0;
int   tempJam2 = 0, tempMenit2 = 0;
int   tempJam3 = 0, tempMenit3 = 0;
int   tempJam4 = 0, tempMenit4 = 0;

unsigned long lastLCDRefresh     = 0;
const unsigned long LCD_INTERVAL = 500;

bool  sedangDispensing = false;
float beratSaatIni     = 0;
float targetSaatIni    = 0;
int   sesiSaatIni      = 1;
int   totalSesiNeeded  = 1;

// ======================================================
// LCD HELPERS
// ======================================================
void lcdClear() { lcd.clear(); }

void lcdPrint(int col, int row, String text) {
  lcd.setCursor(col, row);
  lcd.print(text);
}

String lcdPad(String s, int len) {
  while ((int)s.length() < len) s += ' ';
  return s.substring(0, len);
}

#define WIFI_ICON_CHAR 0
#define WIFI_ICON_COL  19
#define WIFI_ICON_ROW  0

byte wifiIconBitmap[8] = {
  B00000,
  B01110,
  B10001,
  B00100,
  B01010,
  B00000,
  B00100,
  B00000
};

void lcdSetupWifiIcon() {
  lcd.createChar(WIFI_ICON_CHAR, wifiIconBitmap);
}

// Panggil tiap kali halaman yang menampilkan baris Waktu (row 0)
// di-refresh, supaya ikon selalu sinkron dengan status WiFi terkini.
void lcdUpdateWifiIcon() {
  lcd.setCursor(WIFI_ICON_COL, WIFI_ICON_ROW);
  if (WiFi.status() == WL_CONNECTED) {
    lcd.write(byte(WIFI_ICON_CHAR));
  } else {
    lcd.print(' ');
  }
}

// ======================================================
// ULTRASONIK
// ======================================================
void bacaUltrasonik() {
  const int JUMLAH_SAMPEL = 5;
  float sampel[JUMLAH_SAMPEL];

  for (int i = 0; i < JUMLAH_SAMPEL; i++) {
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(5);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);
    long duration = pulseIn(ECHO_PIN, HIGH, 30000);

    float jarakRaw = (duration * 0.034 / 2.0); //regresi jarak hc-sr04
    sampel[i] = (0.978 * jarakRaw) + 0.133;

    if (i < JUMLAH_SAMPEL - 1) delay(10);
  }

  for (int i = 0; i < JUMLAH_SAMPEL - 1; i++) {
    for (int j = 0; j < JUMLAH_SAMPEL - 1 - i; j++) {
      if (sampel[j] > sampel[j + 1]) {
        float tmp = sampel[j];
        sampel[j] = sampel[j + 1];
        sampel[j + 1] = tmp;
      }
    }
  }

  jarakUltrasonik = sampel[JUMLAH_SAMPEL / 2];
  // ===== STATUS STOK PAKAN (Ultrasonik) =====
  // Jarak sensor ke permukaan pakan:
  //   < 35 cm  → TERSEDIA
  //   35-40 cm → HAMPIR HABIS (warning, tapi tetap lanjut)
  //   ≥ 40 cm  → HABIS (hentikan pemberian)
  if      (jarakUltrasonik >= 40) statusPakan = "HABIS";
  else if (jarakUltrasonik >= 35) statusPakan = "HAMPIR HABIS";
  else                             statusPakan = "TERSEDIA";
}

const int JUMLAH_SAMPEL_STABIL   = 3;
const unsigned long JEDA_SAMPEL_STABIL = 200; // ms antar sampel

// ===== STABILISASI BACAAN ULTRASONIK =====
// Setelah wadah dikosongkan, cek status stok 3x dengan jeda 200ms.
// Status "HABIS" hanya valid jika mayoritas sampel menunjukkan habis.
// Ini mencegah false-positive karena pakan bergerak saat didorong.
void bacaUltrasonikStabil() {
  int habisCount = 0;

  for (int i = 0; i < JUMLAH_SAMPEL_STABIL; i++) {
    bacaUltrasonik();
    if (statusPakan == "HABIS") habisCount++;
    delay(JEDA_SAMPEL_STABIL);
  }
  if (habisCount > JUMLAH_SAMPEL_STABIL / 2) {
    statusPakan = "HABIS";
  }
}

#ifdef MODE_ONLINE
void jagaKoneksiMqtt() {
  if (wifiConnected && !provisioningMode && mqtt.connected()) {
    mqtt.loop();
  }
}
#endif

// ======================================================
// BACA BERAT
// ======================================================
float bacaBerat() {
  LoadCell.update();
  float berat = (0.999 * LoadCell.getData()) + 0.848; //regresi loadcell
  if (abs(berat) < 1.0) berat = 0;
  if (berat < 0)        berat = 0;
  return berat;
}

// ======================================================
// TARE LOADCELL
// ======================================================
void tareLoadcell(String pesanLCD) {
  Serial.println("Tare Loadcell...");
  if (pesanLCD.length() > 0) {
    lcdPrint(0, 3, lcdPad(pesanLCD, 20));
  }
  LoadCell.tareNoDelay();
  while (!LoadCell.getTareStatus()) {
    LoadCell.update();
#ifdef MODE_ONLINE
    jagaKoneksiMqtt();
#endif
    delay(10);
  }
  for (int i = 0; i < 5; i++) {
    LoadCell.update();
    delay(150);
  }
  float cek = bacaBerat();
  Serial.print("Berat setelah tare: ");
  Serial.print(cek, 2);
  Serial.println(" gram");
}

// ======================================================
// ATTACH/DETACH SERVO GATE
// ======================================================
void gateAttach() {
  if (!servoGate.attached()) {
    servoGate.setPeriodHertz(50);
    servoGate.attach(SERVO_GATE_PIN, 500, 2400);
    delay(100);
  }
}

void gateTutup() {
  gateAttach();
  servoGate.write(GATE_TUTUP);
  delay(700);
  servoGate.detach();
  pinMode(SERVO_GATE_PIN, OUTPUT);
  digitalWrite(SERVO_GATE_PIN, LOW);
}

void gateBukaFungsi() {
  gateAttach();
  servoGate.write(gateBuka);
  delay(300);
}

// ======================================================
// ATTACH/DETACH SERVO DORONG
// ======================================================
void servo360Attach() {
  if (!servo360.attached()) {
    servo360.setPeriodHertz(50);
    servo360.attach(SERVO_DORONG_PIN, 500, 2400);
    servo360.write(STOP_SERVO);
    delay(300);
  }
}

void servo360Stop() {
  servo360.write(STOP_SERVO);
  delay(300);
  servo360.detach();
  pinMode(SERVO_DORONG_PIN, OUTPUT);
  digitalWrite(SERVO_DORONG_PIN, LOW);
}

// ======================================================
// SERVO DORONG
// ======================================================
void dorongPakan() {
  servo360Attach();
  servo360.write(PUTAR_KIRI);
  delay(1300);
  servo360.write(STOP_SERVO);
  delay(500);
  servo360.write(PUTAR_KANAN);
  delay(1400);
  servo360.write(STOP_SERVO);
  delay(500);
  servo360Stop();
}

// ======================================================
// KOSONGKAN WADAH
// ======================================================
void kosongkanWadah(bool tareLagi = true) {
  Serial.println("\nMengosongkan Wadah Timbang...");
  lcd.clear();
  lcdPrint(0, 0, lcdPad("=== MEMBERI PAKAN ===", 20));
  lcdPrint(0, 1, lcdPad("Mendorong pakan...", 20));
  char info[21];
  sprintf(info, "Sesi %d selesai", sesiSaatIni);
  lcdPrint(0, 2, lcdPad(String(info), 20));
  dorongPakan();
  delay(2000);
  if (tareLagi) {
    tareLoadcell("Tare loadcell...");
  }
}

// ======================================================
// UPDATE LCD SAAT DISPENSING
// ======================================================
void updateLCDDispensing() {
  char baris1[21], baris2[21], baris3[21];
  lcdPrint(0, 0, lcdPad("=== MEMBERI PAKAN ===", 20));
  sprintf(baris1, "Sesi : %d / %d", sesiSaatIni, totalSesiNeeded);
  lcdPrint(0, 1, lcdPad(String(baris1), 20));
  sprintf(baris2, "Berat: %.1f / %.0f g", beratSaatIni, targetSaatIni);
  lcdPrint(0, 2, lcdPad(String(baris2), 20));
  sprintf(baris3, "Total: %.0f / %.0f g", totalTerkirim + beratSaatIni, totalKebutuhan);
  lcdPrint(0, 3, lcdPad(String(baris3), 20));
}

// ======================================================
// DISPENSING 1 SESI
// ======================================================
float dispensingSesi(float targetBerat) {
  Serial.println("\n=================================");
  Serial.print("SESI KE-"); Serial.println(nomorSesi);
  Serial.print("Target: "); Serial.print(targetBerat); Serial.println(" gram");

  targetSaatIni = targetBerat;
  sesiSaatIni   = nomorSesi;

  gateBukaFungsi();
  waktuMulai = millis();

  unsigned long lastLCDUpdate = 0;
  float berat = 0;

  while (1) {
    berat        = bacaBerat();
    beratSaatIni = berat;

#ifdef MODE_ONLINE
    jagaKoneksiMqtt();
#endif

    if (millis() - lastPrint >= 100) {
      Serial.print("Berat: "); Serial.print(berat, 2); Serial.println(" gram");
      lastPrint = millis();
    }
    if (millis() - lastLCDUpdate >= 300) {
      lastLCDUpdate = millis();
      updateLCDDispensing();
    }

    if (berat >= (targetBerat - kompensasiTutup)) {
      gateTutup();
      waktuSelesai = millis();

      float durasi      = (waktuSelesai - waktuMulai) / 1000.0;
      float errorPersen = abs(berat - targetBerat) / targetBerat * 100.0;

      targetSesiData[nomorSesi - 1] = targetBerat;
      beratAkhirData[nomorSesi - 1] = berat;
      waktuData[nomorSesi - 1]      = durasi;
      errorData[nomorSesi - 1]      = errorPersen;

      Serial.println("\nTARGET TERCAPAI - Gate Ditutup");
      Serial.print("Berat Akhir: "); Serial.print(berat, 2); Serial.println(" gram");
      Serial.print("Waktu     : "); Serial.print(durasi, 2); Serial.println(" detik");
      Serial.print("Error     : "); Serial.print(errorPersen, 2); Serial.println(" %");

      lcd.clear();
      char done[21];
      sprintf(done, "Sesi %d Selesai!", nomorSesi);
      lcdPrint(0, 1, lcdPad(String(done), 20));
      sprintf(done, "Berat: %.1f g", berat);
      lcdPrint(0, 2, lcdPad(String(done), 20));
      delay(800);

      return berat;
    }
    delay(20);
  }
}

// ======================================================
// FORMAT DATETIME DARI RTC
// ======================================================
String formatDateTimeISO(DateTime dt) {
  char buffer[35];
  sprintf(
    buffer,
    "%04d-%02d-%02dT%02d:%02d:%02d+07:00",
    dt.year(), dt.month(), dt.day(),
    dt.hour(), dt.minute(), dt.second()
  );
  return String(buffer);
}

int getGateBuka(int jenis) {
  if (jenis == 3) return 17;
  return 19;
}

String getNamaPakan(int jenis) {
  if (jenis == 1) return "pelet";
  if (jenis == 2) return "jagung";
  if (jenis == 3) return "mix";
  return "???";
}

#ifdef MODE_ONLINE

String getTimestampISO() {
  return formatDateTimeISO(rtc.now());
}

// ======================================================
// EVENT HANDLER WIFI / PROVISIONING
// ======================================================
void SysProvEvent(arduino_event_t *sys_event) {
  switch (sys_event->event_id) {
    case ARDUINO_EVENT_PROV_START:
      Serial.println(">> Provisioning dimulai, connect ke AP: " + serviceName);
      break;

    case ARDUINO_EVENT_PROV_CRED_FAIL:
      Serial.println(">> Provisioning gagal (cek SSID/password)");
      break;

    case ARDUINO_EVENT_PROV_CRED_SUCCESS:
      Serial.println(">> Kredensial WiFi diterima");
      break;

    case ARDUINO_EVENT_WIFI_STA_GOT_IP: {
      wifiConnected    = true;
      provisioningMode = false;

      wifi_config_t wifi_config;
      esp_wifi_get_config(WIFI_IF_STA, &wifi_config);
      preferences.begin("wifi", false);
      preferences.putString("ssid",     (char*)wifi_config.sta.ssid);
      preferences.putString("password", (char*)wifi_config.sta.password);
      preferences.end();

      configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);

      Serial.print(">> WiFi terhubung, IP: ");
      Serial.println(WiFi.localIP());
      break;
    }

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      wifiConnected = false;
      ntpSynced     = false;
      break;

    default: break;
  }
}

void startProvisioning() {
  provisioningMode = true;
  wifiConnected    = false;
  ntpSynced        = false;

  WiFi.disconnect(true, true);
  delay(300);
  WiFi.mode(WIFI_OFF);
  delay(300);

  Serial.println(">> Mulai provisioning SoftAP: " + serviceName);
  updateLCDProvisioning();

  WiFiProv.beginProvision(
    NETWORK_PROV_SCHEME_SOFTAP,
    NETWORK_PROV_SCHEME_HANDLER_NONE,
    NETWORK_PROV_SECURITY_1,
    pop,
    serviceName.c_str(),
    service_key,
    NULL,
    true   // selalu reset — provisioning ini permintaan eksplisit user
  );
}

void connectSavedWifiOrProvision() {
  preferences.begin("wifi", true);
  String savedSsid = preferences.getString("ssid", "");
  String savedPass = preferences.getString("password", "");
  preferences.end();

  if (savedSsid.length() == 0) {
    startProvisioning();
    return;
  }

  WiFi.begin(savedSsid.c_str(), savedPass.c_str());
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    attempts++;
  }
}

void handleWifiState() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  wifiConnected = false;
  ntpSynced     = false;

  if (provisioningMode) {
    return; // menunggu app HP connect ke AP, tidak melakukan apa2 di sini
  }

  if (millis() - lastWifiRetry > WIFI_RETRY_INTERVAL) {
    lastWifiRetry = millis();
    preferences.begin("wifi", true);
    String savedSsid = preferences.getString("ssid", "");
    String savedPass = preferences.getString("password", "");
    preferences.end();
    if (savedSsid.length() > 0) {
      WiFi.begin(savedSsid.c_str(), savedPass.c_str()); // async, TIDAK blocking
    }
  }
}

// Non-blocking check NTP: timeout kecil (10ms), aman dipanggil tiap loop
void checkNtpSync() {
  if (!wifiConnected || ntpSynced) return;
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 10)) {
    ntpSynced = true;
    rtc.adjust(DateTime(
      timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
      timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec
    ));
    Serial.println("[NTP] Sync OK, RTC diupdate");
  }
}

// ======================================================
// [BARU v4.9] SETTING DARI SERVER (MQTT subscribe)
// ======================================================
int getJenisPakanFromString(String s) {
  if (s == "pelet")  return 1;
  if (s == "jagung") return 2;
  if (s == "mix")    return 3;
  return -1;
}

// Parsing "HH:MM:SS" (atau "HH:MM") jadi jam/menit. Return false kalau
// formatnya tidak valid (caller tidak akan mengubah jadwal lama kalau
// ini false).
bool parseJamMenit(String hhmmss, int &jam, int &menit) {
  int sep = hhmmss.indexOf(':');
  if (sep < 0) return false;
  int jamParsed   = hhmmss.substring(0, sep).toInt();
  int menitParsed = hhmmss.substring(sep + 1).toInt();
  if (jamParsed < 0 || jamParsed > 23 || menitParsed < 0 || menitParsed > 59) return false;
  jam = jamParsed;
  menit = menitParsed;
  return true;
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String pesan;
  pesan.reserve(length);
  for (unsigned int i = 0; i < length; i++) pesan += (char)payload[i];

  Serial.println("[MQTT-SUB] ==========================================");
  Serial.print("[MQTT-SUB] Topic  : "); Serial.println(topic);
  Serial.print("[MQTT-SUB] Payload: "); Serial.println(pesan);

  StaticJsonDocument<384> doc;
  DeserializationError err = deserializeJson(doc, pesan);
  if (err) {
    Serial.print("[MQTT-SUB] JSON invalid, diabaikan: ");
    Serial.println(err.c_str());
    return;
  }

  // codenumber WAJIB dicek dulu sebelum apapun diproses/diterapkan —
  // topic pakai wildcard '#' jadi bisa saja payload ini sebenarnya
  // ditujukan utk codenumber kandang lain di bawah codename yang sama.
  if (!doc.containsKey("codenumber")) {
    Serial.println("[MQTT-SUB] Field codenumber tidak ada, diabaikan");
    return;
  }
  int codenumberMasuk = doc["codenumber"].as<int>();
  if (codenumberMasuk != codeNumber) {
    Serial.print("[MQTT-SUB] codenumber "); Serial.print(codenumberMasuk);
    Serial.print(" bukan untuk device ini (codenumber="); Serial.print(codeNumber);
    Serial.println("), diabaikan");
    return;
  }
  String timestampMasuk = doc["timestamp"] | "";
  if (timestampMasuk.length() == 0) {
    Serial.println("[MQTT-SUB] Field timestamp tidak ada, diabaikan (wajib utk LWW)");
    return;
  }

  long epochMasukSigned = 0;
  if (!parseISO8601ToEpoch(timestampMasuk, epochMasukSigned) || epochMasukSigned < 0) {
    Serial.print("[MQTT-SUB] Field timestamp '"); Serial.print(timestampMasuk);
    Serial.println("' tidak bisa diparse, diabaikan (wajib utk LWW)");
    return;
  }
  unsigned long epochMasuk = (unsigned long)epochMasukSigned;

  if (lastSettingsEpoch > 0 && epochMasuk <= lastSettingsEpoch) {
    Serial.print("[MQTT-SUB] Diabaikan — timestamp payload (" ); Serial.print(timestampMasuk);
    Serial.print(" = epoch "); Serial.print(epochMasuk);
    Serial.print(") <= setting tersimpan (epoch "); Serial.print(lastSettingsEpoch);
    Serial.println("), dianggap lebih lama/duplikat (LWW)");
    return;
  }

  // --- Validasi & konversi tiap field SEBELUM ada satupun yang
  // diterapkan ke variabel global, supaya kalau salah satu field
  // rusak, tidak ada penerapan setengah-setengah (partial update). ---
  if (!doc.containsKey("jenis_pakan") || !doc.containsKey("jumlah_ayam") ||
      !doc.containsKey("pakan_per_ayam") || !doc.containsKey("waktu_pemberian") ||
      !doc.containsKey("jadwal1")) {
    Serial.println("[MQTT-SUB] Ada field wajib yang hilang, diabaikan");
    return;
  }

  int jenisBaru = getJenisPakanFromString(doc["jenis_pakan"].as<String>());
  if (jenisBaru < 0) {
    Serial.print("[MQTT-SUB] jenis_pakan tidak dikenal: ");
    Serial.println(doc["jenis_pakan"].as<String>());
    return;
  }

  int freqBaru = doc["waktu_pemberian"].as<int>();
  if (freqBaru < 1 || freqBaru > 4) {
    Serial.println("[MQTT-SUB] waktu_pemberian di luar rentang 1-4, diabaikan");
    return;
  }

  int jamTmp[4], menitTmp[4];
  bool jadwalOk = true;
  const char* keyJadwal[4] = {"jadwal1", "jadwal2", "jadwal3", "jadwal4"};
  for (int i = 0; i < 4; i++) {
    if (i < freqBaru) {
      if (doc[keyJadwal[i]].isNull()) { jadwalOk = false; break; }
      String jam_str = doc[keyJadwal[i]].as<String>();
      if (!parseJamMenit(jam_str, jamTmp[i], menitTmp[i])) { jadwalOk = false; break; }
    } else {
      // Di luar frekuensi aktif: null itu wajar (lihat catatan tim
      // backend), pertahankan jadwal lama di slot ini apa adanya.
      jamTmp[i] = jadwalPakan[i].jam;
      menitTmp[i] = jadwalPakan[i].menit;
    }
  }
  if (!jadwalOk) {
    Serial.println("[MQTT-SUB] jadwal1..N (sesuai waktu_pemberian) ada yang null/invalid, diabaikan");
    return;
  }

  float jumlahAyamBaru = doc["jumlah_ayam"].as<int>();
  float pakanPerAyamBaru = doc["pakan_per_ayam"].as<float>();

  // --- Semua field valid, baru sekarang diterapkan ---
  jumlahAyam     = jumlahAyamBaru;
  pakanPerAyam   = pakanPerAyamBaru;
  jenisPakan     = jenisBaru;
  waktuPemberian = freqBaru;
  gateBuka       = getGateBuka(jenisPakan);
  for (int i = 0; i < 4; i++) {
    jadwalPakan[i].jam   = jamTmp[i];
    jadwalPakan[i].menit = menitTmp[i];
  }
  for (int i = 0; i < 4; i++) sudahJalan[i] = false; // reset penanda jadwal harian

  saveSettingPakan(timestampMasuk, 'S');   // [v4.10] persist ke NVS + tandai sumber = Server/web

  Serial.println("[MQTT-SUB] Setting BARU dari server berhasil diterapkan & disimpan:");
  Serial.print("  Jumlah Ayam    : "); Serial.println(jumlahAyam);
  Serial.print("  Pakan/ekor     : "); Serial.println(pakanPerAyam);
  Serial.print("  Jenis Pakan    : "); Serial.println(getNamaPakan(jenisPakan));
  Serial.print("  Frekuensi      : "); Serial.println(waktuPemberian);
  for (int i = 0; i < waktuPemberian; i++) {
    Serial.printf("  Jadwal %d       : %02d:%02d\n", i + 1, jadwalPakan[i].jam, jadwalPakan[i].menit);
  }
}

// ======================================================
// MQTT RECONNECT
// ======================================================
void mqttReconnect() {
  if (mqtt.connected()) return;
  if (millis() - lastReconnect < 5000) return;
  lastReconnect = millis();

  Serial.print("[MQTT] Connecting... ");
  if (mqtt.connect(mqttClientId.c_str(), MQTT_USER, MQTT_PASSWORD)) {
    Serial.println("OK");
    bool subOk = mqtt.subscribe(mqttSettingsTopic.c_str());
    Serial.print("[MQTT] Subscribe "); Serial.print(mqttSettingsTopic);
    Serial.println(subOk ? " -> OK" : " -> GAGAL");
  } else {
    Serial.print("GAGAL rc=");
    Serial.print(mqtt.state());
    Serial.println(" — coba lagi 5 detik");
  }
}

String buildSettingsReportJSON() {
  char j1[10], j2[10], j3[10], j4[10];
  sprintf(j1, "%02d:%02d:00", jadwalPakan[0].jam, jadwalPakan[0].menit);
  sprintf(j2, "%02d:%02d:00", jadwalPakan[1].jam, jadwalPakan[1].menit);
  sprintf(j3, "%02d:%02d:00", jadwalPakan[2].jam, jadwalPakan[2].menit);
  sprintf(j4, "%02d:%02d:00", jadwalPakan[3].jam, jadwalPakan[3].menit);

  String json = "{";
  json += "\"codename\":\"" + String(codeName) + "\",";
  json += "\"codenumber\":" + String(codeNumber) + ",";
  json += "\"jenis_pakan\":\"" + getNamaPakan(jenisPakan) + "\",";
  json += "\"jumlah_ayam\":" + String(jumlahAyam) + ",";
  json += "\"pakan_per_ayam\":" + String(pakanPerAyam, 1) + ",";
  json += "\"waktu_pemberian\":" + String(waktuPemberian) + ",";
  json += "\"jadwal1\":" + (waktuPemberian >= 1 ? ("\"" + String(j1) + "\"") : String("null")) + ",";
  json += "\"jadwal2\":" + (waktuPemberian >= 2 ? ("\"" + String(j2) + "\"") : String("null")) + ",";
  json += "\"jadwal3\":" + (waktuPemberian >= 3 ? ("\"" + String(j3) + "\"") : String("null")) + ",";
  json += "\"jadwal4\":" + (waktuPemberian >= 4 ? ("\"" + String(j4) + "\"") : String("null"));
  json += "}";
  return json;
}

void sendSettingsReport() {
  if (!mqtt.connected()) {
    Serial.println("[MQTT] Settings report ditunda — MQTT belum connected, akan dikirim otomatis saat online");
    pendingSettingsReport = true;
    return;
  }
  String json = buildSettingsReportJSON();
  bool ok = mqtt.publish(SETTINGS_REPORT_TOPIC, json.c_str());
  Serial.println("[MQTT] ==========================================");
  Serial.print("[MQTT] Publish (settings report) -> ");
  Serial.println(ok ? "OK" : "GAGAL, akan dicoba lagi saat MQTT reconnect");
  Serial.println("[MQTT] JSON: " + json);
  pendingSettingsReport = !ok;
}

String buildPayloadJSON(String tipe) {
  float jarakSnap = jarakUltrasonik;
  String stokSnap = statusPakan;               // status STOK: TERSEDIA/HAMPIR HABIS/HABIS
  int rssiSnap = WiFi.RSSI();
  String waktuSnap = getTimestampISO();
  unsigned long msSnap = millis();

  float targetSnap = lastTargetGram;
  float aktualSnap = lastAktualGram;
  float outSnap = lastOutGram;
  String jenisSnap = lastJenisPakan;
  String eventTypeSnap = lastEventType;   // "selesai" | "dibatalkan" | "tidak_selesai"
  String waktuPakanSnap = lastWaktuPakan.length() > 0 ? lastWaktuPakan : waktuSnap;

  //  - "idle"          : belum pernah dispensing sejak boot (targetSnap masih 0)
  //  - "dibatalkan"     : stok sudah HABIS SEBELUM dispensing mulai sama sekali
  //  - "tidak_selesai"  : dispensing sempat jalan, tapi stok jadi HABIS
  //                        DI TENGAH proses, berhenti sebelum target tercapai
  //  - "berhasil"       : dispensing selesai normal, out_gram <= 3 gram
  //  - "tidak_sesuai"   : dispensing selesai normal, tapi out_gram > 3 gram
  String statusPakanSnap;
  if (targetSnap <= 0) {
    statusPakanSnap = "idle";
  } else if (eventTypeSnap == "dibatalkan") {
    statusPakanSnap = "dibatalkan";
  } else if (eventTypeSnap == "tidak_selesai") {
    statusPakanSnap = "tidak_selesai";
  } else if (outSnap <= 3.0) {
    statusPakanSnap = "berhasil";
  } else {
    statusPakanSnap = "tidak_sesuai";
  }

  if (targetSnap == 0) {
    targetSnap = (float)jumlahAyam * pakanPerAyam;
    aktualSnap = 0;
    outSnap = targetSnap;
    jenisSnap = getNamaPakan(jenisPakan);
    // statusPakanSnap sudah "idle" dari cabang di atas (targetSnap awal <= 0)
  }

  String json = "{";
  json += "\"publish_type\":\"" + tipe + "\",";
  json += "\"codename\":\"" + String(codeName) + "\",";
  json += "\"action\":\"feeder\",";
  json += "\"codenumber\":" + String(codeNumber) + ",";
  json += "\"jenis_pakan\":\"" + jenisSnap + "\",";
  json += "\"target_gram\":" + String(targetSnap, 0) + ",";
  json += "\"aktual_gram\":" + String(aktualSnap, 0) + ",";
  json += "\"out_gram\":" + String(outSnap, 0) + ",";
  json += "\"status_pakan\":\"" + statusPakanSnap + "\",";
  json += "\"waktu_pakan\":\"" + waktuPakanSnap + "\",";
  json += "\"status_stok\":\"" + stokSnap + "\",";
  json += "\"jarak_ultrasonik\":" + String(jarakSnap, 1) + ",";
  json += "\"status\":\"online\",";
  json += "\"rssi\":" + String(rssiSnap) + ",";
  json += "\"esp_millis\":" + String(msSnap) + ",";
  json += "\"created_at\":\"" + waktuSnap + "\"";
  json += "}";
  return json;
}

void bufferSendData(String json) {
  File f = LittleFS.open(BUFFER_FILE, FILE_APPEND);
  if (!f) {
    Serial.println("[BUFFER] Gagal buka file buffer untuk menulis!");
    return;
  }
  unsigned long ts = rtc.now().unixtime();
  f.print(String(ts) + "|" + json + "\n");
  f.close();
  Serial.println("[BUFFER] Event tersimpan ke buffer (MQTT offline saat itu)");
}

void flushBufferedData() {
  if (!LittleFS.exists(BUFFER_FILE)) return;

  File f = LittleFS.open(BUFFER_FILE, FILE_READ);
  if (!f) {
    Serial.println("[BUFFER] Gagal buka file buffer untuk membaca!");
    return;
  }
  if (f.size() == 0) {
    f.close();
    LittleFS.remove(BUFFER_FILE);
    return;
  }

  const int MAX_RECORD = 60; // jauh di atas realistis (maks 4x/hari jadwal)
  String baris[MAX_RECORD];
  int total = 0;
  while (f.available() && total < MAX_RECORD) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) baris[total++] = line;
  }
  f.close();

  Serial.print("[BUFFER] Mulai flush, jumlah record tertahan: ");
  Serial.println(total);

  unsigned long nowUnix = rtc.now().unixtime();
  String sisaBelumTerkirim = "";
  int terkirim = 0, kadaluarsa = 0;

  for (int i = 0; i < total; i++) {
    int sep = baris[i].indexOf('|');
    if (sep < 0) continue; // format rusak, buang saja

    unsigned long ts = (unsigned long) baris[i].substring(0, sep).toInt();
    String json = baris[i].substring(sep + 1);

    if (nowUnix > ts && (nowUnix - ts) > BUFFER_MAX_AGE_SEC) {
      Serial.println("[BUFFER] Record kadaluarsa (>24 jam), dibuang");
      kadaluarsa++;
      continue;
    }

    if (!mqtt.connected()) {
      // Putus lagi di tengah proses flush -> simpan sisanya balik ke file
      sisaBelumTerkirim += baris[i] + "\n";
      continue;
    }

    bool ok = mqtt.publish(MQTT_TOPIC, json.c_str());
    Serial.print("[BUFFER] Kirim record tertahan #"); Serial.print(i + 1);
    Serial.print(" -> "); Serial.println(ok ? "OK" : "GAGAL, disimpan ulang");

    if (ok) {
      terkirim++;
      delay(BUFFER_FLUSH_DELAY_MS); // jeda antar publish, tidak burst bersamaan
    } else {
      sisaBelumTerkirim += baris[i] + "\n";
    }
  }

  LittleFS.remove(BUFFER_FILE);
  if (sisaBelumTerkirim.length() > 0) {
    File fw = LittleFS.open(BUFFER_FILE, FILE_WRITE);
    if (fw) {
      fw.print(sisaBelumTerkirim);
      fw.close();
    }
  }

  Serial.print("[BUFFER] Flush selesai. Terkirim: "); Serial.print(terkirim);
  Serial.print(", Kadaluarsa: "); Serial.print(kadaluarsa);
  Serial.print(", Sisa tertahan lagi: "); Serial.println(total - terkirim - kadaluarsa);
}

void sendEventData() {
  String json = buildPayloadJSON("event");

  if (mqtt.connected()) {
    bool ok = mqtt.publish(MQTT_TOPIC, json.c_str());
    Serial.println("[MQTT] ==========================================");
    Serial.print("[MQTT] Publish (event) → ");
    Serial.println(ok ? "OK" : "GAGAL, disimpan ke buffer");
    Serial.println("[MQTT] JSON: " + json);
    if (!ok) {
      bufferSendData(json);
    }
  } else {
    Serial.println("[MQTT] Offline saat event selesai — data disimpan ke buffer");
    bufferSendData(json);
  }
}

// ======================================================
// [v4.9] HEARTBEAT — dipanggil tiap SEND_INTERVAL_MS
// ======================================================
void sendHeartbeat() {
  if (!mqtt.connected()) {
    Serial.println("[MQTT] Heartbeat dilewati (offline), tidak dibuffer");
    return;
  }
  String json = buildPayloadJSON("heartbeat");
  bool ok = mqtt.publish(MQTT_TOPIC, json.c_str());
  Serial.println("[MQTT] ==========================================");
  Serial.print("[MQTT] Publish (heartbeat) → ");
  Serial.println(ok ? "OK" : "GAGAL");
  Serial.println("[MQTT] JSON: " + json);
}
#endif

// ======================================================
// PROSES PEMBERIAN PAKAN
// ======================================================
void prosesPemberianPakan() {
  bacaUltrasonik();

  if (statusPakan == "HABIS") {
    Serial.println("\n!!! PAKAN HABIS - Pemberian dibatalkan !!!");
    lcd.clear();
    lcdPrint(0, 0, lcdPad("!!! PERINGATAN !!!", 20));
    lcdPrint(0, 1, lcdPad("STOK PAKAN HABIS!", 20));
    lcdPrint(0, 2, lcdPad("Pemberian Dibatalkan", 20));
    lcdPrint(0, 3, lcdPad("Isi ulang pakan!", 20));
    delay(3000);
#ifdef MODE_ONLINE
    {
      String waktuBatal = waktuPakanAktif;
      if (waktuBatal == "") waktuBatal = formatDateTimeISO(rtc.now());

      lastTargetGram = (float)jumlahAyam * pakanPerAyam; // target yg SEHARUSNYA diberikan
      lastAktualGram = 0;                                 // tidak ada yang sempat keluar
      lastOutGram    = lastTargetGram;                    // selisih penuh = target itu sendiri
      lastWaktuPakan = waktuBatal;
      lastJenisPakan = getNamaPakan(jenisPakan);
      lastEventType  = "dibatalkan";

      sendEventData();
      lastSendTime = millis();
    }
#endif

    waktuPakanAktif = "";
    modePakan = "auto";
    menuState = MENU_HOME;
    lcd.clear();
    return;
  }

  if (statusPakan == "HAMPIR HABIS") {
    Serial.println("\n! PERINGATAN: Pakan hampir habis...");
    lcd.clear();
    lcdPrint(0, 0, lcdPad("! PERINGATAN !", 20));
    lcdPrint(0, 1, lcdPad("Pakan Hampir Habis!", 20));
    lcdPrint(0, 2, lcdPad("Tetap melanjutkan...", 20));
    delay(2000);
  }

  sedangDispensing = true;
  menuState = MENU_DISPENSING;
  lcd.clear();

  Serial.println("\nTare awal sebelum mulai dispensing...");
  lcdPrint(0, 0, lcdPad("=== MEMBERI PAKAN ===", 20));
  lcdPrint(0, 1, lcdPad("Persiapan...", 20));
  lcdPrint(0, 2, lcdPad("Tare loadcell...", 20));
  tareLoadcell("");

  totalKebutuhan = (float)jumlahAyam * pakanPerAyam;
  totalTerkirim = 0;
  nomorSesi = 1;
  beratSaatIni = 0;
  totalSesiNeeded = (int)ceil(totalKebutuhan / kapasitasSesi);

  lastEventType = "selesai";

  Serial.println("\n=================================");
  Serial.println("PEMBERIAN PAKAN DIMULAI");
  Serial.print("Mode           : "); Serial.println(modePakan);
  Serial.print("Jenis Pakan    : "); Serial.println(getNamaPakan(jenisPakan));
  Serial.print("Total Kebutuhan: "); Serial.print(totalKebutuhan); Serial.println(" gram");
  Serial.print("Estimasi Sesi  : "); Serial.println(totalSesiNeeded);

  float sisaWadah = 0;

  while (totalTerkirim < totalKebutuhan) {
    if ((totalKebutuhan - totalTerkirim) <= 3.0) {
      Serial.println("Target sudah tercapai (dalam toleransi)");
      break;
    }

    float sisaKebutuhan = totalKebutuhan - totalTerkirim;
    float targetTambahan = min(kapasitasSesi, sisaKebutuhan) - sisaWadah;
    if (targetTambahan < 0) targetTambahan = 0;

    float targetSesi = sisaWadah + targetTambahan;

    Serial.print("\nSisa wadah awal sesi : "); Serial.print(sisaWadah, 2); Serial.println(" gram");
    Serial.print("Target tambahan gate : "); Serial.print(targetTambahan, 2); Serial.println(" gram");
    Serial.print("Target total loadcell: "); Serial.print(targetSesi, 2); Serial.println(" gram");

    float beratAktual;
    if (targetTambahan <= 0.5) {
      Serial.println("Sisa wadah cukup, skip buka gate");
      beratAktual = sisaWadah;
      sisaWadah = 0;
    } else {
      beratAktual = dispensingSesi(targetSesi);
      sisaWadah = 0;
    }

    totalTerkirim += beratAktual;
    beratSaatIni = 0;

    float sisaKebutuhanUpdate = totalKebutuhan - totalTerkirim;
    Serial.print("\nTotal Terkirim: "); Serial.print(totalTerkirim, 2); Serial.println(" gram");
    Serial.print("Sisa Kebutuhan: "); Serial.print(sisaKebutuhanUpdate, 2); Serial.println(" gram");

    if (sisaKebutuhanUpdate > 0) {
      kosongkanWadah(true);
      sisaWadah = 0;
      delay(300);
      bacaUltrasonikStabil();

      if (statusPakan == "HABIS") {
        Serial.println("\n!!! PAKAN HABIS setelah wadah dikosongkan - sesi berikutnya DIBATALKAN, gate TIDAK dibuka lagi !!!");
        lcd.clear();
        lcdPrint(0, 0, lcdPad("!!! PAKAN HABIS !!!", 20));
        lcdPrint(0, 1, lcdPad("Proses dihentikan!", 20));
        char info[21];
        sprintf(info, "Terkirim: %.0f/%.0f g", totalTerkirim, totalKebutuhan);
        lcdPrint(0, 2, lcdPad(String(info), 20));
        lcdPrint(0, 3, lcdPad("Isi ulang pakan!", 20));
        delay(4000);
        lastEventType = "tidak_selesai";
        break;
      }

      nomorSesi++;
    }
  }

  Serial.println("\nMendorong sisa pakan sesi terakhir...");
  lcd.clear();
  lcdPrint(0, 0, lcdPad("=== SELESAI ===", 20));
  lcdPrint(0, 1, lcdPad("Mendorong sisa pakan", 20));
  lcdPrint(0, 2, lcdPad("ke wadah ayam...", 20));
  kosongkanWadah(false);

  Serial.println("\n=================================");
  Serial.println("SEMUA SESI SELESAI");
  Serial.print("Total Terkirim : "); Serial.print(totalTerkirim, 2); Serial.println(" gram");
  Serial.print("Selisih        : "); Serial.print(abs(totalKebutuhan - totalTerkirim), 2); Serial.println(" gram");

  String modePakanLog = modePakan;
  String waktuPakan = waktuPakanAktif;
  if (waktuPakan == "") {
    waktuPakan = formatDateTimeISO(rtc.now());
  }

  Serial.println("\n===== RINGKASAN LOG (LOKAL) =====");
  Serial.print("Mode pakan       : "); Serial.println(modePakanLog);
  Serial.print("Waktu pakan      : "); Serial.println(waktuPakan);
  Serial.print("Jenis pakan      : "); Serial.println(getNamaPakan(jenisPakan));
  Serial.print("Total target     : "); Serial.print(totalKebutuhan, 2); Serial.println(" gram");
  Serial.print("Total terkirim   : "); Serial.print(totalTerkirim, 2); Serial.println(" gram");
  Serial.print("Status stok      : "); Serial.println(statusPakan);
  Serial.println("===================================");

#ifdef MODE_ONLINE
  // Simpan data terakhir untuk pengiriman berkala
  lastTargetGram = totalKebutuhan;
  lastAktualGram = totalTerkirim;
  lastOutGram = abs(totalKebutuhan - totalTerkirim);
  lastWaktuPakan = waktuPakan;
  lastJenisPakan = getNamaPakan(jenisPakan);

  sendEventData();
  lastSendTime = millis();   // reset timer heartbeat
#endif

  waktuPakanAktif = "";

  lcd.clear();
  char ring1[21], ring2[21];
  lcdPrint(0, 0, lcdPad("=== SELESAI ===", 20));
  sprintf(ring1, "Dikirim: %.0f g", totalTerkirim);
  lcdPrint(0, 1, lcdPad(String(ring1), 20));
  sprintf(ring2, "Target : %.0f g", totalKebutuhan);
  lcdPrint(0, 2, lcdPad(String(ring2), 20));
  sprintf(ring1, "Selisih: %.1f g", abs(totalKebutuhan - totalTerkirim));
  lcdPrint(0, 3, lcdPad(String(ring1), 20));
  delay(3000);

  modePakan = "auto";
  sedangDispensing = false;
  menuState = MENU_HOME;
  lcd.clear();
}

// ======================================================
// CEK JADWAL
// ======================================================
void cekJadwal() {
  DateTime now = rtc.now();
  int jamNow = now.hour();
  int mntNow = now.minute();

  if (jamNow == 0 && mntNow == 0) {
    bool adaReset = false;
    for (int i = 0; i < 4; i++) {
      if (sudahJalan[i]) {
        sudahJalan[i] = false;
        adaReset = true;
      }
    }
    if (adaReset) {
      Serial.println("[JADWAL] Reset harian sudahJalan (00:00)");
    }
    return;
  }

  if (sedangDispensing) return;
  if (menuState != MENU_HOME && menuState != MENU_DATA) return;

  for (int i = 0; i < waktuPemberian; i++) {
    if (sudahJalan[i]) continue;

    if (jamNow == jadwalPakan[i].jam && mntNow == jadwalPakan[i].menit) {
      Serial.print("\nJADWAL KE-"); Serial.print(i + 1); Serial.println(" AKTIF!");
      sudahJalan[i] = true;
      modePakan = "auto";
      waktuPakanAktif = formatDateTimeISO(now);
      prosesPemberianPakan();
      break;
    }
  }
}

void tampilHome() {
  DateTime now = rtc.now();
  char jamStr[16];
  sprintf(jamStr, "%02d:%02d:%02d", now.hour(), now.minute(), now.second());
  lcdPrint(0, 0, lcdPad("Waktu: " + String(jamStr) + " [" + String(sumberSettingTerakhir) + "]", 20));
  lcdUpdateWifiIcon();  // [BARU v4.13] ikon WiFi pojok kanan-atas, ditulis setelah baris Waktu supaya tidak ketiban lcdPad
  lcdPrint(0, 1, lcdPad("Stok : " + statusPakan, 20));
  lcdPrint(0, 2, lcdPad("A:Setting  B:Data", 20));
  lcdPrint(0, 3, lcdPad("C:Manual", 20));
}

// ======================================================
// TAMPILAN DATA
// ======================================================
void tampilData() {
  static int dataPage = 0;
  static unsigned long lastDataSwitch = 0;
  const unsigned long DATA_PAGE_INTERVAL = 2500;

  if (millis() - lastDataSwitch >= DATA_PAGE_INTERVAL) {
    lastDataSwitch = millis();
    dataPage = (dataPage + 1) % 2;
  }

  lcdPrint(0, 0, lcdPad("=== DATA SISTEM ===", 20));

  char b1[21], b2[21];

  if (dataPage == 0) {
    sprintf(b1, "Ayam:%-3d Brt:%.0fg/ekr", jumlahAyam, pakanPerAyam);
    String namaPakan = getNamaPakan(jenisPakan);
    namaPakan.trim();
    sprintf(b2, "Pakan:%-6s Freq:%dx", namaPakan.c_str(), waktuPemberian);
  }
  else {
    char j1[8], j2[8], j3[8], j4[8];
    if (waktuPemberian >= 1) sprintf(j1, "%02d:%02d", jadwalPakan[0].jam, jadwalPakan[0].menit); else strcpy(j1, "--:--");
    if (waktuPemberian >= 2) sprintf(j2, "%02d:%02d", jadwalPakan[1].jam, jadwalPakan[1].menit); else strcpy(j2, "--:--");
    if (waktuPemberian >= 3) sprintf(j3, "%02d:%02d", jadwalPakan[2].jam, jadwalPakan[2].menit); else strcpy(j3, "--:--");
    if (waktuPemberian >= 4) sprintf(j4, "%02d:%02d", jadwalPakan[3].jam, jadwalPakan[3].menit); else strcpy(j4, "--:--");
    sprintf(b1, "J1:%s  J2:%s", j1, j2);
    sprintf(b2, "J3:%s  J4:%s", j3, j4);
  }

  lcdPrint(0, 1, lcdPad(String(b1), 20));
  lcdPrint(0, 2, lcdPad(String(b2), 20));
  lcdPrint(0, 3, lcdPad("D:Back", 20));
}

void tampilSetting(String judul, String prompt, String nilai) {
  lcdPrint(0, 0, lcdPad("=== SETTING ===", 20));
  lcdPrint(0, 1, lcdPad(judul, 20));
  lcdPrint(0, 2, lcdPad(prompt + ": " + nilai + "_", 20));
  lcdPrint(0, 3, lcdPad("#:OK *:Hapus D:Batal", 20));
}

void tampilPilihPakan() {
  lcdPrint(0, 0, lcdPad("==== JENIS PAKAN ====", 20));
  String s1 = (tempJenisPakan == 1) ? ">1: pelet " : " 1: pelet ";
  String s2 = (tempJenisPakan == 2) ? ">2: jagung" : " 2: jagung";
  String s3 = (tempJenisPakan == 3) ? ">3: mix   " : " 3: mix   ";
  lcdPrint(0, 1, lcdPad(s1, 20));
  lcdPrint(0, 2, lcdPad(s2, 20));
  lcdPrint(0, 3, lcdPad(s3 + " #OK D:Btl", 20));
}

void tampilFrekuensi() {
  lcdPrint(0,0,lcdPad("=== FREKUENSI ===",20));
  lcdPrint(0,1,lcdPad("Jumlah Pemberian",20));
  String teks = String(tempWaktuPemberian) + " Kali / Hari";
  lcdPrint(0,2,lcdPad(teks,20));
  lcdPrint(0,3,lcdPad("1-4  #:OK D:Back",20));
}

void tampilConfirm() {
  static int confirmPage = 0;
  static unsigned long lastConfirmSwitch = 0;
  const unsigned long CONFIRM_PAGE_INTERVAL = 2000;

  if (millis() - lastConfirmSwitch >= CONFIRM_PAGE_INTERVAL) {
    lastConfirmSwitch = millis();
    confirmPage = (confirmPage + 1) % 2;
  }

  char b1[21], b2[21];

  lcdPrint(0, 0, lcdPad("--Simpan Setting?--", 20));

  if (confirmPage == 0) {
    sprintf(b1, "Ayam:%-2d  Brt:%.0fg/ekr", tempJumlahAyam, tempPakanPerAyam);
    sprintf(b2, "Pakan:%-6s Freq:%dx", getNamaPakan(tempJenisPakan).c_str(), tempWaktuPemberian);
  } else {
    char j1[8], j2[8], j3[8], j4[8];
    if (tempWaktuPemberian >= 1) sprintf(j1, "%02d:%02d", tempJam1, tempMenit1); else strcpy(j1, "--:--");
    if (tempWaktuPemberian >= 2) sprintf(j2, "%02d:%02d", tempJam2, tempMenit2); else strcpy(j2, "--:--");
    if (tempWaktuPemberian >= 3) sprintf(j3, "%02d:%02d", tempJam3, tempMenit3); else strcpy(j3, "--:--");
    if (tempWaktuPemberian >= 4) sprintf(j4, "%02d:%02d", tempJam4, tempMenit4); else strcpy(j4, "--:--");
    sprintf(b1, "J1:%s  J2:%s", j1, j2);
    sprintf(b2, "J3:%s  J4:%s", j3, j4);
  }

  lcdPrint(0, 1, lcdPad(String(b1), 20));
  lcdPrint(0, 2, lcdPad(String(b2), 20));
  lcdPrint(0, 3, lcdPad("A:OK        D:Batal", 20));
}

void tampilManualConfirm() {
  char b1[21];
  sprintf(b1, "Target: %.0fg", (float)jumlahAyam * pakanPerAyam);
  lcdPrint(0, 0, lcdPad("=== MODE MANUAL ===", 20));
  lcdPrint(0, 1, lcdPad(String(b1), 20));
  lcdPrint(0, 2, lcdPad("A:Mulai  D:Batal", 20));
  lcdPrint(0, 3, lcdPad("", 20));
}

#ifdef MODE_ONLINE
// ======================================================
// LCD — KONFIRMASI & MODE PROVISIONING WIFI
// ======================================================
void tampilConfirmProv() {
  lcdPrint(0, 0, lcdPad("=== WIFI ===", 20));
  lcdPrint(0, 1, lcdPad("Masuk Provisioning?", 20));
  lcdPrint(0, 2, lcdPad("[#]=Ya   [*]=Batal", 20));
  //lcdPrint(0, 3, lcdPad("Tombol lain = batal", 20));
}

void updateLCDProvisioning() {
  lcdPrint(0, 0, lcdPad("MODE PROVISIONING", 20));
  lcdPrint(0, 1, lcdPad("Hubungkan via App", 20));
  lcdPrint(0, 2, lcdPad("", 20));
  lcdPrint(0, 3, lcdPad("", 20));
}
#endif

// ======================================================
// PROSES KEYPAD
// ======================================================
void prosesKeypad(char key) {
  if (sedangDispensing) return;
#ifdef MODE_ONLINE
  if (provisioningMode) return;  // abaikan keypad selama AP provisioning aktif
#endif

  switch (menuState) {
    case MENU_HOME:
      if (key == 'A') {
        tempJumlahAyam = jumlahAyam;
        tempPakanPerAyam = pakanPerAyam;
        tempJenisPakan = jenisPakan;
        tempWaktuPemberian = waktuPemberian;
        tempJam1 = jadwalPakan[0].jam;
        tempMenit1 = jadwalPakan[0].menit;
        tempJam2 = jadwalPakan[1].jam;
        tempMenit2 = jadwalPakan[1].menit;
        tempJam3 = jadwalPakan[2].jam;
        tempMenit3 = jadwalPakan[2].menit;
        tempJam4 = jadwalPakan[3].jam;
        tempMenit4 = jadwalPakan[3].menit;
        inputBuffer = ""; menuState = MENU_SETTING_AYAM; lcdClear();
      }
      else if (key == 'B') { menuState = MENU_DATA; lcdClear(); }
      else if (key == 'C') {
        // FIX v4.5: dulu di sini ada while(true){...} blocking.
        // Sekarang cukup pindah state, loop() tetap jalan normal
        // (WiFi/MQTT/jadwal tidak ikut freeze) selama user mikir.
        modePakan = "manual";
        Serial.println("\nMODE MANUAL dipilih via keypad C");
        menuState = MENU_MANUAL_CONFIRM;
        lcdClear();
      }
#ifdef MODE_ONLINE
      else if (key == 'D') {
        menuState = MENU_CONFIRM_PROV;
        confirmProvUntil = millis() + CONFIRM_PROV_TIMEOUT;
        lcdClear();
      }
#endif
      break;

    case MENU_MANUAL_CONFIRM:
      if (key == 'A') {
        waktuPakanAktif = formatDateTimeISO(rtc.now());
        lcdClear();
        prosesPemberianPakan();   // prosesPemberianPakan() sendiri yg reset menuState ke HOME
      } else if (key == 'D') {
        modePakan = "auto";
        Serial.println("Manual dibatalkan");
        menuState = MENU_HOME;
        lcdClear();
      }
      break;

#ifdef MODE_ONLINE
    case MENU_CONFIRM_PROV:
      if (key == '#') {
        menuState = MENU_HOME;
        startProvisioning();
      } else {
        // tombol apapun selain [#] = batal
        menuState = MENU_HOME;
        lcdClear();
      }
      break;
#endif

    case MENU_DATA:
      if (key == 'D') { menuState = MENU_HOME; lcdClear(); }
      break;

    case MENU_SETTING_AYAM:
      if (key >= '0' && key <= '9') { if (inputBuffer.length() < 4) inputBuffer += key; }
      else if (key == '*') { if (inputBuffer.length() > 0) inputBuffer.remove(inputBuffer.length()-1); }
      else if (key == '#') { if (inputBuffer.length() > 0) { tempJumlahAyam = inputBuffer.toInt(); inputBuffer = ""; menuState = MENU_SETTING_BERAT; lcdClear(); } }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    case MENU_SETTING_BERAT:
      if (key >= '0' && key <= '9') { if (inputBuffer.length() < 5) inputBuffer += key; }
      else if (key == '*') { if (inputBuffer.length() > 0) inputBuffer.remove(inputBuffer.length()-1); }
      else if (key == '#') { if (inputBuffer.length() > 0) { tempPakanPerAyam = inputBuffer.toFloat(); inputBuffer = ""; menuState = MENU_SETTING_PAKAN; lcdClear(); } }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    case MENU_SETTING_PAKAN:
      if (key == '1') { tempJenisPakan = 1; lcdClear(); }
      else if (key == '2') { tempJenisPakan = 2; lcdClear(); }
      else if (key == '3') { tempJenisPakan = 3; lcdClear(); }
      else if (key == '#') { menuState = MENU_SETTING_FREKUENSI; inputBuffer = ""; lcdClear(); }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    case MENU_SETTING_FREKUENSI:
      if (key >= '1' && key <= '4') { tempWaktuPemberian = key - '0'; lcdClear(); }
      else if (key == '#') { inputBuffer = ""; menuState = MENU_SETTING_WAKTU1; lcdClear(); }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    case MENU_SETTING_WAKTU1:
      if (key >= '0' && key <= '9') { if (inputBuffer.length() < 4) inputBuffer += key; }
      else if (key == '*') { if (inputBuffer.length() > 0) inputBuffer.remove(inputBuffer.length() - 1); }
      else if (key == '#') {
        if (inputBuffer.length() == 4) {
          int nilai = inputBuffer.toInt();
          int jam = nilai / 100;
          int menit = nilai % 100;
          if (jam >= 0 && jam <= 23 && menit >= 0 && menit <= 59) {
            tempJam1 = jam; tempMenit1 = menit; inputBuffer = "";
            if (tempWaktuPemberian == 1) menuState = MENU_SETTING_CONFIRM;
            else menuState = MENU_SETTING_WAKTU2;
            lcdClear();
          }
        }
      }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    case MENU_SETTING_WAKTU2:
      if (key >= '0' && key <= '9') { if (inputBuffer.length() < 4) inputBuffer += key; }
      else if (key == '*') { if (inputBuffer.length() > 0) inputBuffer.remove(inputBuffer.length() - 1); }
      else if (key == '#') {
        if (inputBuffer.length() == 4) {
          int nilai = inputBuffer.toInt();
          int jam = nilai / 100;
          int menit = nilai % 100;
          if (jam >= 0 && jam <= 23 && menit >= 0 && menit <= 59) {
            tempJam2 = jam; tempMenit2 = menit; inputBuffer = "";
            if (tempWaktuPemberian == 2) menuState = MENU_SETTING_CONFIRM;
            else menuState = MENU_SETTING_WAKTU3;
            lcdClear();
          }
        }
      }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    case MENU_SETTING_WAKTU3:
      if (key >= '0' && key <= '9') { if (inputBuffer.length() < 4) inputBuffer += key; }
      else if (key == '*') { if (inputBuffer.length() > 0) inputBuffer.remove(inputBuffer.length() - 1); }
      else if (key == '#') {
        if (inputBuffer.length() == 4) {
          int nilai = inputBuffer.toInt();
          int jam = nilai / 100;
          int menit = nilai % 100;
          if (jam >= 0 && jam <= 23 && menit >= 0 && menit <= 59) {
            tempJam3 = jam; tempMenit3 = menit; inputBuffer = "";
            if (tempWaktuPemberian == 3) menuState = MENU_SETTING_CONFIRM;
            else menuState = MENU_SETTING_WAKTU4;
            lcdClear();
          }
        }
      }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    case MENU_SETTING_WAKTU4:
      if (key >= '0' && key <= '9') { if (inputBuffer.length() < 4) inputBuffer += key; }
      else if (key == '*') { if (inputBuffer.length() > 0) inputBuffer.remove(inputBuffer.length() - 1); }
      else if (key == '#') {
        if (inputBuffer.length() == 4) {
          int nilai = inputBuffer.toInt();
          int jam = nilai / 100;
          int menit = nilai % 100;
          if (jam >= 0 && jam <= 23 && menit >= 0 && menit <= 59) {
            tempJam4 = jam; tempMenit4 = menit; inputBuffer = "";
            menuState = MENU_SETTING_CONFIRM;
            lcdClear();
          }
        }
      }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    case MENU_SETTING_CONFIRM:
      if (key == 'A') {
        jumlahAyam = tempJumlahAyam;
        pakanPerAyam = tempPakanPerAyam;
        waktuPemberian = tempWaktuPemberian;
        jenisPakan = tempJenisPakan;
        gateBuka = getGateBuka(jenisPakan);
        jadwalPakan[0].jam = tempJam1; jadwalPakan[0].menit = tempMenit1;
        jadwalPakan[1].jam = tempJam2; jadwalPakan[1].menit = tempMenit2;
        jadwalPakan[2].jam = tempJam3; jadwalPakan[2].menit = tempMenit3;
        jadwalPakan[3].jam = tempJam4; jadwalPakan[3].menit = tempMenit4;
        for (int i = 0; i < 4; i++) { sudahJalan[i] = false; }

        saveSettingPakan(formatDateTimeISO(rtc.now()), 'M');
#ifdef MODE_ONLINE
        sendSettingsReport();
#endif

        Serial.println("\nSetting Disimpan!");
        Serial.print("Jumlah Ayam  : "); Serial.println(jumlahAyam);
        Serial.print("Pakan/ekor   : "); Serial.print(pakanPerAyam); Serial.println(" gram");
        Serial.print("Jenis Pakan  : "); Serial.println(getNamaPakan(jenisPakan));
        lcdClear();
        lcdPrint(2, 1, "SETTING DISIMPAN");
        lcdPrint(4, 2, "BERHASIL!");
        delay(1500);
        menuState = MENU_HOME; lcdClear();
      }
      else if (key == 'D') { menuState = MENU_HOME; inputBuffer = ""; lcdClear(); }
      break;

    default: break;
  }
}

// ======================================================
// REFRESH LCD
// ======================================================
void refreshLCD() {
  switch (menuState) {
    case MENU_HOME:            tampilHome();          break;
    case MENU_DATA:             tampilData();          break;
    case MENU_DISPENSING:      updateLCDDispensing(); break;
    case MENU_SETTING_AYAM:    tampilSetting("Input Jumlah Ayam", "Ayam", inputBuffer); break;
    case MENU_SETTING_BERAT:   tampilSetting("Input Berat/Ekor", "Gram", inputBuffer); break;
    case MENU_SETTING_PAKAN:   tampilPilihPakan();    break;
    case MENU_SETTING_FREKUENSI: tampilFrekuensi();   break;
    case MENU_SETTING_WAKTU1:  tampilSetting("Waktu Pakan 1", "Jam", inputBuffer); break;
    case MENU_SETTING_WAKTU2:  tampilSetting("Waktu Pakan 2", "Jam", inputBuffer); break;
    case MENU_SETTING_WAKTU3:  tampilSetting("Waktu Pakan 3", "Jam", inputBuffer); break;
    case MENU_SETTING_WAKTU4:  tampilSetting("Waktu Pakan 4", "Jam", inputBuffer); break;
    case MENU_SETTING_CONFIRM: tampilConfirm();       break;
    case MENU_MANUAL_CONFIRM:  tampilManualConfirm(); break;
#ifdef MODE_ONLINE
    case MENU_CONFIRM_PROV:    tampilConfirmProv();   break;
#endif
    default: break;
  }
}

void inisialisasiSensor() {
  if (!rtc.begin()) {
    Serial.println("RTC tidak ditemukan!");
    lcdPrint(0, 2, lcdPad("RTC ERROR!", 20));
    while (1);
  }

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);

  servoGate.setPeriodHertz(50);
  servoGate.attach(SERVO_GATE_PIN, 500, 2400);
  servoGate.write(GATE_TUTUP);
  delay(800);
  servoGate.detach();
  pinMode(SERVO_GATE_PIN, OUTPUT);
  digitalWrite(SERVO_GATE_PIN, LOW);

  servo360.setPeriodHertz(50);
  servo360.attach(SERVO_DORONG_PIN, 500, 2400);
  servo360.write(STOP_SERVO);
  delay(500);
  servo360.detach();
  pinMode(SERVO_DORONG_PIN, OUTPUT);
  digitalWrite(SERVO_DORONG_PIN, LOW);
  loadSettingPakan();

  gateBuka = getGateBuka(jenisPakan);

  LoadCell.begin();
  LoadCell.start(2000);
  LoadCell.tare();
  LoadCell.setCalFactor(calibrationValue);

  keypad.begin();
}

// ======================================================
// SETUP
// ======================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Wire.begin(8, 9);

  lcd.init();
  lcd.backlight();
  lcdSetupWifiIcon();
  lcdPrint(0, 0, lcdPad("SMART FEEDER", 20));
  lcdPrint(0, 1, lcdPad("Inisialisasi...", 20));

#ifdef MODE_ONLINE
  if (!LittleFS.begin(true)) {
    Serial.println("[LittleFS] Gagal mount! Buffer offline tidak akan berfungsi.");
  } else {
    Serial.println("[LittleFS] Mount OK, siap dipakai untuk buffer offline");
  }

  // Nama AP dinamis: "pakan-<codeName>-<codeNumber>", mis. "pakan-NJYF1-1"
  serviceName  = "pakan-" + String(codeName) + "-" + String(codeNumber);
  mqttClientId = "esp32-feeder-" + String(codeName) + "-" + String(codeNumber);
  // [BARU v4.9] Topic subscribe setting dari server: "feeder/settings/<codename>/#"
  mqttSettingsTopic = "feeder/settings/" + String(codeName) + "/#";

  WiFi.onEvent(SysProvEvent);

  lcdPrint(0, 2, lcdPad("Cek WiFi tersimpan...", 20));
  connectSavedWifiOrProvision();   // blocking cuma di boot (wajar), setelah ini semua non-blocking
  inisialisasiSensor();

  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setCallback(mqttCallback);   // [BARU v4.9] terima setting dari server

  if (!provisioningMode) {
    lcdPrint(0, 2, lcdPad(WiFi.status() == WL_CONNECTED ? "WiFi OK" : "WiFi gagal, retry bg", 20));
  }
  lastSendTime = millis();
  delay(1500);
#else
  lcdPrint(0, 2, lcdPad("Mode Tryout", 20));

  inisialisasiSensor();

  delay(2000);
#endif

  lcdClear();

  Serial.println("\n=================================");
  Serial.println("SMART FEEDER SIAP - v4.10 (fix LWW timestamp)");
#ifdef MODE_ONLINE
  Serial.println("Mode: ONLINE - Event-driven + Heartbeat berkala");
  Serial.println("Buffer offline: LittleFS (/buffer.log), cap 24 jam");
  Serial.println("(BARU v4.9: subscribe setting dari server aktif)");
  Serial.print("MQTT Broker : "); Serial.print(MQTT_BROKER);
  Serial.print(":"); Serial.println(MQTT_PORT);
  Serial.print("MQTT Topic  : "); Serial.println(MQTT_TOPIC);
  Serial.print("Sub Settings: "); Serial.println(mqttSettingsTopic);
  Serial.print("Client ID   : "); Serial.println(mqttClientId);
  Serial.print("AP Provision: "); Serial.println(serviceName);
#else
  Serial.println("Mode: OFFLINE (Tryout)");
#endif
  DateTime now = rtc.now();
  Serial.printf("Waktu WIB: %02d/%02d/%04d %02d:%02d:%02d\n",
    now.day(), now.month(), now.year(), now.hour(), now.minute(), now.second());
  Serial.print("Jumlah Ayam  : "); Serial.println(jumlahAyam);
  Serial.print("Pakan/ekor   : "); Serial.print(pakanPerAyam); Serial.println(" gram");
  Serial.print("Jenis Pakan  : "); Serial.println(getNamaPakan(jenisPakan));
  Serial.printf("Jadwal 1     : %02d:%02d WIB\n", jadwalPakan[0].jam, jadwalPakan[0].menit);
  Serial.printf("Jadwal 2     : %02d:%02d WIB\n", jadwalPakan[1].jam, jadwalPakan[1].menit);
  Serial.println("=================================");
}

// ======================================================
// LOOP
// ======================================================
void loop() {
#ifdef MODE_ONLINE
  // WiFi & NTP: non-blocking, aman dipanggil tiap iterasi
  handleWifiState();
  checkNtpSync();

  // Auto-batal konfirmasi provisioning kalau timeout
  if (menuState == MENU_CONFIRM_PROV && millis() > confirmProvUntil) {
    menuState = MENU_HOME;
    lcdClear();
  }

  // MQTT — cuma jalan kalau WiFi connect & bukan provisioning
  if (wifiConnected && !provisioningMode) {
    mqttReconnect();
    mqtt.loop();
    bool mqttNowConnected = mqtt.connected();
    if (mqttNowConnected && !wasMqttConnected) {
      flushBufferedData();   // kalau buffer kosong, fungsi ini langsung selesai tanpa efek apa-apa
      if (pendingSettingsReport) {
        sendSettingsReport();
      }
      lastSendTime = millis();
    }
    wasMqttConnected = mqttNowConnected;

    // [v4.9] Heartbeat berkala (SEND_INTERVAL_MS) — otomatis dilewati (bukan dibuffer)
    // kalau pas jadwal ini MQTT sedang tidak connected.
    if (millis() - lastSendTime >= SEND_INTERVAL_MS) {
      lastSendTime = millis();
      sendHeartbeat();
    }
  } else {
    wasMqttConnected = false;
  }
#endif

  char key = keypad.getKey();
  if (key != NO_KEY && !sedangDispensing) {
    Serial.print("Key: "); Serial.println(key);
    prosesKeypad(key);
#ifdef MODE_ONLINE
    if (!provisioningMode) {
      lcdClear();
      refreshLCD();
    }
#else
    lcdClear();
    refreshLCD();
#endif
  }

  if (millis() - lastLCDRefresh >= LCD_INTERVAL) {
    lastLCDRefresh = millis();
    if (!sedangDispensing) bacaUltrasonik();
#ifdef MODE_ONLINE
    if (!provisioningMode) refreshLCD();
#else
    refreshLCD();
#endif
  }

  cekJadwal();
  delay(20);
}
