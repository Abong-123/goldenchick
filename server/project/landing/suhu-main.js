/**
 * suhu-main.js
 * File ini berisi logika rendering, chart, dan event handling.
 * Data diambil dari API real via suhu-data.js
 */

// ========== GLOBAL STATE ==========
let currentKandang = null;
let currentChart   = null;

// ========== FUNGSI BANTU ==========
function getEffectiveSuhuRange(settings) {
    const konfig = SuhuData.getKonfigurasiSuhu(settings.jenis, settings.fase);
    return {
        min:    konfig.min,
        max:    konfig.max,
        target: konfig.target
    };
}

function getCurrentSettingsPayload() {
    const settings = SuhuData.kandangSettings[currentKandang];
    const minInput = document.getElementById('suhuMinInput');
    const maxInput = document.getElementById('suhuMaxInput');

    const suhuMin = minInput ? parseFloat(minInput.value) : getEffectiveSuhuRange(settings).min;
    const suhuMax = maxInput ? parseFloat(maxInput.value) : getEffectiveSuhuRange(settings).max;
    const target  = ((suhuMin + suhuMax) / 2);

    return {
        kandang_id: currentKandang,
        jenis:      settings.jenis,
        fase:       settings.fase,
        suhuMin:    suhuMin,
        suhuMax:    suhuMax,
        target:     parseFloat(target.toFixed(1)),
        timestamp:  new Date().toISOString()
    };
}

function showConfirmModal() {
    const modal        = document.getElementById('confirmModal');
    const details      = document.getElementById('confirmModalDetails');
    const kandangLabel = document.getElementById('confirmModalKandang');
    const payload      = getCurrentSettingsPayload();
    if (kandangLabel) kandangLabel.innerText = `Kandang ${payload.kandang_id}`;
    if (details)      details.innerText      = `Jenis: ${payload.jenis}, Fase: ${payload.fase}, Min ${payload.suhuMin}°C, Max ${payload.suhuMax}°C, Target ${payload.target}°C`;
    modal?.classList.remove('hidden');
}

function closeConfirmModal() {
    document.getElementById('confirmModal')?.classList.add('hidden');
}

async function publishMqttSettings(payload) {
    const res  = await fetch('/suhu/settings', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify(payload)
    })
    const data = await res.json()
    if (data.status !== 'ok') {
        throw new Error(data.message || 'Gagal kirim ke MCU')
    }
    return data
}

// ========== RENDER KANDANG DROPDOWN ==========
function renderKandangDropdown() {
    const kandangIds = SuhuData.getAvailableKandangIds();

    if (!kandangIds.length) {
        const select = document.getElementById('kandangSelect');
        if (select) {
            select.innerHTML = `<option value="" disabled selected>⏳ Menunggu data kandang...</option>`;
        }
        const countSpan = document.getElementById('kandangCount');
        if (countSpan) countSpan.innerText = '0';
        return;
    }

    if (!kandangIds.includes(currentKandang)) {
        currentKandang = kandangIds[0];
    }

    const select = document.getElementById('kandangSelect');
    if (!select) return;

    const countSpan = document.getElementById('kandangCount');
    if (countSpan) countSpan.innerText = kandangIds.length;

    const optionsHtml = kandangIds.map(id => {
        const isActive = id === currentKandang;
        return `
            <option value="${id}" ${isActive ? 'selected' : ''}>
                🏚️ Kandang ${id}
            </option>
        `;
    }).join('');

    select.innerHTML = `
        <option value="" disabled ${!currentKandang ? 'selected' : ''}>Pilih Kandang</option>
        ${optionsHtml}
    `;

    select.onchange = function() {
        const id = this.value;
        if (id && id !== currentKandang) {
            switchKandang(id);
        }
    };
}

