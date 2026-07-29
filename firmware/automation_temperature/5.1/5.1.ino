/**************
 * automatic temperature control - v5.1
 * component: SHT30 + LCD 20x4 I2c + Keypad I2C (PCF8574) + Dimmer robodyn + ZMCT103c + SSR fotek
 * feature stack: WiFi SoftAP Provisioning (manual via keypad) + MQTT Settings
 * board: ESP32-S3 N16R8
 *
 * === IDENTITAS DEVICE ===
 * Ganti CODENAME dan CODENUMBER sesuai device
 *
 * === PIN MAPPING ===
 *   SDA        → GPIO 8
 *   SCL        → GPIO 9
 *   ZC         → GPIO 41  (1 dimmer)
 *   PSM        → GPIO 6
 *   ZMCTC      → GPIO 2   (ADC1)
 *   SSR        → GPIO 45
 *   LED_BUILTIN→ GPIO 48
 *
 * === PID VALUES PER KANDANG ===
 * (default): Kp=80.0, Ki=0.6, Kd=0.5
 *
 * === PROVISIONING ===
 * - PoP (PIN)     : lihat variabel `pop`
 * - Nama AP       : "suhu-<CODENAME>-<CODENUMBER>" (unik per device)
 * - App           : ESP SoftAP Provisioning (Android/iOS)
 * - Trigger awal  : otomatis, HANYA kalau NVS WiFi kosong
 * - Trigger ulang : keypad [C] lalu konfirmasi [#] (manual, kapan saja)
 *
 * === CATATAN UPLOAD (Arduino IDE) ===
 * Library yang wajib di-install via Library Manager:
 *  - "Adafruit SHT31"      oleh Adafruit
 * - "LiquidCrystal_I2C"   oleh Frank de Brabander
 * - "Keypad_I2C"          oleh joeyoung (atau "Keypad" + soft I2C)
 * - "RBDdimmer"            oleh Robojax
 * - "PubSubClient"         oleh Nick O'Leary
 * - "ArduinoJson"           oleh Benoit Blanchon
 * - "WiFiProv"              (bawaan ESP32, tidak perlu install)
 * - "LittleFS"               (bawaan ESP32, tidak perlu install)
 * Opsi penting di Tools:
 * - USB CDC On Boot    → Enable (WAJIB untuk ESP32-S3 native USB)
 *  (kalau tidak di-enable, Serial monitor tidak akan muncul)
 * - USB Mode           → "Hardware CDC and JTAG" (default aman)
 * - Flash Size         → Sesuaikan dengan board (min. 4MB)
 * - Partition Scheme   → "Default 4MB with spiffs"
 *                          atau "Minimal SPIFFS" jika butuh ruang
 **************/

#include <WiFi.h>
#include <WiFiProv.h>
#include <esp_wifi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Keypad_I2C.h>
#include <Keypad.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_SHT31.h>
#include <Preferences.h>
#include <RBDdimmer.h>
#include <time.h>           // NTP

// =====================
// IDENTITAS DEVICE
// Ganti dua baris ini per MCU
// =====================
const char* CODENAME   = "";
const char* CODENUMBER = "";

// =====================
// MQTT
// =====================
const char* MQTT_BROKER   = "your-ip-or-domain";  // contoh: "
const int   MQTT_PORT     = 1883;
const char* MQTT_USER     = "your-mqtt-username";
const char* MQTT_PASSWORD = "your-mqtt-password";
const char* MQTT_TOPIC    = "suhu/rawlog";       // topic publish (data suhu)
String mqttClientId;
String mqttSettingsTopic;                        // topic subscribe (settings dari server)

// =====================
// NTP — WIB UTC+7
// =====================
const char* NTP_SERVER = "pool.ntp.org";
const long  GMT_OFFSET = 7 * 3600;   // UTC+7
const int   DST_OFFSET = 0;

// =====================
// I2C PIN
// =====================
#define SDA_PIN 8
#define SCL_PIN 9

