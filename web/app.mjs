import { CONTROL_KEYS, NEUTRAL_INPUT, readControls } from "./controls.mjs";
import { makeRuntime } from "./runtime.mjs";

const get = (id) => document.getElementById(id);
const canvas = get("outputCanvas");
const remote = get("remote");
const screen = get("screen");
const startPanel = get("start-panel");
const screenTitle = get("screen-title");
const screenMessage = get("screen-message");
const retry = get("retry");
const pageUrl = new URL(location.href);
const guestEntry = pageUrl.searchParams.has("join");
const staticHost = location.hostname.endsWith(".github.io");
const transport = staticHost ? "../netplay/peerjs.mjs" : "../netplay/client.mjs";
const status = get("status");

const audioButton = get("audio");
const streamButton = get("play-stream");
const hostButton = get("host-match");
const joinForm = get("join-form");
const joinCode = get("join-code");
const room = get("room");
const roomCode = get("room-code");
const netStatus = get("net-status");

let playing = false;
let loading = false;

let muted = false;

let match;
let role;
let roomGeneration = 0;
const pressedKeys = new Set();
const manualPads = new Map();

const runtime = makeRuntime({
  canvas,
  onStatus(message) {
    status.textContent = message;
  }
});
window.defJam = Object.freeze({
  setPad(port, input) {
    if (input) manualPads.set(port, input);
    else manualPads.delete(port);
    if (role === "guest") {
      if (port === 2) match?.setInput(input ?? NEUTRAL_INPUT);
    } else {
      runtime.setPad(port, input ?? NEUTRAL_INPUT);
    }
  },
  diagnostics: runtime.diagnostics,
  getInputReadback: runtime.getInputReadback,
  getSecondInputReadback: runtime.getSecondInputReadback
});

canvas.tabIndex = -1;
remote.tabIndex = -1;

function showStart(title, message) {
  startPanel.hidden = false;
  screenTitle.textContent = title;
  screenMessage.textContent = message;
  retry.hidden = true;
  streamButton.hidden = true;
}

async function startGame() {
  if (loading || playing || role === "guest") return;
  loading = true;
  showStart("Starting game", "Loading Battle mode.");
  status.textContent = "Starting Play!";
  void runtime.prepareAudio().catch(() => {});
  try {
    const disc = await runtime.boot();
    playing = true;
    startPanel.hidden = true;
    status.textContent = "PlayStation 2 · " + disc.gameId;

    audioButton.disabled = !runtime.getAudioStream();
    hostButton.disabled = !runtime.diagnostics().secondController;
    netStatus.textContent = hostButton.disabled
      ? "Guests can join with a code. Hosting needs a two-controller build."
      : "Host a match or join with a room code.";
    canvas.focus();
    // Desktop browsers may defer OpenAL until the next game gesture after boot.
    canvas.addEventListener('pointerdown', () => void runtime.prepareAudio(), { once: true });
    canvas.addEventListener('keydown', () => void runtime.prepareAudio(), { once: true });
    void runtime.setMuted(muted).catch(() => {
      muted = true;
      audioButton.textContent = "Unmute";
    });
    return disc;
  } catch (error) {
    loading = false;
    status.textContent = "Game unavailable";
    showStart("Couldn’t start the game", error.message);
    retry.hidden = false;
  } finally {
    loading = false;
  }
}

async function startAudio() {
  muted = !muted;
  audioButton.textContent = muted ? "Unmute" : "Mute";
  if (role === "guest") {
    remote.muted = muted;
    if (!muted) await remote.play();
    return;
  }
  await runtime.setMuted(muted);
}

retry.addEventListener("click", () => location.reload());

audioButton.addEventListener("click", () => void startAudio().catch((error) => {
  status.textContent = error.message;
}));
get("fullscreen").addEventListener("click", () => {
  const change = document.fullscreenElement ? document.exitFullscreen() : screen.requestFullscreen?.();
  void change?.catch((error) => { status.textContent = error.message; });
});

function keyboardInput(event) {
  if ((!playing && role !== "guest") || !CONTROL_KEYS.has(event.code)) return;
  if (event.type === "keydown" && (event.target.closest?.("button, input, a") || event.metaKey || event.ctrlKey || event.altKey)) return;
  event.preventDefault();
  if (event.type === "keydown") pressedKeys.add(event.code);
  else pressedKeys.delete(event.code);
  sendLocalInput();
}

function sendLocalInput() {
  const gamepads = Array.from(navigator.getGamepads?.() ?? []).filter(Boolean);
  const input = readControls(pressedKeys, gamepads[0]);
  if (role === "guest") {
    match?.setInput(manualPads.get(2) ?? input);
    return;
  }
  runtime.setPad(1, manualPads.get(1) ?? input);
  if (role !== "host") runtime.setPad(2, manualPads.get(2) ?? readControls(new Set(), gamepads[1]));
}

window.addEventListener("keydown", keyboardInput);
window.addEventListener("keyup", keyboardInput);
window.addEventListener("blur", () => {
  pressedKeys.clear();
  if (role === "guest") match?.setInput(NEUTRAL_INPUT);
  else {
    if (!manualPads.has(1)) runtime.setPad(1, NEUTRAL_INPUT);
    if (role !== "host" && !manualPads.has(2)) runtime.setPad(2, NEUTRAL_INPUT);
  }
});

