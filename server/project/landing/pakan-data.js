/**
 * pakan-data.js — Versi Real (API)
 * Menggantikan data dummy dengan fetch ke backend Node.js
 *
 * Alur:
 * 1. GET /feeder/rawlog         → hanya event (dispensing), bukan heartbeat
 * 2. GET /feeder/status/latest  → status stok real-time dari heartbeat cache
 * 3. Deteksi offline → tidak ada update > 10 menit → showOfflineView()
 * 4. Guest → user tidak punya token (API return 403) → showGuestView()
 *
 * Catatan penting:
 * - `waktu_pakan` di row adalah waktu dispensing di MCU (bisa jauh sebelum
 *   created_at server, misal device offline lama lalu online lagi)
 * - `created_at` adalah waktu row masuk ke server — JANGAN pakai ini
 *   sebagai waktu kejadian dispensing
 * - Status stok real-time diambil dari /feeder/status/latest (heartbeat cache),
 *   bukan dari kolom status_stok di rawlog
 */

// ========== KONFIGURASI ==========
const CONFIG = {
    LOG_LIMIT:             200,
    RIWAYAT_PER_KANDANG:   15,
    REFRESH_INTERVAL_MS:   300000,   // 5 menit
    OFFLINE_THRESHOLD_MS:  600000    // 10 menit tanpa heartbeat = offline
}

// ========== STATE ==========
let kandangSettings = {}   // { [codenumber]: { codename, jenisPakan, frekuensi, jumlahAyam, gramPerEkor } }
let jadwalPakan     = {}   // { [codenumber]: ['06:00', '11:00', ...] }
let riwayatPakan    = {}   // { [codenumber]: [{ id, waktu_pakan, jenis_pakan, ... }] }
let deviceStatus    = {}   // { [codenumber]: { status_stok, jarak_ultrasonik, status, rssi, updated_at } }
let allCodenumbers  = []   // list codenumber dari backend
let lastError       = null
let refreshTimer    = null
let viewState = 'loading'  // 'loading' | 'guest' | 'offline' | 'ready'

// ========== HELPER ==========
function formatWaktuPakanWIB(isoStr) {
    // Pakai waktu_pakan dari MCU (bukan created_at server)
    // Format: "2026-07-12T06:00:05+07:00" → "12/07 06:00"
    try {
        if (!isoStr) return '-'
        // Parse manual supaya tidak kena konversi UTC browser
        const d = new Date(isoStr)
        if (isNaN(d.getTime())) return isoStr.slice(0, 16).replace('T', ' ')
        // Kalau string sudah ada offset +07:00, new Date() akan handle dengan benar
        const dd = String(d.getDate()).padStart(2, '0')
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const hh = String(d.getHours()).padStart(2, '0')
        const mi = String(d.getMinutes()).padStart(2, '0')
        return `${dd}/${mm} ${hh}:${mi}`
    } catch {
        return '-'
    }
}

function trimJamDetik(jamStr) {
    if (!jamStr) return null
    return jamStr.length >= 5 ? jamStr.slice(0, 5) : jamStr
}

// ========== DETEKSI OFFLINE ==========
// Berdasarkan updated_at dari heartbeat cache (/feeder/status/latest)
function isOffline(updatedAt) {
    if (!updatedAt) return true
    const lastTime = new Date(updatedAt).getTime()
    return (Date.now() - lastTime) > CONFIG.OFFLINE_THRESHOLD_MS
}