// =====================
// DIMMER PIN (1 dimmer)
// =====================
#define PSM_PIN 6
#define ZC_PIN  41

// =====================
// ZMCTC + SSR
// =====================
#define ZMCTC_PIN        2
#define SSR_PIN          45
#define POWER_THRESHOLD  50

const int   SAMPLES            = 500;
const int   SAMPLING_DELAY_US  = 100;
const float CURRENT_THRESHOLD  = 0.30;
const float HYSTERESIS         = 0.05;
const float VREF               = 3.3;
const int   ADC_RESOLUTION     = 4095;
const float ADC_VOLTAGE_PER_STEP = VREF / ADC_RESOLUTION;
const float SENSITIVITY        = 0.185;

float current_rms_filtered = 0.0;
const float ALPHA = 0.2;
bool ssrState = false;

float zmctcSamples[SAMPLES];

// =====================
// PID SETTING — DIVONIS DEVELOPER
// =====================
const float Kp = 80.0;
const float Ki = 0.6;
const float Kd = 0.5;

// =====================
// PID VARIABLE
// =====================
float lastError   = 0;
float integral    = 0;
unsigned long lastPIDTime = 0;
int pidOutput = 0;
bool autoMode = true;

// =====================
// LIMIT + SETPOINT
// =====================
float limitLow  = 32.0;
float limitHigh = 35.0;
float setpoint  = 33.5;

String currentMode = "default";  // "default" | "manual" | "server"

// =====================
// LCD 20x4
// =====================
LiquidCrystal_I2C lcd(0x27, 20, 4);

// Custom char 0: titik solid — indikator ONLINE
byte dotChar[8] = {
  0b00000,
  0b01110,
  0b11111,
  0b11111,
  0b11111,
  0b01110,
  0b00000,
  0b00000
};

// Custom char 1: steker — indikator SSR CADANGAN aktif
byte plugChar[8] = {
  0b01010,
  0b01010,
  0b11111,
  0b10001,
  0b10001,
  0b11111,
  0b00100,
  0b00100
};

// =====================
// SHT30
// =====================
Adafruit_SHT31 sht31 = Adafruit_SHT31();

// =====================
// KEYPAD via PCF8574 (0x20)
// =====================
const byte ROWS = 4;
const byte COLS = 4;

char keys[ROWS][COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};

byte rowPins[ROWS] = {0, 1, 2, 3};
byte colPins[COLS] = {4, 5, 6, 7};

Keypad_I2C keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS, 0x20, PCF8574, &Wire);

// =====================
// DIMMER (1 unit)
// =====================
dimmerLamp dimmer(PSM_PIN, ZC_PIN);

// =====================
// PREFERENCES (NVS)
// =====================
Preferences prefs;
Preferences preferences;   // khusus kredensial WiFi

void saveData() {
  prefs.begin("pid_cfg", false);
  prefs.putFloat("low",  limitLow);
  prefs.putFloat("high", limitHigh);
  prefs.putFloat("sp",   setpoint);
  prefs.putString("mode", currentMode);
  prefs.end();
}

void loadData() {
  prefs.begin("pid_cfg", true);
  float low = prefs.getFloat("low", -1.0);

  if (low < 0 || low >= 100) {
    prefs.end();
    currentMode = "default";
    return;
  }

  limitLow    = low;
  limitHigh   = prefs.getFloat("high", 34.0);
  setpoint    = prefs.getFloat("sp",   31.0);
  currentMode = prefs.getString("mode", "default");
  prefs.end();
}

float computeSetpoint(float low, float high) {
  return (low + high) / 2.0;
}

// =====================
// KEYPAD INPUT STATE
// =====================
String inputBuf = "";
enum KeyMode { RUN, SET_LOW, SET_HIGH, CONFIRM_PROV };
KeyMode keyMode = RUN;

unsigned long confirmProvUntil = 0;
const unsigned long CONFIRM_PROV_TIMEOUT = 5000; // 5 detik utk konfirmasi

float lastSuhu = 0;   // suhu terakhir yang terbaca, dipakai utk refresh LCD

