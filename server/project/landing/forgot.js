// =============================================
// forgot.js — Forgot Password Page
// Gantikan fungsi checkAccount() yang hardcode
// =============================================

async function checkAccount() {
  const username = document.getElementById('username').value.trim()
  const email    = document.getElementById('email').value.trim()
  const errEl    = document.getElementById('error-message')

  errEl.innerHTML = ''

  if (!username || !email) {
    errEl.innerHTML = 'Username dan email wajib diisi'
    errEl.style.color = 'red'
    return
  }

  try {
    const res  = await fetch('/api/reset-password/cek', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, email }),
    })
    const data = await res.json()

    if (data.status === 'ok') {
    // Simpan reset_token di sessionStorage, dipakai di reset-password.html
    sessionStorage.setItem('reset_token', data.reset_token);
    // Arahkan ke halaman reset password
    window.location.href = 'http://www.goldenchick.my.id/reset-password';
    } else {
        errEl.innerHTML = data.message;
        errEl.style.color = 'red';
    }
  } catch (err) {
    errEl.innerHTML   = 'Gagal terhubung ke server'
    errEl.style.color = 'red'
  }
}