// ========== FETCH RAW LOG (event saja, heartbeat tidak disimpan di DB) ==========
async function fetchRawLog() {
    try {
        const res = await fetch(`/feeder/rawlog?limit=${CONFIG.LOG_LIMIT}`, {
            credentials: 'include'
        })

        if (res.status === 401) {
            window.location.href = '/login'
            return null
        }
        if (res.status === 403) {
            showGuestView()
            return null  // null = sudah handle, stop initData
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const data = await res.json()
        console.log(`[FETCH] rawlog: ${data.count} event`)
        return data
    } catch (err) {
        console.error('[FETCH] rawlog error:', err.message)
        throw err
    }
}

// ========== FETCH STATUS REAL-TIME (dari heartbeat cache di backend) ==========
async function fetchStatusLatest() {
    try {
        const res = await fetch('/feeder/status/latest', { credentials: 'include' })

        if (res.status === 401) {
            window.location.href = '/login'
            return null
        }
        if (res.status === 403) {
            showGuestView()
            return null  // null = sudah handle, stop initData
        }
        if (!res.ok) return { status: 'error', count: 0, data: [] }

        const data = await res.json()
        console.log(`[FETCH] status latest: ${data.count} device`)
        return data
    } catch (err) {
        console.error('[FETCH] status latest error:', err.message)
        return { status: 'error', count: 0, data: [] }
    }
}

// ========== PROSES RAW LOG → STATE ==========
function processRawLog(rawLogs) {
    const newRiwayat = {}
    const codenameFromLog = {}
    const now = Date.now()
    const BATAS_TAMPIL_MS = 24 * 60 * 60 * 1000 // 24 jam

    rawLogs.forEach(row => {
        const id = String(row.codenumber)

        if (row.codename) codenameFromLog[id] = row.codename

        // Data TETAP masuk dari backend, cuma tidak dimasukkan ke tampilan
        // kalau waktu_pakan-nya sudah lebih dari 24 jam yang lalu.
        const waktuMs = new Date(row.waktu_pakan).getTime()
        const sudahLewat24Jam = !isNaN(waktuMs) && (now - waktuMs) > BATAS_TAMPIL_MS
        if (sudahLewat24Jam) return // skip render, tapi baris asli di DB tidak diapa-apakan

        if (!newRiwayat[id]) newRiwayat[id] = []

        if (newRiwayat[id].length < CONFIG.RIWAYAT_PER_KANDANG) {
            newRiwayat[id].push({
                id:          row.id,
                waktu_pakan:  formatWaktuPakanWIB(row.waktu_pakan),
                jenis_pakan:  row.jenis_pakan  || '-',
                target_gram:  row.target_gram  ?? '-',
                aktual_gram:  row.aktual_gram  ?? '-',
                out_gram:     row.out_gram     ?? '-',
                status_pakan: row.status_pakan || '-',
                status_stok:  row.status_stok  || '-',
                publish_type: row.publish_type || 'event'
            })
        }
    })

    riwayatPakan = newRiwayat
    return codenameFromLog
}

// ========== PROSES STATUS LATEST → deviceStatus ==========
function processStatusLatest(statusData) {
    const newStatus = {}
    statusData.forEach(row => {
        const id = String(row.codenumber)
        newStatus[id] = {
            status_stok:      row.status_stok      || '-',
            jarak_ultrasonik: row.jarak_ultrasonik || 0,
            status:           row.status           || 'offline',
            rssi:             row.rssi             || 0,
            updated_at:       row.updated_at       || null
        }
    })
    deviceStatus = newStatus
}

// ========== DEFAULT SETTINGS ==========
function getDefaultSetting(id, codename) {
    return {
        codename:   codename || `Kandang ${id}`,
        jenisPakan: 'pelet',
        frekuensi:  2,
        jumlahAyam: 10,
        gramPerEkor: 20
    }
}

function getDefaultJadwal(frekuensi) {
    const defaultTimes = ['06:00', '15:00', null, null]
    return defaultTimes.slice(0, frekuensi || 3)
}

// ========== SAVE SETTING PAKAN (stub — MQTT belum implement di feeder) ==========
async function saveSettingPakan(codenumber, formData) {
    const res = await fetch('/feeder/settings', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            kandang_id:      codenumber,
            jenis_pakan:     formData.jenisPakan,
            jumlah_ayam:     formData.jumlahAyam,
            pakan_per_ayam:  formData.gramPerEkor,
            waktu_pemberian: formData.frekuensi,
            jadwal1:         formData.jadwal1 ? formData.jadwal1 + ':00' : null,
            jadwal2:         formData.jadwal2 ? formData.jadwal2 + ':00' : null,
            jadwal3:         formData.jadwal3 ? formData.jadwal3 + ':00' : null,
            jadwal4:         formData.jadwal4 ? formData.jadwal4 + ':00' : null,
        })
    })

    const data = await res.json()
    if (data.status !== 'ok') {
        throw new Error(data.message || 'Gagal kirim ke MCU')
    }

    // Update local state
    updateLocalSetting(codenumber, formData)
    return data
}