// =====================
// MQTT CLIENT
// =====================
WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);

unsigned long lastSend      = 0;
unsigned long lastReconnect = 0;

// =====================
// MQTT CALLBACK — TERIMA SETTINGS DARI SERVER
// Payload contoh:
// {"codename":"","codenumber":"1","suhu_min":32.0,
//  "suhu_max":34.0,"target":33.0,"timestamp":"..."}
// =====================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.print(">> Gagal parse JSON settings: ");
    Serial.println(err.c_str());
    return;
  }

  const char* codenumber = doc["codenumber"];
  if (!codenumber || String(codenumber) != String(CODENUMBER)) {
    return; // bukan untuk device ini, abaikan
  }

  float suhu_min    = doc["suhu_min"]    | limitLow;
  float suhu_max    = doc["suhu_max"]    | limitHigh;
  float suhu_target = doc["target"]      | setpoint;

  if (suhu_min <= 0 || suhu_max <= 0 || suhu_min >= suhu_max) {
    Serial.println(">> Settings dari server tidak valid, diabaikan");
    return;
  }

  limitLow    = suhu_min;
  limitHigh   = suhu_max;
  setpoint    = suhu_target;
  currentMode = "server";

  integral  = 0;
  lastError = 0;

  saveData();

  Serial.println(">> Settings baru dari server diterapkan");
}

// =====================
// WIFI PROVISIONING
// =====================
const char* pop          = "your-pin";           // PIN (PoP) provisioning
const char* service_key  = NULL;              // NULL = AP open (tanpa password)
String serviceName;                           // diisi di setup(): suhu-<CODENAME>-<CODENUMBER>

bool provisioningMode   = false;
bool wifiConnected      = false;
bool ntpSynced          = false;

unsigned long lastWifiRetry = 0;
const unsigned long WIFI_RETRY_INTERVAL = 15000; // coba reconnect senyap tiap 15 detik

#define LED_BUILTIN 48

// =====================
// EVENT HANDLER PROVISIONING
// =====================
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
      wifiConnected     = true;
      provisioningMode  = false;

      wifi_config_t wifi_config;
      esp_wifi_get_config(WIFI_IF_STA, &wifi_config);
      preferences.begin("wifi", false);
      preferences.putString("ssid",     (char*)wifi_config.sta.ssid);
      preferences.putString("password", (char*)wifi_config.sta.password);
      preferences.end();

      configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);

      digitalWrite(LED_BUILTIN, HIGH);
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

// Provisioning HANYA dipicu: 
// (1) belum ada kredensial sama sekali
// (2) saat user tekan [C] lalu konfirmasi [#] di keypad.
// SELALU menghapus kredensial lama (reset=true)
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
    true   // selalu reset — provisioning manual = minta kredensial baru, hapus lama
  );
}

// Dipanggil sekali di setup(). Kalau belum ada kredensial tersimpan
// sama sekali -> wajib provisioning. Kalau sudah ada -> coba connect,
// dan APAPUN hasilnya, TIDAK PERNAH otomatis masuk provisioning lagi
// setelah baris ini (biar handleWifiState() yang retry senyap terus).
void connectSavedWifiOrProvision() {
  preferences.begin("wifi", true);
  String savedSsid = preferences.getString("ssid", "");
  String savedPass = preferences.getString("password", "");
  preferences.end();

  if (savedSsid.length() == 0) {
    startProvisioning();   // belum pernah provisioning sama sekali
    return;
  }

  WiFi.begin(savedSsid.c_str(), savedPass.c_str());
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    attempts++;
  }
  // Kalau gagal connect di sini, biarkan saja — handleWifiState()
  // di loop() akan terus mencoba lagi tiap WIFI_RETRY_INTERVAL,
  // tanpa menghapus kredensial atau membuka provisioning.
}

