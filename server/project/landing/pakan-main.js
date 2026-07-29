/**
 * pakan-main.js
 * Rendering, event handling, dan komunikasi ke FastAPI backend.
 * Sumber data: feeder-data.js (window.PakanData).
 */

// ========== GLOBAL STATE ==========
let currentKandang = null;
let refreshInterval = null;
let jamInterval = null;
const REFRESH_MS = 15000;

// ========== FUNGSI BANTU ==========
function getEffectiveFeedConfig(settings) {
    return {
        gramPerEkor: settings.gramPerEkor || 10,
        frekuensi: settings.frekuensi || 3
    };
}

// Format jam HH:MM:SS (pakai locale id-ID -> otomatis pisah pakai titik)
function getJamString() {
    return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Update tampilan jam tanpa re-render seluruh konten (biar input yg lagi diisi user gak keganggu)
function updateJamDisplay() {
    const el = document.getElementById('jamHeaderDisplay');
    if (el) {
        el.textContent = getJamString();
    }
}

// Payload buat ditampilkan di modal konfirmasi (bukan payload API)
function getDisplaySummary() {
    const settings = PakanData.kandangSettings[currentKandang];
    const feedConfig = getEffectiveFeedConfig(settings);
    const totalHarian = settings.jumlahAyam * feedConfig.gramPerEkor;
    return {
        kandang_id: currentKandang,
        jenisPakan: settings.jenisPakan || 'mix',
        frekuensi: feedConfig.frekuensi,
        jumlahAyam: settings.jumlahAyam,
        totalPerHari: totalHarian
    };
}

// Payload sesuai format POST /feeder/settings/{codename}/{codenumber}
function buildFormData() {
    const settings = PakanData.kandangSettings[currentKandang];
    const jadwal = PakanData.jadwalPakan[currentKandang] || [];
    return {
        codename: settings.codename || `Kandang ${currentKandang}`,
        jenisPakan: settings.jenisPakan,
        frekuensi: settings.frekuensi,
        jumlahAyam: settings.jumlahAyam,
        gramPerEkor: settings.gramPerEkor,
        jadwal1: jadwal[0] || null,
        jadwal2: jadwal[1] || null,
        jadwal3: jadwal[2] || null,
        jadwal4: jadwal[3] || null
    };
}

function showConfirmModal() {
    const modal = document.getElementById('confirmModal');
    const details = document.getElementById('confirmModalDetails');
    const kandangLabel = document.getElementById('confirmModalKandang');
    const summary = getDisplaySummary();
    if (kandangLabel) kandangLabel.innerText = `Kandang ${summary.kandang_id}`;
    if (details) {
        details.innerText = `Jenis Pakan: ${summary.jenisPakan}, Jadwal: ${summary.frekuensi}x/hari, Jumlah: ${summary.jumlahAyam} ekor, Total: ${summary.totalPerHari} gram/jadwal`;
    }
    modal?.classList.remove('hidden');
}

function closeConfirmModal() {
    document.getElementById('confirmModal')?.classList.add('hidden');
}

// Bikin baris virtual "menunggu" untuk tiap jadwal yang belum lewat hari ini
function buildJadwalMenungguRows(kandangId) {
    const settings = PakanData.kandangSettings[kandangId];
    const jadwal = PakanData.jadwalPakan[kandangId] || [];
    if (!settings) return [];

    const feedConfig = getEffectiveFeedConfig(settings);
    const totalHarian = settings.jumlahAyam * feedConfig.gramPerEkor;
    const perSajian = feedConfig.frekuensi > 0 ? Math.round(totalHarian) : 0;

    const now = new Date();
    const rows = [];

    jadwal.forEach((waktu) => {
        if (!waktu) return;
        const [h, m] = waktu.split(':').map(Number);
        if (isNaN(h) || isNaN(m)) return;

        const jadwalDate = new Date();
        jadwalDate.setHours(h, m, 0, 0);

        // hanya tampil kalau jam jadwal masih di depan (belum lewat hari ini)
        if (jadwalDate.getTime() > now.getTime()) {
            rows.push({
                id: `menunggu-${waktu}`,
                waktu_pakan: waktu,
                jenis_pakan: settings.jenisPakan || '-',
                target_gram: perSajian,
                aktual_gram: '-',
                out_gram: '-',
                status_pakan: 'menunggu'
            });
        }
    });

    return rows.sort((a, b) => a.waktu_pakan.localeCompare(b.waktu_pakan));
}

// Badge status buat kolom status_pakan / status_stok di tabel log
function statusPill(status) {
    if (!status)
        return `<span class="status-badge info">-</span>`;

    const s = String(status).toLowerCase();

    let cls = "info";
    let icon = "circle-info";

    // ==========================
    // STATUS MENUNGGU
    // ==========================
    if (["menunggu"].includes(s)) {
        cls = "info";
        icon = "hourglass-half";
    }

    // ==========================
    // STATUS BERHASIL
    // ==========================
    if (["berhasil", "tersedia", "success"].includes(s)) {
        cls = "success";
        icon = "check";
    }
    
    // ==========================
    // STATUS PERINGATAN
    // ==========================
    else if (["hampir habis"].includes(s)) {
        cls = "warning";
        icon = "triangle-exclamation";
    }

    // ==========================
    // STATUS GAGAL
    // ==========================
    else if ([
        "habis",
        "dibatalkan",
        "tidak selesai",
        "tidak sesuai",
        "failed"
    ].includes(s)) {
        cls = "danger";
        icon = "xmark";
    }

    return `
        <span class="status-badge ${cls}">
            <i class="fa-solid fa-${icon} text-[8px]"></i>
            ${status}
        </span>`;
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    const colors = {
        success: 'bg-green-500',
        error: 'bg-red-500',
        warning: 'bg-yellow-500',
        info: 'bg-blue-500'
    };
    toast.className = `fixed top-4 right-4 z-50 px-4 py-3 rounded-lg text-white text-sm font-medium shadow-lg ${colors[type] || colors.success} transform transition-all duration-300`;
    toast.innerHTML = `<i class="fa-solid fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'circle-exclamation' : 'info-circle'} mr-2"></i> ${message}`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Ambil nilai TERKINI dari semua <input type=time> yang ada di layar dan simpan
// ke state.
function syncJadwalStateFromDOM() {
    const inputs = document.querySelectorAll('#jadwalInputsContainer .jadwal-time-input');
    if (!inputs.length) return;
    if (!PakanData.jadwalPakan[currentKandang]) PakanData.jadwalPakan[currentKandang] = [];
    inputs.forEach(input => {
        const index = parseInt(input.dataset.index);
        if (!isNaN(index) && input.value) {
            PakanData.jadwalPakan[currentKandang][index] = input.value;
        }
    });
}

// Cek apakah user lagi ngetik di dalam kandangContent (buat hindari refresh nimpa input)
function isUserEditing() {
    const container = document.getElementById('kandangContent');
    const active = document.activeElement;
    return !!(container && active && container.contains(active) &&
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName));
}

// ========== RENDER KANDANG DROPDOWN ==========
function renderKandangDropdown() {
    const kandangIds = PakanData.getAvailableKandangIds();

    if (!kandangIds.length) {
        const select = document.getElementById('kandangSelect');
        if (select) {
            select.innerHTML = `<option value="" disabled selected>⏳ Menunggu data kandang...</option>`;
        }
        const countSpan = document.getElementById('kandangCount');
        if (countSpan) countSpan.innerText = '0';
        return;
    }

    if (currentKandang === null || !kandangIds.includes(currentKandang)) {
        currentKandang = kandangIds[0];
    }

    const select = document.getElementById('kandangSelect');
    if (!select) return;

    const countSpan = document.getElementById('kandangCount');
    if (countSpan) countSpan.innerText = kandangIds.length;

    const optionsHtml = kandangIds.map(id => {
        const isActive = id === currentKandang;
        return `<option value="${id}" ${isActive ? 'selected' : ''}>🏚️ Kandang ${id}</option>`;
    }).join('');

    select.innerHTML = `
        <option value="" disabled ${currentKandang ? '' : 'selected'}>Pilih Kandang</option>
        ${optionsHtml}
    `;

    select.onchange = function () {
        const id = parseInt(this.value);
        if (id && id !== currentKandang) {
            switchKandang(id);
        }
    };
}

// ========== RENDER OPTIONS ==========
function renderJenisPakanOptions(activeJenis) {
    const jenisList = [
        { id: 'mix', nama: 'Mix' },
        { id: 'jagung', nama: 'Jagung' },
        { id: 'pelet', nama: 'Pelet' }
    ];
    return jenisList.map(j => `
        <option value="${j.id}" ${activeJenis === j.id ? 'selected' : ''}>${j.nama}</option>
    `).join('');
}

function renderFrekuensiOptions(activeFrekuensi) {
    const frekuensiList = [1, 2, 3, 4];
    return frekuensiList.map(f => `
        <option value="${f}" ${activeFrekuensi === f ? 'selected' : ''}>${f} kali/hari</option>
    `).join('');
}

// ========== RENDER JADWAL INPUT ==========
function renderJadwalInputs(frekuensi, jadwalExist) {
    const defaultJadwal = ['06:00', '11:00', '16:00', '20:00'];
    let html = '';

    for (let i = 0; i < frekuensi; i++) {
        const defaultValue = jadwalExist && jadwalExist[i] ? jadwalExist[i] : defaultJadwal[i] || '12:00';
        html += `
            <div class="jadwal-slot flex items-center gap-3 p-2 bg-gray-50 rounded-md border border-gray-200">
                <span class="w-6 h-6 flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold">${i + 1}</span>
                <input type="time" class="jadwal-time-input flex-1 border-0 bg-transparent text-sm text-gray-700 focus:ring-0 outline-none" value="${defaultValue}" data-index="${i}">
            </div>
        `;
    }

    return html;
}

// ========== RENDER KONTEN KANDANG ==========
function renderKandangContent() {
    // Kalau guest atau offline, jangan timpa view yang sudah diset initData()
    if (PakanData.viewState === 'guest' || PakanData.viewState === 'offline') return
    renderKandangDropdown();

    const ids = PakanData.getAvailableKandangIds();
    if (!ids.length) {
        const container = document.getElementById('kandangContent');
        const errMsg = PakanData.lastError;
        container.innerHTML = `
            <div class="col-span-full flex items-center justify-center py-12">
                <div class="text-center">
                    <i class="fa-solid fa-circle-notch fa-spin text-amber-500 text-3xl mb-3"></i>
                    <p class="text-gray-500 text-sm">Menunggu data dari MCU...</p>
                    <p class="text-gray-400 text-xs mt-1">${errMsg ? `Gagal konek ke server: ${errMsg}` : 'Data kandang akan muncul otomatis'}</p>
                </div>
            </div>
        `;
        return;
    }

    const settings = PakanData.kandangSettings[currentKandang] || {
        codename: `Kandang ${currentKandang}`,
        jenisPakan: 'mix',
        frekuensi: 3,
        jumlahAyam: 0,
        gramPerEkor: 0
    };
    const feedConfig = getEffectiveFeedConfig(settings);
    const jadwal = PakanData.jadwalPakan[currentKandang] || [];
    const riwayatAsli = PakanData.riwayatPakan[currentKandang] || [];
    const menungguRows = buildJadwalMenungguRows(currentKandang);
    const riwayat = [...menungguRows, ...riwayatAsli];
    const device = PakanData.deviceStatus[currentKandang] || {
        status_stok: "-",
        status: "OFFLINE"
    };
    
    let ledClass = "led-green";
    if (device.status_stok === "HAMPIR HABIS" || device.status_stok === "hampir habis") {
        ledClass = "led-yellow";
    } else if (device.status_stok === "HABIS" || device.status_stok === "habis") {
        ledClass = "led-red";
    }
    
    const statusRealtime = `
    <div class="flex items-center text-xs font-semibold text-gray-700">
        <span class="led-status ${ledClass}"></span>
        ${device.status_stok || "-"}
    </div> `;
    
    const totalHarian = settings.jumlahAyam * feedConfig.gramPerEkor;
    const perSajian = feedConfig.frekuensi > 0 ? Math.round(totalHarian / feedConfig.frekuensi) : 0;
    const jamSekarang = getJamString();

    const jadwalInputsHtml = renderJadwalInputs(feedConfig.frekuensi, jadwal);

    const html = `
    <div class="flex flex-col lg:flex-row gap-4 h-full min-h-0 overflow-hidden">
        <!-- BAWAH -> jadi KIRI di desktop: Log Pakan -->
        <div class="bg-white rounded-xl shadow-sm p-4 flex flex-col flex-1 min-h-[220px] lg:min-h-0 lg:h-full order-2 lg:order-1 overflow-hidden" id="logPakanCard">
            <div class="mb-2 flex-shrink-0">
                <h3 class="text-sm font-semibold text-gray-700">
                    <i class="fa-solid fa-list text-amber-500"></i>
                    Log Pakan
                </h3>
            </div>

            <!-- ===== TAMPILAN TABEL (tablet ke atas, sm: dan lebih besar) ===== -->
            <div class="hidden sm:block overflow-auto flex-1 min-h-0" id="logTableWrapper">
                <table class="w-full text-xs">
                    <thead class="sticky top-0 z-10">
                        <tr class="text-left text-[9px] text-gray-400 uppercase border-b border-gray-100 bg-white">
                            <th class="py-2 px-2 bg-white">Jenis Pakan</th>
                            <th class="py-2 px-2 bg-white">Target (g)</th>
                            <th class="py-2 px-2 bg-white">Aktual (g)</th>
                            <th class="py-2 px-2 bg-white">Out (g)</th>
                            <th class="py-2 px-2 bg-white">Waktu</th>
                            <th class="py-2 px-2 bg-white">Status Pakan</th>
                        </tr>
                    </thead>
                    <tbody id="logTableBody">
                        ${riwayat.length ? riwayat.map(item => `
                        <tr class="border-b border-gray-50">
                            <td class="py-2 px-2 text-gray-700">${item.jenis_pakan ?? '-'}</td>
                            <td class="py-2 px-2 text-gray-700">${item.target_gram ?? '-'}</td>
                            <td class="py-2 px-2 text-gray-700">${item.aktual_gram ?? '-'}</td>
                            <td class="py-2 px-2 text-gray-700">${item.out_gram ?? '-'}</td>
                            <td class="py-2 px-2 text-gray-500">${item.waktu_pakan}</td>
                            <td class="py-2 px-2">${statusPill(item.status_pakan)}</td>
                        </tr>
                        `).join('') : `
                        <tr>
                            <td colspan="6" class="text-center text-gray-400 italic py-6">Belum ada log</td>
                        </tr>
                        `}
                    </tbody>
                </table>
            </div>

            <!-- ===== TAMPILAN CARD LIST (HP, di bawah sm:) ===== -->
            <div class="sm:hidden overflow-y-auto flex-1 min-h-0" id="logCardWrapper" style="padding-bottom: calc(2.7rem + env(safe-area-inset-bottom, 0px));">
                <div class="flex flex-col gap-2" id="logCardList">
                    ${riwayat.length ? riwayat.map(item => `
                    <div class="rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
                        <div class="flex items-center justify-between mb-2">
                            <span class="text-xs font-semibold text-gray-700">
                                <i class="fa-solid fa-bowl-food text-amber-500 text-[10px] mr-1"></i>${item.jenis_pakan ?? '-'}
                            </span>
                            ${statusPill(item.status_pakan)}
                        </div>
                        <div class="grid grid-cols-4 gap-1.5 text-center">
                            <div>
                                <div class="text-[8px] text-gray-400 uppercase tracking-wide">Target</div>
                                <div class="text-[11px] font-medium text-gray-700">${item.target_gram ?? '-'}g</div>
                            </div>
                            <div>
                                <div class="text-[8px] text-gray-400 uppercase tracking-wide">Aktual</div>
                                <div class="text-[11px] font-medium text-gray-700">${item.aktual_gram ?? '-'}g</div>
                            </div>
                            <div>
                                <div class="text-[8px] text-gray-400 uppercase tracking-wide">Out</div>
                                <div class="text-[11px] font-medium text-gray-700">${item.out_gram ?? '-'}g</div>
                            </div>
                            <div>
                                <div class="text-[8px] text-gray-400 uppercase tracking-wide">Waktu</div>
                                <div class="text-[11px] font-medium text-gray-500">${item.waktu_pakan}</div>
                            </div>
                        </div>
                    </div>
                    `).join('') : `
                    <div class="text-center text-gray-400 italic py-6 text-xs">Belum ada log</div>
                    `}
                </div>
            </div>
        </div>

        <!-- ATAS -> jadi KANAN di desktop: Pengaturan Pakan -->
        <div class="bg-white rounded-xl shadow-sm p-4 flex-shrink-0 lg:w-[360px] order-1 lg:order-2 lg:overflow-y-auto lg:h-full">
            <div class="flex items-center justify-between mb-3">
                <h3 class="text-sm font-semibold text-gray-700">
                    <i class="fa-solid fa-sliders-h text-amber-500"></i>
                    Pengaturan Pakan
                </h3>
                ${statusRealtime}
            </div>

            <div class="grid grid-cols-2 gap-3">
                <div class="mb-2">
                    <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-0.5">
                        <i class="fa-solid fa-bowl-food text-amber-500 text-[9px]"></i> Jenis Pakan
                    </label>
                    <select id="jenisPakanSelect" class="w-full border-0 bg-gray-50 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:ring-2 focus:ring-amber-400 focus:bg-white outline-none transition">
                        ${renderJenisPakanOptions(settings.jenisPakan || 'mix')}
                    </select>
                </div>

                <div class="mb-2">
                    <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-0.5">
                        <i class="fa-regular fa-clock text-amber-500 text-[9px]"></i> Jadwal
                    </label>
                    <select id="frekuensiSelect" class="w-full border-0 bg-gray-50 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:ring-2 focus:ring-amber-400 focus:bg-white outline-none transition">
                        ${renderFrekuensiOptions(feedConfig.frekuensi)}
                    </select>
                </div>

                <div>
                    <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide block mb-0.5">
                        <i class="fa-solid fa-people-arrows text-amber-500 text-[9px]"></i> Jumlah Ayam
                    </label>
                    <input id="jumlahAyamInput" type="number" min="1" step="1"
                        class="w-full border-0 bg-gray-50 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:ring-2 focus:ring-amber-400 focus:bg-white outline-none transition"
                        value="${settings.jumlahAyam}">
                </div>
                <div>
                    <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide block mb-0.5">
                        <i class="fa-solid fa-weight-scale text-amber-500 text-[9px]"></i> Gram/Ekor
                    </label>
                    <input id="gramPerEkorInput" type="number" min="1" step="0.5"
                        class="w-full border-0 bg-gray-50 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:ring-2 focus:ring-amber-400 focus:bg-white outline-none transition"
                        value="${feedConfig.gramPerEkor}">
                </div>
            </div>

            <div class="mb-2">
                <label class="text-[9px] font-medium text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-0.5">
                    <i class="fa-regular fa-calendar-check text-amber-500 text-[9px]"></i> Waktu Pakan
                </label>
                <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-2 gap-1.5" id="jadwalInputsContainer">
                    ${jadwalInputsHtml}
                </div>
            </div>

            <button id="confirmBtn" class="w-full confirm-btn bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium px-4 py-2 rounded-lg transition-all flex items-center justify-center gap-2 shadow-sm hover:shadow">
                <i class="fa-solid fa-check-circle text-[10px]"></i>
                <span>Terapkan Pengaturan</span>
            </button>
        </div>
    </div>
`;

    const container = document.getElementById('kandangContent');
    container.innerHTML = html;

    attachEventListeners();
}

// ========== UPDATE JADWAL INPUTS ==========
function updateJadwalInputs(frekuensi) {
    const container = document.getElementById('jadwalInputsContainer');
    if (!container) return;

    const defaultJadwal = ['06:00', '11:00', '16:00', '20:00'];
    const currentJadwal = PakanData.jadwalPakan[currentKandang] || [];

    let html = '';
    for (let i = 0; i < frekuensi; i++) {
        const defaultValue = currentJadwal[i] || defaultJadwal[i] || '12:00';
        html += `
            <div class="jadwal-slot flex items-center gap-3 p-2 bg-gray-50 rounded-md border border-gray-200">
                <span class="w-6 h-6 flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold">${i + 1}</span>
                <input type="time" class="jadwal-time-input flex-1 border-0 bg-transparent text-sm text-gray-700 focus:ring-0 outline-none" value="${defaultValue}" data-index="${i}">
            </div>
        `;
    }

    container.innerHTML = html;
}

// ========== UPDATE TOTAL PAKAN ==========
function updateTotalPakan() {
    const jumlahInput = document.getElementById('jumlahAyamInput');
    const gramInput = document.getElementById('gramPerEkorInput');
    const frekuensiSelect = document.getElementById('frekuensiSelect');

    if (!jumlahInput || !gramInput || !frekuensiSelect) return;

    const jumlah = parseInt(jumlahInput.value) || 0;
    const gram = parseFloat(gramInput.value) || 0;
    const frekuensi = parseInt(frekuensiSelect.value) || 1;

    const settings = PakanData.kandangSettings[currentKandang];
    if (settings) {
        settings.jumlahAyam = jumlah;
        settings.gramPerEkor = gram;
        settings.frekuensi = frekuensi;
    }

    const total = jumlah * gram;
    const perSajian = Math.round(total / frekuensi);

    const totalDisplay = document.getElementById('totalPakanDisplay');
    const perSajianDisplay = document.getElementById('perSajianDisplay');
    if (totalDisplay) totalDisplay.textContent = `${total} gram`;
    if (perSajianDisplay) perSajianDisplay.textContent = `${perSajian} gram`;
}

// ========== EVENT HANDLER ==========
function attachEventListeners() {
    const jenisPakanSelect = document.getElementById('jenisPakanSelect');
    jenisPakanSelect?.addEventListener('change', () => {
        const settings = PakanData.kandangSettings[currentKandang];
        settings.jenisPakan = jenisPakanSelect.value;
        renderKandangContent();
    });

    const frekuensiSelect = document.getElementById('frekuensiSelect');
    frekuensiSelect?.addEventListener('change', () => {
        const frekuensi = parseInt(frekuensiSelect.value);
        const settings = PakanData.kandangSettings[currentKandang];
    
        settings.frekuensi = frekuensi;
    
        // Hapus jadwal yang tidak dipakai
        if (!PakanData.jadwalPakan[currentKandang]) {
            PakanData.jadwalPakan[currentKandang] = [];
        }
    
        PakanData.jadwalPakan[currentKandang] =
            PakanData.jadwalPakan[currentKandang].slice(0, frekuensi);
    
        updateJadwalInputs(frekuensi);
        updateTotalPakan();
    });

    const jumlahAyamInput = document.getElementById('jumlahAyamInput');
    const gramPerEkorInput = document.getElementById('gramPerEkorInput');

    jumlahAyamInput?.addEventListener('input', updateTotalPakan);
    gramPerEkorInput?.addEventListener('input', updateTotalPakan);

    document.getElementById('jadwalInputsContainer')?.addEventListener('change', (e) => {
        if (e.target.classList.contains('jadwal-time-input')) {
            const index = parseInt(e.target.dataset.index);
            const waktu = e.target.value;
            if (!isNaN(index) && waktu) {
                if (!PakanData.jadwalPakan[currentKandang]) {
                    PakanData.jadwalPakan[currentKandang] = [];
                }
                PakanData.jadwalPakan[currentKandang][index] = waktu;
            }
        }
    });

    const confirmBtn = document.getElementById('confirmBtn');
    confirmBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        const jumlah = parseInt(document.getElementById('jumlahAyamInput')?.value) || 0;
        const gram = parseFloat(document.getElementById('gramPerEkorInput')?.value) || 0;
        const frekuensi = parseInt(document.getElementById('frekuensiSelect')?.value) || 3;

        const settings = PakanData.kandangSettings[currentKandang];
        if (settings) {
            settings.jumlahAyam = jumlah;
            settings.gramPerEkor = gram;
            settings.frekuensi = frekuensi;
        }

        syncJadwalStateFromDOM(); // pastikan jadwal3/4 (yg mungkin belum "disentuh") ikut kebaca

        showConfirmModal();
    });

    document.getElementById('confirmModalCancel')?.addEventListener('click', closeConfirmModal);

    document.getElementById('confirmModalConfirm')?.addEventListener('click', async () => {
        const btn = document.getElementById('confirmModalConfirm');
        btn.setAttribute('disabled', 'true');
        btn.innerText = 'Mengirim...';
        try {
            syncJadwalStateFromDOM();
            const formData = buildFormData(); // ✅ Sekarang return formData, bukan payload API
            
            // ✅ Panggil dengan 2 parameter: codenumber dan formData
            await PakanData.saveSettingPakan(currentKandang, formData);
            
            closeConfirmModal();
            showToast('Pengaturan pakan berhasil disimpan ke server', 'success');
            
            // Refresh data dari server
            await PakanData.initData();
            renderKandangContent();
        } catch (e) {
            showToast(`Gagal menyimpan pengaturan: ${e.message}`, 'error');
        } finally {
            btn.removeAttribute('disabled');
            btn.innerText = 'Kirim ke Server';
        }
    });
}

