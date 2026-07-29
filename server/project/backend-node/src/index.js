const express      = require('express')
const mqtt         = require('mqtt')
const { Pool }     = require('pg')
const bcrypt       = require('bcrypt')
const jwt          = require('jsonwebtoken')
const cookieParser = require('cookie-parser')

const app = express()
app.use(express.json())
app.use(cookieParser())

// =====================
// JWT SECRET
// =====================
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET is not set. Please check your .env file.')
  process.exit(1)
}
const JWT_EXPIRES = '8h'

// =====================
// BASE URL
// =====================
const BASE_URL = process.env.BASE_URL || 'http://localhost'

// =====================
// DATABASE — tugasakhir (satu pool untuk semua)
// users         → public.users
// data suhu     → suhu.rawlog
// =====================
const pool = new Pool({
  host:     process.env.DB_HOST || 'postgres',
  port:     process.env.DB_PORT || 5432,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'tugasakhir',
})

// Validasi
if (!process.env.DB_USER || !process.env.DB_PASS) {
  console.error('❌ DB_USER or DB_PASS is not set. Please check your .env file.')
  process.exit(1)
}

pool.connect()
  .then(() => console.log('>> PostgreSQL tugasakhir terhubung'))
  .catch(err => console.error('>> PostgreSQL ERROR:', err.message))

// Cache status real-time feeder dari heartbeat (tidak disimpan ke DB)
const feederStatusCache = {}  // { 'NJYF1/1': { status_stok, jarak_ultrasonik, rssi, status, updated_at } }
// =====================
// MIDDLEWARE — verifikasi JWT
// =====================
function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers?.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ status: 'error', message: 'Tidak ada token, silakan login' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ status: 'error', message: 'Token tidak valid atau sudah expired' })
  }
}

// =====================
// MIDDLEWARE — khusus admin
// =====================
function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ status: 'error', message: 'Akses ditolak, hanya admin' })
  }
  next()
}