function pollInputs() {
  if ((playing || role === "guest") && document.hasFocus()) sendLocalInput();
  requestAnimationFrame(pollInputs);
}
requestAnimationFrame(pollInputs);

const STATES = {
  connecting: "Connecting to the other player…",
  connected: "Connected",
  closed: "Room closed",
  waiting: "Waiting for a guest",
  error: "Connection failed"
};

function setRoomState(state, error) {
  netStatus.textContent = error?.message || STATES[state] || state;
  if (role === "guest" && state === "connected" && !remote.paused) {
    startPanel.hidden = true;
    remote.focus();
  }
  if (state === "closed" || state === "error") {
    const message = netStatus.textContent;
    leaveRoom();
    netStatus.textContent = message;
  }
}

async function peerOptions() {
  if (staticHost) return {};
  const response = await fetch(new URL("../netplay/config", import.meta.url), {cache: "no-store"});
  if (!response.ok) throw new Error('Room connection settings are unavailable.');
  return response.json();
}

function showRoom(code) {
  room.hidden = false;
  roomCode.value = code;
  joinForm.hidden = true;
  hostButton.hidden = true;
  get("copy-room").hidden = role !== "host";
}

function leaveRoom() {
  roomGeneration++;
  const oldMatch = match;
  match = undefined;
  role = undefined;
  pressedKeys.clear();
  manualPads.delete(2);
  oldMatch?.close();
  runtime.setPad(2, NEUTRAL_INPUT);
  remote.hidden = true;
  remote.srcObject = null;
  canvas.hidden = false;
  room.hidden = true;
  joinForm.hidden = false;
  hostButton.hidden = false;
  audioButton.disabled = !playing;
  if (!playing) showStart("Join a match", "Enter a room code to play as player two.");
  status.textContent = playing ? "PlayStation 2 · " + runtime.diagnostics().discId : "Waiting for room code";
  netStatus.textContent = playing ? "Room closed" : "Enter a room code to join.";
}

hostButton.addEventListener("click", async () => {
  if (role || !playing) return;
  role = "host";
  const generation = ++roomGeneration;
  try {
    const { hostMatch } = await import(transport);
    const hosted = await hostMatch({
      ...await peerOptions(),
      canvas,
      audioStream: runtime.getAudioStream(),
      frameRate: 60,
      onInput(input) {
        if (generation === roomGeneration) runtime.setPad(2, manualPads.get(2) ?? input);
      },
      onState(state, error) {
        if (generation === roomGeneration) setRoomState(state, error);
      }
    });
    if (generation !== roomGeneration) {
      hosted.close();
      return;
    }
    match = hosted;
    showRoom(match.code);
    canvas.focus();
  } catch (error) {
    if (generation === roomGeneration) {
      leaveRoom();
      netStatus.textContent = error.message;
    }
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (role) return;
  const code = joinCode.value.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
    netStatus.textContent = "Enter the eight-character room code.";
    return;
  }
  if (!guestEntry) {
    pageUrl.searchParams.set("join", code);
    location.assign(pageUrl);
    return;
  }
  role = "guest";
  const generation = ++roomGeneration;
  muted = false;
  audioButton.textContent = "Mute";
  remote.muted = false;
  remote.hidden = false;
  canvas.hidden = true;
  showStart("Joining match", "Waiting for the host’s game stream.");
  showRoom(code);
  netStatus.textContent = STATES.connecting;
  status.textContent = "Online · Player 2";
  audioButton.disabled = false;
  try {
    const { joinMatch } = await import(transport);
    const joined = await joinMatch({
      ...await peerOptions(),
      code,
      video: remote,
      onState(state, error) {
        if (generation === roomGeneration) setRoomState(state, error);
      },
      onPlaybackBlocked() {
        if (generation !== roomGeneration) return;
        showStart("Match connected", "Play the host’s stream to enable video and audio.");
        streamButton.hidden = false;
      }
    });
    if (generation !== roomGeneration) {
      joined.close();
      return;
    }
    match = joined;
  } catch (error) {
    if (generation === roomGeneration) {
      leaveRoom();
      netStatus.textContent = error.message;
    }
  }
});

remote.addEventListener("playing", () => {
  if (role !== "guest") return;
  startPanel.hidden = true;
  remote.focus();
});
streamButton.addEventListener("click", async () => {
  try {
    await remote.play();
    startPanel.hidden = true;
    remote.focus();
  } catch (error) {
    netStatus.textContent = error.message;
  }
});
get("leave-room").addEventListener("click", leaveRoom);
get("copy-room").addEventListener("click", async () => {
  try {
    const invite = new URL(location.href);
    invite.searchParams.set("join", roomCode.value);
    await navigator.clipboard.writeText(invite.href);
    netStatus.textContent = "Invite link copied";
  } catch {
    netStatus.textContent = "Select the room code to copy it.";
  }
});
window.addEventListener("pagehide", () => {
  match?.close();
  runtime.close();
});


if (guestEntry) {
  hostButton.hidden = true;
  get("local-play").hidden = false;
  status.textContent = "Waiting for room code";
  showStart("Join a match", "Enter a room code to play as player two.");
  const invite = pageUrl.searchParams.get("join").toUpperCase();
  if (/^[A-HJ-NP-Z2-9]{8}$/.test(invite)) {
    joinCode.value = invite;
    joinForm.requestSubmit();
  }
} else {
  void startGame();
}
