/**
 * suhu-data.js — Versi Real (API)
 * Menggantikan data dummy dengan fetch ke backend Node.js
 *
 * Alur:
 * 1. Fetch /suhu/rawlog/latest → dapat data per codenumber (kandang) milik user
 * 2. Fetch /suhu/rawlog/hourly?codenumber=X → grafik rata-rata per jam
 * 3. Deteksi offline → created_at terakhir > 10 menit → showOfflineView()
 * 4. Guest → user tidak punya token (API return 403) → showGuestView()
 */

// ========== KONFIGURASI SUHU PER KOMBINASI JENIS + FASE ==========
const KONFIGURASI_SUHU = {
    'doc_broiler':     { min: 28, max: 32, target: 30   },
    'doc_layer':       { min: 31, max: 33, target: 32   },
    'doc_kampung':     { min: 32, max: 35, target: 33.5 }
}

// ========== STATE ==========
let kandangSuhuData = {}   // { codenumber: [array suhu per jam, bisa null untuk gap] }
let kandangSettings = {}   // { codenumber: { jenis, fase } }
let kandangLatest   = {}   // { codenumber: data terbaru dari API }
let jamLabels       = []
let allCodenumbers  = []   // list codenumber (kandang) milik user, dari API

// ========== THRESHOLD OFFLINE ==========
// MCU kirim tiap 2 menit, offline jika tidak ada data > 10 menit
const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000

function isOffline(createdAt) {
    if (!createdAt) return true
    const lastTime = new Date(createdAt).getTime()
    return (Date.now() - lastTime) > OFFLINE_THRESHOLD_MS
}

// ========== KONFIGURASI SUHU ==========
function getKonfigurasiSuhu(jenis, fase) {
    const key = `${fase}_${jenis}`
    return KONFIGURASI_SUHU[key] || KONFIGURASI_SUHU['doc_broiler']
}

function getSuhuRangeKandang(kandangId) {
    const settings = kandangSettings[kandangId]
    if (!settings) return { min: 32, max: 34, target: 33 }
    return getKonfigurasiSuhu(settings.jenis, settings.fase)
}

function getAvailableKandangIds() {
    return allCodenumbers.length > 0
        ? allCodenumbers
        : Object.keys(kandangSettings)
}

function getJumlahKandang() {
    return getAvailableKandangIds().length
}

// ========== GENERATE LABEL WAKTU (fallback) ==========
function generateTimeLabels(count = 12) {
    const labels = []
    for (let i = count - 1; i >= 0; i--) {
        const d = new Date()
        d.setHours(d.getHours() - i, 0, 0, 0)
        labels.push(d.getHours() + ':00')
    }
    return labels
}

// ========== FETCH LATEST — semua kandang milik user ==========
async function fetchAllLatest() {
    try {
        const res = await fetch('/suhu/rawlog/latest', { credentials: 'include' })
        console.log('STEP 1 - res.status:', res.status)

        if (res.status === 401) {
            window.location.href = '/login'
            return false
        }

        if (res.status === 403) {
            showGuestView()
            return false
        }

        const data = await res.json()
        console.log('STEP 2 - data:', data)

        allCodenumbers.length = 0

        if (data.status !== 'ok' || data.count === 0) {
            console.log('STEP 3 - masuk offline view, count:', data.count)
            showOfflineView()
            return false
        }

        console.log('STEP 4 - mulai forEach, data.data.length:', data.data.length)

        data.data.forEach(row => {
            const key = String(row.codenumber || '1')
            console.log('STEP 5 - processing key:', key)

            if (!allCodenumbers.includes(key)) {
                allCodenumbers.push(key)
            }

            kandangLatest[key] = row

            if (!kandangSettings[key]) {
                kandangSettings[key] = { jenis: 'kampung', fase: 'doc' }
            }
        })

        console.log('STEP 6 - allCodenumbers final:', allCodenumbers)

        allCodenumbers.sort((a, b) => Number(a) - Number(b))
        return true
    } catch (err) {
        console.error('fetchAllLatest error:', err)
        showOfflineView()
        return false
    }
}

// ========== FETCH LATEST UNTUK 1 KANDANG (dipanggil tiap 5 detik) ==========
async function fetchLatestSuhuFromMCU(codenumber) {
    try {
        const res  = await fetch('/suhu/rawlog/latest', { credentials: 'include' })
        const data = await res.json()
        if (data.status !== 'ok') return { suhu: '--', timestamp: null, offline: true }

        const row = data.data.find(r => String(r.codenumber) === String(codenumber))
        if (!row) return { suhu: '--', timestamp: null, offline: true }

        kandangLatest[codenumber] = row

        const offline = isOffline(row.created_at)
        if (offline) {
            showOfflineView()
            return { suhu: '--', timestamp: row.created_at, offline: true }
        }

        return {
            codenumber: codenumber,
            suhu:       parseFloat(row.temperature),
            timestamp:  row.created_at,
            offline:    false,
            power:      row.power,
            mode:       row.mode,
            status:     row.status,
            rssi:       row.rssi,
            setpoint:        row.setpoint,
            limit_low_temp:  row.limit_low_temp,
            limit_high_temp: row.limit_high_temp,
        }
    } catch (err) {
        console.error('fetchLatestSuhuFromMCU error:', err)
        return { suhu: '--', timestamp: null, offline: true }
    }
}

