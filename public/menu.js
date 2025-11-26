const token = localStorage.getItem('uno_token');
let username = localStorage.getItem('uno_username');
const welcomeLabel = document.getElementById('welcome-label');
const leaderboardTable = document.getElementById('leaderboard-table').querySelector('tbody');

if (!token) {
  window.location.href = '/';
}

(async function validateSession() {
  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('unauthorized');
    const data = await res.json();
    username = data.username;
    welcomeLabel.textContent = `Signed in as ${username}`;
  } catch (err) {
    localStorage.removeItem('uno_token');
    localStorage.removeItem('uno_username');
    window.location.href = '/';
  }
})();

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('uno_token');
  localStorage.removeItem('uno_username');
  window.location.href = '/';
});

welcomeLabel.textContent = username ? `Signed in as ${username}` : 'Welcome';

document.getElementById('create-btn').addEventListener('click', async () => {
  setActionMessage('Creating room...');
  try {
    const res = await fetch('/api/create-room', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create room');
    window.location.href = `/game.html?code=${data.code}`;
  } catch (err) {
    setActionMessage(err.message);
  }
});

document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (code.length !== 5) {
    setActionMessage('Enter a 5 letter code');
    return;
  }
  window.location.href = `/game.html?code=${code}`;
});

async function loadLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    leaderboardTable.innerHTML = '';
    data.leaderboard.forEach((row, index) => {
      const medalClass = index === 0 ? 'gold' : index === 1 ? 'silver' : 'bronze';
      const medalLabel = index === 0 ? 'Gold' : index === 1 ? 'Silver' : 'Bronze';
      leaderboardTable.insertAdjacentHTML(
        'beforeend',
        `<tr>
          <td>${index + 1}</td>
          <td><span class="medal ${medalClass}">${medalLabel}</span></td>
          <td>${row.username}</td>
          <td>${row.wins}</td>
        </tr>`
      );
    });
  } catch (err) {
    setActionMessage('Unable to load leaderboard');
  }
}

function setActionMessage(text) {
  let helper = document.getElementById('action-helper');
  if (!helper) {
    helper = document.createElement('div');
    helper.id = 'action-helper';
    helper.className = 'helper';
    document.querySelector('.panel').appendChild(helper);
  }
  helper.textContent = text;
}

loadLeaderboard();
