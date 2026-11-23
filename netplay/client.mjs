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
  code, media, video, signalingUrl, iceServers = DEFAULT_ICE_SERVERS,
  connectSignaling = (url) => new WebSocket(websocketUrl(url)), roomTimeout = 10_000,
  onInput = () => {}, onState = () => {}, onPlaybackBlocked = () => {}, onClose = () => {},
}) {
  const socket = connectSignaling(signalingUrl);
  let peer;
  let state;
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

  function deliverInput(activePeer, next) {
    if (sameInput(activePeer.input, next)) return;
    activePeer.input = next;
    onInput({ buttons: next.buttons, axes: next.axes.map((axis) => axis / 127) });
  }

  function resetPeer() {
    const previous = peer;
    if (!previous) return;
    peer = undefined;
    clearTimeout(previous.deadline);
    clearTimeout(previous.channelCloseDeadline);
    clearTimeout(previous.inputDeadline);
    clearInterval(previous.inputInterval);
    previous.channel?.close();
    previous.connection.close();
    if (video && video.srcObject === previous.playback) video.srcObject = null;
    if (role === 'host') deliverInput(previous, NEUTRAL);
  }

  function close(error) {
    if (closed) return;
    closed = true;
    clearTimeout(roomDeadline);
    window.removeEventListener('pagehide', closePage);
    window.removeEventListener('blur', releaseInput);
    document.removeEventListener('visibilitychange', releaseHiddenInput);
    if (socket.readyState < WebSocket.CLOSING) socket.close();
    resetPeer();
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

  function setInput(next) {
    if (closed) return;
    const newInput = controllerState(next);
    if (sameInput(input, newInput)) return;
    input = newInput;
    writeInput(peer);
  }

  function releaseInput() {
    setInput(NEUTRAL);
  }

  function releaseHiddenInput() {
    if (document.hidden) releaseInput();
  }

  function failPeer(activePeer, error) {
    if (peer !== activePeer) return;
    send({ type: 'drop-peer', round: activePeer.round });
    if (role === 'guest') close(error);
    else {
      resetPeer();
      updateState('waiting', error);
    }
  }

  function refreshState(activePeer) {
    if (peer !== activePeer) return;
    const connectionState = activePeer.connection.connectionState;
    if (connectionState === 'failed') {
      failPeer(activePeer, new Error('Could not establish a peer connection.'));
    } else if (connectionState === 'connected' && activePeer.channel?.readyState === 'open') {
      clearTimeout(activePeer.deadline);
      activePeer.deadline = null;
      updateState('connected');
    } else if (connectionState === 'disconnected') {
      if (role === 'host') deliverInput(activePeer, NEUTRAL);
      activePeer.deadline ??= startConnectionDeadline(activePeer);
      updateState('connecting');
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
      if (peer !== activePeer) return;
      if (role === 'guest') {
        writeInput(activePeer);
        activePeer.inputInterval = setInterval(() => writeInput(activePeer), INPUT_INTERVAL);
      }
      refreshState(activePeer);
    });
    channel.addEventListener('close', () => {
      if (peer !== activePeer) return;
      if (role === 'host') deliverInput(activePeer, NEUTRAL);
      // The room-close signal can arrive after WebRTC reports the channel closure.
      activePeer.channelCloseDeadline = setTimeout(() => {
        failPeer(activePeer, new Error('The controller connection ended.'));
      }, CHANNEL_CLOSE_GRACE);
    });
    if (role !== 'host') return;
    channel.addEventListener('message', (event) => {
      if (peer !== activePeer) return;
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

  function newPeer(round) {
    resetPeer();
    const connection = new RTCPeerConnection({ iceServers });
    const activePeer = {
      round, connection, input: NEUTRAL, sequence: role === 'guest' ? 0 : null,
      remoteIce: [], localIce: [], announced: false,
    };
    peer = activePeer;
    activePeer.deadline = startConnectionDeadline(activePeer);
    connection.addEventListener('connectionstatechange', () => refreshState(activePeer));
    connection.addEventListener('icecandidate', ({ candidate }) => {
      if (!candidate || peer !== activePeer) return;
      const message = { type: 'ice', round, candidate: candidate.toJSON() };
      if (activePeer.announced) send(message);
      else activePeer.localIce.push(message);
    });
    if (role === 'host') {
      for (const track of media.getTracks()) connection.addTrack(track, media);
      bindChannel(activePeer, connection.createDataChannel(INPUT_CHANNEL, { ordered: false, maxRetransmits: 0 }));
    } else {
      const playback = new MediaStream();
      activePeer.playback = playback;
      video.playsInline = true;
      video.srcObject = playback;
      connection.addEventListener('datachannel', ({ channel }) => bindChannel(activePeer, channel));
      connection.addEventListener('track', ({ track }) => {
        if (peer !== activePeer) return;
        playback.addTrack(track);
        if (track.kind === 'video') {
          video.play().catch((error) => {
            if (error.name === 'NotAllowedError' && peer === activePeer) onPlaybackBlocked(video);
          });
        }
      });
    }
    updateState('connecting');
    return activePeer;
  }

  async function announce(activePeer, description) {
    if (peer !== activePeer) return;
    await activePeer.connection.setLocalDescription(description);
    if (peer !== activePeer) return;
    const local = activePeer.connection.localDescription.toJSON();
    send({ type: local.type, round: activePeer.round, description: local });
    activePeer.announced = true;
    activePeer.localIce.splice(0).forEach(send);
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
        if (role === 'guest') newPeer(message.round);
        else updateState('waiting');
        roomCode = message.code;
        clearTimeout(roomDeadline);
        resolveRoom({ code: roomCode, close: closePage, setInput });
        return;
      case 'peer-joined': {
        const activePeer = newPeer(message.round);
        try {
          await announce(activePeer, await activePeer.connection.createOffer());
        } catch (error) {
          failPeer(activePeer, error);
        }
        return;
      }
      case 'peer-left':
        if (peer?.round === message.round) {
          resetPeer();
          updateState('waiting');
        }
        return;
    }

    const activePeer = peer;
    if (!activePeer || activePeer.round !== message.round) return;
    const { connection, remoteIce } = activePeer;
    try {
      if (message.type === 'ice') {
        if (connection.remoteDescription) await connection.addIceCandidate(message.candidate);
        else remoteIce.push(message.candidate);
      } else if (message.type === 'offer' || message.type === 'answer') {
        await connection.setRemoteDescription(message.description);
        for (const candidate of remoteIce.splice(0)) await connection.addIceCandidate(candidate);
        if (message.type === 'offer' && peer === activePeer) {
          await announce(activePeer, await connection.createAnswer());
        }
      }
    } catch (error) {
      failPeer(activePeer, error);
    }
  }

  const roomDeadline = setTimeout(() => close(new Error('Signaling server did not respond.')), roomTimeout);
  socket.addEventListener('open', () => send({ type: role === 'host' ? 'host' : 'join', code }));
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

export async function hostMatch({ canvas, audioStream, frameRate = 60, ...options }) {
  const videoTracks = canvas.captureStream(frameRate).getVideoTracks();
  if (!videoTracks.length) throw new Error('The emulator canvas has no video track.');
  const stopCapture = () => videoTracks.forEach((track) => track.stop());
  try {
    const media = new MediaStream([...videoTracks, ...(audioStream?.getAudioTracks() || [])]);
    const { code, close } = await openRoom('host', { ...options, media, onClose: stopCapture });
    return { code, close };
  } catch (error) {
    stopCapture();
    throw error;
  }
}

export async function joinMatch({ code, video, ...options }) {
  const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!ROOM_PATTERN.test(normalizedCode)) throw new Error('Enter the eight-character room code.');
  const { setInput, close } = await openRoom('guest', { ...options, code: normalizedCode, video });
  return { setInput, close };
}
