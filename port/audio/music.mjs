// Battle music for the native match: the retail PathFinder fight path of one tune, streamed on demand into the
// host mix (venueAudio's bus feeds the local speakers and the WebRTC broadcast stream, so guests hear it).
//
//   const audio = venueAudio(arena.file);
//   const music = createMusic(audio, { seed });       // or { tune: "hitem" }, or { songs: [...] } for a profile's list
//   await music.start();                              // fetches music.json and one ~1 MB track only now
//   music.stop();                                     // on match end / leaving the arena
//
// Selection follows what was recovered from retail (see README): the match builds BACKEND::BATTLESONGS from the
// profile's songs and falls back to "dirty" when that list is empty. Without a profile list the 16 tunes read from
// the list in two captured retail matches are used, "dirty" first (first in both captures), the rest in a seeded shuffle.
// A track is the tune's intro followed by its song body; looping tunes repeat the body on the exact retail loop point.
import { musicManifest } from "./venue.mjs";

function shuffle(list, seed) {
  const out = [...list];
  let state = seed >>> 0 || 1;
  const next = () => (state = Math.imul(state ^ state >>> 15, 0x2c1b3c6d) + 0x297a2d39 >>> 0) / 4294967296;
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// The order a match plays its songs in. An empty list is retail's "primary song to default song": just "dirty".
export function songQueue(manifest, { songs, seed = 1 } = {}) {
  const list = (songs ?? manifest.battleSongs.set).filter(name => manifest.tracks[name]);
  if (!list.length) return [manifest.default];
  const primary = manifest.battleSongs.primary;
  const rest = shuffle(list.filter(name => name !== primary), seed);
  return list.includes(primary) ? [primary, ...rest] : rest;
}

export function chooseTune(manifest, { tune, songs, seed = 1 } = {}) {
  if (tune) {
    if (!manifest.tracks[tune]) throw new RangeError("No retail music track for " + tune);
    return tune;
  }
  return songQueue(manifest, { songs, seed })[0];
}

export function createMusic(audio, { tune, songs, seed = 1, fetcher = globalThis.fetch, gain } = {}) {
  let manifest, handle, current, token = 0, queue = [], index = 0;

  async function play(name, version) {
    const track = manifest.tracks[name];
    const next = await audio.track(track.file, {
      gain: gain ?? manifest.gain,
      loop: track.loops,
      loopStart: track.introSeconds,
      onEnded: () => { if (version === token) advance().catch(() => {}); },
    });
    if (version !== token) { next.stop(); return; }
    handle = next;
    current = name;
  }

  async function advance() {
    const version = ++token;
    index = (index + 1) % queue.length;
    await play(queue[index], version);
  }

  return {
    async start() {
      manifest ??= await musicManifest(fetcher);
      const version = ++token;
      handle?.stop();
      queue = tune ? [tune] : songQueue(manifest, { songs, seed });
      if (tune) chooseTune(manifest, { tune });
      index = 0;
      await play(queue[0], version);
      return current;
    },
    stop() { token++; handle?.stop(); handle = undefined; current = undefined; },
    get tune() { return current; },
    get queue() { return [...queue]; },
  };
}
