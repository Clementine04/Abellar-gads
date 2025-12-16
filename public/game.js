// Game client for UNO Online
const socket = io({
    auth: { token: localStorage.getItem('uno_token') }
});

const qs = (id) => document.getElementById(id);

// DOM elements
const opponentHand = qs('opponent-hand');
const handRow = qs('hand-row');
const discardCard = qs('discard-card');
const currentColor = qs('current-color');
const turnBanner = qs('turn-banner');
const roomCodeDisplay = qs('room-code-display');
const deckCount = qs('deck-count');
const discardCount = qs('discard-count');
const lastAction = qs('last-action');
const gameStatus = qs('game-status');
const player1Label = qs('player1-label');
const player2Label = qs('player2-label');
const drawBtn = qs('draw-btn');
const unoBtn = qs('uno-btn');
const quitBtn = qs('quit-btn');
const musicToggle = qs('music-toggle');
const sfxToggle = qs('sfx-toggle');

let currentState = null;
let roomCode = null;

// Audio elements
let bgMusic = new Audio('/sounds/game-bg-music.mp3');
bgMusic.loop = true;
bgMusic.volume = 0.3;
let musicEnabled = true;
let sfxEnabled = true;

// Sound effects - using actual file names from sounds directory
const sounds = {
    cardPlay: new Audio('/sounds/shuffling-cards-1.mp3'),
    cardDraw: new Audio('/sounds/shuffling-cards-1.mp3'),
    uno: new Audio('/sounds/uno-sound.mp3'),
    win: new Audio('/sounds/game-over-sound.mp3'),
    lose: new Audio('/sounds/game-over-sound.mp3'),
    turn: new Audio('/sounds/shuffling-cards-1.mp3'),
    skip: new Audio('/sounds/skip-sound.mp3'),
    reverse: new Audio('/sounds/skip-sound.mp3'),
    draw2: new Audio('/sounds/draw2-sound.mp3'),
    draw4: new Audio('/sounds/draw4-sound.mp3'),
    wild: new Audio('/sounds/wild-sound.mp3')
};

function playSfx(name) {
    if (sfxEnabled && sounds[name]) {
        sounds[name].currentTime = 0;
        sounds[name].play().catch(() => { });
    }
}

// Get room code from URL or sessionStorage
function getRoomCode() {
    const params = new URLSearchParams(window.location.search);
    return params.get('room') || sessionStorage.getItem('roomCode');
}

// Card image path helper
function cardImagePath(cardId) {
    return `/cards-front/${cardId}.png`;
}

// Render opponent hand with CCSICT logo overlay (card backs)
function renderOpponentHand(count) {
    opponentHand.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'card-back-wrapper';
        const img = document.createElement('img');
        img.src = '/card-back.png';
        img.alt = 'Opponent card';
        wrapper.appendChild(img);
        opponentHand.appendChild(wrapper);
    }
}

// Render player hand with ISU logo overlay
function renderPlayerHand(cards, isMyTurn) {
    handRow.innerHTML = '';
    cards.forEach((card) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'card-wrapper player1-card-front';

        const btn = document.createElement('button');
        btn.className = 'card';

        const img = document.createElement('img');
        img.src = cardImagePath(card.id);
        img.alt = card.id;
        img.dataset.uid = card.uid;

        // Check if card is playable
        const isPlayable = isMyTurn && canPlayCard(card);
        if (isPlayable) {
            wrapper.classList.add('playable');
        }

        btn.appendChild(img);
        wrapper.appendChild(btn);

        // Add wild color picker if needed
        if (card.color === 'W') {
            const picker = createColorPicker(card.uid);
            wrapper.appendChild(picker);
        } else {
            btn.onclick = () => playCard(card.uid);
        }

        handRow.appendChild(wrapper);
    });
}

// Check if a card can be played
function canPlayCard(card) {
    if (!currentState || !currentState.topCard) return true;
    const top = currentState.topCard;
    if (card.color === 'W') return true;
    if (card.color === currentState.currentColor) return true;
    if (top.type === 'number' && card.type === 'number' && top.value === card.value) return true;
    if (top.type !== 'number' && card.type === top.type) return true;
    return false;
}

// Create color picker for wild cards
function createColorPicker(cardUid) {
    const picker = document.createElement('div');
    picker.className = 'wild-picker hidden';
    ['R', 'G', 'B', 'Y'].forEach((color) => {
        const dot = document.createElement('div');
        dot.className = `color-dot color-${color}`;
        dot.onclick = (e) => {
            e.stopPropagation();
            playCard(cardUid, color);
        };
        picker.appendChild(dot);
    });
    return picker;
}

// Play a card
function playCard(cardUid, chosenColor = null) {
    socket.emit('playCard', { code: roomCode, cardUid, chosenColor });
    playSfx('cardPlay');
}

