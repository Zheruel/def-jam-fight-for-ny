// Battle music for the native match: the retail PathFinder fight path of one tune, streamed on demand into the
// host mix (venueAudio's bus feeds the local speakers and the WebRTC broadcast stream, so guests hear it).
//
//   const audio = venueAudio(arena.file);
//   const music = createMusic(audio, { seed });       // or { tune: "hitem" }
//   await music.start();                              // fetches music.json and one ~1 MB track only now
//   music.stop();                                     // on match end / leaving the arena
//
// A track is the tune's intro followed by its song body; looping tunes repeat the body forever on the
// exact retail loop point, the two non-looping tunes (nwa, minitrack2) end and the next playlist tune starts.
// Which tune retail picks for a match is not recovered (see README): `tune` overrides the seeded pick.
import { musicManifest } from "./venue.mjs";

export function chooseTune(manifest, { tune, seed = 1, exclude } = {}) {
  if (tune) {
    if (!manifest.tracks[tune]) throw new RangeError("No retail music track for " + tune);
    return tune;
  }
  const list = manifest.playlist.filter(name => name !== exclude && manifest.tracks[name]);
  return list.length ? list[Math.abs(seed) % list.length] : manifest.default;
}

export function createMusic(audio, { tune, seed = 1, fetcher = globalThis.fetch, gain } = {}) {
  let manifest, handle, current, token = 0, round = 0;

  async function play(name, version) {
    const track = manifest.tracks[name];
    const next = await audio.track(track.file, {
      gain: gain ?? manifest.gain,
      loop: track.loops,
      loopStart: track.introSeconds,
      onEnded: () => { if (version === token) advance(name).catch(() => {}); },
    });
    if (version !== token) { next.stop(); return; }
    handle = next;
    current = name;
  }

  async function advance(previous) {
    const version = ++token;
    round++;
    await play(chooseTune(manifest, { seed: seed + round, exclude: previous }), version);
  }

  return {
    async start() {
      manifest ??= await musicManifest(fetcher);
      const version = ++token;
      handle?.stop();
      await play(chooseTune(manifest, { tune, seed }), version);
      return current;
    },
    stop() { token++; handle?.stop(); handle = undefined; current = undefined; },
    get tune() { return current; },
  };
}
