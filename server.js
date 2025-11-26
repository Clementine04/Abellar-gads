const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'uno-secret';

const rooms = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve root-level assets (logos, card back, landing gif) under /assets
app.use('/cards-front', express.static(path.join(__dirname, 'cards-front')));
app.use('/backgrounds', express.static(path.join(__dirname, 'backgrounds')));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));
app.use('/assets', express.static(__dirname));

initStore();

function initStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
}

function readUsers() {
  const raw = fs.readFileSync(USERS_FILE, 'utf8');
  return JSON.parse(raw).users || [];
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
}

function findUser(username) {
  return readUsers().find((u) => u.username.toLowerCase() === username.toLowerCase());
}

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  if (username.length < 3) return res.status(400).json({ error: 'Username too short' });
  if (password.length < 4) return res.status(400).json({ error: 'Password too short' });
  const existing = findUser(username);
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const users = readUsers();
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, passwordHash, wins: 0 };
  users.push(user);
  writeUsers(users);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  const user = findUser(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

app.get('/api/leaderboard', (req, res) => {
  const users = readUsers()
    .map((u) => ({ username: u.username, wins: u.wins || 0 }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 25);
  res.json({ leaderboard: users });
});

app.post('/api/create-room', authMiddleware, (req, res) => {
  let code = generateRoomCode();
  while (rooms.has(code)) {
    code = generateRoomCode();
  }
  const room = {
    code,
    createdBy: req.user.username,
    status: 'waiting',
    players: [],
    deck: [],
    discard: [],
    currentColor: null,
    currentPlayerIndex: 0,
    lastEvent: null,
    turnDrawn: false,
    turnPlayer: null,
    winner: null
  };
  rooms.set(code, room);
  res.json({ code });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('joinRoom', (payload = {}, cb = () => {}) => {
    const { token, code } = payload;
    const user = verifyToken(token);
    if (!user) return cb({ error: 'Unauthorized' });
    const roomCode = (code || '').toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return cb({ error: 'Room not found' });

    let player = room.players.find((p) => p.username === user.username);
    if (!player) {
      if (room.players.length >= 2) return cb({ error: 'Room is full' });
      player = { id: socket.id, username: user.username, hand: [], connected: true, unoDeclared: false };
      room.players.push(player);
    } else {
      player.id = socket.id;
      player.connected = true;
      player.unoDeclared = false;
    }

    socket.join(roomCode);
    attachRoomListeners(socket, roomCode);

    ensureGameCanStart(room);

    emitRoomState(room);
    cb({ ok: true, code: roomCode });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.find((p) => p.id === socket.id);
      if (player) {
        player.connected = false;
        const connected = room.players.filter((p) => p.connected).length;
        if (room.status === 'playing' && connected === 1) {
          const winnerName = room.players.find((p) => p.connected)?.username;
          if (winnerName) concludeGame(room, winnerName);
        }
        emitRoomState(room);
      }
    }
  });

  socket.on('quitRoom', ({ code } = {}, cb = () => {}) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb({ error: 'Room not found' });
    const quitter = room.players.find((p) => p.id === socket.id);
    if (!quitter) return cb({ error: 'Not in room' });
    // If the game already ended or a winner is recorded, do nothing.
    if (room.status !== 'playing' || room.winner) return cb({ ok: true });
    const opponent = room.players.find((p) => p.username !== quitter.username);
    if (opponent) {
      concludeGame(room, opponent.username);
      emitRoomState(room);
    }
    cb({ ok: true });
  });
});