// Dipanggil tiap loop(). Menjaga koneksi WiFi tanpa PERNAH mereset
// kredensial atau masuk provisioning dengan sendirinya.
void handleWifiState() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  wifiConnected = false;
  ntpSynced     = false;

  if (provisioningMode) {
    static unsigned long lastBlink = 0;
    if (millis() - lastBlink > 1000) {
      lastBlink = millis();
      digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
    }
    return;
  }

  // Retry senyap pakai kredensial tersimpan — device tetap jalan
  // normal (PID/LCD/keypad) selama menunggu WiFi kembali.
  if (millis() - lastWifiRetry > WIFI_RETRY_INTERVAL) {
    lastWifiRetry = millis();
    preferences.begin("wifi", true);
    String savedSsid = preferences.getString("ssid", "");
    String savedPass = preferences.getString("password", "");
    preferences.end();
    if (savedSsid.length() > 0) {
      WiFi.begin(savedSsid.c_str(), savedPass.c_str());
    }
  }
}

void checkNtpSync() {
  if (!wifiConnected || ntpSynced) return;
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 10)) {
    ntpSynced = true;
  }
}

// =====================
// NTP — TIMESTAMP ISO 8601
// =====================
String getTimestamp() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 10)) {
    return "1970-01-01T00:00:00.000Z";
  }
  char buf[30];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S.000+07:00", &timeinfo);
  return String(buf);
}

// =====================
// PID FUNCTION
// =====================
int computePID(float currentTemp) {
  unsigned long now = millis();
  float dt = (now - lastPIDTime) / 1000.0; // Mengukur waktu yang berlalu sejak perhitungan PID terakhir
  if (dt < 0.1) return pidOutput;
  lastPIDTime = now;

  float error = setpoint - currentTemp; // Jika error positif: suhu terlalu rendah → perlu pemanasan, Jika error negatif: suhu terlalu tinggi → perlu pendinginan
  integral += error * dt; // Mengakumulasi error dari waktu ke waktu (untuk menghilangkan offset steady-state)
  integral = constrain(integral, -50.0, 50.0); // Constrain membatasi nilai integral antara -50 dan 50 untuk mencegah integral windup (akumulasi berlebihan)
  float derivative = (error - lastError) / dt; // Menghitung laju perubahan error (turunan)
  lastError = error;

  float output = (Kp * error) + (Ki * integral) + (Kd * derivative); // output PID dihitung sebagai kombinasi dari proporsional, integral, dan turunan
  return (int)constrain(output, 0, 99); // batas 00 - 99 untuk mencegah kehilangan kemampuan untuk responsif terhadap perubahan
}

// =====================
// ZMCTC — BACA RMS
// =====================
float readCurrentRMS() {
  float sumSquared = 0;

  for (int i = 0; i < SAMPLES; i++) {
    zmctcSamples[i] = analogRead(ZMCTC_PIN) * ADC_VOLTAGE_PER_STEP;
    delayMicroseconds(SAMPLING_DELAY_US);
  }

  float dcOffset = 0;
  for (int i = 0; i < SAMPLES; i++) dcOffset += zmctcSamples[i];
  dcOffset /= SAMPLES;

  for (int i = 0; i < SAMPLES; i++) {
    float ac = zmctcSamples[i] - dcOffset;
    sumSquared += ac * ac;
  }

  float current = sqrt(sumSquared / SAMPLES) / SENSITIVITY;
  if (isnan(current) || current < 0) return 0;
  return current;
}

bool detectCurrent(float current) {
  static bool state = false;
  if (!state) {
    if (current > (CURRENT_THRESHOLD + HYSTERESIS)) state = true;
  } else {
    if (current < (CURRENT_THRESHOLD - HYSTERESIS)) state = false;
  }
  return state;
}

String getPowerStatus(bool hasCurrent) {
  if (pidOutput < POWER_THRESHOLD) return "safe";
  return hasCurrent ? "safe" : "error";
}

void controlBackupLamp(bool hasCurrent) {
  bool newState;
  if (pidOutput < POWER_THRESHOLD) {
    newState = false;
  } else {
    newState = !hasCurrent;   // true = PLN padam, cadangan nyala
  }

  if (newState != ssrState) {
    ssrState = newState;
    digitalWrite(SSR_PIN, ssrState ? HIGH : LOW);
  }
}