function updateLocalSetting(codenumber, formData) {
    kandangSettings[codenumber] = {
        codename:    formData.codename    || kandangSettings[codenumber]?.codename || `Kandang ${codenumber}`,
        jenisPakan:  formData.jenisPakan  || 'jagung',
        frekuensi:   formData.frekuensi   || 3,
        jumlahAyam:  formData.jumlahAyam  || 0,
        gramPerEkor: formData.gramPerEkor || 0
    }

    const frek = formData.frekuensi || 3
    jadwalPakan[codenumber] = [
        formData.jadwal1,
        formData.jadwal2,
        formData.jadwal3,
        formData.jadwal4
    ].slice(0, frek).map(t => trimJamDetik(t) || null)
}

// ========== TAMPILKAN GUEST VIEW ==========
function showGuestView() {
    viewState = 'guest'
    const content   = document.getElementById('kandangContent')
    const select    = document.getElementById('kandangSelect')
    const countSpan = document.getElementById('kandangCount')

    if (select)    select.innerHTML    = `<option value="" disabled selected>Tidak ada kandang</option>`
    if (countSpan) countSpan.innerText = '0'

    const userSession = JSON.parse(sessionStorage.getItem('user') || '{}')
    const username    = userSession.username   || 'tidak diketahui'
    const peternakan  = userSession.peternakan || 'tidak diketahui'

    const subject = encodeURIComponent('Mendaftar Akun Baru - Permintaan Token MCU')
    const body    = encodeURIComponent(
`Username    : ${username}
Peternakan  : ${peternakan}
Alamat      : [isi alamat peternakan Anda]
No. HP      : [isi nomor HP Anda]

Foto Peternakan:
[lampirkan foto peternakan Anda]`)

    if (content) content.innerHTML = `
        <div class="col-span-full flex items-center justify-center min-h-[60vh] p-6">
            <div class="text-center max-w-md">
                <div class="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <i class="fa-solid fa-lock text-gray-400 text-3xl"></i>
                </div>
                <h1 class="text-2xl font-bold text-gray-800 mb-3">⚠️ User Tidak Memiliki Akses Data</h1>
                <p class="text-gray-500 text-sm mb-6">Akun Anda belum terhubung dengan perangkat MCU. Hubungi admin untuk mendapatkan akses.</p>
                <div class="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-left">
                    <p class="text-xs font-semibold text-amber-700 mb-2">
                        <i class="fa-solid fa-lightbulb mr-1"></i> Cara mendapatkan akses:
                    </p>
                    <ul class="text-xs text-gray-600 space-y-1.5">
                        <li class="flex items-start gap-2">
                            <i class="fa-solid fa-envelope text-amber-500 mt-0.5"></i>
                            <span>Hubungi admin untuk mendaftarkan alat ke akun Anda</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fa-solid fa-microchip text-amber-500 mt-0.5"></i>
                            <span>Pastikan perangkat sudah terpasang di kandang</span>
                        </li>
                    </ul>
                </div>
                <a href="mailto:goldenchickapp@yahoo.com?subject=${encodeURIComponent('Mendaftar Akun Baru - Permintaan Token MCU')}"
                   class="inline-flex items-center justify-center gap-2 bg-gray-600 hover:bg-gray-700 text-white font-semibold py-3 px-6 rounded-xl transition-all shadow-md">
                    <i class="fa-solid fa-envelope text-lg"></i>
                    <span>Hubungi via Email</span>
                </a>
            </div>
        </div>`
}