// Update HANYA bagian log (tbody + card list), tidak menyentuh form pengaturan.
// Dipakai saat auto-refresh terjadi ketika user sedang mengisi input.
function refreshLogDisplay() {
    if (PakanData.viewState !== 'ready' || currentKandang === null) return;

    const tbody = document.getElementById('logTableBody');
    const cardList = document.getElementById('logCardList');
    if (!tbody && !cardList) return; // form belum pernah dirender

    const riwayatAsli = PakanData.riwayatPakan[currentKandang] || [];
    const menungguRows = buildJadwalMenungguRows(currentKandang);
    const riwayat = [...menungguRows, ...riwayatAsli];

    if (tbody) {
        tbody.innerHTML = riwayat.length ? riwayat.map(item => `
            <tr class="border-b border-gray-50">
                <td class="py-2 px-2 text-gray-700">${item.jenis_pakan ?? '-'}</td>
                <td class="py-2 px-2 text-gray-700">${item.target_gram ?? '-'}</td>
                <td class="py-2 px-2 text-gray-700">${item.aktual_gram ?? '-'}</td>
                <td class="py-2 px-2 text-gray-700">${item.out_gram ?? '-'}</td>
                <td class="py-2 px-2 text-gray-500">${item.waktu_pakan}</td>
                <td class="py-2 px-2">${statusPill(item.status_pakan)}</td>
            </tr>
        `).join('') : `
            <tr><td colspan="6" class="text-center text-gray-400 italic py-6">Belum ada log</td></tr>
        `;
    }

    if (cardList) {
        cardList.innerHTML = riwayat.length ? riwayat.map(item => `
            <div class="rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-semibold text-gray-700">
                        <i class="fa-solid fa-bowl-food text-amber-500 text-[10px] mr-1"></i>${item.jenis_pakan ?? '-'}
                    </span>
                    ${statusPill(item.status_pakan)}
                </div>
                <div class="grid grid-cols-4 gap-1.5 text-center">
                    <div>
                        <div class="text-[8px] text-gray-400 uppercase tracking-wide">Target</div>
                        <div class="text-[11px] font-medium text-gray-700">${item.target_gram ?? '-'}g</div>
                    </div>
                    <div>
                        <div class="text-[8px] text-gray-400 uppercase tracking-wide">Aktual</div>
                        <div class="text-[11px] font-medium text-gray-700">${item.aktual_gram ?? '-'}g</div>
                    </div>
                    <div>
                        <div class="text-[8px] text-gray-400 uppercase tracking-wide">Out</div>
                        <div class="text-[11px] font-medium text-gray-700">${item.out_gram ?? '-'}g</div>
                    </div>
                    <div>
                        <div class="text-[8px] text-gray-400 uppercase tracking-wide">Waktu</div>
                        <div class="text-[11px] font-medium text-gray-500">${item.waktu_pakan}</div>
                    </div>
                </div>
            </div>
        `).join('') : `
            <div class="text-center text-gray-400 italic py-6 text-xs">Belum ada log</div>
        `;
    }
}