// =====================
// MQTT
// =====================
void mqttReconnect() {
  if (mqtt.connected()) return;
  if (millis() - lastReconnect < 5000) return;
  lastReconnect = millis();

  if (mqtt.connect(mqttClientId.c_str(), MQTT_USER, MQTT_PASSWORD)) {
    mqtt.subscribe(mqttSettingsTopic.c_str());
    Serial.print(">> MQTT connected, subscribe: ");
    Serial.println(mqttSettingsTopic);
  } else {
    Serial.print(">> MQTT gagal, rc=");
    Serial.println(mqtt.state());
  }
}

void sendToMQTT(float suhu, bool hasCurrent) {
  if (!mqtt.connected()) return;

  String powerStatus = getPowerStatus(hasCurrent);
  String timestamp   = getTimestamp();
  int    rssi        = WiFi.RSSI();

  String json = "{";
  json += "\"codename\":\""      + String(CODENAME)        + "\",";
  json += "\"action\":\"suhu\",";
  json += "\"codenumber\":\""    + String(CODENUMBER)      + "\",";
  json += "\"temperature\":"     + String(suhu, 1)         + ",";
  json += "\"limit_low_temp\":"  + String(limitLow, 1)     + ",";
  json += "\"limit_high_temp\":" + String(limitHigh, 1)    + ",";
  json += "\"setpoint\":"        + String(setpoint, 1)     + ",";
  json += "\"type\":\"normal\",";
  json += "\"power\":"           + String(pidOutput)       + ",";
  json += "\"mode\":\""          + currentMode             + "\",";
  json += "\"power_status\":\""  + powerStatus             + "\",";
  json += "\"status\":\"online\",";
  json += "\"rssi\":"            + String(rssi)            + ",";
  json += "\"esp_millis\":"      + String(millis())        + ",";
  json += "\"created_at\":\""    + timestamp               + "\"";
  json += "}";

  if (!mqtt.publish(MQTT_TOPIC, json.c_str())) {
    Serial.println(">> MQTT publish gagal");
  }
}

// =====================
// KEYPAD HANDLER
// =====================
void handleKeypad() {
  char key = keypad.getKey();
  if (!key) return;

  if (key == 'D') return;  // cadangan, belum dipakai

  // --- Konfirmasi masuk provisioning ---
  if (keyMode == CONFIRM_PROV) {
    if (key == '#') {
      keyMode = RUN;
      startProvisioning();
    } else {
      // tombol apapun selain [#] = batal
      keyMode = RUN;
      updateLCDRun(lastSuhu);
    }
    return;
  }

  if (keyMode == RUN) {
    if (key == 'A') {
      keyMode = SET_LOW;
      inputBuf = "";
      updateLCDInput();
    } else if (key == 'B') {
      keyMode = SET_HIGH;
      inputBuf = "";
      updateLCDInput();
    } else if (key == 'C' && !provisioningMode) {
      keyMode = CONFIRM_PROV;
      confirmProvUntil = millis() + CONFIRM_PROV_TIMEOUT;
      updateLCDConfirmProv();
    }
    return;
  }

  // --- Sedang input limit low/high ---
  if (key >= '0' && key <= '9') {
    if (inputBuf.length() < 5) inputBuf += key;
  } else if (key == '*') {
    if (inputBuf.indexOf('.') == -1) inputBuf += '.';
  } else if (key == '#') {
    float val = inputBuf.toFloat();
    bool valid = false;

    if (keyMode == SET_LOW) {
      if (val > 0 && val < limitHigh) {
        limitLow    = val;
        setpoint    = computeSetpoint(limitLow, limitHigh);
        currentMode = "manual";
        valid = true;
      }
    } else if (keyMode == SET_HIGH) {
      if (val > limitLow && val < 60) {
        limitHigh   = val;
        setpoint    = computeSetpoint(limitLow, limitHigh);
        currentMode = "manual";
        valid = true;
      }
    }

    if (valid) {
      saveData();
      integral  = 0;
      lastError = 0;
    }

    inputBuf = "";
    keyMode  = RUN;
    updateLCDRun(lastSuhu);
  } else if (key == 'A') {
    keyMode  = SET_LOW;
    inputBuf = "";
  } else if (key == 'B') {
    keyMode  = SET_HIGH;
    inputBuf = "";
  }

  if (keyMode == SET_LOW || keyMode == SET_HIGH) updateLCDInput();
}

