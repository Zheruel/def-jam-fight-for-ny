const ROOM_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const INPUT_CHANNEL = 'controller-v1';
const INPUT_BYTES = 10;
const INPUT_INTERVAL = 50;
const INPUT_TIMEOUT = 500;
const CONNECTION_TIMEOUT = 20_000;
const CHANNEL_CLOSE_GRACE = 1_000;
const NEUTRAL = { buttons: 0, axes: [0, 0, 0, 0] };

function websocketUrl(value = '/netplay') {
  const url = new URL(value, window.location.href);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Invalid signaling URL.');
  return url.href;
}

function controllerState(input) {
  const buttons = Number.isInteger(input?.buttons) ? input.buttons & 0xffff : 0;
  const axes = NEUTRAL.axes.map((_, index) => {
    const axis = input?.axes?.[index];
    return Number.isFinite(axis) ? Math.round(Math.min(1, Math.max(-1, axis)) * 127) : 0;
  });
  return { buttons, axes };
}

function sameInput(first, second) {
  return first.buttons === second.buttons && first.axes.every((axis, index) => axis === second.axes[index]);
}

function encodeInput(input, sequence) {
  const message = new DataView(new ArrayBuffer(INPUT_BYTES));
  message.setUint32(0, sequence);
  message.setUint16(4, input.buttons);
  input.axes.forEach((axis, index) => message.setInt8(6 + index, axis));
  return message.buffer;
}

function decodeInput(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== INPUT_BYTES) return null;
  const message = new DataView(buffer);
  const axes = NEUTRAL.axes.map((_, index) => Math.max(-127, message.getInt8(6 + index)));
  return { sequence: message.getUint32(0), input: { buttons: message.getUint16(4), axes } };
}

