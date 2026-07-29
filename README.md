<!-- BADGES - Technology Stack & AI Assistants -->
<p align="center">
  <img src="https://img.shields.io/badge/Architecture-Microservices-blue?style=for-the-badge&logo=moleculer" alt="Microservices"/>
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"/>
  <img src="https://img.shields.io/badge/Nginx-009639?style=for-the-badge&logo=nginx&logoColor=white" alt="Nginx"/>
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python"/>
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/Mosquitto-3C5280?style=for-the-badge&logo=eclipse-mosquitto&logoColor=white" alt="Mosquitto"/>
  <img src="https://img.shields.io/badge/ESP32-E7352C?style=for-the-badge&logo=espressif&logoColor=white" alt="ESP32"/>
  <img src="https://img.shields.io/badge/Arduino-00979D?style=for-the-badge&logo=arduino&logoColor=white" alt="Arduino"/>
  <img src="https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind"/>
  <img src="https://img.shields.io/badge/Telegram_Bot-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram"/>
  <br/>
  <img src="https://img.shields.io/badge/AI_Assistant-DeepSeek-4B32C3?style=flat-square&logo=deepseek" alt="DeepSeek"/>
  <img src="https://img.shields.io/badge/AI_Assistant-OpenAI-412991?style=flat-square&logo=openai" alt="OpenAI"/>
  <img src="https://img.shields.io/badge/AI_Assistant-Claude-D97706?style=flat-square&logo=anthropic" alt="Anthropic Claude"/>
</p>

<!-- LOGO & TITLE -->
<p align="center">
  <img src="img/logo.png" alt="Goldenchick Logo" width="120"/>
</p>

<h1 align="center">Goldenchick</h1>
<h3 align="center">IoT-Based Coop Temperature Monitoring & Scheduled Chicken Feeding System</h3>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"/></a>
</p>

---

