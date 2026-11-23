// Retail venue audio for the native port: the venue's ambience bed streamed to the host mix (and so
// to WebRTC guests), plus on-demand cue banks. Nothing is fetched until start() or cue() runs, and
// only the chosen venue's bed (and the banks a cue asks for) is ever loaded.
const files = new URL("./", import.meta.url);
const cache = new Map();

function json(path, fetcher) {
  if (!cache.has(path)) {
    cache.set(path, fetcher(new URL(path, files)).then(response => {
      if (!response.ok) throw Error(`Unable to load ${path}`);
      return response.json();
    }));
    cache.get(path).catch(() => cache.delete(path));
  }
  return cache.get(path);
}

export const venueManifest = (fetcher = globalThis.fetch) => json("venues.json", fetcher);
export const cueManifest = (fetcher = globalThis.fetch) => json("cues.json", fetcher);
export const mixLevels = (fetcher = globalThis.fetch) => json("mix.json", fetcher);
export const musicManifest = (fetcher = globalThis.fetch) => json("music.json", fetcher);
export const combatManifest = (fetcher = globalThis.fetch) => json("combat.json", fetcher);

// Retail per-animation audio tags (ANIMTAGS.DAT): {anims:[[name,[[frame,n,...words]]]]}.
export async function loadAnimTags(fetcher = globalThis.fetch) {
  const response = await fetcher(new URL("animtags.json.gz", files));
  if (!response.ok) throw Error("Unable to load animation audio tags");
  const text = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text);
}

// Every runtime file one venue needs, for publication lists and cold-boot audits.
export const venueFiles = (venue) => [venue.bed].filter(Boolean);
export const sharedFiles = ["venue.mjs", "venues.json", "cues.json", "mix.json", "combat.json", "match.mjs", "music.json", "music.mjs", "animtags.json.gz"];

