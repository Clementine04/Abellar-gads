const loginTab = document.getElementById('tab-login');
const registerTab = document.getElementById('tab-register');
const form = document.getElementById('auth-form');
const message = document.getElementById('auth-message');
const submitBtn = document.getElementById('auth-submit');

let mode = 'login';

if (localStorage.getItem('uno_token')) {
  window.location.href = '/menu.html';
}

loginTab.addEventListener('click', () => setMode('login'));
registerTab.addEventListener('click', () => setMode('register'));

function setMode(next) {
  mode = next;
  loginTab.classList.toggle('active', mode === 'login');
  registerTab.classList.toggle('active', mode === 'register');
  submitBtn.textContent = mode === 'login' ? 'Continue' : 'Create account';
  message.textContent = '';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  if (!username || !password) {
    message.textContent = 'Please fill all fields.';
    return;
  }
  submitBtn.disabled = true;
  message.textContent = 'Working...';
  try {
    const res = await fetch(`/api/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    localStorage.setItem('uno_token', data.token);
    localStorage.setItem('uno_username', data.username);
    window.location.href = '/menu.html';
  } catch (err) {
    message.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});
