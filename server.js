// Live, shareable whiteboards. Board state lives only in memory and is
// dropped shortly after the last person leaves — nothing is written to disk.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Grace period so a page refresh doesn't wipe the board.
const EMPTY_ROOM_TTL_MS = 30 * 1000;
const MAX_ITEMS_PER_ROOM = 5000;
const MAX_MESSAGE_BYTES = 512 * 1024;
const ROOM_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/new') {
    const id = crypto.randomBytes(6).toString('base64url');
    res.writeHead(302, { Location: `/b/${id}` });
    return res.end();
  }

  if (pathname === '/' || pathname.startsWith('/b/')) {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  sendFile(res, file);
});

// roomId -> { items: Map<id, item>, clients: Map<ws, user>, cleanup: Timeout|null }
const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { items: new Map(), clients: new Map(), cleanup: null };
    rooms.set(id, room);
  }
  if (room.cleanup) {
    clearTimeout(room.cleanup);
    room.cleanup = null;
  }
  return room;
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients.keys()) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function isValidItem(item) {
  return item && typeof item === 'object' && typeof item.id === 'string' && item.id.length <= 64;
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws, req) => {
  const roomId = new URL(req.url, 'http://localhost').searchParams.get('room');
  if (!roomId || !ROOM_ID_RE.test(roomId)) return ws.close(1008, 'Invalid board id');

  const room = getRoom(roomId);
  const user = { id: crypto.randomBytes(4).toString('hex'), name: 'Guest', color: '#888' };
  room.clients.set(ws, user);

  ws.send(JSON.stringify({
    t: 'init',
    you: user.id,
    items: [...room.items.values()],
    users: [...room.clients.values()].filter((u) => u !== user),
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.t) {
      case 'hello':
        user.name = String(msg.name || 'Guest').slice(0, 32);
        user.color = String(msg.color || '#888').slice(0, 16);
        broadcast(room, { t: 'join', user }, ws);
        break;
      case 'cursor':
        broadcast(room, { t: 'cursor', id: user.id, x: +msg.x || 0, y: +msg.y || 0 }, ws);
        break;
      case 'upsert':
        if (!Array.isArray(msg.items)) return;
        for (const item of msg.items) {
          if (!isValidItem(item)) return;
          if (!room.items.has(item.id) && room.items.size >= MAX_ITEMS_PER_ROOM) return;
          room.items.set(item.id, item);
        }
        broadcast(room, { t: 'upsert', items: msg.items }, ws);
        break;
      case 'delete':
        if (!Array.isArray(msg.ids)) return;
        for (const id of msg.ids) room.items.delete(id);
        broadcast(room, { t: 'delete', ids: msg.ids }, ws);
        break;
      case 'clear':
        room.items.clear();
        broadcast(room, { t: 'clear' }, ws);
        break;
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcast(room, { t: 'leave', id: user.id });
    if (room.clients.size === 0) {
      room.cleanup = setTimeout(() => rooms.delete(roomId), EMPTY_ROOM_TTL_MS);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Board server running at http://localhost:${PORT}`);
});