## 📖 Table of Contents
- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Key Features](#key-features)
- [Technology Stack](#technology-stack)
- [Multi-User & Multi-Device Scheme](#multi-user--multi-device-scheme)
- [Prerequisites & Installation](#prerequisites--installation)
- [Usage Guide](#usage-guide)
- [Device Layouts](#device-layouts)
- [Limitations & Future Development](#limitations--future-development)
- [License](#license)
- [Contact](#contact)

---

## Overview

**Goldenchick** is an integrated monitoring and control system for chicken coops that allows farmers to **monitor temperature in real-time with a PID mechanism** and **schedule automatic feeding**. The system is designed with a *multi-layered microservices* architecture for high scalability, supporting multi-tenant (multiple farms) and multi-device (multiple microcontrollers per farm) capabilities.

Each farmer gets exclusive access to a personal dashboard after validation, ensuring the security and privacy of each farm's data.

---

## System Architecture

Goldenchick is built using a **Multi-Layering System** approach with Docker & Nginx as the infrastructure foundation.

<p align="center">
  <img src="element/tech_stack.png" alt="Goldenchick Multi-Layer Architecture" width="700"/>
</p>

| Layer | Technology / Implementation | Description |
|---|---|---|
| **Infrastructure** | Docker Compose, Nginx | Containerization & reverse proxy for all microservices. |
| **Application** | HTML, CSS, JS, Tailwind, Telegram Bot | Responsive web interface and real-time notifications via bot. |
| **Presentation** | JSON | Standard data exchange format between services. |
| **Integration** | API Gateway (Node.js & FastAPI) | Single entry point for all client requests. |
| **Business Logic** | Node.js, Python | Business rules processing, PID logic, feed scheduling, and authentication. |
| **Data Access** | Node.js, SQLAlchemy | Object-Relational Mapping and query builder. |
| **Data Storage** | PostgreSQL | Main relational database for user, farm, token, and sensor log data. |
| **Messaging** | Mosquitto MQTT Broker | Lightweight protocol for real-time communication between server and ESP32. |
| **Connectivity** | WiFi (ESP32-S3) | Connects hardware devices to the internet. |
| **Perception** | ESP32-S3 (C/Arduino) | Microcontroller with sensors, actuators, and WiFi Provisioning feature. |


🍽️ Feeder Layout
<p align="center"> <img src="element/feeder_layout.png" alt="3D Feeder Layout" width="600"/> </p>
🌡️ Temperature Controller Layout
<p align="center"> <img src="element/temperature_layout.png" alt="3D Temperature Controller Layout" width="600"/> </p>
🔌 System Wiring Diagram
<p align="center"> <img src="element/layout.png" alt="Original System Wiring Model" width="700"/> </p>

---

## Key Features

### 🌡️ Coop Temperature Controller (PID Controller)
- **PID Control:** Temperature sensor (trigger) and dimmer (actuator) work in a PID loop to maintain temperature at the *setpoint* (midpoint of high & low limits).
- **Dynamic Setpoint:** Manually adjustable from the device keypad or *in real-time* from the website.
- **Heater Failover:** A current sensor detects the electrical flow to the main heater. If it fails, a relay automatically switches to a battery-based backup heater.

### ⏰ Scheduled Feeding
- **Two-Stage Precision:**
  1.  **Hopper (Reservoir):** Feed is stored in a fixed-size container.
  2.  **Load Cell Tray:** When the schedule arrives or a button is pressed, a gate servo opens the reservoir. Feed falls onto the *load cell* until the target weight is reached, then the gate closes. A push servo then slides the feed into the feeding trough below.

### 🔐 Multi-User & Multi-Device Access
- **Login System:** Every user must log in to access the dashboard.
- **Token-Based Authorization:** A user account must be assigned a farm token by an admin to view real-time data.
- **Team Collaboration:** One farm can be monitored by multiple accounts (owner & employees).
- **Multi-Device:** One farm can have many devices (temperature/feeder) connected under a single token.

### 📱 WiFi Provisioning
- Easily change the device's WiFi connection by pressing a button and using the official *ESP SoftAP Provisioning* app by Espressif.

---

## Technology Stack

### Software & Backend
- **Container:** Docker, Docker Compose
- **Web Server:** Nginx
- **API & Logic:** Node.js, Python (FastAPI)
- **Database:** PostgreSQL, SQLAlchemy
- **Message Broker:** Eclipse Mosquitto (MQTT)
- **Frontend:** Vanilla HTML/CSS/JS, Tailwind CSS
- **Notification:** Telegram Bot API

### Hardware
- **Microcontroller:** Espressif ESP32-S3
- **Firmware:** Arduino Framework (C/C++)
- **Sensors & Actuators:** SHT-30, AC Dimmer Robodyn, Heater, Relay fotek, ZMCT10c, Servo MG996R, Load Cell, Keypad 3x4, LCD 20x4 I2C, HC-SR04.

### AI Development Assistants
This project was developed with the assistance of:
- **Anthropic (Claude)**
- **OpenAI (ChatGPT)**
- **DeepSeek**

---

## Multi-User & Multi-Device Scheme

Goldenchick's authorization and multi-tenancy flow:

1.  **General Registration:** Anyone can register, but can only see the guide dashboard.
2.  **Farmer Onboarding:** A farmer (e.g., Mr. Ren) contacts the admin to install devices and activate their account.
3.  **Token Assignment:** The admin links Mr. Ren account to a unique token for his farm (e.g., `nova-jaya-farm`). Mr. Ren can now see *real-time* data and control his devices.
4.  **Multi-User:** Employees registered by Mr. Ren can ask the admin to link their accounts to the same token. Now 3 people can monitor `nova-jaya-farm`.
5.  **Multi-Device:** Mr. Budi from `barakah-farm` orders 2 temperature controllers and 3 scheduled feeders. All five devices send data using one single token. The server handles multiple *incoming data* streams from various devices within one farm.

---

## Limitations & Future Development
While the system is already functional, several areas are planned for future improvement:

- End-device security: ESP32 communication still uses a non-encrypted port.
- WiFi provisioning: The open Access Point mode during provisioning is vulnerable to attacks.
- Server rate limiting: No rate limiting is implemented yet, making the system susceptible to DDoS/DoS attacks.
- Feed sensor: The ultrasonic sensor in the reservoir is inaccurate and prone to damage; it is planned to be replaced with a full load cell system.
- Mobile experience: The web interface is still browser-based and not yet wrapped in a WebView for a better Android experience.
- Frontend framework: The project still uses vanilla HTML/CSS/JS, with a migration plan to React/Vue.
- Token security: Token validation is still handled directly in the business logic layer and should be isolated in a gateway or dedicated service.
- Session management: A cookie issue sometimes forces users to re-login; this needs to be fixed in the persistent login mechanism.

---

## License
This project is licensed under the MIT License. See the LICENSE file for full details.

---

## Contact
For more information about device installation or farm token activation, please contact us at:

📧 goldenchickapp@yahoo.com

<p align="center">Made with ❤️ by the Goldenchick Team</p> ```

---

## Prerequisites & Installation
1.  **Clone Repository**
    ```bash
    git clone https://github.com/Abong-123/goldenchick.git
    cd goldenchick