// =====================
// LCD HELPER
// Cetak teks di kolom/baris tertentu, dipotong/di-pad ke `width`
// karakter supaya sisa teks lama di LCD ikut tertimpa (bersih).
// =====================
void lcdPrintAt(int col, int row, const String &text, int width) {
  String s = text;
  if ((int)s.length() > width) {
    s = s.substring(0, width);
  } else {
    while ((int)s.length() < width) s += ' ';
  }
  lcd.setCursor(col, row);
  lcd.print(s);
}

// =====================
// LCD — MODE RUN
// Baris 0: "T: xx.xC"                 [steker][online]
// Baris 1: "SP:xx.xC   yy.y - zz.z"
// Baris 2: "power:xx%"                [mode]
// Baris 3: "A=Lo"                     "B=Hi"
// =====================
unsigned long lastLCD = 0;

void updateLCDRun(float t) {
  if (millis() - lastLCD < 500) return;
  lastLCD = millis();

  if (keyMode != RUN) return;

  bool systemOnline = wifiConnected && ntpSynced && mqtt.connected();
  char tmp[16];
  char tmp2[16];

  // ---- Baris 0: suhu + icon steker + icon online ----
  snprintf(tmp, sizeof(tmp), "T: %4.1fC", t);
  lcdPrintAt(0, 0, tmp, 17);
  lcd.setCursor(17, 0);
  lcd.write(ssrState ? byte(1) : ' ');
  lcd.setCursor(18, 0);
  lcd.print(' ');
  lcd.setCursor(19, 0);
  lcd.write(systemOnline ? byte(0) : ' ');

  // ---- Baris 1: setpoint (kiri) + limit low-high (kanan) ----
  snprintf(tmp, sizeof(tmp), "SP:%4.1fC", setpoint);
  snprintf(tmp2, sizeof(tmp2), "%4.1f - %4.1f", limitLow, limitHigh);
  lcdPrintAt(0, 1, tmp, 9);
  lcdPrintAt(9, 1, tmp2, 11);

  // ---- Baris 2: power (kiri) + mode (kanan) ----
  snprintf(tmp, sizeof(tmp), "power:%3d%%", pidOutput);
  lcdPrintAt(0, 2, tmp, 17);
  snprintf(tmp2, sizeof(tmp2), "[%c]", currentMode[0]);
  lcdPrintAt(17, 2, tmp2, 3);

  // ---- Baris 3: panduan tombol ----
  lcdPrintAt(0, 3, "A=Lo", 16);
  lcdPrintAt(16, 3, "B=Hi", 4);
}

// =====================
// LCD — MODE INPUT (limit low/high)
// =====================
void updateLCDInput() {
  if (keyMode == SET_LOW) {
    lcdPrintAt(0, 1, "Set limit LOW :", 20);
  } else {
    lcdPrintAt(0, 1, "Set limit HIGH:", 20);
  }

  lcdPrintAt(0, 2, "> " + inputBuf + "_", 20);
  lcdPrintAt(0, 3, "[#]=OK  [*]=titik", 20);
}

// =====================
// LCD — KONFIRMASI PROVISIONING
// =====================
void updateLCDConfirmProv() {
  lcdPrintAt(0, 1, "Masuk Provisioning?", 20);
  lcdPrintAt(0, 2, "[#]=Ya   [*]=Batal", 20);
  lcdPrintAt(0, 3, "Tombol lain = batal", 20);
}

