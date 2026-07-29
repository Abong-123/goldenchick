// =============================================
// crud.js — Admin CRUD Users + Token MCU
// =============================================

// Guard — cek session, harus admin
const userSession = JSON.parse(sessionStorage.getItem('user') || 'null')
if (!userSession || userSession.role !== 'admin') {
  window.location.href = '/login'
}

let allUsers = []

// =============================================
// LOAD USERS
// =============================================
async function loadUsers() {
  try {
    const res  = await fetch('/api/users', { credentials: 'include' })
    const data = await res.json()

    if (res.status === 401) {
      window.location.href = '/login'
      return
    }

    if (data.status === 'ok') {
      allUsers = data.data
      renderTable(allUsers)
      updateStats(allUsers)
    } else {
      alert('Gagal memuat data: ' + data.message)
    }
  } catch (err) {
    alert('Gagal terhubung ke server')
  }
}

// =============================================
// RENDER TABEL
// =============================================
function renderTable(users) {
  const tbody = document.getElementById('userTableBody')

  if (users.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-state">
        <td colspan="6">
          <i class="fa-solid fa-users-slash"></i>
          <p>Belum ada data pengguna</p>
        </td>
      </tr>`
    return
  }

  tbody.innerHTML = users.map((u, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escHtml(u.username)}</td>
      <td>${escHtml(u.email)}</td>
      <td>${escHtml(u.peternakan)}</td>
      <td>${u.token
        ? `<code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:12px;">${escHtml(u.token)}</code>`
        : '<span style="color:#aaa;font-size:12px;">—</span>'
      }</td>
      <td>
        <button class="edit-btn" onclick="openEditModal(${u.id})">
          <i class="fa-solid fa-pen"></i> Edit
        </button>
        <button class="delete-btn" onclick="deleteUser(${u.id}, '${escHtml(u.username)}')">
          <i class="fa-solid fa-trash"></i> Hapus
        </button>
      </td>
    </tr>
  `).join('')
}

// =============================================
// UPDATE STATS
// =============================================
function updateStats(users) {
  document.getElementById('totalUsers').textContent  = users.length
  document.getElementById('totalFarms').textContent  = new Set(users.map(u => u.peternakan)).size
  document.getElementById('totalActive').textContent = users.filter(u => u.role === 'peternak').length
}

// =============================================
// SEARCH
// =============================================
function searchUsers() {
  const q = document.getElementById('searchInput').value.toLowerCase()
  const filtered = allUsers.filter(u =>
    u.username.toLowerCase().includes(q)   ||
    u.email.toLowerCase().includes(q)      ||
    u.peternakan.toLowerCase().includes(q) ||
    (u.token || '').toLowerCase().includes(q)
  )
  renderTable(filtered)
}

// =============================================
// MODAL — TAMBAH
// =============================================
function openAddModal() {
  document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-user-plus"></i> Tambah Pengguna'
  document.getElementById('userForm').reset()
  document.getElementById('userId').value          = ''
  document.getElementById('tokenInput').value      = ''
  document.getElementById('passwordGroup').style.display = 'block'
  document.getElementById('password').required     = true
  document.getElementById('userModal').style.display = 'flex'
}

// =============================================
// MODAL — EDIT
// =============================================
function openEditModal(id) {
  const user = allUsers.find(u => u.id === id)
  if (!user) return

  document.getElementById('modalTitle').innerHTML  = '<i class="fa-solid fa-pen"></i> Edit Pengguna'
  document.getElementById('userId').value          = user.id
  document.getElementById('username').value        = user.username
  document.getElementById('email').value           = user.email
  document.getElementById('farmName').value        = user.peternakan
  document.getElementById('password').value        = ''
  document.getElementById('password').required     = false
  document.getElementById('tokenInput').value      = user.token || ''
  document.getElementById('userModal').style.display = 'flex'
}

// =============================================
// MODAL — TUTUP
// =============================================
function closeModal() {
  document.getElementById('userModal').style.display = 'none'
  document.getElementById('userForm').reset()
}

window.addEventListener('click', (e) => {
  const modal = document.getElementById('userModal')
  if (e.target === modal) closeModal()
})

// =============================================
// SAVE USER — tambah atau edit
// =============================================
async function saveUser(e) {
  e.preventDefault()

  const id         = document.getElementById('userId').value
  const username   = document.getElementById('username').value.trim()
  const email      = document.getElementById('email').value.trim()
  const peternakan = document.getElementById('farmName').value.trim()
  const password   = document.getElementById('password').value
  const tokenVal   = document.getElementById('tokenInput').value.trim()

  const isEdit = !!id

  try {
    let res, data, savedId

    if (isEdit) {
      const body = { username, email, peternakan, role: 'peternak' }
      if (password) body.password = password

      res  = await fetch(`/api/users/${id}`, {
        method:      'PUT',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify(body),
      })
      data    = await res.json()
      savedId = id
    } else {
      if (!password || password.length < 6) {
        return alert('Password minimal 6 karakter')
      }
      res  = await fetch('/api/users', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ peternakan, email, username, password, role: 'peternak' }),
      })
      data    = await res.json()
      savedId = data.user?.id
    }

    if (data.status !== 'ok') {
      return alert('Gagal: ' + data.message)
    }

    // Update token — selalu call endpoint token jika savedId ada
    // (kirim string kosong untuk hapus token)
    if (savedId) {
      const existingToken = isEdit ? (allUsers.find(u => u.id == id)?.token || '') : ''
      if (tokenVal !== existingToken) {
        const tokenRes  = await fetch(`/api/users/${savedId}/token`, {
          method:      'PUT',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify({ token: tokenVal || null }),
        })
        const tokenData = await tokenRes.json()
        if (tokenData.status !== 'ok') {
          console.warn('Token update gagal:', tokenData.message)
        }
      }
    }

    closeModal()
    loadUsers()

  } catch (err) {
    alert('Gagal terhubung ke server')
  }
}

// =============================================
// HAPUS USER
// =============================================
async function deleteUser(id, username) {
  if (!confirm(`Hapus user "${username}"? Tindakan ini tidak bisa dibatalkan.`)) return

  try {
    const res  = await fetch(`/api/users/${id}`, {
      method:      'DELETE',
      credentials: 'include',
    })
    const data = await res.json()

    if (data.status === 'ok') {
      loadUsers()
    } else {
      alert('Gagal hapus: ' + data.message)
    }
  } catch (err) {
    alert('Gagal terhubung ke server')
  }
}

// =============================================
// LOGOUT
// =============================================
async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' })
  } catch (_) {}
  sessionStorage.removeItem('user')
  window.location.href = '/login'
}

// =============================================
// HELPER
// =============================================
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// =============================================
// INIT
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  loadUsers()

  const logoutBtn = document.querySelector('.logout-btn')
  if (logoutBtn) {
    logoutBtn.parentElement.removeAttribute('href')
    logoutBtn.addEventListener('click', logout)
    logoutBtn.style.cursor = 'pointer'
  }
})