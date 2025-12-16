const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const DISCONNECT_GRACE_MS = 30000;

const sessions = new Map(); // token -> username
const rooms = new Map(); // roomCode -> room state
let users = {}; // username -> { passwordHash }
let leaderboard = {}; // username -> wins

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/backgrounds', express.static(path.join(__dirname, 'backgrounds')));
app.use('/cards-front', express.static(path.join(__dirname, 'cards-front')));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));
app.get('/card-back.png', (req, res) => res.sendFile(path.join(__dirname, 'card-back.png')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
app.get('/isu-logo.png', (req, res) => res.sendFile(path.join(__dirname, 'ISU LOGO.png')));
app.get('/ccsict-logo.png', (req, res) => res.sendFile(path.join(__dirname, 'ccsict-logo.png')));
app.get('/Landing-Page.gif', (req, res) => res.sendFile(path.join(__dirname, 'Landing-Page.gif')));

const COLORS = ['R', 'G', 'B', 'Y'];
const ACTION_TYPES = ['skip', 'reverse', 'draw2'];

async function ensureDataFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    await fsp.writeFile(USERS_FILE, JSON.stringify({}, null, 2));
  }
  if (!fs.existsSync(LEADERBOARD_FILE)) {
    await fsp.writeFile(LEADERBOARD_FILE, JSON.stringify({}, null, 2));
  }
}

async function loadData() {
  try {
    const rawUsers = await fsp.readFile(USERS_FILE, 'utf-8');
    users = JSON.parse(rawUsers || '{}');
  } catch {
    users = {};
  }
  try {
    const rawLeaderboard = await fsp.readFile(LEADERBOARD_FILE, 'utf-8');
    leaderboard = JSON.parse(rawLeaderboard || '{}');
  } catch {
    leaderboard = {};
  }
}