// =====================
// MQTT CLIENT
// =====================
const mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_BROKER || 'mosquitto'}:${process.env.MQTT_PORT || 1883}`, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  clientId: 'backend-node-' + Math.random().toString(16).slice(2, 8),
  reconnectPeriod: 5000,
})

// Validasi
if (!process.env.MQTT_USER || !process.env.MQTT_PASS) {
  console.error('❌ MQTT_USER or MQTT_PASS is not set. Please check your .env file.')
  process.exit(1)
}

mqttClient.on('connect', () => {
  console.log('>> MQTT terhubung ke broker')
  mqttClient.subscribe('suhu/rawlog', { qos: 1 }, (err) => {
    if (err) console.error('>> MQTT subscribe ERROR:', err.message)
    else     console.log('>> MQTT subscribe: suhu/rawlog')
  })
  mqttClient.subscribe('feeder/rawlog', (err) => {
    if (err) console.error('MQTT subscribe feeder/rawlog error:', err)
    else console.log('>> MQTT subscribed: feeder/rawlog')
  })
  mqttClient.subscribe('feeder/settings/report', (err) => {
    if (err) console.error('MQTT subscribe feeder/settings/report error:', err)
    else console.log('>> MQTT subscribed: feeder/settings/report')
  })
})

mqttClient.on('error',     (err) => console.error('>> MQTT ERROR:', err.message))
mqttClient.on('reconnect', ()    => console.log('>> MQTT reconnecting...'))

// =====================
// TERIMA PESAN MQTT → INSERT ke suhu.rawlog
// =====================
mqttClient.on('message', async (topic, message) => {
  let data
  try {
    data = JSON.parse(message.toString())
  } catch (e) {
    console.error('>> MQTT parse ERROR:', e.message)
    return
  }

  // ===== SUHU =====
  if (topic === 'suhu/rawlog') {
    if (data.action !== 'suhu') {
      console.log('>> MQTT skip — action bukan suhu:', data.action)
      return
    }

    console.log('>> MQTT suhu diterima:', data.codename, data.codenumber, 'T:', data.temperature)

    try {
      const userCheck = await pool.query(
        'SELECT id, username FROM public.users WHERE token = $1',
        [data.codename]
      )
      if (userCheck.rows.length === 0) {
        console.warn('>> MQTT WARNING: codename tidak terdaftar:', data.codename, '— data tetap disimpan')
      } else {
        console.log('>> MQTT codename match user:', userCheck.rows[0].username)
      }

      await pool.query(
        `INSERT INTO suhu.rawlog
          (codename, codenumber, temperature, limit_low_temp, limit_high_temp,
           setpoint, power, mode, power_status, status, rssi, esp_millis, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          data.codename        ?? null,
          data.codenumber      ?? null,
          data.temperature     ?? null,
          data.limit_low_temp  ?? null,
          data.limit_high_temp ?? null,
          data.setpoint        ?? null,
          data.power           ?? null,
          data.mode            ?? null,
          data.power_status    ?? null,
          data.status          ?? null,
          data.rssi            ?? null,
          data.esp_millis      ?? null,
          data.created_at      ?? null,
        ]
      )
      console.log('>> DB insert OK — suhu.rawlog codename:', data.codename, 'T:', data.temperature)
    } catch (err) {
      console.error('>> DB insert ERROR (suhu):', err.message)
    }
    return
  }

  // ===== FEEDER =====
  if (topic === 'feeder/rawlog') {
    if (data.action !== 'feeder') {
      console.log('>> MQTT skip — action bukan feeder:', data.action)
      return
    }

    const cacheKey = `${data.codename}/${data.codenumber}`

    // Selalu update cache status real-time (berlaku untuk event maupun heartbeat)
    feederStatusCache[cacheKey] = {
      codename:         data.codename,
      codenumber:       data.codenumber,
      status_stok:      data.status_stok,
      jarak_ultrasonik: data.jarak_ultrasonik,
      rssi:             data.rssi,
      status:           data.status,
      updated_at:       new Date().toISOString()
    }
    console.log(`>> feeder status cache updated: ${cacheKey} stok=${data.status_stok}`)

    // Persist ke DB juga supaya alert_bot.py (proses Python terpisah) bisa baca
    try {
      await pool.query(
        `INSERT INTO feeder.status_latest
            (codename, codenumber, status_stok, jarak_ultrasonik, status, rssi, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (codename, codenumber)
        DO UPDATE SET
            status_stok      = EXCLUDED.status_stok,
            jarak_ultrasonik = EXCLUDED.jarak_ultrasonik,
            status           = EXCLUDED.status,
            rssi             = EXCLUDED.rssi,
            updated_at       = NOW()`,
        [data.codename, data.codenumber, data.status_stok, data.jarak_ultrasonik, data.status, data.rssi]
      )
    } catch (err) {
      console.error('>> DB insert ERROR (feeder.status_latest):', err.message)
    }

    // Heartbeat — tidak disimpan ke DB
    if (data.publish_type === 'heartbeat') {
      console.log(`>> feeder heartbeat diterima: ${cacheKey} — tidak disimpan ke DB`)
      return
    }

    // Event — simpan ke DB
    console.log(`>> feeder event diterima: ${cacheKey} status_pakan=${data.status_pakan}`)
    try {
      const userCheck = await pool.query(
        'SELECT id, username FROM public.users WHERE token = $1',
        [data.codename]
      )
      if (userCheck.rows.length === 0) {
        console.warn('>> MQTT WARNING: codename tidak terdaftar:', data.codename, '— data tetap disimpan')
      } else {
        console.log('>> MQTT codename match user:', userCheck.rows[0].username)
      }

      await pool.query(
        `INSERT INTO feeder.rawlog
          (publish_type, codename, codenumber, jenis_pakan, target_gram, aktual_gram, out_gram,
          status_pakan, waktu_pakan, status_stok, jarak_ultrasonik,
          status, rssi, esp_millis, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          data.publish_type      ?? 'event',
          data.codename          ?? null,
          data.codenumber        ?? null,
          data.jenis_pakan       ?? null,
          data.target_gram       ?? null,
          data.aktual_gram       ?? null,
          data.out_gram          ?? null,
          data.status_pakan      ?? null,
          data.waktu_pakan       ?? null,
          data.status_stok       ?? null,
          data.jarak_ultrasonik  ?? null,
          data.status            ?? null,
          data.rssi              ?? null,
          data.esp_millis        ?? null,
          data.created_at        ?? null,
        ]
      )
      console.log(`>> DB insert OK — feeder.rawlog event: ${cacheKey} waktu_pakan=${data.waktu_pakan}`)
    } catch (err) {
      console.error('>> DB insert ERROR (feeder):', err.message)
    }
    return
  }


  // ===== FEEDER TAMBAHAN =======
  if (topic === 'feeder/settings/report') {
    console.log('>> MQTT feeder settings report diterima dari MCU:', data)

    try {
      const codename        = data.codename
      const codenumber       = data.codenumber
      const jenis_pakan      = data.jenis_pakan
      const jumlah_ayam      = data.jumlah_ayam
      const pakan_per_ayam   = data.pakan_per_ayam
      const waktu_pemberian  = data.waktu_pemberian
      const jadwal1          = data.jadwal1 || null
      const jadwal2          = data.jadwal2 || null
      const jadwal3          = data.jadwal3 || null
      const jadwal4          = data.jadwal4 || null

      if (!codename || !codenumber) {
        console.warn('>> feeder settings report: codename/codenumber kosong, dilewati')
        return
      }

      await pool.query(
        `INSERT INTO feeder.settings
            (codename, codenumber, jenis_pakan, jumlah_ayam, pakan_per_ayam,
            waktu_pemberian, jadwal1, jadwal2, jadwal3, jadwal4,
            updated_at, updated_by, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NULL,'mcu')
        ON CONFLICT (codename, codenumber)
        DO UPDATE SET
            jenis_pakan     = EXCLUDED.jenis_pakan,
            jumlah_ayam     = EXCLUDED.jumlah_ayam,
            pakan_per_ayam  = EXCLUDED.pakan_per_ayam,
            waktu_pemberian = EXCLUDED.waktu_pemberian,
            jadwal1         = EXCLUDED.jadwal1,
            jadwal2         = EXCLUDED.jadwal2,
            jadwal3         = EXCLUDED.jadwal3,
            jadwal4         = EXCLUDED.jadwal4,
            updated_at      = NOW(),
            updated_by      = NULL,
            source          = 'mcu'`,
        [codename, codenumber, jenis_pakan, jumlah_ayam, pakan_per_ayam,
        waktu_pemberian, jadwal1, jadwal2, jadwal3, jadwal4]
      )

      console.log(`>> DB updated dari MCU — feeder.settings: ${codename}/${codenumber}`)
    } catch (err) {
      console.error('>> DB update ERROR (feeder settings dari MCU):', err.message)
    }
    return
  }

  console.log('>> MQTT topic tidak dikenal:', topic)
})

// =====================================================================
// AUTH ENDPOINTS
// =====================================================================

// POST /api/register
app.post('/api/register', async (req, res) => {
  const { peternakan, email, username, password } = req.body
  if (!peternakan || !email || !username || !password) {
    return res.status(400).json({ status: 'error', message: 'Semua field wajib diisi' })
  }
  try {
    const cek = await pool.query(
      'SELECT id FROM public.users WHERE email=$1 OR username=$2',
      [email, username]
    )
    if (cek.rows.length > 0) {
      return res.status(409).json({ status: 'error', message: 'Email atau username sudah terdaftar' })
    }
    const hash   = await bcrypt.hash(password, 12)
    const result = await pool.query(
      `INSERT INTO public.users (peternakan, email, username, password)
       VALUES ($1,$2,$3,$4) RETURNING id, username, role`,
      [peternakan, email, username, hash]
    )
    res.status(201).json({ status: 'ok', message: 'Registrasi berhasil', user: result.rows[0] })
  } catch (err) {
    console.error('>> Register ERROR:', err.message)
    res.status(500).json({ status: 'error', message: 'Server error' })
  }
})

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ status: 'error', message: 'Username dan password wajib diisi' })
  }
  try {
    const result = await pool.query(
      'SELECT * FROM public.users WHERE username=$1', [username]
    )
    if (result.rows.length === 0) {
      return res.status(401).json({ status: 'error', message: 'Username atau password salah' })
    }
    const user  = result.rows[0]
    const match = await bcrypt.compare(password, user.password)
    if (!match) {
      return res.status(401).json({ status: 'error', message: 'Username atau password salah' })
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, peternakan: user.peternakan },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    )
    res.cookie('token', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax' })
    res.json({
      status: 'ok', message: 'Login berhasil',
      user: { id: user.id, username: user.username, role: user.role, peternakan: user.peternakan, token: user.token },
    })
  } catch (err) {
    console.error('>> Login ERROR:', err.message)
    res.status(500).json({ status: 'error', message: 'Server error' })
  }
})

// POST /api/logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token')
  res.json({ status: 'ok', message: 'Logout berhasil' })
})

// GET /api/me
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ status: 'ok', user: req.user })
})

// POST /api/reset-password/cek
app.post('/api/reset-password/cek', async (req, res) => {
  const { username, email } = req.body
  if (!username || !email) {
    return res.status(400).json({ status: 'error', message: 'Username dan email wajib diisi' })
  }
  try {
    const result = await pool.query(
      'SELECT id FROM public.users WHERE username=$1 AND email=$2', [username, email]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Username dan email tidak cocok' })
    }
    const resetToken = jwt.sign(
      { id: result.rows[0].id, purpose: 'reset' }, JWT_SECRET, { expiresIn: '15m' }
    )
    res.json({ status: 'ok', message: 'Verifikasi berhasil', reset_token: resetToken })
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Server error' })
  }
})

// POST /api/reset-password/ganti
app.post('/api/reset-password/ganti', async (req, res) => {
  const { reset_token, password_baru } = req.body
  if (!reset_token || !password_baru) {
    return res.status(400).json({ status: 'error', message: 'Token dan password baru wajib diisi' })
  }
  try {
    const decoded = jwt.verify(reset_token, JWT_SECRET)
    if (decoded.purpose !== 'reset') {
      return res.status(401).json({ status: 'error', message: 'Token tidak valid' })
    }
    const hash = await bcrypt.hash(password_baru, 12)
    await pool.query('UPDATE public.users SET password=$1 WHERE id=$2', [hash, decoded.id])
    res.json({ status: 'ok', message: 'Password berhasil direset, silakan login' })
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'error', message: 'Token expired, ulangi proses reset' })
    }
    res.status(500).json({ status: 'error', message: 'Server error' })
  }
})

// =====================================================================
// USER MANAGEMENT — admin only
// =====================================================================

// GET /api/users — include token
app.get('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, peternakan, email, username, role, token, created_at
       FROM public.users ORDER BY created_at DESC`
    )
    res.json({ status: 'ok', count: result.rows.length, data: result.rows })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// POST /api/users
app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { peternakan, email, username, password, role } = req.body
  if (!peternakan || !email || !username || !password) {
    return res.status(400).json({ status: 'error', message: 'Semua field wajib diisi' })
  }
  try {
    const hash   = await bcrypt.hash(password, 12)
    const result = await pool.query(
      `INSERT INTO public.users (peternakan, email, username, password, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, username, role`,
      [peternakan, email, username, hash, role || 'peternak']
    )
    res.status(201).json({ status: 'ok', user: result.rows[0] })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// PUT /api/users/:id
app.put('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params
  const { peternakan, email, username, role, password } = req.body
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 12)
      await pool.query(
        `UPDATE public.users SET peternakan=$1, email=$2, username=$3, role=$4, password=$5 WHERE id=$6`,
        [peternakan, email, username, role, hash, id]
      )
    } else {
      await pool.query(
        `UPDATE public.users SET peternakan=$1, email=$2, username=$3, role=$4 WHERE id=$5`,
        [peternakan, email, username, role, id]
      )
    }
    res.json({ status: 'ok', message: 'User berhasil diupdate' })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// PUT /api/users/:id/token — set token MCU (admin only)
app.put('/api/users/:id/token', authMiddleware, adminMiddleware, async (req, res) => {
  const { id }    = req.params
  const { token } = req.body
  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token wajib diisi' })
  }
  try {
    await pool.query(
      'UPDATE public.users SET token=$1 WHERE id=$2', [token, id]
    )
    res.json({ status: 'ok', message: 'Token berhasil disimpan' })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// DELETE /api/users/:id
app.delete('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params
  try {
    await pool.query('DELETE FROM public.users WHERE id=$1', [id])
    res.json({ status: 'ok', message: 'User berhasil dihapus' })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// =====================================================================
// SUHU ENDPOINTS
// =====================================================================

// GET /suhu/rawlog — data suhu milik user (filter by token)
app.get('/suhu/rawlog', authMiddleware, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500)
  const from  = req.query.from
  const to    = req.query.to

  try {
    // Ambil token user yang login
    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const userToken = userResult.rows[0]?.token

    if (!userToken && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    // Admin bisa lihat semua, peternak hanya codename miliknya
    let whereClause = req.user.role === 'admin' ? '' : `WHERE codename = '${userToken}'`
    const params    = []

    if (from && to) {
      const separator = whereClause ? ' AND ' : 'WHERE '
      params.push(from, to)
      whereClause += separator + `created_at BETWEEN $1 AND $2::timestamptz + interval '1 day'`
    } else if (from) {
      const separator = whereClause ? ' AND ' : 'WHERE '
      params.push(from)
      whereClause += separator + `created_at >= $1`
    } else if (to) {
      const separator = whereClause ? ' AND ' : 'WHERE '
      params.push(to)
      whereClause += separator + `created_at <= $1::timestamptz + interval '1 day'`
    }

    params.push(limit)

    const result = await pool.query(
      `SELECT id, codename, codenumber, temperature, limit_low_temp, limit_high_temp,
              setpoint, power, mode, power_status, status, rssi, esp_millis, created_at
       FROM suhu.rawlog
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    )
    res.json({ status: 'ok', count: result.rows.length, data: result.rows })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// GET /suhu/rawlog/latest — data terbaru per codename (untuk realtime UI)
app.get('/suhu/rawlog/latest', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const userToken = userResult.rows[0]?.token

    // Kalau bukan admin dan tidak punya token → 403
    if (!userToken && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    const whereClause = req.user.role === 'admin' ? '' : `WHERE codename = $1`
    const params      = req.user.role === 'admin' ? [] : [userToken]

    const result = await pool.query(
      `SELECT DISTINCT ON (codenumber)
              id, codename, codenumber, temperature, limit_low_temp, limit_high_temp,
              setpoint, power, mode, power_status, status, rssi, esp_millis, created_at
       FROM suhu.rawlog
       ${whereClause}
       ORDER BY codenumber, created_at DESC`,
      params
    )
    res.json({ status: 'ok', count: result.rows.length, data: result.rows })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// GET /suhu/rawlog/hourly?codenumber=1
// Rata-rata suhu per jam, 12 jam terakhir
app.get('/suhu/rawlog/hourly', authMiddleware, async (req, res) => {
  const codenumber = req.query.codenumber
  if (!codenumber) {
    return res.status(400).json({ status: 'error', message: 'codenumber wajib diisi' })
  }
  try {
    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const userToken = userResult.rows[0]?.token

    if (!userToken && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    // Admin bisa akses semua, peternak hanya codename miliknya
    const codeFilter = req.user.role === 'admin'
      ? `AND codenumber = $1`
      : `AND codename = $2 AND codenumber = $1`
    const params = req.user.role === 'admin'
      ? [codenumber]
      : [codenumber, userToken]

    const result = await pool.query(
      `SELECT
          TO_CHAR(
            DATE_TRUNC('hour', created_at AT TIME ZONE 'Asia/Jakarta'),
            'YYYY-MM-DD"T"HH24:MI:SS'
          ) AS jam,
          ROUND(AVG(temperature)::numeric, 1) AS avg_suhu,
          COUNT(*) AS jumlah_data
      FROM suhu.rawlog
      WHERE created_at >= NOW() - INTERVAL '12 hours'
      ${codeFilter}
      GROUP BY DATE_TRUNC('hour', created_at AT TIME ZONE 'Asia/Jakarta')
      ORDER BY jam ASC`,
      params
    )
    res.json({ status: 'ok', count: result.rows.length, data: result.rows })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// POST /suhu/settings — kirim pengaturan suhu ke MCU via MQTT + simpan ke DB
app.post('/suhu/settings', authMiddleware, async (req, res) => {
  try {
    const { kandang_id, jenis, fase, suhuMin, suhuMax, target } = req.body

    if (!kandang_id || suhuMin === undefined || suhuMax === undefined || !target) {
      return res.status(400).json({ status: 'error', message: 'Data tidak lengkap' })
    }

    // Ambil token user (= codename MCU)
    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const codename = userResult.rows[0]?.token

    if (!codename && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    const codenumber = String(kandang_id)
    const topic      = `suhu/settings/${codename}/${codenumber}`

    const payload = JSON.stringify({
      codename:   codename,
      codenumber: codenumber,
      suhu_min:   parseFloat(suhuMin),
      suhu_max:   parseFloat(suhuMax),
      target:     parseFloat(target),
      timestamp:  new Date().toISOString()
    })

    // Publish ke MQTT
    mqttClient.publish(topic, payload, { qos: 1 }, async (err) => {
      if (err) {
        console.error('MQTT publish error:', err)
        return res.status(500).json({ status: 'error', message: 'Gagal publish ke MQTT' })
      }

      // Upsert ke suhu.settings
      await pool.query(
        `INSERT INTO suhu.settings
            (codename, codenumber, jenis, fase, suhu_min, suhu_max, suhu_target, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)
         ON CONFLICT (codename, codenumber)
         DO UPDATE SET
            jenis       = EXCLUDED.jenis,
            fase        = EXCLUDED.fase,
            suhu_min    = EXCLUDED.suhu_min,
            suhu_max    = EXCLUDED.suhu_max,
            suhu_target = EXCLUDED.suhu_target,
            updated_at  = NOW(),
            updated_by  = EXCLUDED.updated_by`,
        [codename, codenumber, jenis, fase, suhuMin, suhuMax, target, req.user.id]
      )

      // Update baris terbaru di suhu.rawlog supaya kartu realtime langsung sinkron
      // tanpa menunggu heartbeat MCU berikutnya
      await pool.query(
        `UPDATE suhu.rawlog
        SET limit_low_temp  = $1,
            limit_high_temp = $2,
            setpoint         = $3
        WHERE id = (
          SELECT id FROM suhu.rawlog
          WHERE codename = $4 AND codenumber = $5
          ORDER BY created_at DESC
          LIMIT 1
        )`,
        [suhuMin, suhuMax, target, codename, codenumber]
      )

      console.log(`>> MQTT published to ${topic}:`, payload)
      res.json({ status: 'ok', message: 'Pengaturan berhasil dikirim ke MCU', topic, payload: JSON.parse(payload) })
    })

  } catch (err) {
    console.error('>> /suhu/settings ERROR:', err.message)
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// GET /suhu/settings — lihat setting suhu milik user
app.get('/suhu/settings', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const userToken = userResult.rows[0]?.token

    if (!userToken && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    const whereClause = req.user.role === 'admin' ? '' : `WHERE codename = $1`
    const params      = req.user.role === 'admin' ? [] : [userToken]

    const result = await pool.query(
      `SELECT s.*, u.username as updated_by_username
       FROM suhu.settings s
       LEFT JOIN public.users u ON s.updated_by = u.id
       ${whereClause}
       ORDER BY s.updated_at DESC`,
      params
    )

    res.json({ status: 'ok', count: result.rows.length, data: result.rows })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// =====================================================================
// FEEDER ENDPOINTS
// =====================================================================
// GET /feeder/rawlog — data terbaru feeder per kandang milik user
app.get('/feeder/rawlog', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const userToken = userResult.rows[0]?.token

    if (!userToken && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    const whereClause = req.user.role === 'admin' ? '' : `WHERE codename = $1`
    const params      = req.user.role === 'admin' ? [] : [userToken]

    const result = await pool.query(
      `SELECT id, codename, codenumber, jenis_pakan, target_gram, aktual_gram,
              out_gram, status_pakan, waktu_pakan, status_stok, jarak_ultrasonik,
              status, rssi, esp_millis, created_at
       FROM feeder.rawlog
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT 200`,
      params
    )
    res.json({ status: 'ok', count: result.rows.length, data: result.rows })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// GET /feeder/status/latest — status stok real-time dari heartbeat cache
app.get('/feeder/status/latest', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const userToken = userResult.rows[0]?.token

    if (!userToken && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    // Filter cache berdasarkan token user
    const result = Object.entries(feederStatusCache)
      .filter(([key]) => req.user.role === 'admin' || key.startsWith(userToken + '/'))
      .map(([key, val]) => val)

    res.json({ status: 'ok', count: result.length, data: result })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// POST /feeder/settings — kirim pengaturan pakan ke MCU via MQTT + simpan ke DB
app.post('/feeder/settings', authMiddleware, async (req, res) => {
  try {
    const { kandang_id, jenis_pakan, jumlah_ayam, pakan_per_ayam,
            waktu_pemberian, jadwal1, jadwal2, jadwal3, jadwal4 } = req.body

    if (!kandang_id) {
      return res.status(400).json({ status: 'error', message: 'kandang_id wajib diisi' })
    }

    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const codename = userResult.rows[0]?.token

    if (!codename && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    const codenumber = parseInt(kandang_id)
    const topic      = `feeder/settings/${codename}/${codenumber}`

    const payload = JSON.stringify({
      codename:        codename,
      codenumber:      codenumber,
      jenis_pakan:     jenis_pakan     || 'jagung',
      jumlah_ayam:     jumlah_ayam     || 0,
      pakan_per_ayam:  pakan_per_ayam  || 0,
      waktu_pemberian: waktu_pemberian || 3,
      jadwal1:         jadwal1         || null,
      jadwal2:         jadwal2         || null,
      jadwal3:         jadwal3         || null,
      jadwal4:         jadwal4         || null,
      timestamp:       new Date().toISOString()
    })

    mqttClient.publish(topic, payload, { qos: 1 }, async (err) => {
      if (err) {
        console.error('MQTT publish feeder error:', err)
        return res.status(500).json({ status: 'error', message: 'Gagal publish ke MQTT' })
      }

      // Upsert ke feeder.settings
      await pool.query(
        `INSERT INTO feeder.settings
            (codename, codenumber, jenis_pakan, jumlah_ayam, pakan_per_ayam,
             waktu_pemberian, jadwal1, jadwal2, jadwal3, jadwal4,
             updated_at, updated_by, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11,'web')
         ON CONFLICT (codename, codenumber)
         DO UPDATE SET
            jenis_pakan     = EXCLUDED.jenis_pakan,
            jumlah_ayam     = EXCLUDED.jumlah_ayam,
            pakan_per_ayam  = EXCLUDED.pakan_per_ayam,
            waktu_pemberian = EXCLUDED.waktu_pemberian,
            jadwal1         = EXCLUDED.jadwal1,
            jadwal2         = EXCLUDED.jadwal2,
            jadwal3         = EXCLUDED.jadwal3,
            jadwal4         = EXCLUDED.jadwal4,
            updated_at      = NOW(),
            updated_by      = EXCLUDED.updated_by,
            source          = 'web'`,
        [
          codename, codenumber, jenis_pakan, jumlah_ayam, pakan_per_ayam,
          waktu_pemberian, jadwal1 || null, jadwal2 || null,
          jadwal3 || null, jadwal4 || null, req.user.id
        ]
      )

      console.log(`>> MQTT feeder published to ${topic}:`, payload)
      res.json({
        status:  'ok',
        message: 'Pengaturan pakan berhasil dikirim ke MCU',
        topic,
        payload: JSON.parse(payload)
      })
    })

  } catch (err) {
    console.error('>> /feeder/settings ERROR:', err.message)
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// GET /feeder/settings — lihat setting pakan milik user
app.get('/feeder/settings', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT token FROM public.users WHERE id=$1', [req.user.id]
    )
    const userToken = userResult.rows[0]?.token

    if (!userToken && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'User belum punya token MCU' })
    }

    const whereClause = req.user.role === 'admin' ? '' : `WHERE codename = $1`
    const params      = req.user.role === 'admin' ? [] : [userToken]

    const result = await pool.query(
      `SELECT s.*, u.username as updated_by_username
       FROM feeder.settings s
       LEFT JOIN public.users u ON s.updated_by = u.id
       ${whereClause}
       ORDER BY s.updated_at DESC`,
      params
    )

    res.json({ status: 'ok', count: result.rows.length, data: result.rows })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})


// =====================================================================
// ADMIN TABLES
// =====================================================================
// GET /admin/db — lihat isi tabel via browser (admin only, desktop/tablet only)
app.get('/admin/db', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).send('<h2>Access denied — admin only</h2>')
  }

  const table = req.query.table || 'suhu.rawlog'

  const allowedTables = [
    'suhu.rawlog',
    'suhu.settings',
    'feeder.rawlog',
    'feeder.settings',
    'feeder.status_latest',
    'public.users',
    'telegram_subscriptions'
  ]

  if (!allowedTables.includes(table)) {
    return res.status(400).send('<h2>Tabel tidak diizinkan</h2>')
  }

  // Kolom yang dipakai untuk pencarian tergantung tabel
  const searchCol = table === 'public.users' ? 'token' : 'codename'
  const search = (req.query.search || '').trim()

  try {
    const limit  = parseInt(req.query.limit)  || 50
    const offset = parseInt(req.query.offset) || 0

    const whereClause = search ? `WHERE ${searchCol}::text ILIKE $3` : ''
    const queryParams  = search ? [limit, offset, `%${search}%`] : [limit, offset]

    const result = await pool.query(
      `SELECT * FROM ${table} ${whereClause} ORDER BY id DESC LIMIT $1 OFFSET $2`,
      queryParams
    )

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${table} ${search ? `WHERE ${searchCol}::text ILIKE $1` : ''}`,
      search ? [`%${search}%`] : []
    )
    const total = parseInt(countResult.rows[0].count)

    const cols = result.rows.length > 0 ? Object.keys(result.rows[0]) : []

    const searchParam = search ? `&search=${encodeURIComponent(search)}` : ''

    const tableNav = allowedTables.map(t => `
      <a href="/admin/db?table=${t}&limit=${limit}"
         class="nav-pill ${t === table ? 'active' : ''}">
        ${t}
      </a>`).join('')

    const rows = result.rows.map(row => `
      <tr>
        ${cols.map(col => `<td title="${row[col] ?? ''}">${row[col] ?? '<span class="null-val">null</span>'}</td>`).join('')}
      </tr>`).join('')

    const prevOffset = Math.max(0, offset - limit)
    const nextOffset = offset + limit

    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Tables — Golden Chick</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: #f8fafc;
      color: #1f2937;
      min-height: 100vh;
    }

    /* ---------- Header (minimalis) ---------- */
    .header {
      background: white;
      border-bottom: 1px solid #e5e7eb;
      padding: 14px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }
    .header .left {
      display: flex;
      flex-direction: column;
    }
    .header h1 { font-size: 15px; font-weight: 700; color: #1f2937; letter-spacing: 0.2px; }
    .header .sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .back-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      background: #f3f4f6;
      color: #374151;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .back-btn:hover { background: #e5e7eb; border-color: #d1d5db; }

    .container { padding: 28px; max-width: 1400px; margin: 0 auto; }

    /* ---------- Table nav pills ---------- */
    .nav { margin-bottom: 22px; display: flex; flex-wrap: wrap; gap: 8px; }
    .nav-pill {
      padding: 8px 16px;
      border-radius: 999px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      background: white;
      color: #374151;
      border: 1px solid #e5e7eb;
      transition: all 0.15s ease;
    }
    .nav-pill:hover { border-color: #d97706; color: #d97706; }
    .nav-pill.active {
      background: #d97706;
      color: white;
      border-color: #d97706;
      box-shadow: 0 2px 8px rgba(217,119,6,0.35);
    }

    /* ---------- Filter form (limit + search) ---------- */
    .filter-form {
      margin-bottom: 18px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 13px;
      background: white;
      padding: 12px 16px;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
      width: fit-content;
    }
    .filter-form label { color: #6b7280; font-weight: 500; }
    .filter-form input {
      padding: 7px 10px;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      font-size: 13px;
    }
    .filter-form input[name="limit"] { width: 90px; }
    .filter-form input[name="search"] { width: 200px; }
    .filter-form input:focus { outline: none; border-color: #d97706; }
    .filter-form button {
      padding: 7px 16px;
      background: #d97706;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.15s ease;
    }
    .filter-form button:hover { background: #b45309; }
    .filter-form .clear-link {
      font-size: 12.5px;
      color: #9ca3af;
      text-decoration: none;
    }
    .filter-form .clear-link:hover { color: #6b7280; text-decoration: underline; }

    /* ---------- Meta info ---------- */
    .meta {
      margin-bottom: 14px;
      font-size: 13px;
      color: #6b7280;
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }
    .meta strong { color: #1f2937; }

    /* ---------- Table ---------- */
    .table-wrap {
      overflow-x: auto;
      background: white;
      border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.05);
      border: 1px solid #f1f5f9;
    }
    table { width: 100%; border-collapse: collapse; }
    thead { background: #fef3c7; position: sticky; top: 0; }
    th {
      padding: 12px 16px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      color: #92400e;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
      border-bottom: 2px solid #fde68a;
    }
    td {
      padding: 10px 16px;
      border-bottom: 1px solid #f3f4f6;
      font-size: 12.5px;
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    tbody tr:hover td { background: #fffbeb; }
    tbody tr:nth-child(even) td { background: #fafafa; }
    tbody tr:nth-child(even):hover td { background: #fffbeb; }
    .null-val { color: #cbd5e1; font-style: italic; }

    /* ---------- Pagination ---------- */
    .pagination { margin-top: 18px; display: flex; align-items: center; gap: 14px; }
    .pagination a {
      padding: 9px 18px;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      text-decoration: none;
      font-size: 13px;
      color: #374151;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .pagination a:hover { background: #fef3c7; border-color: #d97706; color: #92400e; }
    .pagination span { font-size: 13px; color: #6b7280; }

    /* ---------- Desktop/tablet only lock ---------- */
    .desktop-lock {
      display: none;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 32px;
    }
    .desktop-lock .box {
      background: white;
      border-radius: 16px;
      padding: 32px 24px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
      max-width: 320px;
    }
    .desktop-lock .icon { font-size: 40px; margin-bottom: 12px; }
    .desktop-lock h2 { font-size: 16px; color: #1f2937; margin-bottom: 8px; }
    .desktop-lock p { font-size: 13px; color: #6b7280; line-height: 1.5; }

    @media (max-width: 767px) {
      .header, .container { display: none; }
      .desktop-lock { display: flex; }
    }
  </style>
</head>
<body>

  <!-- Ditampilkan hanya di layar < 768px -->
  <div class="desktop-lock">
    <div class="box">
      <div class="icon">🖥️</div>
      <h2>Khusus Tampilan Desktop / Tablet</h2>
      <p>Halaman Admin Tables dirancang untuk layar lebar agar data mudah dibaca. Silakan buka halaman ini menggunakan laptop, PC, atau tablet.</p>
    </div>
  </div>

  <!-- Konten utama, disembunyikan otomatis di HP lewat CSS -->
  <div class="header">
    <div class="left">
      <h1>Admin Tables</h1>
      <div class="sub">${req.user.username} (${req.user.role})</div>
    </div>
    <a href="${BASE_URL}/admin" class="back-btn">← Kembali ke Admin</a>
  </div>
  <div class="container">
    <div class="nav">${tableNav}</div>

    <form class="filter-form" method="GET" action="/admin/db">
      <input type="hidden" name="table" value="${table}">
      <label>Limit:</label>
      <input type="number" name="limit" value="${limit}" min="1" max="500">
      <label>Cari (${searchCol}):</label>
      <input type="text" name="search" value="${search}" placeholder="ketik ${searchCol}...">
      <button type="submit">Tampilkan</button>
      ${search ? `<a class="clear-link" href="/admin/db?table=${table}&limit=${limit}">Hapus filter</a>` : ''}
    </form>

    <div class="meta">
      <span>Tabel: <strong>${table}</strong></span>
      ${search ? `<span>Filter: <strong>${searchCol} ~ "${search}"</strong></span>` : ''}
      <span>Total: <strong>${total} baris</strong></span>
      <span>Menampilkan: <strong>${total > 0 ? offset + 1 : 0}–${Math.min(offset + limit, total)}</strong></span>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="99" style="padding:32px;text-align:center;color:#9ca3af">Tidak ada data</td></tr>'}</tbody>
      </table>
    </div>

    <div class="pagination">
      ${offset > 0 ? `<a href="/admin/db?table=${table}&limit=${limit}&offset=${prevOffset}${searchParam}">← Sebelumnya</a>` : ''}
      <span>Halaman ${Math.floor(offset / limit) + 1} dari ${Math.max(1, Math.ceil(total / limit))}</span>
      ${nextOffset < total ? `<a href="/admin/db?table=${table}&limit=${limit}&offset=${nextOffset}${searchParam}">Berikutnya →</a>` : ''}
    </div>
  </div>
</body>
</html>`)
  } catch (err) {
    res.status(500).send(`<h2>Error: ${err.message}</h2>`)
  }
})

// =====================================================================
// BASE ROUTES
// =====================================================================
app.get('/',       (req, res) => res.send('Node.js OK'))
app.get('/suhu',   (req, res) => res.json({ status: 'ok', message: 'Endpoint suhu OK' }))
app.get('/feeder', (req, res) => res.json({ status: 'ok', message: 'Endpoint feeder OK' }))

// =====================================================================
// 404
// =====================================================================
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Endpoint tidak ditemukan' })
})

// =====================================================================
// SERVER
// =====================================================================
const PORT = 3000
app.listen(PORT, () => console.log(`>> Node.js running on port ${PORT}`))