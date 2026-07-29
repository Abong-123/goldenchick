-- =====================================================================
-- INIT.SQL — Golden Chick Database Schema
-- Disusun berdasarkan definisi tabel yang sudah ada di sistem.
-- Urutan pembuatan disesuaikan dengan dependency (FK) antar tabel.
-- =====================================================================

-- ---------------------------------------------------------------------
-- SCHEMAS
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS suhu;
CREATE SCHEMA IF NOT EXISTS feeder;

-- ---------------------------------------------------------------------
-- PUBLIC.USERS (dibuat lebih dulu karena jadi referensi FK tabel lain)
-- ---------------------------------------------------------------------
CREATE TYPE public.userrole AS ENUM ('peternak', 'admin');

CREATE TABLE public.users (
  id          SERIAL PRIMARY KEY,
  peternakan  VARCHAR(100) NOT NULL,
  email       VARCHAR(100) UNIQUE NOT NULL,
  username    VARCHAR(100) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  role        public.userrole DEFAULT 'peternak',
  created_at  TIMESTAMP DEFAULT NOW()
);

ALTER TABLE public.users ADD COLUMN token VARCHAR(50);

-- ---------------------------------------------------------------------
-- SUHU.RAWLOG
-- ---------------------------------------------------------------------
CREATE TABLE suhu.rawlog (
  id              SERIAL PRIMARY KEY,
  codename        VARCHAR(50),
  codenumber      VARCHAR(10),
  temperature     NUMERIC(5,2),
  limit_low_temp  NUMERIC(5,2),
  limit_high_temp NUMERIC(5,2),
  setpoint        NUMERIC(5,2),
  power           INTEGER,
  mode            VARCHAR(20),
  power_status    VARCHAR(20),
  status          VARCHAR(20),
  rssi            INTEGER,
  esp_millis      BIGINT,
  created_at      TIMESTAMPTZ
);

CREATE INDEX idx_suhu_rawlog_codename  ON suhu.rawlog(codename);
CREATE INDEX idx_suhu_rawlog_createdat ON suhu.rawlog(created_at);

-- ---------------------------------------------------------------------
-- SUHU.SETTINGS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suhu.settings (
    id           SERIAL PRIMARY KEY,
    codename     VARCHAR(50) NOT NULL,
    codenumber   VARCHAR(10) NOT NULL,
    jenis        VARCHAR(20),
    fase         VARCHAR(20),
    suhu_min     NUMERIC(5,2),
    suhu_max     NUMERIC(5,2),
    suhu_target  NUMERIC(5,2),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_by   INTEGER REFERENCES public.users(id),
    UNIQUE (codename, codenumber)
);

-- ---------------------------------------------------------------------
-- FEEDER.RAWLOG
-- ---------------------------------------------------------------------
CREATE TABLE feeder.rawlog (
  id                SERIAL PRIMARY KEY,
  publish_type      VARCHAR(20),
  codename          VARCHAR(50),
  codenumber        VARCHAR(10),
  jenis_pakan       VARCHAR(20),
  target_gram       NUMERIC(8,2),
  aktual_gram       NUMERIC(8,2),
  out_gram          NUMERIC(8,2),
  status_pakan      VARCHAR(20),
  waktu_pakan       TIME,
  status_stok       VARCHAR(20),
  jarak_ultrasonik  NUMERIC(6,2),
  status            VARCHAR(20),
  rssi              INTEGER,
  esp_millis        BIGINT,
  created_at        TIMESTAMPTZ
);

CREATE INDEX idx_feeder_rawlog_codename  ON feeder.rawlog(codename);
CREATE INDEX idx_feeder_rawlog_createdat ON feeder.rawlog(created_at);

-- ---------------------------------------------------------------------
-- FEEDER.SETTINGS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feeder.settings (
    id               SERIAL PRIMARY KEY,
    codename         VARCHAR(50) NOT NULL,
    codenumber       INTEGER NOT NULL,
    jenis_pakan      VARCHAR(20),
    jumlah_ayam      INTEGER,
    pakan_per_ayam   NUMERIC(8,2),
    waktu_pemberian  INTEGER,
    jadwal1          TIME,
    jadwal2          TIME,
    jadwal3          TIME,
    jadwal4          TIME,
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_by       INTEGER REFERENCES public.users(id),
    source            VARCHAR(10),
    UNIQUE (codename, codenumber)
);

-- ---------------------------------------------------------------------
-- TELEGRAM_SUBSCRIPTIONS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_subscriptions (
    id            SERIAL PRIMARY KEY,
    chat_id       BIGINT UNIQUE NOT NULL,
    codename      VARCHAR(50) NOT NULL,
    username      VARCHAR(100),
    first_name    VARCHAR(100),
    last_name     VARCHAR(100),
    is_active     BOOLEAN DEFAULT TRUE,
    subscribed_at TIMESTAMPTZ DEFAULT NOW()
);