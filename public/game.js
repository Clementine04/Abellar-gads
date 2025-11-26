const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || '').toUpperCase();
const token = localStorage.getItem('uno_token');
const username = localStorage.getItem('uno_username');

if (!roomCode) window.location.href = '/menu.html';
if (!token) window.location.href = '/';

const socket = io();

const playerNameEl = document.getElementById('player-name');
const opponentNameEl = document.getElementById('opponent-name');
const turnLabelEl = document.getElementById('turn-label');
const colorChipEl = document.getElementById('color-chip');
const playerHandEl = document.getElementById('player-hand');
const opponentHandEl = document.getElementById('opponent-hand');
const discardPileEl = document.getElementById('discard-pile');
const drawPileEl = document.getElementById('draw-pile');
const statusPillEl = document.getElementById('status-pill');
const deckLabelEl = document.getElementById('deck-label');
const codeLabelEl = document.getElementById('code-label');

const musicEl = document.getElementById('audio-music');
const shuffleEl = document.getElementById('audio-shuffle');
const draw2El = document.getElementById('audio-draw2');
const draw4El = document.getElementById('audio-draw4');
const skipEl = document.getElementById('audio-skip');
const wildEl = document.getElementById('audio-wild');
const unoEl = document.getElementById('audio-uno');
const unoOppEl = document.getElementById('audio-uno-opp');
const winEl = document.getElementById('audio-win');

let musicOn = false;
let sfxOn = true;
let lastEventSignature = '';
let prevHandCount = null;
let prevOpponentCount = null;

document.getElementById('music-toggle').addEventListener('click', () => {
  musicOn = !musicOn;
  document.getElementById('music-toggle').textContent = musicOn ? 'Pause Music' : 'Play Music';
  if (musicOn) {
    musicEl.volume = 0.35;
    musicEl.play();
  } else {
    musicEl.pause();
  }
});

document.getElementById('sfx-toggle').addEventListener('click', () => {
  sfxOn = !sfxOn;
  document.getElementById('sfx-toggle').textContent = sfxOn ? 'SFX On' : 'SFX Off';
});

document.getElementById('leave-btn').addEventListener('click', () => {
  socket.emit('quitRoom', { code: roomCode }, () => {
    window.location.href = '/menu.html';
  });
});

document.getElementById('draw-btn').addEventListener('click', () => {
  socket.emit('drawCard', { code: roomCode }, handleResult);
});

document.getElementById('uno-btn').addEventListener('click', () => {
  socket.emit('callUno', { code: roomCode });
  playSound(unoEl);
});

socket.emit('joinRoom', { token, code: roomCode }, (res) => {
  if (!res || res.error) {
    alert(res?.error || 'Unable to join room');
    window.location.href = '/menu.html';
  }
});

socket.on('state', (state) => {
  updateUI(state);
});

function updateUI(state) {
  if (!state) return;
  codeLabelEl.textContent = `Game Code: ${state.code}`;
  playerNameEl.textContent = state.you;
  opponentNameEl.textContent = state.opponentName || 'Waiting...';
  if (state.status === 'ended' && state.winner === state.you) {
    statusPillEl.textContent = 'You win!';
  } else if (state.status === 'ended') {
    statusPillEl.textContent = `${state.winner || 'Opponent'} wins`;
  } else {
    statusPillEl.textContent = state.status === 'waiting' ? 'Waiting for players...' : 'Game on!';
  }

  const isYourTurn = state.currentPlayer === state.you && state.status === 'playing';
  const hasPlayable = (state.yourHand || []).some((card) => clientCanPlay(card, state));
  if (state.status === 'ended') {
    turnLabelEl.textContent = state.winner === state.you ? 'Opponent left / game over' : 'Game over';
  } else {
    turnLabelEl.textContent = isYourTurn ? 'Your turn — match color or number' : `Waiting for ${state.currentPlayer || 'player'}...`;
  }
  document.getElementById('draw-btn').disabled = !isYourTurn || state.turnDrawn;

  renderHand(playerHandEl, state.yourHand || [], isYourTurn, state);
  renderOpponentHand(opponentHandEl, state.players, state.you);

  const yourCount = (state.yourHand || []).length;
  // Only play UNO sound when player explicitly calls UNO (server sends lastEvent) instead of auto.
  prevHandCount = yourCount;

  const opponent = (state.players || []).find((p) => p.username !== state.you);
  const oppCount = opponent ? opponent.cards : 0;
  prevOpponentCount = oppCount;

  discardPileEl.src = cardToImage(state.topCard);
  drawPileEl.src = '/assets/card-back.png';
  deckLabelEl.textContent = `${state.drawPile || 0} cards in deck`;

  const color = state.currentColor || 'R';
  colorChipEl.textContent = colorName(color);
  colorChipEl.style.background = colorValue(color);
  setBackground(color);

  if (state.lastEvent) {
    const sig = JSON.stringify(state.lastEvent);
    if (sig !== lastEventSignature) {
      handleSfx(state.lastEvent, state.you);
      lastEventSignature = sig;
    }
  }
}

