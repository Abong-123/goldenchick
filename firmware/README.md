<!-- BADGES -->
<p align="center">
  <img src="https://img.shields.io/badge/ESP32--S3-E7352C?style=for-the-badge&logo=espressif&logoColor=white" alt="ESP32-S3"/>
  <img src="https://img.shields.io/badge/Arduino-00979D?style=for-the-badge&logo=arduino&logoColor=white" alt="Arduino"/>
  <img src="https://img.shields.io/badge/MQTT-660066?style=for-the-badge&logo=eclipse-mosquitto&logoColor=white" alt="MQTT"/>
  <img src="https://img.shields.io/badge/WiFi_Provisioning-4285F4?style=for-the-badge&logo=wifi&logoColor=white" alt="WiFi Provisioning"/>
</p>

<h1 align="center">🔧 Goldenchick Hardware & Firmware</h1>
<h3 align="center">ESP32-S3 Based IoT Devices for Poultry Farm Automation</h3>

---

## 📖 Table of Contents
- [Hardware Overview](#hardware-overview)
- [Device 1: Automatic Temperature Control v5.1](#device-1-automatic-temperature-control-v51)
- [Device 2: Smart Feeder v4.10](#device-2-smart-feeder-v410)
- [Provisioning Guide](#provisioning-guide)
- [Arduino IDE Setup Notes](#arduino-ide-setup-notes)

---

## Hardware Overview

All devices are built on the **Espressif ESP32-S3 N16R8** board with Arduino Framework (C/C++). The system consists of two specialized devices working together to automate poultry farm operations.

| Component | Type | Used In |
|---|---|---|
| **ESP32-S3 N16R8** | Microcontroller | Both Devices |
| **SHT-30** | Temperature & Humidity Sensor | Temperature Control |
| **AC Dimmer Robodyn** | AC Power Controller | Temperature Control |
| **Heater** | Heating Element | Temperature Control |
| **SSR Fotek** | Solid State Relay | Temperature Control |
| **ZMCT103c** | AC Current Sensor | Temperature Control |
| **Servo MG996R** | High Torque Servo Motor | Smart Feeder |
| **Load Cell + HX711** | Weight Sensor Module | Smart Feeder |
| **HC-SR04** | Ultrasonic Distance Sensor | Smart Feeder |
| **LCD 20x4 I2C** | Display Module | Both Devices |
| **Keypad 3x4 I2C (PCF8574)** | Input Interface | Both Devices |

---

## Device 1: Automatic Temperature Control v5.1

### Components
- SHT30 (Temperature & Humidity Sensor)
- LCD 20x4 I2C
- Keypad I2C (PCF8574)
- AC Dimmer Robodyn
- ZMCT103c (Current Sensor)
- SSR Fotek (Solid State Relay)

### Features
- PID-based automatic temperature regulation
- Real-time temperature & humidity monitoring
- Setpoint adjustment via keypad or MQTT
- Heater failover detection with current sensor
- WiFi SoftAP Provisioning (manual trigger via keypad)
- MQTT communication with backend server

### Pin Mapping

| Pin | GPIO | Component |
|---|---|---|
| SDA | 8 | I2C Data (LCD + Keypad) |
| SCL | 9 | I2C Clock (LCD + Keypad) |
| ZC | 41 | Zero Crossing (AC Dimmer) |
| PSM | 6 | Dimmer Control Signal |
| ZMCTC | 2 (ADC1) | Current Sensor Analog Input |
| SSR | 45 | Solid State Relay Control |
| LED_BUILTIN | 48 | Built-in LED Indicator |

### Required Libraries

Install via Arduino Library Manager:

| Library | Author | Purpose |
|---|---|---|
| **Adafruit SHT31** | Adafruit | SHT30 temperature & humidity sensor driver |
| **LiquidCrystal_I2C** | Frank de Brabander | I2C LCD display control |
| **Keypad_I2C** | joeyoung | I2C keypad matrix input |
| **RBDdimmer** | Robojax | AC dimmer control with zero-crossing |
| **PubSubClient** | Nick O'Leary | MQTT client communication |
| **ArduinoJson** | Benoit Blanchon | JSON data parsing and serialization |
| **WiFiProv** | Espressif (built-in) | WiFi provisioning over BLE/SoftAP |
| **LittleFS** | Espressif (built-in) | Flash file system for configuration storage |

---

## Device 2: Smart Feeder v4.10

### Components
- HX711 + Load Cell (Weight Sensor)
- Servo Gate (MG996R)
- Servo Dorong/Push (MG996R)
- Ultrasonic HC-SR04
- LCD 20x4 I2C
- Keypad I2C (PCF8574)

### Features
- Precision weight-based feeding mechanism
- Scheduled and manual feeding modes
- Multi-session feeding logic for limited load cell capacity
- Feed stock monitoring via ultrasonic sensor
- WiFi SoftAP Provisioning (manual trigger via keypad)
- MQTT communication with backend server

### Pin Mapping

| Pin | GPIO | Component |
|---|---|---|
| SDA | 8 | I2C Data (LCD + Keypad) |
| SCL | 9 | I2C Clock (LCD + Keypad) |
| SERVO_GATE | 17 | Gate Servo Motor |
| SERVO_DORONG | 18 | Push Servo Motor |
| HX711_DOUT | 5 | Load Cell Data Output |
| HX711_SCK | 4 | Load Cell Serial Clock |
| TRIG | 6 | Ultrasonic Trigger Pin |
| ECHO | 7 | Ultrasonic Echo Pin |

### Required Libraries

Install via Arduino Library Manager:

| Library | Author | Purpose |
|---|---|---|
| **HX711_ADC** | Olav Kallhovd | Load cell amplifier interface |
| **RTClib** | Adafruit | Real-time clock for scheduling |
| **LiquidCrystal_I2C** | Frank de Brabander | I2C LCD display control |
| **Keypad_I2C** | joeyoung | I2C keypad matrix input |
| **ESP32Servo** | Kevin Harrington | Servo motor control for ESP32 |
| **PubSubClient** | Nick O'Leary | MQTT client communication |
| **ArduinoJson** | Benoit Blanchon | JSON data parsing and serialization |
| **WiFiProv** | Espressif (built-in) | WiFi provisioning over BLE/SoftAP |
| **LittleFS** | Espressif (built-in) | Flash file system for configuration storage |

### Multi-Session Feeding Logic

Due to the load cell's limited capacity (100g), feeding is divided into multiple sessions:

1. **Open gate** → weigh until session target is reached → **close gate**
2. **Push feed** to the feeding trough (empty the weighing platform)
3. **Repeat** until total required amount is delivered
4. If stock runs **EMPTY** mid-session → **stop completely** (prevents gate from opening unnecessarily)

---

## Provisioning Guide

Both devices support **WiFi SoftAP Provisioning** via Espressif's official provisioning app.

| Parameter | Value |
|---|---|
| **Provisioning Method** | SoftAP (manual trigger via keypad) |
| **App** | ESP SoftAP Provisioning (Android/iOS) |
| **AP Name Format** | `pakan-<CODENAME>-<CODENUMBER>` (Feeder) / `suhu-<CODENAME>-<CODENUMBER>` (Temp Control) |
| **PoP (PIN)** | See `pop` variable in firmware |
| **Initial Trigger** | Automatic, ONLY if NVS WiFi is empty |
| **Manual Re-trigger** | Press keypad `[D]` then confirm with `[#]` |

---

## Arduino IDE Setup Notes

### Required Board Package
- **ESP32 by Espressif Systems** (install via Boards Manager)

### Critical Tools Settings for ESP32-S3

| Setting | Value | Note |
|---|---|---|
| **USB CDC On Boot** | **Enable** | **MANDATORY** for ESP32-S3 native USB. Serial monitor will not appear if disabled. |
| **USB Mode** | Hardware CDC and JTAG | Default safe option |
| **Flash Size** | Match your board (min. 4MB) | Adjust according to your specific ESP32-S3 variant |
| **Partition Scheme** | Default 4MB with spiffs | Or "Minimal SPIFFS" if more program space is needed |

### Device Identity
Each device has a unique identity set in firmware:
```cpp
// Change CODENAME and CODENUMBER according to device
#define CODENAME "DEVICE_NAME"
#define CODENUMBER "001"