// ========== FETCH HOURLY — rata-rata per jam, 12 jam terakhir ==========
async function fetchHourlySuhu(codenumber) {
    try {
        const res  = await fetch(
            `/suhu/rawlog/hourly?codenumber=${codenumber}`,
            { credentials: 'include' }
        )
        const data = await res.json()
        if (data.status !== 'ok') return []

        // Buat slot 12 jam terakhir (waktu lokal browser), isi null kalau tidak ada data
        const now    = new Date()
        const labels = []
        const values = []

        for (let i = 11; i >= 0; i--) {
            const d = new Date(now)
            d.setHours(d.getHours() - i, 0, 0, 0)

            const slotYear  = d.getFullYear()
            const slotMonth = String(d.getMonth() + 1).padStart(2, '0')
            const slotDay   = String(d.getDate()).padStart(2, '0')
            const slotHour  = String(d.getHours()).padStart(2, '0')
            const slotStr   = `${slotYear}-${slotMonth}-${slotDay}T${slotHour}:00:00`

            labels.push(slotHour + ':00')

            const match = data.data.find(r => r.jam === slotStr)
            values.push(match ? parseFloat(match.avg_suhu) : null)
        }

        kandangSuhuData[codenumber] = values
        jamLabels.length = 0
        jamLabels.push(...labels)

        return values
    } catch (err) {
        console.error('fetchHourlySuhu error:', err)
        return []
    }
}

// Wrapper supaya kompatibel dengan nama fungsi lama (dipanggil sebagai history)
async function fetchHistorySuhu(codenumber) {
    return await fetchHourlySuhu(codenumber)
}

// ========== TAMPILKAN GUEST VIEW ==========
function showGuestView() {
    const content   = document.getElementById('kandangContent')
    const select    = document.getElementById('kandangSelect')
    const countSpan = document.getElementById('kandangCount')
    if (select)    select.innerHTML    = `<option value="" disabled selected>Tidak ada kandang</option>`
    if (countSpan) countSpan.innerText = '0'

    // Ambil data user dari sessionStorage
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

    const mailtoGuest = `mailto:goldenchickapp@yahoo.com?subject=${subject}&body=${body}`

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
                <a href="${mailtoGuest}"
                   class="inline-flex items-center justify-center gap-2 bg-gray-600 hover:bg-gray-700 text-white font-semibold py-3 px-6 rounded-xl transition-all shadow-md">
                    <i class="fa-solid fa-envelope text-lg"></i>
                    <span>Hubungi via Email</span>
                </a>
                <p class="text-xs text-gray-400 mt-6">
                    <i class="fa-solid fa-clock"></i>
                    <a href="panduan.pdf" download class="underline ml-1">Klik disini</a> untuk mengunduh panduan penggunaan aplikasi.
                </p>
            </div>
        </div>`
}

// ========== TAMPILKAN OFFLINE VIEW ==========
function showOfflineView() {
    const content = document.getElementById('kandangContent')
    if (!content) return

    const userSession = JSON.parse(sessionStorage.getItem('user') || '{}')
    const token       = userSession.token || 'none'

    const now  = new Date()
    const date = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const time = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

    const subject = encodeURIComponent('Masalah Data Tidak Terkirim')
    const body    = encodeURIComponent(
`Token   : ${token}
Tanggal : ${date}
Waktu   : ${time}

Keterangan masalah:
[Tuliskan keterangan masalah Anda di sini]

Foto:
[lampirkan foto kondisi perangkat/kandang]`)

    const mailtoOffline = `mailto:goldenchickapp@yahoo.com?subject=${subject}&body=${body}`

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
                <a href="${mailtoOffline}"
                   class="ml-3 inline-flex items-center gap-2 bg-gray-600 hover:bg-gray-700 text-white font-semibold py-3 px-6 rounded-xl transition-all shadow-md">
                    <i class="fa-solid fa-envelope"></i>
                    <span>Hubungi Support</span>
                </a>
            </div>
        </div>`
}

// ========== INIT — dipanggil pertama kali oleh suhu-main.js ==========
async function initSuhuData() {
    const ok = await fetchAllLatest()
    if (!ok) return false

    // Fetch history (hourly) untuk semua kandang milik user
    for (const key of allCodenumbers) {
        await fetchHourlySuhu(key)
    }

    return true
}

// ========== EKSPOR GLOBAL ==========
window.SuhuData = {
    KONFIGURASI_SUHU,
    kandangSuhuData,
    kandangSettings,
    kandangLatest,
    allCodenumbers,
    jamLabels,
    fetchLatestSuhuFromMCU,
    fetchHistorySuhu,
    fetchHourlySuhu,
    generateTimeLabels,
    getKonfigurasiSuhu,
    getSuhuRangeKandang,
    getAvailableKandangIds,
    getJumlahKandang,
    isOffline,
    showGuestView,
    showOfflineView,
    initSuhuData,
}