// =====================
// LCD — MODE PROVISIONING AKTIF
// =====================
void updateLCDProvisioning() {
  lcdPrintAt(0, 0, "MODE PROVISIONING", 20);
  lcdPrintAt(0, 1, "AP: " + serviceName, 20);
  lcdPrintAt(0, 2, "PIN:" + String(pop), 20);
  lcdPrintAt(0, 3, "Tunggu app HP...", 20);
}

// =====================
// SETUP
// =====================
void setup() {
  Serial.begin(115200);
  delay(300);

  serviceName       = "suhu-" + String(CODENAME) + "-" + String(CODENUMBER);
  mqttClientId      = "esp32s3-" + String(CODENAME) + "-" + String(CODENUMBER);
  mqttSettingsTopic = "suhu/settings/" + String(CODENAME) + "/" + String(CODENUMBER);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

  Wire.begin(SDA_PIN, SCL_PIN);

  lcd.init();
  lcd.backlight();
  lcd.createChar(0, dotChar);
  lcd.createChar(1, plugChar);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("PID Dimmer v5.1");
  lcd.setCursor(0, 1);
  lcd.print(String(CODENAME) + " #" + String(CODENUMBER));
  delay(1200);

  keypad.begin();

  if (!sht31.begin(0x44)) {
    Serial.println("ERROR: SHT30 tidak ditemukan!");
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("SHT30 ERROR!");
    while (1) delay(1);
  }

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  pinMode(ZMCTC_PIN, INPUT);

  pinMode(SSR_PIN, OUTPUT);
  digitalWrite(SSR_PIN, LOW);

  loadData();

  WiFi.onEvent(SysProvEvent);
  connectSavedWifiOrProvision();

  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setCallback(mqttCallback);

  dimmer.begin(NORMAL_MODE, ON);
  dimmer.setPower(0);

  lastPIDTime = millis();

  // Kalau provisioning belum jalan (kredensial sudah ada), langsung
  // ke layar status. Kalau lagi provisioning, layarnya sudah diisi
  // oleh startProvisioning() -> updateLCDProvisioning().
  if (!provisioningMode) {
    lcd.clear();
    updateLCDRun(0);
  }

  Serial.println("=== PID Dimmer v5.1 siap ===");
  Serial.print("Codename: "); Serial.print(CODENAME);
  Serial.print(" #"); Serial.println(CODENUMBER);
  Serial.print("Settings topic: "); Serial.println(mqttSettingsTopic);
}

// =====================
// LOOP
// =====================
unsigned long lastRead = 0;

void loop() {
  handleWifiState();
  checkNtpSync();

  // Auto-batal konfirmasi provisioning kalau timeout
  if (keyMode == CONFIRM_PROV && millis() > confirmProvUntil) {
    keyMode = RUN;
    updateLCDRun(lastSuhu);
  }

  if (wifiConnected && !provisioningMode) {
    mqttReconnect();
    mqtt.loop();
  }

  handleKeypad();

  if (millis() - lastRead >= 1000) {
    lastRead = millis();

    float suhu_raw = sht31.readTemperature();
    if (!isfinite(suhu_raw)) {
      Serial.println("ERROR: SHT30 gagal baca!");
      return;
    }
    float suhu = -8.1500 + (1.2533 * suhu_raw); // regresi kalibrasi suhu (hasil uji lab)
    lastSuhu = suhu;

    if (autoMode) {
      pidOutput = computePID(suhu);
      dimmer.setPower(pidOutput);
    }

    float current_raw = readCurrentRMS();
    current_rms_filtered = (ALPHA * current_raw) + ((1 - ALPHA) * current_rms_filtered);
    bool hasCurrent = detectCurrent(current_rms_filtered);

    controlBackupLamp(hasCurrent);

    if (!provisioningMode) {
      updateLCDRun(suhu);
    }

    if (wifiConnected && millis() - lastSend >= 120000) {
      lastSend = millis();
      sendToMQTT(suhu, hasCurrent);
    }
  }

  delay(10);
}