function openRoom(role, {
  code, media, video, signalingUrl, iceServers = DEFAULT_ICE_SERVERS, players, slot: wantedSlot,
  connectSignaling = (url) => new WebSocket(websocketUrl(url)), roomTimeout = 10_000,
  onInput = () => {}, onState = () => {}, onPeer = () => {}, onSlots = () => {}, onPlayers = () => {},
  onVibration = () => {}, onPlaybackBlocked = () => {}, onClose = () => {},
}) {
  const socket = connectSignaling(signalingUrl);
  // The host holds one connection per seated guest, keyed by the room round that seated it; a guest holds one.
  const peers = new Map();
  let state;
  let seats = players ?? 2;
  let roomCode;
  let closed = false;
  let input = NEUTRAL;
  let handleMessage = Promise.resolve();
  let resolveRoom;
  let rejectRoom;
  const ready = new Promise((resolve, reject) => {
    resolveRoom = resolve;
    rejectRoom = reject;
  });

  function updateState(next, error) {
    if (state === next) return;
    state = next;
    onState(next, error);
  }

  function send(message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  const live = (activePeer) => peers.get(activePeer.round) === activePeer;
  const guestPeer = () => peers.values().next().value;

  // Seat list for the host's frontend: slot 0 is the host, the rest are open or taken by a guest peer.
  function slotList() {
    const list = [{ slot: 0, state: 'host' }];
    for (let slot = 1; slot < seats; slot += 1) {
      const taken = [...peers.values()].find((entry) => entry.slot === slot);
      list.push({ slot, state: taken?.state ?? 'open' });
    }
    return list;
  }

  function announcePeers() {
    if (role !== 'host') return;
    onSlots(slotList());
    const all = [...peers.values()];
    const next = !all.length ? 'waiting' : all.every((entry) => entry.state === 'connected') ? 'connected' : 'connecting';
    updateState(next);
  }

  function setPeerState(activePeer, next, error) {
    if (activePeer.state === next) return;
    activePeer.state = next;
    if (role === 'host') onPeer({ slot: activePeer.slot, state: next, error });
  }

  function deliverInput(activePeer, next) {
    if (sameInput(activePeer.input, next)) return;
    activePeer.input = next;
    onInput({ buttons: next.buttons, axes: next.axes.map((axis) => axis / 127) }, activePeer.slot);
  }

  function resetPeer(previous) {
    if (!previous || !live(previous)) return;
    peers.delete(previous.round);
    clearTimeout(previous.deadline);
    clearTimeout(previous.channelCloseDeadline);
    clearTimeout(previous.inputDeadline);
    clearInterval(previous.inputInterval);
    previous.channel?.close();
    previous.connection.close();
    if (video && video.srcObject === previous.playback) video.srcObject = null;
    if (role === 'host') {
      deliverInput(previous, NEUTRAL);
      setPeerState(previous, 'open');
    }
  }

  function close(error) {
    if (closed) return;
    closed = true;
    clearTimeout(roomDeadline);
    window.removeEventListener('pagehide', closePage);
    window.removeEventListener('blur', releaseInput);
    document.removeEventListener('visibilitychange', releaseHiddenInput);
    if (socket.readyState < WebSocket.CLOSING) socket.close();
    for (const entry of [...peers.values()]) resetPeer(entry);
    onClose();
    if (!roomCode) rejectRoom(error || new Error('The room closed before it was ready.'));
    updateState(error ? 'error' : 'closed', error);
  }

  function closePage() {
    close();
  }

  function writeInput(activePeer) {
    const channel = activePeer?.channel;
    if (channel?.readyState !== 'open' || channel.bufferedAmount >= 1024) return;
    activePeer.sequence = (activePeer.sequence + 1) >>> 0;
    channel.send(encodeInput(input, activePeer.sequence));
  }

  // Each seat receives the PS2 motor level on its controller channel. Use a
  // separate sequence from pad input so a late packet cannot restart a stopped motor.
  function setVibration(slot, level) {
    if (!Number.isInteger(level) || level < 0 || level > 3) return;
    const peer = [...peers.values()].find(entry => entry.slot === slot);
    const channel = peer?.channel;
    if (channel?.readyState !== 'open' || channel.bufferedAmount >= 1024) return;
    const command = new DataView(new ArrayBuffer(5));
    peer.motorSequence = (peer.motorSequence + 1) >>> 0;
    command.setUint32(0, peer.motorSequence);
    command.setUint8(4, level);
    channel.send(command.buffer);
  }

  function setInput(next) {
    if (closed) return;
    const newInput = controllerState(next);
    if (sameInput(input, newInput)) return;
    input = newInput;
    writeInput(guestPeer());
  }

  function releaseInput() {
    setInput(NEUTRAL);
  }

  function releaseHiddenInput() {
    if (document.hidden) releaseInput();
  }

  function failPeer(activePeer, error) {
    if (!live(activePeer)) return;
    send({ type: 'drop-peer', round: activePeer.round });
    if (role === 'guest') close(error);
    else {
      resetPeer(activePeer);
      if (error) onPeer({ slot: activePeer.slot, state: 'open', error });
      announcePeers();
    }
  }

  function refreshState(activePeer) {
    if (!live(activePeer)) return;
    const connectionState = activePeer.connection.connectionState;
    if (connectionState === 'failed') {
      failPeer(activePeer, new Error('Could not establish a peer connection.'));
    } else if (connectionState === 'connected' && activePeer.channel?.readyState === 'open') {
      clearTimeout(activePeer.deadline);
      activePeer.deadline = null;
      setPeerState(activePeer, 'connected');
      if (role === 'host') announcePeers(); else updateState('connected');
    } else if (connectionState === 'disconnected') {
      if (role === 'host') deliverInput(activePeer, NEUTRAL);
      activePeer.deadline ??= startConnectionDeadline(activePeer);
      setPeerState(activePeer, 'connecting');
      if (role === 'host') announcePeers(); else updateState('connecting');
    }
  }

  function startConnectionDeadline(activePeer) {
    return setTimeout(() => {
      failPeer(activePeer, new Error('Peer connection timed out. Check the network and try again.'));
    }, CONNECTION_TIMEOUT);
  }

  function bindChannel(activePeer, channel) {
    if (channel.label !== INPUT_CHANNEL || activePeer.channel) {
      channel.close();
      return;
    }
    activePeer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      if (!live(activePeer)) return;
      if (role === 'guest') {
        writeInput(activePeer);
        activePeer.inputInterval = setInterval(() => writeInput(activePeer), INPUT_INTERVAL);
      }
      refreshState(activePeer);
    });
    channel.addEventListener('close', () => {
      if (!live(activePeer)) return;
      if (role === 'host') deliverInput(activePeer, NEUTRAL);
      // The room-close signal can arrive after WebRTC reports the channel closure.
      activePeer.channelCloseDeadline = setTimeout(() => {
        failPeer(activePeer, new Error('The controller connection ended.'));
      }, CHANNEL_CLOSE_GRACE);
    });
    if (role === 'guest') {
      channel.addEventListener('message', ({data}) => {
        if (!live(activePeer) || !(data instanceof ArrayBuffer) || data.byteLength !== 5) return;
        const command = new DataView(data), sequence = command.getUint32(0), level = command.getUint8(4);
        const gap = (sequence - activePeer.motorSequence) >>> 0;
        if (!gap || gap >= 0x80000000 || level > 3) return;
        activePeer.motorSequence = sequence;
        onVibration(level);
      });
      return;
    }
    channel.addEventListener('message', (event) => {
      if (!live(activePeer)) return;
      const data = decodeInput(event.data);
      if (!data) return;
      if (activePeer.sequence !== null) {
        const gap = (data.sequence - activePeer.sequence) >>> 0;
        if (gap === 0 || gap >= 0x80000000) return;
      }
      activePeer.sequence = data.sequence;
      clearTimeout(activePeer.inputDeadline);
      activePeer.inputDeadline = setTimeout(() => deliverInput(activePeer, NEUTRAL), INPUT_TIMEOUT);
      deliverInput(activePeer, data.input);
    });
  }

  function newPeer(round, slot) {
    if (role === 'guest') for (const entry of [...peers.values()]) resetPeer(entry);
    const connection = new RTCPeerConnection({ iceServers });
    const activePeer = {
      round, slot, connection, motorSequence: 0, input: NEUTRAL, sequence: role === 'guest' ? 0 : null,
      remoteIce: [], localIce: [], announced: false, state: 'connecting',
    };
    peers.set(round, activePeer);
    activePeer.deadline = startConnectionDeadline(activePeer);
    connection.addEventListener('connectionstatechange', () => refreshState(activePeer));
    connection.addEventListener('icecandidate', ({ candidate }) => {
      if (!candidate || !live(activePeer)) return;
      const message = { type: 'ice', round, candidate: candidate.toJSON() };
      if (activePeer.announced) send(message);
      else activePeer.localIce.push(message);
    });
    if (role === 'host') {
      // Each seat gets its own media when the host supplies a function, otherwise everyone sees the one stream.
      const stream = typeof media === 'function' ? media(slot) : media;
      for (const track of stream.getTracks()) connection.addTrack(track, stream);
      bindChannel(activePeer, connection.createDataChannel(INPUT_CHANNEL, { ordered: false, maxRetransmits: 0 }));
    } else {
      const playback = new MediaStream();
      activePeer.playback = playback;
      video.playsInline = true;
      video.srcObject = playback;
      connection.addEventListener('datachannel', ({ channel }) => bindChannel(activePeer, channel));
      connection.addEventListener('track', ({ track }) => {
        if (!live(activePeer)) return;
        playback.addTrack(track);
        if (track.kind === 'video') {
          video.play().catch((error) => {
            if (error.name === 'NotAllowedError' && live(activePeer)) onPlaybackBlocked(video);
          });
        }
      });
    }
    if (role === 'host') {
      onPeer({ slot, state: 'connecting' });
      announcePeers();
    } else updateState('connecting');
    return activePeer;
  }

  async function announce(activePeer, description) {
    if (!live(activePeer)) return;
    await activePeer.connection.setLocalDescription(description);
    if (!live(activePeer)) return;
    const local = activePeer.connection.localDescription.toJSON();
    send({ type: local.type, round: activePeer.round, description: local });
    activePeer.announced = true;
    activePeer.localIce.splice(0).forEach(send);
  }

  // Host: switch every seat's existing senders to new tracks (a different canvas or audio bus) without renegotiating,
  // so slots, connections and input channels survive the change (menu -> venue -> match).
  async function replaceTracks(stream) {
    const tracks = stream.getTracks();
    await Promise.all([...peers.values()].flatMap((entry) => entry.connection.getSenders().map((sender) => {
      const next = tracks.find((track) => track.kind === sender.track?.kind);
      return next && sender.track !== next ? sender.replaceTrack(next) : null;
    }).filter(Boolean)));
  }

  function setSeats(next) {
    if (seats === next) return;
    seats = next;
    onPlayers(seats);
    announcePeers();
  }

  async function receive(message) {
    switch (message.type) {
      case 'error':
        close(new Error(message.message));
        return;
      case 'room-closed':
        close();
        return;
      case 'room':
        roomCode = message.code;
        seats = message.players ?? seats;
        if (role === 'guest') newPeer(message.round, message.slot ?? 1);
        else announcePeers();
        clearTimeout(roomDeadline);
        resolveRoom(role === 'host'
          ? { code: roomCode, players: seats, close: closePage,
            setPlayers: (count) => send({ type: 'players', players: count }), slots: slotList, replaceTracks, setVibration }
          : { code: roomCode, slot: message.slot ?? 1, players: seats, close: closePage, setInput });
        return;
      case 'players':
        setSeats(message.players);
        return;
      case 'peer-joined': {
        const activePeer = newPeer(message.round, message.slot ?? 1);
        try {
          await announce(activePeer, await activePeer.connection.createOffer());
        } catch (error) {
          failPeer(activePeer, error);
        }
        return;
      }
      case 'peer-left': {
        const gone = peers.get(message.round);
        if (gone) {
          resetPeer(gone);
          announcePeers();
        }
        return;
      }
    }

    const activePeer = peers.get(message.round);
    if (!activePeer) return;
    const { connection, remoteIce } = activePeer;
    try {
      if (message.type === 'ice') {
        if (connection.remoteDescription) await connection.addIceCandidate(message.candidate);
        else remoteIce.push(message.candidate);
      } else if (message.type === 'offer' || message.type === 'answer') {
        await connection.setRemoteDescription(message.description);
        for (const candidate of remoteIce.splice(0)) await connection.addIceCandidate(candidate);
        if (message.type === 'offer' && live(activePeer)) {
          await announce(activePeer, await connection.createAnswer());
        }
      }
    } catch (error) {
      failPeer(activePeer, error);
    }
  }

  const roomDeadline = setTimeout(() => close(new Error('Signaling server did not respond.')), roomTimeout);
  socket.addEventListener('open', () => send(role === 'host' ? { type: 'host', ...(players ? { players } : {}) } : { type: 'join', code, ...(wantedSlot ? { slot: wantedSlot } : {}) }));
  socket.addEventListener('message', ({ data }) => {
    handleMessage = handleMessage.then(async () => {
      if (!closed) await receive(JSON.parse(data));
    }).catch(close);
  });
  socket.addEventListener('error', () => close(new Error('Could not connect to the signaling server.')));
  socket.addEventListener('close', () => close(new Error('The signaling server disconnected.')));
  window.addEventListener('pagehide', closePage);
  if (role === 'guest') {
    window.addEventListener('blur', releaseInput);
    document.addEventListener('visibilitychange', releaseHiddenInput);
  }
  return ready;
}

