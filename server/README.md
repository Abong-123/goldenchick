<!-- BADGES -->
<p align="center">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"/>
  <img src="https://img.shields.io/badge/Nginx-009639?style=for-the-badge&logo=nginx&logoColor=white" alt="Nginx"/>
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/Mosquitto-3C5280?style=for-the-badge&logo=eclipse-mosquitto&logoColor=white" alt="Mosquitto"/>
</p>

<!-- LOGO & TITLE -->
<p align="center">
  <img src="img/home.png" alt="Goldenchick Web Services Logo" width="500"/>
</p>

<h1 align="center">🌐 Goldenchick Web Services</h1>
<h3 align="center">Docker-Based Multi-Service Backend Infrastructure</h3>

---

## 📖 Table of Contents
- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [Installation](#installation)
- [Configuration Files](#configuration-files)
- [Mosquitto Password Setup](#mosquitto-password-setup)
- [Running the Services](#running-the-services)
- [Verification](#verification)
- [Service Endpoints](#service-endpoints)
- [Useful Commands](#useful-commands)

---

## Overview

This folder contains the backend infrastructure for Goldenchick, orchestrated with Docker Compose. The system consists of five containerized services working together to support the IoT monitoring and control platform.

| Service | Description | Port |
|---|---|---:|
| Nginx | Reverse proxy and load balancer | 80/443 |
| Mosquitto | MQTT broker for IoT device communication | 1883 |
| Backend Node.js | Business logic and API endpoints | 3000 |
| Backend FastAPI | High-performance async API services | 8000 |
| PostgreSQL | Primary relational database | 5432 |

---

## Directory Structure

```text
server/
├── nginx/
│   └── nginx.conf
├── mosquitto/
│   └── mosquitto.conf
├── backend-node/
│   ├── Dockerfile
│   └── src/
│       └── index.js
├── backend-fastapi/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── main.py
├── postgres/
├── docker-compose.yml
└── README.md
```

---

## Installation

### 1. Create the directory structure

Navigate to your home directory and create the required folders:

```bash
cd ~/
mkdir -p nginx mosquitto backend-node/src backend-fastapi postgres
```

### 2. Install Docker

```bash
apt update
apt install -y docker.io docker-compose
systemctl enable docker
systemctl start docker
```

### 3. Verify Docker installation

```bash
docker --version
docker-compose --version
```

### 4. Fix Docker Compose version mismatch (if needed)

If Docker Compose does not work properly, install it manually from the official release:

```bash
curl -L "https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-linux-x86_64" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
ln -s /usr/local/bin/docker-compose /usr/bin/docker-compose

docker --version
docker-compose --version
```

### 5. Create the Docker Compose file

Create a file named `docker-compose.yml` in the project root with the service definitions.

### 6. Create Nginx configuration

Place the reverse proxy settings in `nginx/nginx.conf`.

### 7. Create Mosquitto configuration

Place the MQTT broker configuration in `mosquitto/mosquitto.conf`.

### 8. Create the Node.js Dockerfile

Create `backend-node/Dockerfile`.

### 9. Create the FastAPI Dockerfile

Create `backend-fastapi/Dockerfile`.

### 10. Create the FastAPI requirements file

Create `backend-fastapi/requirements.txt` with:

```text
fastapi
uvicorn
paho-mqtt
asyncpg
```

### 11. Create the Node.js entry point

Create `backend-node/src/index.js` with:

```javascript
const express = require('express')
const app = express()

app.use(express.json())

app.get('/', (req, res) => {
  res.send('Node.js OK')
})

app.get('/suhu', (req, res) => {
  res.send('Endpoint suhu OK')
})

app.get('/feeder', (req, res) => {
  res.send('Endpoint feeder OK')
})

app.listen(3000, () => {
  console.log('Node.js running on port 3000')
})
```

### 12. Create the FastAPI entry point

Create `backend-fastapi/main.py` with:

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/testing")
def root():
    return {"status": "FastAPI OK"}
```

---

## Configuration Files

- `nginx.conf`: Handles routing requests to the appropriate backend services.
- `mosquitto.conf`: Defines MQTT broker behavior such as authentication, ports, and persistence.
- `docker-compose.yml`: Orchestrates all services, including build contexts, ports, volumes, and networks.

---

## Mosquitto Password Setup

Before running the services for the first time, configure the Mosquitto password file.

### 1. Create a password file

```bash
touch /root/project/mosquitto/passwd
```

### 2. Set the correct permissions

```bash
chmod 600 /root/project/mosquitto/passwd
chown 1883:1883 /root/project/mosquitto/passwd
```

### 3. Generate a hashed password

Replace `****` with your desired username and password:

```bash
docker run --rm \
  -v /root/project/mosquitto:/mosquitto/config \
  eclipse-mosquitto \
  sh -c "mosquitto_passwd -b /mosquitto/config/passwd **** **** && chown 1883:1883 /mosquitto/config/passwd"
```

### 4. Verify the password file

```bash
cat /root/project/mosquitto/passwd
```

---

## Running the Services

Ensure you are in the project directory containing `docker-compose.yml`:

```bash
docker-compose up --build
```

The `--build` flag ensures fresh builds of the Node.js and FastAPI services.

---

## Verification

Check that all services are running:

```bash
docker-compose ps
```

Expected output:

```text
NAME                        IMAGE                       COMMAND                  SERVICE            STATUS              PORTS
project-backend-fastapi-1   project-backend-fastapi     "uvicorn main:app --…"   backend-fastapi    Up About a minute   8000/tcp
project-backend-node-1      project-backend-node        "docker-entrypoint.s…"   backend-node       Up About a minute   3000/tcp
project-mosquitto-1         eclipse-mosquitto:latest    "/docker-entrypoint.…"   mosquitto          Up About a minute   0.0.0.0:1883->1883/tcp
project-nginx-1             nginx:alpine                "/docker-entrypoint.…"   nginx               Up About a minute   0.0.0.0:80->80/tcp
project-postgres-1          postgres:15-alpine          "docker-entrypoint.s…"   postgres           Up About a minute   5432/tcp
```

---

## Service Endpoints

| Service | Endpoint | Description |
|---|---|---|
| Node.js | `/` | Health check; returns `Node.js OK` |
| Node.js | `/suhu` | Temperature endpoint; returns `Endpoint suhu OK` |
| Node.js | `/feeder` | Feeder endpoint; returns `Endpoint feeder OK` |
| FastAPI | `/testing` | Health check; returns `{"status": "FastAPI OK"}` |
| Mosquitto | `mqtt://localhost:1883` | MQTT broker connection |
| Nginx | `http://localhost:80` | Main entry point that proxies to backend services |

---

## Useful Commands

```bash
# Stop all services
docker-compose down

# Restart services
docker-compose restart

# View logs for a specific service
docker-compose logs -f backend-node
docker-compose logs -f backend-fastapi

# Rebuild and restart a specific service
docker-compose up --build backend-node

# Remove all containers, networks, and volumes
docker-compose down -v
```

## Native Tailwind Deployment

This project uses Tailwind CSS in landing page without a JavaScript framework. To compile the CSS:

```bash
npx tailwindcss -i ./src/input.css -o ./src/output.css --minify
```

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/Abong-123/goldenchick/main/server/img/landing.png" alt="Landing Page" width="700"/>
  <br/>
  <em>Landing Page</em>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Abong-123/goldenchick/main/server/img/dashboard.png" alt="Main Dashboard" width="700"/>
  <br/>
  <em>Main Dashboard</em>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Abong-123/goldenchick/main/server/img/dashboard-feeder.png" alt="Feeder Dashboard" width="700"/>
  <br/>
  <em>Feeder Dashboard</em>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Abong-123/goldenchick/main/server/img/dashboard-temp.png" alt="Temperature Dashboard" width="700"/>
  <br/>
  <em>Temperature Dashboard</em>
</p>