// Update game state UI
function updateUI(state) {
    currentState = state;

    // Room code display
    roomCodeDisplay.textContent = `Game Code: ${state.code}`;

    // Player labels
    player1Label.textContent = state.you || 'Player 1';
    player2Label.textContent = state.opponent?.username || 'Waiting...';

    // Turn banner
    if (state.status === 'playing') {
        turnBanner.textContent = `Turn: ${state.turn}`;
        turnBanner.style.background = state.turn === state.you
            ? 'rgba(17, 196, 107, 0.7)'
            : 'rgba(0, 0, 0, 0.55)';
    } else if (state.status === 'finished') {
        turnBanner.textContent = state.winner === state.you ? '🎉 You Win!' : `${state.winner} Wins!`;
        turnBanner.style.background = state.winner === state.you
            ? 'rgba(255, 206, 0, 0.8)'
            : 'rgba(255, 82, 82, 0.8)';
    } else {
        turnBanner.textContent = 'Waiting for opponent...';
    }

    // Discard pile
    if (state.topCard) {
        discardCard.src = cardImagePath(state.topCard.id);
    } else {
        discardCard.src = '/card-back.png';
    }

    // Current color indicator
    const colorMap = { R: '#ff5252', G: '#11c46b', B: '#2aa3ff', Y: '#ffb400' };
    currentColor.style.background = colorMap[state.currentColor] || 'transparent';

    // Status chips
    deckCount.textContent = `Deck: ${state.deckCount}`;
    discardCount.textContent = `Discard: ${state.discardCount}`;
    lastAction.textContent = state.lastAction;

    // Game status badge
    gameStatus.textContent = state.status === 'playing'
        ? (state.turn === state.you ? 'Your Turn' : "Opponent's Turn")
        : state.status === 'finished'
            ? 'Game Over'
            : 'Waiting...';

    // Render hands
    renderOpponentHand(state.opponent?.cardCount || 0);
    renderPlayerHand(state.yourHand || [], state.turn === state.you);

    // Button states
    drawBtn.disabled = state.status !== 'playing' || state.turn !== state.you;
    unoBtn.disabled = state.status !== 'playing';
}

// Socket events
socket.on('state', (state) => {
    const prevState = currentState;
    updateUI(state);

    // Play sounds based on action type
    if (prevState && state.lastActionType) {
        if (state.lastActionType === 'draw') playSfx('cardDraw');
        if (state.lastActionType === 'uno') playSfx('uno');
        if (state.lastActionType === 'skip' || state.lastActionType === 'reverse') playSfx('skip');
        if (state.lastActionType === 'gameover') {
            playSfx(state.winner === state.you ? 'win' : 'lose');
        }
        if (state.turn === state.you && prevState.turn !== state.you) {
            playSfx('turn');
        }
    }

    // Start music on first state
    if (!prevState && musicEnabled) {
        bgMusic.play().catch(() => { });
    }
});

socket.on('roomCreated', ({ code }) => {
    roomCode = code;
    sessionStorage.setItem('uno_code', code);
    roomCodeDisplay.textContent = `Game Code: ${code}`;
});

socket.on('errorMessage', (msg) => {
    lastAction.textContent = `⚠️ ${msg}`;
});

// Button handlers
drawBtn.addEventListener('click', () => {
    if (roomCode) {
        socket.emit('drawCard', roomCode);
    }
});

unoBtn.addEventListener('click', () => {
    if (roomCode) {
        socket.emit('callUno', roomCode);
        playSfx('uno');
    }
});

quitBtn.addEventListener('click', () => {
    if (roomCode) {
        socket.emit('leaveRoom');
        sessionStorage.removeItem('uno_code');
    }
    window.location.href = '/home.html';
});

// Music toggle
musicToggle.addEventListener('click', () => {
    musicEnabled = !musicEnabled;
    if (musicEnabled) {
        bgMusic.play().catch(() => { });
        musicToggle.textContent = '🔊';
    } else {
        bgMusic.pause();
        musicToggle.textContent = '🔇';
    }
});

// SFX toggle
sfxToggle.addEventListener('click', () => {
    sfxEnabled = !sfxEnabled;
    sfxToggle.textContent = sfxEnabled ? '🔈' : '🔇';
});

// Show/hide wild picker on card hover
handRow.addEventListener('mouseenter', (e) => {
    const wrapper = e.target.closest('.card-wrapper');
    if (wrapper) {
        const picker = wrapper.querySelector('.wild-picker');
        if (picker) picker.classList.remove('hidden');
    }
}, true);

handRow.addEventListener('mouseleave', (e) => {
    const wrapper = e.target.closest('.card-wrapper');
    if (wrapper) {
        const picker = wrapper.querySelector('.wild-picker');
        if (picker) picker.classList.add('hidden');
    }
}, true);

// Initialize
const action = sessionStorage.getItem('uno_action');
roomCode = sessionStorage.getItem('uno_code');

if (action === 'create') {
    // Create a new room
    socket.emit('createRoom');
    sessionStorage.removeItem('uno_action');
} else if (action === 'join' && roomCode) {
    // Join existing room
    socket.emit('joinRoom', roomCode);
    sessionStorage.removeItem('uno_action');
} else if (roomCode) {
    // Reconnect to existing room
    socket.emit('reconnectRoom', roomCode);
} else {
    // If no action or room code, redirect to home
    window.location.href = '/home.html';
}