async function saveUsers() {
  await fsp.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

async function saveLeaderboard() {
  await fsp.writeFile(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
}

function createSession(username) {
  const token = uuidv4();
  sessions.set(token, username);
  return token;
}

function getUserFromToken(token) {
  if (!token) return null;
  return sessions.get(token) || null;
}

function makeRoomCode() {
  let code = '';
  do {
    code = Math.random().toString(36).substring(2, 7).toUpperCase();
  } while (rooms.has(code));
  return code;
}

let cardUid = 0;
function nextCardUid() {
  cardUid += 1;
  return `c${cardUid}`;
}

function buildDeck() {
  const deck = [];
  COLORS.forEach((color) => {
    deck.push({ uid: nextCardUid(), color, type: 'number', value: 0, id: `0${color}` });
    for (let value = 1; value <= 9; value += 1) {
      deck.push({ uid: nextCardUid(), color, type: 'number', value, id: `${value}${color}` });
      deck.push({ uid: nextCardUid(), color, type: 'number', value, id: `${value}${color}` });
    }
    for (let i = 0; i < 2; i += 1) {
      deck.push({ uid: nextCardUid(), color, type: 'skip', id: `skip${color}` });
      deck.push({ uid: nextCardUid(), color, type: 'reverse', id: `_${color}` });
      deck.push({ uid: nextCardUid(), color, type: 'draw2', id: `D2${color}` });
    }
  });
  for (let i = 0; i < 4; i += 1) {
    deck.push({ uid: nextCardUid(), color: 'W', type: 'wild', id: 'W' });
    deck.push({ uid: nextCardUid(), color: 'W', type: 'draw4', id: 'D4W' });
  }
  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function drawCard(room) {
  if (room.deck.length === 0) {
    const top = room.discard.pop();
    room.deck = shuffle(room.discard);
    room.discard = top ? [top] : [];
    if (room.deck.length === 0) {
      room.deck = buildDeck();
      shuffle(room.deck);
      if (top) room.discard = [top];
    }
  }
  return room.deck.pop();
}

function cardMatches(card, room) {
  const top = room.discard[room.discard.length - 1];
  if (!top) return true;
  if (card.color === 'W') return true;
  if (card.color === room.currentColor) return true;
  if (top.type === 'number' && card.type === 'number' && top.value === card.value) return true;
  if (top.type !== 'number' && card.type === top.type) return true;
  return false;
}

function hasPlayableCard(room, username) {
  const player = room.players[username];
  if (!player) return false;
  return player.hand.some((card) => cardMatches(card, room));
}

function otherPlayer(room, username) {
  return Object.keys(room.players).find((u) => u !== username);
}

function resetUnoFlags(room) {
  Object.values(room.players).forEach((p) => {
    p.calledUno = false;
  });
}

function startGame(room) {
  if (Object.keys(room.players).length < 2) {
    room.status = 'waiting';
    room.turn = null;
    room.lastAction = 'Waiting for an opponent.';
    room.lastActionType = 'waiting';
    broadcastRoom(room);
    return;
  }
  room.deck = buildDeck();
  room.discard = [];
  Object.values(room.players).forEach((player) => {
    player.hand = [];
  });
  for (let i = 0; i < 7; i += 1) {
    Object.values(room.players).forEach((player) => {
      player.hand.push(drawCard(room));
    });
  }
  let starter = drawCard(room);
  while (starter.color === 'W' || starter.type !== 'number') {
    room.deck.push(starter);
    shuffle(room.deck);
    starter = drawCard(room);
  }
  room.discard.push(starter);
  room.currentColor = starter.color;
  const playerNames = Object.keys(room.players);
  room.turn = playerNames[Math.floor(Math.random() * playerNames.length)];
  resetUnoFlags(room);
  room.status = 'playing';
  room.winner = null;
  room.lastAction = `Game started. ${room.turn} goes first.`;
  room.lastActionType = 'start';
  room.drawnThisTurn = null;
}

function maybeStartGame(room) {
  if (room && room.status === 'waiting' && Object.keys(room.players).length === 2) {
    startGame(room);
  }
}

function applyCardEffect(room, playerName, card) {
  const opponent = otherPlayer(room, playerName);
  room.lastActionType = card.type;
  switch (card.type) {
    case 'skip':
    case 'reverse':
      room.turn = playerName;
      room.lastAction = `${playerName} skipped ${opponent}'s turn.`;
      room.lastActionType = card.type;
      room.drawnThisTurn = null;
      break;
    case 'draw2': {
      const drawn = [];
      for (let i = 0; i < 2; i += 1) {
        drawn.push(drawCard(room));
      }
      room.players[opponent].hand.push(...drawn);
      room.turn = playerName;
      room.lastAction = `${playerName} made ${opponent} draw 2.`;
      room.lastActionType = 'draw2';
      room.drawnThisTurn = null;
      break;
    }
    case 'draw4': {
      const drawn = [];
      for (let i = 0; i < 4; i += 1) {
        drawn.push(drawCard(room));
      }
      room.players[opponent].hand.push(...drawn);
      room.turn = playerName;
      room.lastAction = `${playerName} made ${opponent} draw 4.`;
      room.lastActionType = 'draw4';
      room.drawnThisTurn = null;
      break;
    }
    default:
      room.turn = opponent;
      room.lastAction = `${playerName} played a ${cardLabel(card)}.`;
      room.lastActionType = card.type;
      room.drawnThisTurn = null;
  }
}

function cardLabel(card) {
  if (card.type === 'number') return `${card.value} ${card.color}`;
  if (card.type === 'wild') return 'Wild';
  if (card.type === 'draw4') return 'Wild Draw 4';
  if (card.type === 'draw2') return `Draw 2 ${card.color}`;
  if (card.type === 'skip') return `Skip ${card.color}`;
  if (card.type === 'reverse') return `Reverse ${card.color}`;
  return 'Card';
}

function punishMissingUno(room, playerName) {
  const player = room.players[playerName];
  if (player.hand.length === 1 && !player.calledUno) {
    const drawn = [drawCard(room), drawCard(room)];
    player.hand.push(...drawn);
    room.lastAction = `${playerName} forgot to call UNO! Drew 2 as penalty.`;
    room.lastActionType = 'penalty';
  }
}

function checkWinner(room, playerName) {
  const player = room.players[playerName];
  if (player.hand.length === 0) {
    room.status = 'finished';
    room.winner = playerName;
    leaderboard[playerName] = (leaderboard[playerName] || 0) + 1;
    saveLeaderboard();
    room.lastAction = `${playerName} wins the round!`;
    room.lastActionType = 'gameover';
  }
}

function sanitizeHand(hand) {
  return hand.map((card) => ({
    uid: card.uid,
    id: card.id,
    color: card.color,
    type: card.type,
    value: card.value ?? null,
  }));
}

function broadcastRoom(room) {
  // Auto-start if two seats are filled but status never flipped
  if (room.status === 'waiting' && Object.keys(room.players).length >= 2) {
    startGame(room);
  }
  Object.entries(room.players).forEach(([username, player]) => {
    const opponentName = otherPlayer(room, username);
    const opponent = opponentName ? room.players[opponentName] : null;
    const payload = {
      code: room.code,
      status: room.status,
      you: username,
      turn: room.turn,
      currentColor: room.currentColor,
      topCard: room.discard[room.discard.length - 1] || null,
      yourHand: sanitizeHand(player.hand),
      opponent: opponent
        ? { username: opponentName, cardCount: opponent.hand.length }
        : null,
      deckCount: room.deck.length,
      discardCount: room.discard.length,
      winner: room.winner,
      lastAction: room.lastAction,
      lastActionType: room.lastActionType || null,
    };
    io.to(player.socketId).emit('state', payload);
  });
}

function finalizeLeave(room, username, reason = 'left the room.') {
  if (!room || !room.players[username]) return;
  if (!room.disconnectTimers) room.disconnectTimers = {};
  if (room.disconnectTimers[username]) {
    clearTimeout(room.disconnectTimers[username]);
    delete room.disconnectTimers[username];
  }

  delete room.players[username];
  if (Object.keys(room.players).length === 0) {
    rooms.delete(room.code);
    return;
  }
  const remainingNames = Object.keys(room.players);
  room.lastAction = `${username} ${reason}`;
  room.lastActionType = 'leave';
  if (room.status === 'playing') {
    room.winner = remainingNames[0];
    room.status = 'finished';
    leaderboard[room.winner] = (leaderboard[room.winner] || 0) + 1;
    saveLeaderboard();
    room.lastAction = `${room.winner} wins by default.`;
    room.lastActionType = 'gameover';
  }
  broadcastRoom(room);
}

function scheduleLeave(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  const username = Object.entries(room.players).find(([, player]) => player.socketId === socket.id)?.[0];
  if (!username) return;
  room.disconnectTimers = room.disconnectTimers || {};
  if (room.disconnectTimers[username]) clearTimeout(room.disconnectTimers[username]);
  room.disconnectTimers[username] = setTimeout(() => {
    finalizeLeave(room, username, 'disconnected.');
  }, DISCONNECT_GRACE_MS);
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }
  if (users[username]) {
    return res.status(409).json({ message: 'Username already exists.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  users[username] = { passwordHash };
  leaderboard[username] = leaderboard[username] || 0;
  await saveUsers();
  await saveLeaderboard();
  const token = createSession(username);
  return res.json({ username, token, wins: leaderboard[username] || 0 });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }
  const user = users[username];
  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials.' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ message: 'Invalid credentials.' });
  }
  const token = createSession(username);
  return res.json({ username, token, wins: leaderboard[username] || 0 });
});

app.get('/api/me', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const username = getUserFromToken(token);
  if (!username) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  return res.json({ username, wins: leaderboard[username] || 0 });
});

app.get('/api/leaderboard', (req, res) => {
  const top = Object.entries(leaderboard)
    .map(([username, wins]) => ({ username, wins }))
    .sort((a, b) => b.wins - a.wins || a.username.localeCompare(b.username))
    .slice(0, 50);
  return res.json(top);
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const username = getUserFromToken(token);
  if (!username) {
    return next(new Error('unauthorized'));
  }
  socket.username = username;
  return next();
});

io.on('connection', (socket) => {
  socket.on('createRoom', () => {
    const code = makeRoomCode();
    const room = {
      code,
      host: socket.username,
      status: 'waiting',
      players: {
        [socket.username]: {
          socketId: socket.id,
          hand: [],
          calledUno: false,
        },
      },
      deck: [],
      discard: [],
      turn: null,
      currentColor: null,
      winner: null,
      lastAction: `${socket.username} is waiting for an opponent.`,
      lastActionType: 'waiting',
      drawnThisTurn: null,
      disconnectTimers: {},
    };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.emit('roomCreated', { code });
    broadcastRoom(room);
  });

  socket.on('joinRoom', (code) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit('errorMessage', 'Room not found.');
      return;
    }
    if (room.status !== 'waiting') {
      socket.emit('errorMessage', 'Room already in play.');
      return;
    }
    if (Object.keys(room.players).length >= 2) {
      socket.emit('errorMessage', 'Room is full.');
      return;
    }
    const playerName = socket.username;
    // if same username re-joining, just update socket and broadcast
    if (room.players[playerName]) {
      room.players[playerName].socketId = socket.id;
      socket.data.roomCode = code;
      broadcastRoom(room);
      return;
    }
    room.disconnectTimers = room.disconnectTimers || {};
    room.players[playerName] = {
      socketId: socket.id,
      hand: [],
      calledUno: false,
    };
    room.lastAction = `${playerName} joined the room.`;
    room.lastActionType = 'join';
    socket.data.roomCode = code;
    startGame(room);
    broadcastRoom(room);
  });

  socket.on('reconnectRoom', (code) => {
    const room = rooms.get(code);
    if (!room) return;
    let player = room.players[socket.username];
    if (!player && Object.keys(room.players).length < 2) {
      // allow re-attach if user was dropped
      room.players[socket.username] = {
        socketId: socket.id,
        hand: [],
        calledUno: false,
      };
      player = room.players[socket.username];
      room.lastAction = `${socket.username} rejoined the room.`;
      room.lastActionType = 'join';
      if (room.status === 'waiting' && Object.keys(room.players).length === 2) {
        startGame(room);
      }
    }
    if (!player) return;
    player.socketId = socket.id;
    socket.data.roomCode = code;
    if (room.disconnectTimers && room.disconnectTimers[socket.username]) {
      clearTimeout(room.disconnectTimers[socket.username]);
      delete room.disconnectTimers[socket.username];
    }
    broadcastRoom(room);
  });

  socket.on('playCard', ({ code, cardUid, chosenColor }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    if (room.turn !== socket.username) return;
    const player = room.players[socket.username];
    const idx = player.hand.findIndex((c) => c.uid === cardUid);
    if (idx === -1) return;
    const card = player.hand[idx];
    let pickedColor = chosenColor ? chosenColor.toUpperCase() : null;
    if (card.color === 'W') {
      const fallback = pickedColor || room.currentColor || 'R';
      pickedColor = COLORS.includes(fallback) ? fallback : 'R';
    }
    if (!cardMatches(card, room)) {
      socket.emit('errorMessage', 'Card does not match.');
      return;
    }
    player.hand.splice(idx, 1);
    room.discard.push(card);
    room.currentColor = card.color === 'W' ? pickedColor || room.currentColor : card.color;
    applyCardEffect(room, socket.username, card);
    punishMissingUno(room, socket.username);
    checkWinner(room, socket.username);
    if (room.status === 'finished') {
      broadcastRoom(room);
      return;
    }
    resetUnoFlags(room);
    broadcastRoom(room);
  });

  socket.on('drawCard', (code) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    if (room.turn !== socket.username) return;
    if (room.drawnThisTurn === socket.username) {
      socket.emit('errorMessage', 'You already drew this turn.');
      return;
    }
    const card = drawCard(room);
    room.players[socket.username].hand.push(card);
    room.lastAction = `${socket.username} drew a card.`;
    room.lastActionType = 'draw';
    room.drawnThisTurn = socket.username;

    // If after drawing there is still no playable card, auto-pass to avoid getting stuck.
    if (!hasPlayableCard(room, socket.username)) {
      const next = otherPlayer(room, socket.username);
      room.turn = next;
      room.drawnThisTurn = null;
      resetUnoFlags(room);
      room.lastAction = `${socket.username} drew and passed (no playable cards).`;
      room.lastActionType = 'pass';
    }

    broadcastRoom(room);
  });

  socket.on('passTurn', (code) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    if (room.turn !== socket.username) return;
    const drewAlready = room.drawnThisTurn === socket.username;
    if (hasPlayableCard(room, socket.username) && !drewAlready) {
      socket.emit('errorMessage', 'Draw a card first or play a card.');
      return;
    }
    const next = otherPlayer(room, socket.username);
    room.turn = next;
    room.drawnThisTurn = null;
    resetUnoFlags(room);
    room.lastAction = `${socket.username} passed the turn.`;
    room.lastActionType = 'pass';
    broadcastRoom(room);
  });

  socket.on('callUno', (code) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const player = room.players[socket.username];
    if (!player) return;
    player.calledUno = true;
    room.lastAction = `${socket.username} calls UNO!`;
    room.lastActionType = 'uno';
    broadcastRoom(room);
  });

  socket.on('requestState', (code) => {
    const room = rooms.get(code);
    if (!room) return;
    if (!room.players[socket.username] && Object.keys(room.players).length < 2) {
      room.players[socket.username] = {
        socketId: socket.id,
        hand: [],
        calledUno: false,
      };
      socket.data.roomCode = code;
      room.lastAction = `${socket.username} rejoined the room.`;
      room.lastActionType = 'join';
      if (room.status === 'waiting' && Object.keys(room.players).length === 2) {
        startGame(room);
      }
    }
    broadcastRoom(room);
  });

  socket.on('leaveRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    finalizeLeave(room, socket.username);
  });

  socket.on('disconnect', () => {
    scheduleLeave(socket);
  });
});

async function bootstrap() {
  await ensureDataFiles();
  await loadData();
  server.listen(PORT, () => {
    console.log(`UNO server running on http://localhost:${PORT}`);
  });
}

bootstrap();
