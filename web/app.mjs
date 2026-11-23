import { CONTROL_KEYS, NEUTRAL_INPUT, readControls } from "./controls.mjs";
import { isDiscInstalled, makeRuntime } from "./runtime.mjs";

const get = (id) => document.getElementById(id);
const canvas = get("outputCanvas");
const remote = get("remote");
const screen = get("screen");
const startPanel = get("start-panel");
const screenTitle = get("screen-title");
const screenMessage = get("screen-message");
const chooseDisc = get("choose-disc");
const installed = get("play-installed");
const discInput = get("disc-input");
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
let installedAvailable = false;
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
  bootInstalled: () => startGame(runtime.bootInstalled),
  boot: (file) => startGame(() => runtime.boot(file)),
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
  const canStart = !loading && !playing && role !== "guest";
  chooseDisc.hidden = !canStart || installedAvailable;
  installed.hidden = !canStart || !installedAvailable;
  streamButton.hidden = true;
}

async function startGame(boot) {
  if (loading || playing || role === "guest") return;
  loading = true;
  showStart("Starting game", "Loading the PlayStation 2 emulator and disc.");
  status.textContent = "Starting Play!";
  void runtime.prepareAudio().catch(() => {});
  try {
    const disc = await boot();
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
    status.textContent = "Disc unavailable";
    showStart("Couldn’t start the game", error.message);
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

isDiscInstalled().then((available) => {
  installedAvailable = available;
  if (available && !loading && !playing && !role) {
    status.textContent = "Ready · PlayStation 2";
    showStart("Ready to play", "Def Jam: Fight for NY is installed on this machine.");
  }
}).catch(() => {});

installed.addEventListener("click", () => void window.defJam.bootInstalled());
chooseDisc.addEventListener("click", () => {
  void runtime.prepareAudio().catch(() => {});
  discInput.click();
});
discInput.addEventListener("change", () => {
  const file = discInput.files[0];
  discInput.value = "";
  if (file) void window.defJam.boot(file);
});
screen.addEventListener("dragover", (event) => {
  if (playing || loading || role === "guest" || !event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  document.body.classList.add("dragging");
});
screen.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
screen.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  const file = event.dataTransfer.files[0];
  if (file) void window.defJam.boot(file);
});

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
  const response = await fetch('/netplay/config', {cache: 'no-store'});
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
  if (!playing) {
    if (installedAvailable) showStart("Ready to play", "Def Jam: Fight for NY is installed on this machine.");
    else showStart("Load a disc", "Choose a PlayStation 2 disc image to start.");
  }
  status.textContent = playing ? "PlayStation 2 · " + runtime.diagnostics().discId : "Waiting for a disc";
  netStatus.textContent = playing ? "Room closed" : "Load the disc to host. Guests can join with a code.";
}

hostButton.addEventListener("click", async () => {
  if (role || !playing) return;
  role = "host";
  const generation = ++roomGeneration;
  try {
    const { hostMatch } = await import("/netplay/client.mjs");
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
  if (role || loading) return;
  if (playing) {
    netStatus.textContent = "Open the player in another tab to join as a guest.";
    return;
  }
  const code = joinCode.value.trim().toUpperCase();
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
    const { joinMatch } = await import("/netplay/client.mjs");
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
    await navigator.clipboard.writeText(roomCode.value);
    netStatus.textContent = "Room code copied";
  } catch {
    netStatus.textContent = "Select the room code to copy it.";
  }
});
window.addEventListener("pagehide", () => {
  match?.close();
  runtime.close();
});
