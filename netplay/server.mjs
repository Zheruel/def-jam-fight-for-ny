import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_PLAYERS = 2;
const MAX_PLAYERS = 4;

// A room seats the host (slot 0) and up to players - 1 guests. Hosts that never ask for more keep the two-player room.
function playerCount(value) {
  return Number.isInteger(value) && value >= DEFAULT_PLAYERS && value <= MAX_PLAYERS ? value : value === undefined ? DEFAULT_PLAYERS : 0;
}

function acceptsOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (!origin || allowedOrigins.has(origin)) return true;

  try {
    const page = new URL(origin);
    const endpoint = new URL(`http://${request.headers.host}`);
    return ['http:', 'https:'].includes(page.protocol) && (
      page.host === endpoint.host ||
      (LOOPBACK.has(page.hostname) && LOOPBACK.has(endpoint.hostname))
    );
  } catch {
    return false;
  }
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function signalPayload(message, role) {
  const { type, description, candidate } = message;
  if (type === 'offer' || type === 'answer') {
    if (type !== (role === 'host' ? 'offer' : 'answer')) return null;
    if (description?.type !== type || typeof description.sdp !== 'string') return null;
    if (description.sdp.length === 0 || description.sdp.length > 48 * 1024) return null;
    return { description: { type, sdp: description.sdp } };
  }

  if (type !== 'ice' || typeof candidate?.candidate !== 'string') return null;
  if (candidate.candidate.length > 4096) return null;
  const { sdpMid, sdpMLineIndex, usernameFragment } = candidate;
  if (sdpMid != null && (typeof sdpMid !== 'string' || sdpMid.length > 256)) return null;
  if (sdpMLineIndex != null && (!Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 32)) return null;
  if (usernameFragment != null && (typeof usernameFragment !== 'string' || usernameFragment.length > 256)) return null;
  return { candidate: { candidate: candidate.candidate, sdpMid, sdpMLineIndex, usernameFragment } };
}

export function attachNetplay(server, { path = '/netplay', allowedOrigins = [], maxClients = 200 } = {}) {
  const rooms = new Map();
  const trustedOrigins = new Set(allowedOrigins);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  function upgrade(request, socket, head) {
    if (request.url?.split('?', 1)[0] !== path) return;

    const reject = !acceptsOrigin(request, trustedOrigins) ? '403 Forbidden'
      : sockets.clients.size >= maxClients ? '503 Service Unavailable' : null;
    if (reject) {
      socket.end(`HTTP/1.1 ${reject}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client));
  }

  sockets.on('connection', (socket) => {
    let room;
    let role;
    let self;
    let closed = false;
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => socket.terminate());
    const roomDeadline = setTimeout(() => {
      if (!room) socket.close(1008, 'Choose a room');
    }, 10_000);
    roomDeadline.unref();

    function reject(message) {
      closed = true;
      send(socket, { type: 'error', message });
      socket.close(1008, 'Invalid room request');
    }

    function removeGuest(guest, message) {
      if (!guest || room.guests.get(guest.slot) !== guest) return;
      room.guests.delete(guest.slot);
      send(room.host, { type: 'peer-left', round: guest.round, slot: guest.slot });
      if (message) {
        send(guest.socket, { type: 'error', message });
        guest.socket.close(1000, 'Match ended');
      }
    }

    socket.on('message', (data, isBinary) => {
      if (closed) return;
      let message;
      try {
        if (!isBinary) message = JSON.parse(data.toString());
      } catch {
        // Invalid requests are rejected below.
      }
      if (!message || typeof message.type !== 'string') return reject('Invalid room request.');

      if (!room && message.type === 'info') {
        // What a guest may see before joining: the seats the host allows and how many are open.
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        const found = ROOM_PATTERN.test(code) && rooms.get(code);
        if (!found) return reject('Room unavailable. Check the code and try again.');
        send(socket, { type: 'info', code, players: found.players, open: found.players - 1 - found.guests.size });
        return;
      }

      if (!room && message.type === 'host') {
        const players = playerCount(message.players);
        if (!players) return reject('A room seats two to four players.');
        let code;
        do {
          code = Array.from(randomBytes(8), (byte) => ROOM_ALPHABET[byte & 31]).join('');
        } while (rooms.has(code));
        room = { code, host: socket, guests: new Map(), round: 0, players };
        role = 'host';
        rooms.set(code, room);
        send(socket, { type: 'room', code, players });
        return;
      }

      if (!room && message.type === 'join') {
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        const availableRoom = ROOM_PATTERN.test(code) && rooms.get(code);
        if (!availableRoom) return reject('Room unavailable. Check the code and try again.');
        if (availableRoom.guests.size >= availableRoom.players - 1) {
          return reject(availableRoom.players === DEFAULT_PLAYERS ? 'This room already has a guest.' : 'This room is full.');
        }
        room = availableRoom;
        role = 'guest';
        // A returning guest may ask for the seat it had; otherwise the lowest free seat.
        let slot = Number.isInteger(message.slot) && message.slot >= 1 && message.slot < room.players && !room.guests.has(message.slot)
          ? message.slot : 1;
        while (room.guests.has(slot)) slot++;
        room.round += 1;
        self = { socket, slot, round: room.round };
        room.guests.set(slot, self);
        send(socket, { type: 'room', code, round: room.round, slot, players: room.players });
        send(room.host, { type: 'peer-joined', round: room.round, slot });
        return;
      }

      if (!room) return reject('Create or join a room first.');
      if (role === 'host' && message.type === 'players') {
        // The host decides how many seats are advertised; it cannot seat fewer than the guests already present.
        const players = playerCount(message.players);
        if (!players || players < room.guests.size + 1 || [...room.guests.keys()].some((slot) => slot >= players)) return;
        room.players = players;
        send(socket, { type: 'players', players, open: players - 1 - room.guests.size });
        return;
      }
      if (role === 'guest' && room.guests.get(self?.slot) !== self) return;
      const target = role === 'host' ? [...room.guests.values()].find((guest) => guest.round === message.round) : self;
      if (!target || message.round !== target.round) return;
      if (message.type === 'drop-peer') {
        removeGuest(target, 'The peer connection ended. Rejoin the room to try again.');
        return;
      }
      const payload = signalPayload(message, role);
      if (payload) {
        const out = { type: message.type, round: target.round, ...payload };
        if (role === 'host') send(target.socket, out);
        else send(room.host, { ...out, slot: target.slot });
      }
    });

    socket.on('close', () => {
      clearTimeout(roomDeadline);
      if (!room) return;
      if (role === 'host') {
        rooms.delete(room.code);
        for (const guest of room.guests.values()) {
          send(guest.socket, { type: 'room-closed' });
          guest.socket.close(1000, 'Room closed');
        }
      } else {
        removeGuest(self);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.alive) {
        socket.terminate();
        continue;
      }
      socket.alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  server.on('upgrade', upgrade);
  server.once('close', () => {
    clearInterval(heartbeat);
    server.off('upgrade', upgrade);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.NETPLAY_HOST || '127.0.0.1';
  const port = Number(process.env.NETPLAY_PORT || 8081);
  const allowedOrigins = (process.env.NETPLAY_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  // The standalone server has no other WebSocket endpoints.
  server.on('upgrade', (request, socket) => {
    if (request.url?.split('?', 1)[0] !== '/netplay') socket.destroy();
  });
  attachNetplay(server, { allowedOrigins });
  server.listen(port, host, () => {
    const address = server.address();
    const hostname = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    console.log(`Netplay signaling listening at ws://${hostname}:${address.port}/netplay`);
  });
}