function renderHand(container, hand, isYourTurn, state) {
  container.innerHTML = '';
  hand.forEach((card) => {
    const img = document.createElement('img');
    img.src = cardToImage(card);
    img.alt = `${card.value} ${card.color || ''}`;
    const playable = isYourTurn && clientCanPlay(card, state);
    if (playable) {
      img.classList.add('playable');
    } else {
      img.classList.add('disabled');
    }
    img.addEventListener('click', () => {
      if (!playable) return;
      onPlayCard(card);
    });
    container.appendChild(img);
  });
}

function renderOpponentHand(container, players, you) {
  container.innerHTML = '';
  const opponent = (players || []).find((p) => p.username !== you);
  const count = opponent ? opponent.cards : 0;
  for (let i = 0; i < count; i += 1) {
    const img = document.createElement('img');
    img.src = '/assets/card-back.png';
    img.className = 'card-visual';
    img.style.width = '70px';
    img.alt = 'Opponent card';
    container.appendChild(img);
  }
}

function onPlayCard(card) {
  const needsColor = card.type === 'wild' || card.type === 'wild4';
  let chosenColor = null;
  if (needsColor) {
    const answer = prompt('Choose a color (R, G, B, Y)') || '';
    chosenColor = answer.trim().toUpperCase()[0];
    if (!['R', 'G', 'B', 'Y'].includes(chosenColor)) return;
  }
  socket.emit('playCard', { code: roomCode, cardId: card.id, chosenColor }, (res) => {
    if (res && res.error) alert(res.error);
  });
}

function handleResult(res) {
  if (res && res.error) alert(res.error);
}

function cardToImage(card) {
  if (!card) return '/assets/card-back.png';
  if (card.type === 'number') return `/cards-front/${card.value}${card.color}.png`;
  if (card.type === 'draw2') return `/cards-front/D2${card.color}.png`;
  if (card.type === 'skip') return `/cards-front/skip${card.color}.png`;
  if (card.type === 'reverse') return `/cards-front/_${card.color}.png`;
  if (card.type === 'wild') return '/cards-front/W.png';
  if (card.type === 'wild4') return '/cards-front/D4W.png';
  return '/card-back.png';
}

function handleSfx(evt, you) {
  if (!evt || !sfxOn) return;
  if (evt.type === 'draw2') playSound(draw2El);
  if (evt.type === 'draw4') playSound(draw4El);
  if (evt.type === 'skip') playSound(skipEl);
  if (evt.type === 'wild') playSound(wildEl);
  if (evt.type === 'uno') playSound(evt.by === you ? unoEl : unoOppEl);
  if (evt.type === 'unoPenalty') playSound(draw2El);
  if (evt.type === 'gameOver') playSound(winEl);
  if (evt.type === 'shuffle') playSound(shuffleEl);
  if (evt.type === 'draw') playSound(shuffleEl);
}

function playSound(audio) {
  if (!audio) return;
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

function colorName(code) {
  return { R: 'Red', G: 'Green', B: 'Blue', Y: 'Yellow' }[code] || 'Red';
}

function colorValue(code) {
  return { R: '#e53935', G: '#43a047', B: '#1e88e5', Y: '#fbc02d' }[code] || '#e53935';
}

function setBackground(color) {
  const map = { R: 'bgR.png', G: 'bgG.png', B: 'bgB.png', Y: 'bgY.png' };
  const img = map[color] || 'bgR.png';
  document.body.style.setProperty('--bg-image', `url('/backgrounds/${img}')`);
}

function clientCanPlay(card, state) {
  if (!card || !state) return false;
  if (card.type === 'wild' || card.type === 'wild4') return true;
  if (card.color && card.color === state.currentColor) return true;
  if (card.value === state.topCard?.value) return true;
  return false;
}