export function venueAudio(file, {
  fetcher = globalThis.fetch, Context = globalThis.AudioContext, doc = globalThis.document,
  win = globalThis.window, button = doc?.querySelector?.("#sound"), onStart,
} = {}) {
  let context, bus, local, broadcast, bedGain, bed, source, venue, loading, level = 30000 / 32767;
  let active = true, requested = false, muted = false;
  const banks = new Map(), playing = new Set(), tracks = new Set();
  let generation = 0;
  const voiceBuffers=new Map();

  const hidden = () => doc?.hidden === true;
  const label = () => { if (button) button.textContent = muted ? "Unmute" : "Mute"; };

  function graph() {
    if (context) return;
    context = new Context({ sampleRate: 48000 });
    bus = context.createGain();
    local = context.createGain();
    broadcast = context.createMediaStreamDestination();
    bedGain = context.createGain();
    bus.connect(local); local.connect(context.destination); bus.connect(broadcast);
    bedGain.connect(bus);
    local.gain.value = muted ? 0 : 1;
  }

  async function decode(path) {
    const response = await fetcher(new URL(path, files));
    if (!response.ok) throw Error(`Unable to load ${path}`);
    return context.decodeAudioData(await response.arrayBuffer());
  }

  function voiceBuffer(path) {
    const cached=voiceBuffers.get(path);
    if(cached){voiceBuffers.delete(path);voiceBuffers.set(path,cached);return cached;}
    const pending=decode(path).catch(error=>{
      if(voiceBuffers.get(path)===pending)voiceBuffers.delete(path);
      throw error;
    });
    voiceBuffers.set(path,pending);
    if(voiceBuffers.size>4)voiceBuffers.delete(voiceBuffers.keys().next().value);
    return pending;
  }

  async function loadBed() {
    const manifest = await venueManifest(fetcher);
    venue = manifest.venues.find(v => v.file === file);
    if (!venue) throw Error("No retail audio for " + file);
    level = manifest.mix?.ambience ?? level;
    if (!venue.bed) return;
    const info = manifest.beds[venue.bedBank];
    graph();
    bed = { info, buffer: await decode(info.file) };
  }

  function loopBed() {
    if (!bed || !context || source) return;
    const {info, buffer} = bed;
    source = context.createBufferSource();
    source.buffer = buffer;
    // The retail loop section is stored whole; its exact length is loopFrames / sourceRate seconds.
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = Math.min(info.loopSeconds, buffer.duration);
    bedGain.gain.value = level;
    source.connect(bedGain);
    source.start();
  }

  function play() {
    if (!active || hidden() || !context) return;
    loading ??= loadBed();
    Promise.all([context.resume(), loading]).then(loopBed).catch(() => { loading = undefined; });
  }

  function start() {
    graph();
    if (!requested) {
      requested = true;
      onStart?.();
    }
    play();
    return broadcast.stream;
  }

  function synchronize() {
    if (!context) return;
    if (!active || hidden()) context.suspend().catch(() => {});
    else if (requested) play();
  }

  const unlock = event => {
    if (event.target === button || event.target?.id === "join" || !active) return;
    start();
    win?.removeEventListener("pointerdown", unlock);
    win?.removeEventListener("keydown", unlock);
  };
  if (button) button.onclick = () => { setMuted(!muted); start(); };
  win?.addEventListener("pointerdown", unlock);
  win?.addEventListener("keydown", unlock);
  doc?.addEventListener?.("visibilitychange", synchronize);
  label();

  function setMuted(value) {
    muted = value;
    if (local) local.gain.value = muted ? 0 : 1;
    label();
  }

  async function bank(name) {
    const key = name.toLowerCase();
    if (!banks.has(key)) {
      banks.set(key, (async () => {
        const manifest = await cueManifest(fetcher);
        const entry = Object.entries(manifest.banks).find(([n]) => n.toLowerCase() === key)?.[1];
        if (!entry?.file) throw Error("No cue bank " + name);
        return { entry, buffer: await decode(entry.file) };
      })());
      banks.get(key).catch(() => banks.delete(key));
    }
    return banks.get(key);
  }

  return {
    stream: start,
    setActive(value) { active = value; synchronize(); },
    restart() {
      generation++;
      for (const effect of playing) effect.stop();
      playing.clear();
      if (!requested || !context) return;
      if (source) { source.stop(); source.disconnect(); source = undefined; }
      loopBed();
    },
    setMuted,
    get muted() { return muted; },
    get venue() { return venue; },
    // Play subsong `index` (1-based, as numbered in the retail bank) of a cue bank, e.g.
    // cue("Fighter_Big_Hits_Ring", 3, {gain: 0.6}). Resolves when the cue has started.
    async cue(name, index, {gain = 1, rate = 1, when = 0} = {}) {
      if (!requested) start();
      graph();
      const version = generation;
      const {entry, buffer} = await bank(name);
      if (version !== generation || !active || hidden()) return;
      const cue = entry.cues.find(c => c.i === index && c.frames);
      if (!cue) throw Error(`No cue ${index} in ${name}`);
      await context.resume();
      if (version !== generation || !active || hidden()) return;
      const node = context.createBufferSource(), volume = context.createGain();
      playing.add(node);
      node.onended = () => { playing.delete(node); node.disconnect(); volume.disconnect(); };
      node.buffer = buffer;
      node.playbackRate.value = rate;
      volume.gain.value = gain;
      node.connect(volume); volume.connect(bus);
      node.start(when ? context.currentTime + when : 0, cue.start / entry.rate, cue.frames / entry.rate);
      return node;
    },
    // Stream a music file into the host mix (so WebRTC guests hear it): `loopStart` seconds into the file the
    // track loops to its end when `loop`; otherwise it plays once and `onEnded` fires. Returns {stop()}.
    async track(path, {gain = 1, loop = false, loopStart = 0, offset = 0, duration, current, onEnded} = {}) {
      if (!requested) start();
      graph();
      const buffer = duration===undefined ? await decode(path) : await voiceBuffer(path);
      await context.resume();
      if(current && !current()) return;
      const node = context.createBufferSource(), volume = context.createGain();
      const handle = { node, stop() { if (!tracks.delete(handle)) return; node.onended = null; try { node.stop(); } catch {} node.disconnect(); volume.disconnect(); } };
      tracks.add(handle);
      node.buffer = buffer;
      if (loop) { node.loop = true; node.loopStart = loopStart; node.loopEnd = buffer.duration; }
      node.onended = () => { if (!tracks.delete(handle)) return; node.disconnect(); volume.disconnect(); onEnded?.(); };
      volume.gain.value = gain;
      node.connect(volume); volume.connect(bus);
      if(duration===undefined) node.start(0,offset);
      else node.start(0,offset,duration);
      return handle;
    },
    dispose() {
      generation++;
      voiceBuffers.clear();
      for (const handle of [...tracks]) handle.stop();
      active = false;
      win?.removeEventListener("pointerdown", unlock);
      win?.removeEventListener("keydown", unlock);
      doc?.removeEventListener?.("visibilitychange", synchronize);
      source?.stop();
      context?.close?.();
      context = undefined;
    },
  };
}