// ========== RENDER KONTEN KANDANG ==========
function renderKandangContent() {
    renderKandangDropdown();

    const ids = SuhuData.getAvailableKandangIds();
    if (!ids.length) {
        const container = document.getElementById('kandangContent');
        container.innerHTML = `
            <div class="col-span-full flex items-center justify-center py-12">
                <div class="text-center">
                    <i class="fa-solid fa-circle-notch fa-spin text-amber-500 text-3xl mb-3"></i>
                    <p class="text-gray-500 text-sm">Menunggu data dari MCU...</p>
                    <p class="text-gray-400 text-xs mt-1">Data kandang akan muncul otomatis</p>
                </div>
            </div>
        `;
        return;
    }

    const settings    = SuhuData.kandangSettings[currentKandang] || { jenis: 'broiler', fase: 'doc' };
    const suhuRange   = getEffectiveSuhuRange(settings);
    const suhuHistory = SuhuData.kandangSuhuData[currentKandang] || [];

    // Ambil dari data MCU terbaru kalau ada, fallback ke settings lokal
    const latest     = SuhuData.kandangLatest[currentKandang];
    const targetTemp = latest?.setpoint        != null ? parseFloat(latest.setpoint)        : suhuRange.target;
    const rangeMin   = latest?.limit_low_temp  != null ? parseFloat(latest.limit_low_temp)  : suhuRange.min;
    const rangeMax   = latest?.limit_high_temp != null ? parseFloat(latest.limit_high_temp) : suhuRange.max;

    const html = `
        <div class="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 items-start">
            <!-- Kiri: Grafik -->
            <div class="bg-white rounded-xl shadow-sm p-4 overflow-hidden flex flex-col" style="height: 100%; max-height: 520px;">
                <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
                    <div>
                        <h3 class="text-sm font-semibold text-gray-700">
                            <i class="fa-solid fa-chart-line text-amber-500"></i>
                            Grafik Suhu Kandang ${currentKandang} (Rata-rata Per Jam, 12 Jam Terakhir)
                        </h3>
                        <p class="text-xs text-gray-400 mt-0.5"><i class="fa-regular fa-clock"></i> Refresh tiap 1 jam</p>
                    </div>
                </div>
                <div class="chart-container-custom flex-1" style="min-height: 320px; height: 100%; max-height: 600px; position: relative;">
                    <canvas id="suhuChart"></canvas>
                </div>
            </div>

            <!-- Kanan: Card Suhu + Pengaturan -->
            <div class="flex flex-col gap-3" style="height: 100%; max-height: 520px;">
                <!-- Card Suhu -->
                <div class="bg-white rounded-xl shadow-sm p-4">
                    <div class="flex items-center justify-between">
                        <div class="flex-1">
                            <div class="flex items-center gap-1.5 mb-0.5">
                                <i class="fa-solid fa-thermometer-half text-amber-500 text-xs"></i>
                                <span class="text-[10px] font-medium text-gray-400 uppercase">Suhu</span>
                            </div>
                            <p class="text-xl font-bold text-gray-800">
                                <span id="currentTemp">--</span><span class="text-sm font-normal text-gray-400">°C</span>
                            </p>
                            <span class="text-[10px] text-gray-400" id="tempStatus">--</span>
                        </div>
                        <div class="w-px h-12 bg-gray-200 mx-4"></div>
                        <div class="flex-1">
                            <div class="flex items-center gap-1.5 mb-0.5">
                                <i class="fa-solid fa-bullseye text-blue-400 text-xs"></i>
                                <span class="text-[10px] font-medium text-gray-400 uppercase">Target</span>
                            </div>
                            <p class="text-xl font-bold text-gray-800">
                                <span id="targetTemp">${targetTemp}</span><span class="text-sm font-normal text-gray-400">°C</span>
                            </p>
                            <span class="text-[10px] text-gray-400">
                                <span id="suhuRange">${rangeMin} - ${rangeMax}</span>°C
                            </span>
                        </div>
                    </div>
                </div>

                <!-- Pengaturan -->
                <div class="bg-white rounded-xl shadow-sm p-3">
                    <div class="mb-2">
                        <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-0.5">
                            <i class="fa-solid fa-kiwi-bird text-amber-500 text-[10px]"></i> Jenis Ayam
                        </label>
                        <select id="jenisSelect" class="w-full border-0 bg-gray-50 rounded-md px-2.5 py-1.5 text-[11px] text-gray-700 focus:ring-2 focus:ring-amber-400 focus:bg-white outline-none transition">
                            ${renderJenisOptions(settings.jenis)}
                        </select>
                    </div>

                    <div class="mb-2">
                        <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-0.5">
                            <i class="fa-solid fa-calendar-alt text-amber-500 text-[10px]"></i> Fase Usia
                        </label>
                        <select id="faseSelect" class="w-full border-0 bg-gray-50 rounded-md px-2.5 py-1.5 text-[11px] text-gray-700 focus:ring-2 focus:ring-amber-400 focus:bg-white outline-none transition">
                            ${renderFaseOptions(settings.fase)}
                        </select>
                    </div>

                    <div class="grid grid-cols-2 gap-2 mb-2">
                        <div>
                            <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide block mb-0.5">Min</label>
                            <input id="suhuMinInput" type="number" step="0.1" min="0.1" class="w-full border-0 bg-gray-50 rounded-md px-2.5 py-1.5 text-[11px] text-gray-700 focus:ring-2 focus:ring-amber-400 focus:bg-white outline-none transition" value="${suhuRange.min}">
                        </div>
                        <div>
                            <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide block mb-0.5">Max</label>
                            <input id="suhuMaxInput" type="number" step="0.1" min="0.1" class="w-full border-0 bg-gray-50 rounded-md px-2.5 py-1.5 text-[11px] text-gray-700 focus:ring-2 focus:ring-amber-400 focus:bg-white outline-none transition" value="${suhuRange.max}">
                        </div>
                    </div>

                    <div class="flex items-center justify-between gap-2 pt-2 border-t border-gray-100">
                        <div class="flex items-center gap-2 bg-gray-50 rounded-md px-2.5 py-1">
                            <span class="text-[9px] font-medium text-gray-400 uppercase">Target</span>
                            <span class="text-sm font-semibold text-gray-800"><span id="suhuTargetDisplay">${suhuRange.target}</span>°C</span>
                        </div>
                        <button id="confirmBtn" class="confirm-btn bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-medium px-3.5 py-1.5 rounded-md transition-all flex items-center gap-1.5 shadow-sm hover:shadow flex-shrink-0">
                            <i class="fa-solid fa-check-circle text-[10px]"></i>
                            <span>Terapkan</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    const container = document.getElementById('kandangContent');
    container.innerHTML = html;

    requestAnimationFrame(() => {
        initChartForCurrentKandang(suhuHistory);
    });

    attachEventListeners();
    updateRealtimeDisplay();
}

function renderJenisOptions(activeJenis) {
    const jenisList = [
        { id: 'broiler', nama: 'Broiler' },
        { id: 'layer',   nama: 'Layer'   },
        { id: 'kampung', nama: 'Kampung' }
    ];
    return jenisList.map(j => `
        <option value="${j.id}" ${activeJenis === j.id ? 'selected' : ''}>${j.nama}</option>
    `).join('');
}

function renderFaseOptions(activeFase) {
    const faseList = [
        { id: 'doc',    nama: 'DOC'    }
    ];
    return faseList.map(f => `
        <option value="${f.id}" ${activeFase === f.id ? 'selected' : ''}>${f.nama}</option>
    `).join('');
}

// ========== CHART ==========
function initChartForCurrentKandang(suhuHistory) {
    const canvas = document.getElementById('suhuChart');
    if (!canvas) return;

    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (currentChart) {
        currentChart.destroy();
        currentChart = null;
    }

    const ctx = canvas.getContext('2d');

    currentChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: SuhuData.jamLabels.length ? SuhuData.jamLabels : ['--'],
            datasets: [{
                label:                `Suhu Kandang ${currentKandang}`,
                data:                 suhuHistory,
                borderColor:          '#d97706',
                borderWidth:          3,
                backgroundColor:      'rgba(217,119,6,0.1)',
                fill:                 true,
                tension:              0.3,
                pointRadius:          4,
                pointBackgroundColor: '#facc15',
                spanGaps:             false
            }]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            animation:           false,
            scales: {
                y: { min: 20, max: 40, ticks: { stepSize: 2, callback: v => v + '°C' } }
            }
        }
    });
}

// ========== UPDATE DATA REAL-TIME (kartu suhu, tiap 5 detik) ==========
async function updateRealtimeDisplay() {
    const settings = SuhuData.kandangSettings[currentKandang];
    if (!settings) return;

    const latestData = await SuhuData.fetchLatestSuhuFromMCU(currentKandang);
    if (latestData.offline) return;

    const currentTemp = latestData.suhu;

    // Update suhu aktual
    const tempSpan = document.getElementById('currentTemp');
    if (tempSpan) tempSpan.innerText = currentTemp;

    // Update target & range dari MCU
    const targetSpan = document.getElementById('targetTemp');
    const rangeSpan  = document.getElementById('suhuRange');
    if (targetSpan && latestData.setpoint != null)
        targetSpan.innerText = parseFloat(latestData.setpoint);
    if (rangeSpan && latestData.limit_low_temp != null && latestData.limit_high_temp != null)
        rangeSpan.innerText = `${parseFloat(latestData.limit_low_temp)} - ${parseFloat(latestData.limit_high_temp)}`;

    // Hitung status
    const statusSpan = document.getElementById('tempStatus');
    const low  = latestData.limit_low_temp  != null ? parseFloat(latestData.limit_low_temp)  : null;
    const high = latestData.limit_high_temp != null ? parseFloat(latestData.limit_high_temp) : null;

    let status = '', color = '';
    if (low === null || high === null) {
        status = 'Tidak Diketahui'; color = 'gray'
    } else if (currentTemp >= low && currentTemp <= high) {
        status = 'Optimal'; color = 'green'
    } else if (currentTemp < low - 2 || currentTemp > high + 2) {
        status = 'Waspada'; color = 'red'
    } else {
        status = 'Normal'; color = 'yellow'
    }

    if (statusSpan) statusSpan.innerHTML = `<i class="fa-solid fa-circle text-${color}-500 text-[8px]"></i> ${status}`;
}

// ========== EVENT HANDLER ==========
function attachEventListeners() {
    const jenisSelect = document.getElementById('jenisSelect');
    jenisSelect?.addEventListener('change', () => {
        const jenis = jenisSelect.value;
        if (jenis) {
            SuhuData.kandangSettings[currentKandang].jenis = jenis;
            renderKandangContent();
        }
    });

    const faseSelect = document.getElementById('faseSelect');
    faseSelect?.addEventListener('change', () => {
        const fase = faseSelect.value;
        if (fase) {
            SuhuData.kandangSettings[currentKandang].fase = fase;
            renderKandangContent();
        }
    });

    // ===== Validasi Min/Max manual =====
    const minInput = document.getElementById('suhuMinInput');
    const maxInput = document.getElementById('suhuMaxInput');

    function validateMinMax() {
        let minVal = parseFloat(minInput.value);
        let maxVal = parseFloat(maxInput.value);

        // Min tidak boleh 0 atau kosong/NaN
        if (isNaN(minVal) || minVal <= 0) {
            minVal = 0.1;
            minInput.value = minVal;
        }

        // Max tidak boleh <= Min
        if (isNaN(maxVal) || maxVal <= minVal) {
            maxVal = minVal + 0.1;
            maxInput.value = maxVal.toFixed(1);
        }

        // Update target display mengikuti rata-rata min-max baru
        const targetDisplay = document.getElementById('suhuTargetDisplay');
        if (targetDisplay) {
            const newTarget = ((minVal + maxVal) / 2).toFixed(1);
            targetDisplay.innerText = newTarget;
        }
    }

    minInput?.addEventListener('change', validateMinMax);
    maxInput?.addEventListener('change', validateMinMax);

    document.getElementById('confirmBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        showConfirmModal();
    });

    document.getElementById('confirmModalCancel')?.addEventListener('click', closeConfirmModal);

    document.getElementById('confirmModalConfirm')?.addEventListener('click', async () => {
        const btn     = document.getElementById('confirmModalConfirm');
        const payload = getCurrentSettingsPayload();
        btn.setAttribute('disabled', 'true');
        btn.innerText = 'Mengirim...';
        await publishMqttSettings(payload);
        btn.removeAttribute('disabled');
        btn.innerText = 'Kirim ke MCU';
        closeConfirmModal();
        alert(`Pengaturan kandang ${currentKandang} berhasil dikirim ke MCU.`);
    });
}

// ========== NAVIGASI KANDANG ==========
function switchKandang(kandangId) {
    currentKandang = kandangId;
    renderKandangContent();
}

// ========== SIDEBAR KOMUNIKASI ==========
const sidebarIframe = document.getElementById('sidebarIframe');
function sendToSidebar(type, data = {}) {
    if (sidebarIframe?.contentWindow)
        sidebarIframe.contentWindow.postMessage({ type, ...data }, '*');
}

function toggleMobileSidebar() {
    const sidebarIframe = document.getElementById('sidebarIframe');
    const body = document.body;
    const isOpen = sidebarIframe?.classList.contains('mobile-open');
    if (isOpen) {
        sidebarIframe.classList.remove('mobile-open');
        body.classList.remove('sidebar-open');
    } else {
        sidebarIframe.classList.add('mobile-open');
        body.classList.add('sidebar-open');
    }
}

document.getElementById('mobileMenuBtn')?.addEventListener('click', toggleMobileSidebar);

document.addEventListener('click', (e) => {
    const sidebarIframe   = document.getElementById('sidebarIframe');
    const mobileMenuBtn   = document.getElementById('mobileMenuBtn');
    const isClickInside   = sidebarIframe?.contains(e.target);
    const isClickOnButton = mobileMenuBtn?.contains(e.target);
    if (!isClickInside && !isClickOnButton && sidebarIframe?.classList.contains('mobile-open')) {
        sidebarIframe.classList.remove('mobile-open');
        document.body.classList.remove('sidebar-open');
    }
});

window.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.type === 'navigate') {
        if (data.page === 'welcome') window.location.href = '/dashboard';
        if (data.page === 'pakan')   window.location.href = '/feeder';
        if (data.page === 'suhu')    window.location.href = '/suhu';
    }
    if (data?.type === 'logout') {
        window.location.href = '/login';
    }
});

sendToSidebar('setActive', { page: 'suhu' });

window.addEventListener('resize', () => { if (currentChart) currentChart.resize(); });

// ========== INITIALIZATION ==========
document.addEventListener('DOMContentLoaded', async function() {
    const ok = await SuhuData.initSuhuData();
    if (!ok) return;

    if (SuhuData.allCodenumbers.length > 0) {
        currentKandang = SuhuData.allCodenumbers[0];
    }

    renderKandangContent();

    // Realtime: update kartu suhu tiap 5 detik
    setInterval(() => updateRealtimeDisplay(), 5000);

    // Refresh grafik (hourly) tiap 1 jam
    setInterval(async () => {
        const data = await SuhuData.fetchHourlySuhu(currentKandang);
        if (currentChart) {
            currentChart.data.labels           = SuhuData.jamLabels;
            currentChart.data.datasets[0].data = data;
            currentChart.update();
        }
    }, 60 * 60 * 1000);
});