// ========== TAMPILKAN OFFLINE VIEW ==========
function showOfflineView() {
    viewState = 'offline'
    const content = document.getElementById('kandangContent')
    if (!content) return

    const userSession = JSON.parse(sessionStorage.getItem('user') || '{}')
    const token       = userSession.token || 'none'
    const now         = new Date()
    const date        = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const time        = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

    const subject = encodeURIComponent('Masalah Data Tidak Terkirim - Feeder')
    const body    = encodeURIComponent(
`Token   : ${token}
Tanggal : ${date}
Waktu   : ${time}

Keterangan masalah:
[Tuliskan keterangan masalah Anda di sini]`)

    content.innerHTML = `
        <div class="col-span-full flex items-center justify-center min-h-[60vh] p-6">
            <div class="text-center max-w-md">
                <div class="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <i class="fa-solid fa-triangle-exclamation text-red-500 text-3xl"></i>
                </div>
                <h1 class="text-2xl font-bold text-gray-800 mb-3">⚠️ Data Tidak Terkirim</h1>
                <p class="text-gray-500 text-sm mb-6">Perangkat tidak mengirimkan data lebih dari 10 menit.</p>
                <div class="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-left">
                    <p class="text-xs font-semibold text-amber-700 mb-2">
                        <i class="fa-solid fa-lightbulb mr-1"></i> Saran Perbaikan:
                    </p>
                    <ul class="text-xs text-gray-600 space-y-1.5">
                        <li class="flex items-start gap-2">
                            <i class="fa-solid fa-plug text-amber-500 mt-0.5"></i>
                            <span>Periksa kabel power dan pastikan alat menyala</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fa-solid fa-wifi text-amber-500 mt-0.5"></i>
                            <span>Cek koneksi internet / sinyal modem</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fa-solid fa-arrows-rotate text-amber-500 mt-0.5"></i>
                            <span>Restart ulang perangkat</span>
                        </li>
                    </ul>
                </div>
                <button onclick="location.reload()"
                    class="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white font-semibold py-3 px-6 rounded-xl transition-all shadow-md">
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span>Coba Lagi</span>
                </button>
                <a href="mailto:goldenchickapp@yahoo.com?subject=${subject}&body=${body}"
                   class="ml-3 inline-flex items-center gap-2 bg-gray-600 hover:bg-gray-700 text-white font-semibold py-3 px-6 rounded-xl transition-all shadow-md">
                    <i class="fa-solid fa-envelope"></i>
                    <span>Hubungi Support</span>
                </a>
            </div>
        </div>`
}

// ========== INIT DATA ==========
async function initData() {
    console.log('[INIT] Memulai inisialisasi data pakan...')
    lastError = null
    allCodenumbers.length = 0
    viewState = 'loading'

    // 1. Fetch status real-time dulu — kalau 403, langsung guest, stop
    let statusData = null
    try {
        const statusRes = await fetchStatusLatest()
        if (statusRes === null) return false  // 403/401 sudah handle di fetchStatusLatest
        if (statusRes && statusRes.status === 'ok' && statusRes.count > 0) {
            statusData = statusRes.data
            processStatusLatest(statusData)
        }
    } catch (err) {
        console.warn('[INIT] fetchStatusLatest error:', err.message)
    }

    // 2. Fetch raw log — kalau 403, langsung guest, stop
    let rawLogData = null
    try {
        const rawRes = await fetchRawLog()
        if (rawRes === null) return false  // 403/401 sudah handle di fetchRawLog
        if (rawRes && rawRes.status === 'ok') {
            rawLogData = rawRes.data || []
        }
    } catch (err) {
        lastError = err.message
        console.warn('[INIT] fetchRawLog error:', err.message)
        showOfflineView()
        return false
    }

    // 3. Tentukan daftar kandang
    const idsFromStatus = statusData ? statusData.map(r => String(r.codenumber)) : []
    const idsFromLog    = rawLogData ? [...new Set(rawLogData.map(r => String(r.codenumber)))] : []
    const discoveredIds = [...new Set([...idsFromStatus, ...idsFromLog])]
        .sort((a, b) => Number(a) - Number(b))

    if (discoveredIds.length === 0) {
        showOfflineView()
        return false
    }

    // 4. Cek offline
    // Kalau tidak ada heartbeat sama sekali (statusData kosong/null)
    // DAN ada rawlog → berarti alat pernah kirim event tapi sekarang offline
    // Tampilkan offline view kalau kondisi ini terpenuhi
    const adaHeartbeat = statusData && statusData.length > 0
    const allOfflineByHeartbeat = adaHeartbeat && discoveredIds.every(id => {
        const d = deviceStatus[id]
        return !d || isOffline(d.updated_at)
    })

    if (!adaHeartbeat || allOfflineByHeartbeat) {
        // Update deviceStatus semua jadi offline (untuk keperluan lain / logging)
        discoveredIds.forEach(id => {
            if (!deviceStatus[id]) {
                deviceStatus[id] = {
                    status_stok: '-', jarak_ultrasonik: 0,
                    status: 'offline', rssi: 0, updated_at: null
                }
            }
        })

        // Konsisten dengan logika di startAutoRefresh():
        // kalau heartbeat basi/tidak ada → alat dianggap mati SEKARANG,
        // rawlog cuma riwayat lama, bukan bukti alat hidup saat ini.
        showOfflineView()
        return false
    }

    // 5. Proses rawlog
    let codenameFromLog = {}
    if (rawLogData?.length) {
        codenameFromLog = processRawLog(rawLogData)
    }

    // 6. Setup state
    allCodenumbers.push(...discoveredIds)
    viewState = 'ready'

    discoveredIds.forEach(id => {
        const codename = codenameFromLog[id]
            || statusData?.find(r => String(r.codenumber) === id)?.codename
            || `Kandang ${id}`
        if (!kandangSettings[id]) kandangSettings[id] = getDefaultSetting(id, codename)
        if (!jadwalPakan[id])     jadwalPakan[id]     = getDefaultJadwal(3)
        if (!deviceStatus[id])    deviceStatus[id]    = {
            status_stok: '-', jarak_ultrasonik: 0, status: 'offline', rssi: 0, updated_at: null
        }
    })

    console.log(`[INIT] Selesai. ${discoveredIds.length} kandang: ${discoveredIds.join(', ')}`)
    startAutoRefresh()
    return true
}

