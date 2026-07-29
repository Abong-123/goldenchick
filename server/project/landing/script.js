const loginForm = document.querySelector('.form-box.login form')

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError(loginForm)

    const username = document.getElementById('username').value.trim()
    const password = document.getElementById('password').value

    if (!username || !password) {
      return showError(loginForm, 'Username dan password wajib diisi')
    }

    try {
      const res  = await fetch('/api/login', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ username, password }),
      })
      const data = await res.json()

      if (data.status === 'ok') {
        sessionStorage.setItem('user', JSON.stringify(data.user))
        window.location.href = data.user.role === 'admin' ? '/admin' : '/dashboard'
      } else {
        showError(loginForm, data.message)
      }
    } catch (err) {
      showError(loginForm, 'Gagal terhubung ke server')
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