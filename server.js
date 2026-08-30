const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room storage: { code: { players: {id:{...}}, hostId, started } }
const rooms = {};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function spawnPoint(index, total) {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  return { x: Math.cos(angle) * 9, z: Math.sin(angle) * 9 };
}

function publicRoomState(code) {
  const room = rooms[code];
  return {
    code,
    hostId: room.hostId,
    started: room.started,
    players: room.players,
  };
}

io.on('connection', (socket) => {
  let currentRoom = null;

  function joinRoom(code, name) {
    currentRoom = code;
    socket.join(code);
    rooms[code].players[socket.id] = {
      id: socket.id,
      name: (name || 'Oyuncu').slice(0, 14),
      x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0,
      health: 100, score: 0, kills: 0, alive: true,
    };
    socket.emit('room-joined', publicRoomState(code));
    socket.to(code).emit('player-joined', rooms[code].players[socket.id]);
  }

  socket.on('create-room', (name) => {
    const code = makeRoomCode();
    rooms[code] = { players: {}, hostId: socket.id, started: false };
    joinRoom(code, name);
  });

  socket.on('join-room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms[code]) return socket.emit('join-error', 'Oda bulunamadı.');
    if (rooms[code].started) return socket.emit('join-error', 'Oyun zaten başladı.');
    if (Object.keys(rooms[code].players).length >= 8) return socket.emit('join-error', 'Oda dolu.');
    joinRoom(code, name);
  });

  socket.on('start-game', () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    room.started = true;
    const ids = Object.keys(room.players);
    ids.forEach((id, i) => {
      const p = spawnPoint(i, ids.length);
      const pl = room.players[id];
      pl.x = p.x; pl.z = p.z; pl.y = 1.7;
      pl.health = 100; pl.score = 0; pl.kills = 0; pl.alive = true;
    });
    io.to(currentRoom).emit('game-started', room.players);
  });

  socket.on('update', (state) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id] || !room.players[socket.id].alive) return;
    Object.assign(room.players[socket.id], state);
    socket.to(currentRoom).emit('player-update', { id: socket.id, ...state });
  });

  socket.on('shoot-fx', () => {
    if (currentRoom) socket.to(currentRoom).emit('player-shot-fx', socket.id);
  });

  socket.on('shoot-hit', ({ targetId, damage }) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[targetId] || !room.players[targetId].alive) return;
    const target = room.players[targetId];
    const shooter = room.players[socket.id];
    target.health -= damage;
    if (target.health <= 0) {
      target.health = 0;
      target.alive = false;
      if (shooter) { shooter.score += 100; shooter.kills += 1; }
      io.to(currentRoom).emit('player-killed', {
        targetId, targetName: target.name,
        killerId: socket.id, killerName: shooter ? shooter.name : '???',
        killerScore: shooter ? shooter.score : 0,
      });
      setTimeout(() => {
        const r = rooms[currentRoom];
        if (!r || !r.players[targetId]) return;
        const ids = Object.keys(r.players);
        const p = spawnPoint(ids.indexOf(targetId), ids.length);
        Object.assign(r.players[targetId], { x: p.x, z: p.z, y: 1.7, health: 100, alive: true });
        io.to(currentRoom).emit('player-respawned', { id: targetId, x: p.x, z: p.z });
      }, 3000);
    } else {
      io.to(currentRoom).emit('player-damaged', { id: targetId, health: target.health, by: socket.id });
    }
  });

  socket.on('leave-room', () => handleLeave());
  socket.on('disconnect', () => handleLeave());

  function handleLeave() {
    const room = rooms[currentRoom];
    if (!room) return;
    delete room.players[socket.id];
    socket.to(currentRoom).emit('player-left', socket.id);
    if (room.hostId === socket.id) {
      const remaining = Object.keys(room.players);
      if (remaining.length > 0) {
        room.hostId = remaining[0];
        io.to(currentRoom).emit('new-host', remaining[0]);
      }
    }
    if (Object.keys(room.players).length === 0) delete rooms[currentRoom];
    currentRoom = null;
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Sunucu ' + PORT + ' portunda çalışıyor'));
