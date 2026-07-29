// =============================================
// register.js — Register Page
// =============================================

const registerForm = document.getElementById('registerForm')

if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError(registerForm)

    const peternakan      = document.getElementById('nama').value.trim()
    const email           = document.getElementById('email').value.trim()
    const username        = document.getElementById('username').value.trim()
    const password        = document.getElementById('password').value
    const confirmPassword = document.getElementById('confirmPassword').value

    if (!peternakan || !email || !username || !password) {
      return showError(registerForm, 'Semua field wajib diisi')
    }

    if (password !== confirmPassword) {
      return showError(registerForm, 'Password dan konfirmasi password tidak sama')
    }

    if (password.length < 6) {
      return showError(registerForm, 'Password minimal 6 karakter')
    }

    try {
      const res  = await fetch('/api/register', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ peternakan, email, username, password }),
      })
      const data = await res.json()

      if (data.status === 'ok') {
        alert('Registrasi berhasil! Silakan login.')
        window.location.href = 'http://www.goldenchick.my.id/login'
      } else {
        showError(registerForm, data.message)
      }
    } catch (err) {
      showError(registerForm, 'Gagal terhubung ke server')
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