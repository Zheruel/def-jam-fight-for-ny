import './vendor/peerjs-1.5.5.min.js';
import { hostMatch as hostWebRTC, joinMatch as joinWebRTC } from './client.mjs';

const PEER_PREFIX = 'defjam1-';
const PROTOCOL = 'def-jam-signaling-v1';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];
const CLOSE_GRACE = 150;

function roomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => ROOM_ALPHABET[byte & 31]).join('');
}

function brokerAddress(value) {
  if (value === undefined) return {};
  const url = new URL(value, window.location.href);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid signaling URL.');
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return { host: url.hostname, port: Number(url.port) || (secure ? 443 : 80), path: url.pathname, secure };
}

function readSignal(raw) {
  if (typeof raw !== 'string' || raw.length > 64 * 1024) return null;
  try {
    const message = JSON.parse(raw);
    return typeof message?.type === 'string' ? message : null;
  } catch {
    return null;
  }
}

function sendSignal(connection, message) {
  if (connection?.open) connection.send(JSON.stringify(message));
}

class PeerSignaling extends EventTarget {
  readyState = WebSocket.CONNECTING;
  #options;
  #peer;
  #connection;
  #role;
  #code;
  #registered = false;
  #round = 0;
  #attempts = 0;
  #retry;

  constructor(options) {
    super();
    this.#options = options;
    queueMicrotask(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  #emit(message) {
    if (this.readyState === WebSocket.OPEN) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    }
  }

  #fail(message) {
    this.#emit({ type: 'error', message });
  }

  #register() {
    const peer = this.#role === 'host'
      ? new window.Peer(PEER_PREFIX + this.#code, this.#options)
      : new window.Peer(this.#options);
    this.#peer = peer;
    const isCurrent = () => this.readyState === WebSocket.OPEN && this.#peer === peer;
    peer.on('error', (error) => {
      if (!isCurrent()) return;
      if (error.type === 'unavailable-id' && this.#role === 'host' && !this.#registered && ++this.#attempts < 6) {
        this.#peer = undefined;
        peer.destroy();
        this.#code = roomCode();
        this.#register();
      } else if (error.type === 'peer-unavailable' && this.#role === 'guest' && !this.#round) {
        this.#fail('Room unavailable. Check the code and try again.');
      } else if (this.#role === 'host' && this.#registered && ['peer-unavailable', 'webrtc'].includes(error.type)) {
        // An incoming connection can fail without invalidating the room.
      } else if (error.type !== 'network' || !this.#registered) {
        this.#fail(error.message || 'Could not reach the room signaling service.');
      }
    });
    peer.on('disconnected', () => {
      if (!isCurrent() || !this.#registered) return;
      if (this.#role === 'guest') {
        if (!this.#round) this.#fail('The signaling service disconnected while joining the room.');
        return;
      }
      clearTimeout(this.#retry);
      this.#retry = setTimeout(() => {
        if (isCurrent() && peer.disconnected && !peer.destroyed) peer.reconnect();
      }, 500);
    });
    peer.on('close', () => {
      if (isCurrent()) this.#fail('The room signaling service disconnected.');
    });
    peer.on('open', () => {
      if (!isCurrent() || this.#registered) return;
      this.#registered = true;
      if (this.#role === 'host') this.#emit({ type: 'room', code: this.#code });
      else this.#join(peer);
    });
    if (this.#role === 'host') peer.on('connection', (connection) => this.#accept(connection));
  }

  #join(peer) {
    const connection = peer.connect(PEER_PREFIX + this.#code, {
      reliable: true,
      serialization: 'raw',
      metadata: { protocol: PROTOCOL },
    });
    if (!connection) return this.#fail('Could not connect to the room.');
    this.#connection = connection;
    connection.on('data', (raw) => {
      const message = readSignal(raw);
      if (!message) return;
      if (!this.#round && message.type === 'room' && message.code === this.#code &&
          Number.isSafeInteger(message.round) && message.round > 0) {
        this.#round = message.round;
        this.#emit(message);
      } else if (message.type === 'error' && typeof message.message === 'string') {
        this.#emit(message);
      } else if (this.#round && (message.type === 'room-closed' ||
          (message.round === this.#round && ['offer', 'ice'].includes(message.type)))) {
        this.#emit(message);
      }
    });
    connection.on('close', () => {
      if (this.#round) this.#emit({ type: 'room-closed' });
      else this.#fail('The room connection closed before it was ready.');
    });
    connection.on('error', () => this.#fail('The room signaling connection failed.'));
  }

  #accept(connection) {
    if (this.readyState !== WebSocket.OPEN || connection.metadata?.protocol !== PROTOCOL) {
      connection.close();
      return;
    }
    connection.on('open', () => {
      if (this.readyState !== WebSocket.OPEN) {
        connection.close();
      } else if (this.#connection) {
        sendSignal(connection, { type: 'error', message: 'This room already has a guest.' });
        setTimeout(() => connection.close(), CLOSE_GRACE);
      } else {
        this.#connection = connection;
        this.#round++;
        sendSignal(connection, { type: 'room', code: this.#code, round: this.#round });
        this.#emit({ type: 'peer-joined', round: this.#round });
      }
    });
    connection.on('data', (raw) => {
      if (this.#connection !== connection) return;
      const message = readSignal(raw);
      if (message?.round !== this.#round) return;
      if (['leave', 'drop-peer'].includes(message.type)) this.#removeGuest(connection);
      else if (['answer', 'ice'].includes(message.type)) this.#emit(message);
    });
    connection.on('close', () => this.#removeGuest(connection));
    connection.on('error', () => this.#removeGuest(connection));
  }

  #removeGuest(connection) {
    if (this.#connection !== connection) return;
    this.#connection = undefined;
    connection.close();
    this.#emit({ type: 'peer-left', round: this.#round });
  }

  send(raw) {
    if (this.readyState !== WebSocket.OPEN) return;
    const message = readSignal(raw);
    if (!message) return;
    if (!this.#role) {
      this.#role = message.type === 'host' ? 'host' : 'guest';
      this.#code = this.#role === 'host' ? roomCode() : message.code;
      this.#register();
    } else if (this.#connection && message.round === this.#round) {
      if (this.#role === 'host' && message.type === 'drop-peer') {
        const connection = this.#connection;
        sendSignal(connection, { type: 'error', message: 'The peer connection ended. Rejoin the room to try again.' });
        this.#connection = undefined;
        setTimeout(() => connection.close(), CLOSE_GRACE);
      } else {
        sendSignal(this.#connection, message);
      }
    }
  }

  close() {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSED;
    clearTimeout(this.#retry);
    const peer = this.#peer;
    const connection = this.#connection;
    this.#peer = undefined;
    this.#connection = undefined;
    if (connection?.open) {
      sendSignal(connection, { type: this.#role === 'host' ? 'room-closed' : 'leave', round: this.#round });
      setTimeout(() => peer?.destroy(), CLOSE_GRACE);
    } else {
      peer?.destroy();
    }
  }
}

function optionsForMatch({ signalingUrl, peerOptions = {}, iceServers = DEFAULT_ICE_SERVERS, ...options }) {
  const broker = {
    debug: 0,
    ...brokerAddress(signalingUrl),
    ...peerOptions,
    config: { ...peerOptions.config, iceServers },
  };
  return {
    ...options,
    iceServers,
    roomTimeout: 20_000,
    connectSignaling: () => new PeerSignaling(broker),
  };
}

export async function hostMatch(options) {
  return hostWebRTC(optionsForMatch(options));
}

export async function joinMatch(options) {
  return joinWebRTC(optionsForMatch(options));
}