// ========== AUTO REFRESH ==========
function startAutoRefresh() {
    stopAutoRefresh()
    refreshTimer = setInterval(async () => {
        console.log('[AUTO-REFRESH] Memperbarui data...')
        try {
            await refreshRiwayat()

            // Cek offline — kalau semua kandang tidak ada heartbeat > 10 menit
            const ids = getAvailableKandangIds()
            const allOffline = ids.every(id => {
                const d = deviceStatus[id]
                return !d || isOffline(d.updated_at)
            })

            if (allOffline && ids.length > 0) {
                showOfflineView()
                return
            }

            // Kalau balik online setelah offline
            if (viewState === 'offline' && !allOffline) {
                viewState = 'ready'
            }

            window.dispatchEvent(new CustomEvent('pakan-data-updated'))
        } catch (err) {
            console.warn('[AUTO-REFRESH] Gagal:', err.message)
        }
    }, CONFIG.REFRESH_INTERVAL_MS)
}

function stopAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer)
        refreshTimer = null
    }
}

async function refreshRiwayat() {
    // Refresh keduanya: status real-time + log event
    const [statusRes, rawRes] = await Promise.allSettled([
        fetchStatusLatest(),
        fetchRawLog()
    ])

    if (statusRes.status === 'fulfilled' && statusRes.value?.status === 'ok') {
        processStatusLatest(statusRes.value.data || [])
    }

    if (rawRes.status === 'fulfilled' && rawRes.value?.status === 'ok') {
        processRawLog(rawRes.value.data || [])
    }
}

// ========== FUNGSI BANTU UNTUK UI ==========
function getAvailableKandangIds() {
    return allCodenumbers.length > 0
        ? [...allCodenumbers]
        : Object.keys(kandangSettings)
}

function getJumlahKandang() {
    return getAvailableKandangIds().length
}

// ========== EKSPOR ==========
window.PakanData = {
    CONFIG,
    get kandangSettings() { return kandangSettings },
    get jadwalPakan()     { return jadwalPakan     },
    get riwayatPakan()    { return riwayatPakan    },
    get deviceStatus()    { return deviceStatus    },
    get allCodenumbers()  { return allCodenumbers  },
    get lastError()       { return lastError       },
    get viewState() { return viewState },
    getAvailableKandangIds,
    getJumlahKandang,
    initData,
    refreshRiwayat,
    saveSettingPakan,
    stopAutoRefresh,
    startAutoRefresh,
    showGuestView,
    showOfflineView,
    isOffline
}

window.addEventListener('beforeunload', () => stopAutoRefresh())