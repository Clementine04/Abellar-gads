const state = {
  mode: 'login',
};

const qs = (id) => document.getElementById(id);

function switchMode(mode) {
  state.mode = mode;
  qs('login-tab').classList.toggle('active', mode === 'login');
  qs('register-tab').classList.toggle('active', mode === 'register');
  qs('auth-submit').textContent = mode === 'login' ? 'Login' : 'Register';
}

async function auth(endpoint, payload) {
  const res = await fetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || 'Unable to authenticate');
  }
  return res.json();
}

async function tryAutoLogin() {
  const token = localStorage.getItem('uno_token');
  if (!token) return false;
  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('invalid');
    window.location.href = '/home.html';
    return true;
  } catch {
    localStorage.removeItem('uno_token');
    localStorage.removeItem('uno_user');
    return false;
  }
}

function init() {
  tryAutoLogin();
  qs('login-tab').onclick = () => switchMode('login');
  qs('register-tab').onclick = () => switchMode('register');

  qs('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = qs('username').value.trim();
    const password = qs('password').value.trim();
    const error = qs('auth-error');
    error.style.display = 'none';
    try {
      const data = await auth(state.mode === 'login' ? 'login' : 'register', { username, password });
      localStorage.setItem('uno_token', data.token);
      localStorage.setItem('uno_user', data.username);
      window.location.href = '/home.html';
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