// ========== NAVIGASI KANDANG ==========
function switchKandang(kandangId) {
    currentKandang = kandangId;
    renderKandangContent();
}

// ========== SIDEBAR KOMUNIKASI ==========
const sidebarIframe = document.getElementById('sidebarIframe');

function sendToSidebar(type, data = {}) {
    if (sidebarIframe?.contentWindow) {
        sidebarIframe.contentWindow.postMessage({ type, ...data }, '*');
    }
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
    const sidebarIframe = document.getElementById('sidebarIframe');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const isClickInsideSidebar = sidebarIframe?.contains(e.target);
    const isClickOnButton = mobileMenuBtn?.contains(e.target);

    if (!isClickInsideSidebar && !isClickOnButton && sidebarIframe?.classList.contains('mobile-open')) {
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

sendToSidebar('setActive', { page: 'pakan' });

// ========== INISIALISASI ==========
document.addEventListener('DOMContentLoaded', async function () {
    renderKandangContent(); // tampilkan state "menunggu data" dulu

    try {
        await PakanData.initData();
    } catch (e) {
        showToast(`Gagal memuat data dari server: ${e.message}`, 'error');
    }
    renderKandangContent();

    refreshInterval = setInterval(async () => {
        try {
            await PakanData.refreshRiwayat(); // tetap ambil data walau user lagi isi form
        } catch (e) {
            console.warn('Refresh riwayat gagal:', e.message);
            return;
        }

        if (isUserEditing()) {
            // user lagi isi form -> jangan timpa form, tapi log tetap bisa diupdate
            refreshLogDisplay();
        } else {
            renderKandangContent();
        }
    }, REFRESH_MS);

    // Jam jalan tiap detik tanpa nge-render ulang seluruh konten
    jamInterval = setInterval(updateJamDisplay, 1000);
});