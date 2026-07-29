// =============================================
// reset.js — Reset Password Page
// =============================================

// Guard — kalau tidak ada reset_token redirect ke forgot-password
if (!sessionStorage.getItem('reset_token')) {
  window.location.href = '/forgot-password'
}
const resetForm = document.querySelector('.form-box.login form')

if (resetForm) {
  const inputs = resetForm.querySelectorAll('input')
  inputs[0].id = 'passwordBaru'
  inputs[1].id = 'konfirmasiPassword'

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError(resetForm)

    const password_baru  = document.getElementById('passwordBaru').value
    const konfirmasi     = document.getElementById('konfirmasiPassword').value
    const reset_token    = sessionStorage.getItem('reset_token')

    if (!reset_token) {
      return showError(resetForm, 'Session expired, ulangi proses reset password')
    }

    if (!password_baru || !konfirmasi) {
      return showError(resetForm, 'Semua field wajib diisi')
    }

    if (password_baru !== konfirmasi) {
      return showError(resetForm, 'Password dan konfirmasi tidak sama')
    }

    if (password_baru.length < 6) {
      return showError(resetForm, 'Password minimal 6 karakter')
    }

    try {
      const res  = await fetch('/api/reset-password/ganti', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reset_token, password_baru }),
      })
      const data = await res.json()

      if (data.status === 'ok') {
        sessionStorage.removeItem('reset_token');
        alert('Password berhasil direset! Silakan login.');
        window.location.href = 'http://www.goldenchick.my.id/login';
      } else {
        showError(resetForm, data.message);
      }
    } catch (err) {
      showError(resetForm, 'Gagal terhubung ke server')
    }
  })
}

function showError(form, msg) {
  clearError(form)
  const p = document.createElement('p')
  p.id        = 'error-msg'
  p.innerText = msg
  p.style.cssText = 'color:red; margin-top:10px; font-size:14px; text-align:center;'
  form.appendChild(p)
}

function clearError(form) {
  const old = form.querySelector('#error-msg')
  if (old) old.remove()
}