function attachRoomListeners(socket, roomCode) {
  socket.on('playCard', ({ code, cardId, chosenColor } = {}, cb = () => {}) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb({ error: 'Room not found' });
    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ error: 'Not in room' });
    if (room.status !== 'playing') return cb({ error: 'Game not active' });
    if (room.currentPlayerIndex !== playerIndex) return cb({ error: 'Not your turn' });
    const player = room.players[playerIndex];
    const aboutToUno = player.hand.length === 2;
    const declaredUno = player.unoDeclared;
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) return cb({ error: 'Card not found' });
    const playable = canPlay(card, room);
    if (!playable) return cb({ error: 'Card cannot be played' });
    if ((card.type === 'wild' || card.type === 'wild4') && !['R', 'G', 'B', 'Y'].includes(chosenColor)) {
      return cb({ error: 'Choose a color' });
    }

    removeCardFromHand(player, cardId);
    // After playing, UNO must be called explicitly when at 1 card; reset for next turns.
    player.unoDeclared = false;
    room.discard.push(card);
    room.currentColor = card.type.startsWith('wild') ? chosenColor : card.color;
    room.currentValue = card.value;
    let drawCount = 0;
    let skipNext = false;

    if (card.type === 'draw2') {
      drawCount = 2;
      skipNext = true;
      room.lastEvent = { type: 'draw2', by: player.username };
    } else if (card.type === 'wild4') {
      drawCount = 4;
      skipNext = true;
      room.lastEvent = { type: 'draw4', by: player.username };
    } else if (card.type === 'skip' || card.type === 'reverse') {
      skipNext = true;
      room.lastEvent = { type: 'skip', by: player.username };
  } else if (card.type === 'wild') {
    room.lastEvent = { type: 'wild', by: player.username };
  } else {
    room.lastEvent = { type: 'play', by: player.username };
  }
  // Penalty: if the player hit 1 card without declaring UNO beforehand, draw 2 immediately.
  if (player.hand.length === 1 && aboutToUno && !declaredUno) {
    drawMany(room, playerIndex, 2);
    room.lastEvent = { type: 'unoPenalty', by: player.username };
  }

    const winner = checkWinner(room, player);
    if (winner) {
      concludeGame(room, winner);
      emitRoomState(room);
      return cb({ ok: true });
    }

    rotateTurn(room, drawCount, skipNext);
    emitRoomState(room);
    cb({ ok: true });
  });

  socket.on('drawCard', ({ code } = {}, cb = () => {}) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb({ error: 'Room not found' });
    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ error: 'Not in room' });
    if (room.status !== 'playing') return cb({ error: 'Game not active' });
    if (room.currentPlayerIndex !== playerIndex) return cb({ error: 'Not your turn' });
    if (room.turnDrawn && room.turnPlayer === room.players[playerIndex].username) return cb({ error: 'You already drew this turn' });

    const card = drawFromDeck(room);
    if (!card) return cb({ error: 'Deck is empty' });
    room.players[playerIndex].hand.push(card);
    room.players[playerIndex].unoDeclared = false;
    room.turnDrawn = true;
    room.turnPlayer = room.players[playerIndex].username;
    room.lastEvent = { type: 'draw', by: room.players[playerIndex].username };
    emitRoomState(room);

    const playable = canPlay(card, room);
    if (!playable) {
      rotateTurn(room, 0, false);
      emitRoomState(room);
    }
    cb({ ok: true, card });
  });

  socket.on('callUno', ({ code } = {}) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    if (player.hand.length <= 2) {
      player.unoDeclared = true;
      room.lastEvent = { type: 'uno', by: player.username };
    }
    emitRoomState(room);
  });

}

function ensureGameCanStart(room) {
  const connected = room.players.filter((p) => p.connected).length;
  if (connected >= 2 && room.status !== 'playing') {
    startGame(room);
  }
}

function startGame(room) {
  room.status = 'playing';
  room.winner = null;
  room.deck = createDeck();
  shuffle(room.deck);
  room.discard = [];
  room.turnDrawn = false;
  room.turnPlayer = null;
  room.lastEvent = { type: 'shuffle' };

  room.players.forEach((p) => {
    p.hand = [];
    p.unoDeclared = false;
  });
  for (let i = 0; i < 7; i += 1) {
    room.players.forEach((p) => p.hand.push(drawFromDeck(room)));
  }

  let topCard = drawFromDeck(room);
  while (topCard.type === 'wild' || topCard.type === 'wild4') {
    room.deck.unshift(topCard);
    shuffle(room.deck);
    topCard = drawFromDeck(room);
  }
  room.discard.push(topCard);
  room.currentColor = topCard.color;
  room.currentValue = topCard.value;
  room.currentPlayerIndex = 0;
  room.turnPlayer = room.players[0]?.username || null;
  emitRoomState(room);
}

