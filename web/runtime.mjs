import { AudioController } from "/runtime/dolphin/src/audio.js";
import { UpstreamWorkerAdapter } from "/runtime/dolphin/src/upstream-worker-adapter.js";
import { toDolphinInput } from "./controls.mjs";

const GAME_IDS = new Set(["GNWE69", "GNWP69"]);
const INSTALLED_DISC_URL = "/disc/reference.iso";
const IMAGE_EXTENSIONS = /\.(iso|gcm|rvz|ciso|gcz|wia)$/i;

export function makeRuntime({ canvas, onStatus }) {
  const settings = new URLSearchParams(location.search);
  const hardware = settings.get("video") !== "software" && Boolean(navigator.gpu);
  const audio = new AudioController();
  let host;
  let mounted;
  let booting = false;
  let pollTimer;
  let mediaAudio;
  let secondController = false;
  let lastSecondInput = "";

  audio.setSource((frames) => host?.mixAudio(frames));
  audio.setTransportBridge((configuration) => host?.configureAudioWorklet(configuration));

  async function boot(file) {
    if (booting || mounted) throw new Error("A disc is already loading or running.");
    if (!crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
      throw new Error("The emulator requires cross-origin isolation. Open the game from its local server.");
    }
    if (!canvas.transferControlToOffscreen) {
      throw new Error("This browser cannot run the GameCube display. Open the game in desktop Chrome or Edge.");
    }
    if (!IMAGE_EXTENSIONS.test(file.name) || !file.size) {
      throw new Error("Choose a GameCube disc image in ISO, GCM, RVZ, CISO, GCZ, or WIA format.");
    }
    booting = true;
    try {
      const firstBytes = new Uint8Array(await file.slice(0, 0x20).arrayBuffer());
      if (firstBytes.length === 0x20 && new DataView(firstBytes.buffer).getUint32(0x1c) === 0xc2339f3d) {
        const id = new TextDecoder("ascii").decode(firstBytes.subarray(0, 6));
        if (!GAME_IDS.has(id)) throw new Error("Choose the GameCube edition of Def Jam: Fight for NY.");
      }
      const fastSoftwareRaster = Number(settings.get("fastsw") ?? 1);
      const jitWarmup = Number(settings.get("jitwarmup") ?? 700);
      host ??= new UpstreamWorkerAdapter({
        visibleCanvas: canvas,
        transferCanvas: () => canvas.transferControlToOffscreen(),
        videoBackend: hardware ? "WebGPU-Real" : "Software Renderer",
        presenterBackend: settings.get("presenter") ?? "webgpu",
        presentationPacing: hardware ? "smooth" : "tick",
        cpuThread: settings.get("cpu") === "dual",
        ppcWasmJit: settings.get("wasmjit") === "1",
        ppcWasmJitWarmupFrames: Number.isInteger(jitWarmup) ? Math.max(0, jitWarmup) : 700,
        fastSoftwareRaster,
        onStatus
      });

      const disc = await host.mountGame(file);
      if (!GAME_IDS.has(disc.gameId)) {
        await host.request("setPaused", { paused: true });
        throw new Error("Choose the GameCube edition of Def Jam: Fight for NY.");
      }
      if (!disc.fullCore || !disc.coreBoot?.accepted) {
        throw new Error(disc.coreBoot?.skippedReason || disc.coreStatus || "Dolphin could not boot the disc.");
      }
      ({ secondController } = await host.request("controllerCapabilities"));
      mounted = disc;
      host.pollFrame();
      pollTimer = setInterval(() => host.pollFrame(), 250);
      return disc;
    } finally {
      booting = false;
    }
  }

  async function bootInstalled() {
    const response = await fetch(INSTALLED_DISC_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("No local disc is installed. Choose your disc image to play.");
    const blob = await response.blob();
    return boot(new File([blob], "reference.iso", { type: "application/octet-stream" }));
  }

  function setPad(port, input) {
    if (!mounted) return;
    const state = toDolphinInput(input);
    if (port === 1) {
      host.setInputState(state);
    } else if (port === 2 && secondController) {
      const next = Object.values(state).join(":");
      if (next !== lastSecondInput) {
        lastSecondInput = next;
        host.post("setSecondInputState", state);
      }
    }
  }

  function diagnostics() {
    return {
      discId: mounted?.gameId ?? null,
      secondController,
      coreFrame: host?.coreFrame ?? 0,
      presentedFrame: host?.presentedFrame ?? 0,
      coreTicks: host?.coreTicks ?? 0,
      ppcPc: host?.ppcPc ?? 0
    };
  }

  return {
    boot,
    bootInstalled,
    setPad,
    diagnostics,
    async getSecondInputReadback() {
      return (await host?.request("controllerCapabilities"))?.secondInputReadback ?? null;
    },
    prepareAudio: () => audio.ensureContext(),
    async setMuted(muted) {
      await audio.setMuted(muted);
      host?.setAudioMuted(muted);
    },
    setPaused: (paused) => host?.request("setPaused", { paused }),
    getAudioStream() {
      if (!audio.context || !audio.gain) return undefined;
      if (!mediaAudio) {
        mediaAudio = audio.context.createMediaStreamDestination();
        audio.gain.connect(mediaAudio);
      }
      return mediaAudio.stream;
    },
    close() {
      clearInterval(pollTimer);
      if (mediaAudio) {
        audio.gain.disconnect(mediaAudio);
        mediaAudio.stream.getTracks().forEach((track) => track.stop());
      }
      audio.stopPump();
      host?.worker?.terminate();
      void audio.context?.close();
    }
  };
}

export async function isDiscInstalled() {
  const response = await fetch(INSTALLED_DISC_URL, { method: "HEAD", cache: "no-store" });
  return response.ok;
}
