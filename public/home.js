const qs = (id) => document.getElementById(id);

async function fetchMe() {
  const token = localStorage.getItem('uno_token');
  if (!token) return null;
  const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

async function fetchLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const tbody = qs('leaderboard').querySelector('tbody');
    tbody.innerHTML = '';
    data.forEach((row, idx) => {
      const tr = document.createElement('tr');
      const medal =
        idx === 0 ? '<span class="medal medal-gold">Gold</span>' :
        idx === 1 ? '<span class="medal medal-silver">Silver</span>' :
        idx === 2 ? '<span class="medal medal-bronze">Bronze</span>' : '';
      tr.innerHTML = `<td>${idx + 1}</td><td>${medal}</td><td>${row.username}</td><td>${row.wins}</td>`;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

function goToGame(action, code) {
  sessionStorage.setItem('uno_action', action);
  if (code) sessionStorage.setItem('uno_code', code);
  else sessionStorage.removeItem('uno_code');
  window.location.href = '/game.html';
}

async function init() {
  const me = await fetchMe();
  if (!me) {
    localStorage.removeItem('uno_token');
    localStorage.removeItem('uno_user');
    window.location.href = '/index.html';
    return;
  }
  qs('user-chip').textContent = `Signed in as ${me.username}`;
  fetchLeaderboard();

  qs('create-room').onclick = () => {
    goToGame('create');
  };

  qs('join-room').onclick = () => {
    const code = qs('join-code').value.trim().toUpperCase();
    if (!code) return;
    sessionStorage.setItem('uno_code', code);
    goToGame('join', code);
  };

  qs('logout').onclick = () => {
    localStorage.removeItem('uno_token');
    localStorage.removeItem('uno_user');
    sessionStorage.clear();
    window.location.href = '/index.html';
  };
}

document.addEventListener('DOMContentLoaded', init);