function rotateTurn(room, drawCount, skipNext) {
  if (!room || room.players.length === 0) return;
  let nextIndex = (room.currentPlayerIndex + 1) % room.players.length;
  if (drawCount > 0) {
    drawMany(room, nextIndex, drawCount);
    nextIndex = (nextIndex + 1) % room.players.length;
  } else if (skipNext) {
    nextIndex = (nextIndex + 1) % room.players.length;
  }
  room.currentPlayerIndex = nextIndex;
  room.turnDrawn = false;
  room.turnPlayer = room.players[nextIndex]?.username || null;
}

function checkWinner(room, player) {
  return player.hand.length === 0 ? player.username : null;
}

function concludeGame(room, winnerName) {
  room.status = 'ended';
  room.winner = winnerName;
  room.turnDrawn = false;
  room.turnPlayer = null;
  room.lastEvent = { type: 'gameOver', by: winnerName };
  const users = readUsers();
  const index = users.findIndex((u) => u.username === winnerName);
  if (index >= 0) {
    users[index].wins = (users[index].wins || 0) + 1;
    writeUsers(users);
  }
}

function emitRoomState(room) {
  room.players.forEach((p, idx) => {
    const opponentIndex = room.players.length > 1 ? (idx + 1) % room.players.length : -1;
    const opponent = opponentIndex >= 0 ? room.players[opponentIndex] : null;
    const state = {
      code: room.code,
      status: room.status,
      players: room.players.map((pl) => ({
        username: pl.username,
        cards: pl.hand.length,
        connected: pl.connected
      })),
      you: p.username,
      yourHand: p.hand,
      topCard: room.discard[room.discard.length - 1],
      drawPile: room.deck.length,
      currentColor: room.currentColor,
      currentPlayer: room.players[room.currentPlayerIndex]?.username,
      winner: room.winner || null,
      lastEvent: room.lastEvent || null,
      opponentName: opponent?.username || null,
      turnDrawn: room.turnDrawn
    };
    io.to(p.id).emit('state', state);
  });
}

function createDeck() {
  const colors = ['R', 'G', 'B', 'Y'];
  const deck = [];
  colors.forEach((color) => {
    deck.push(createCard(color, 0, 'number'));
    for (let i = 1; i <= 9; i += 1) {
      deck.push(createCard(color, i, 'number'));
      deck.push(createCard(color, i, 'number'));
    }
    for (let i = 0; i < 2; i += 1) {
      deck.push(createCard(color, 'D2', 'draw2'));
      deck.push(createCard(color, 'SKIP', 'skip'));
      deck.push(createCard(color, 'REV', 'reverse'));
    }
  });
  for (let i = 0; i < 4; i += 1) {
    deck.push(createCard(null, 'W', 'wild'));
    deck.push(createCard(null, 'D4', 'wild4'));
  }
  return deck;
}

function createCard(color, value, type) {
  return { id: uuidv4(), color, value, type };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function drawFromDeck(room) {
  if (room.deck.length === 0) {
    if (room.discard.length <= 1) {
      const top = room.discard[room.discard.length - 1] || null;
      room.deck = shuffleCopy(createDeck());
      room.discard = top ? [top] : [];
    } else {
      const top = room.discard.pop();
      room.deck = shuffleCopy(room.discard);
      room.discard = [top];
    }
  }
  const card = room.deck.pop();
  if (!card) {
    room.deck = shuffleCopy(createDeck());
    return room.deck.pop() || null;
  }
  return card;
}

function drawMany(room, playerIndex, count) {
  for (let i = 0; i < count; i += 1) {
    const card = drawFromDeck(room);
    if (card) {
      room.players[playerIndex].hand.push(card);
    }
  }
}

function shuffleCopy(arr) {
  const copy = [...arr];
  shuffle(copy);
  return copy;
}

function removeCardFromHand(player, cardId) {
  const idx = player.hand.findIndex((c) => c.id === cardId);
  if (idx >= 0) {
    player.hand.splice(idx, 1);
  }
}

function hasPlayableCard(hand, room) {
  return hand.some((card) => canPlay(card, room));
}

function canPlay(card, room) {
  const top = room.discard[room.discard.length - 1];
  if (!top) return true;
  if (card.type === 'wild' || card.type === 'wild4') return true;
  if (card.color && card.color === room.currentColor) return true;
  if (card.value === room.currentValue) return true;
  return false;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running on http://localhost:${PORT}`);
});