// Capture each distinct canvas once; every seat that is given the same canvas shares its track.
export async function hostMatch({ canvas, audioStream, frameRate = 60, seatMedia, ...options }) {
  const captures = new Map();
  const capture = (source) => {
    if (!captures.has(source)) {
      const tracks = source.captureStream(frameRate).getVideoTracks();
      if (!tracks.length) throw new Error('The emulator canvas has no video track.');
      captures.set(source, tracks);
    }
    return captures.get(source);
  };
  const stopCapture = () => captures.forEach((tracks) => tracks.forEach((track) => track.stop()));
  // What new seats receive, and what setMedia switches every seat to.
  let current = { canvas, audioStream };
  try {
    capture(canvas);
    // seatMedia(slot) may return { canvas, audioStream } to give that guest its own video and audio.
    const media = (slot) => {
      const own = seatMedia?.(slot) ?? {};
      const picture = capture(own.canvas ?? current.canvas);
      const sound = own.audioStream ?? current.audioStream;
      return new MediaStream([...picture, ...(sound?.getAudioTracks() || [])]);
    };
    const room = await openRoom('host', { ...options, media, onClose: stopCapture });
    // setMedia({ canvas, audioStream }) moves the room from one picture and sound to another (RTCRtpSender.replaceTrack):
    // the connections, seats and controller channels stay. Each seat must already carry a track of each kind it will
    // receive, so a host that will have sound later starts with a silent audio stream.
    async function setMedia({ canvas: nextCanvas = current.canvas, audioStream: nextAudio = current.audioStream } = {}) {
      const previous = current.canvas;
      const picture = capture(nextCanvas);
      current = { canvas: nextCanvas, audioStream: nextAudio };
      await room.replaceTracks(new MediaStream([...picture, ...(nextAudio?.getAudioTracks() || [])]));
      if (previous !== nextCanvas && !seatMedia) {
        captures.get(previous)?.forEach((track) => track.stop());
        captures.delete(previous);
      }
    }
    // Captures that are still running (one per canvas the room currently shows): a diagnostic that none are left behind.
    const liveCaptures = () => [...captures.values()].flat().filter((track) => track.readyState === 'live').length;
    return { ...room, setMedia, liveCaptures };
  } catch (error) {
    stopCapture();
    throw error;
  }
}

export async function joinMatch({ code, video, ...options }) {
  const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!ROOM_PATTERN.test(normalizedCode)) throw new Error('Enter the eight-character room code.');
  return openRoom('guest', { ...options, code: normalizedCode, video });
}

// The seats a room advertises (the host decides; two by default) and how many are open, before joining.
export function roomInfo({ code, signalingUrl, connectSignaling = (url) => new WebSocket(websocketUrl(url)), timeout = 10_000 }) {
  const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!ROOM_PATTERN.test(normalizedCode)) return Promise.reject(new Error('Enter the eight-character room code.'));
  return new Promise((resolve, reject) => {
    const socket = connectSignaling(signalingUrl);
    const finish = (error, value) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('Signaling server did not respond.')), timeout);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'info', code: normalizedCode })));
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === 'info') finish(null, { code: message.code, players: message.players, open: message.open });
      else if (message.type === 'error') finish(new Error(message.message));
    });
    socket.addEventListener('error', () => finish(new Error('Could not connect to the signaling server.')));
  });
}
