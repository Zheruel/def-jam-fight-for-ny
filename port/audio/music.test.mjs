import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { decodePoseBank } from "../motion/pose-bank.mjs";
import library from "../motion/library.json" with { type: "json" };
import { createFoundationFight } from "../battle/fight.mjs";
import { venueAudio } from "./venue.mjs";
import { chooseTune, createMusic, songQueue } from "./music.mjs";
import { createMatchAudio } from "./match.mjs";
import { audioMusic } from "./files.mjs";

const here = new URL("./", import.meta.url), root = new URL("../../", import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, here)));
const music = json("music.json"), mix = json("mix.json"), combat = json("combat.json"), venues = json("venues.json");
const tags = JSON.parse(gunzipSync(readFileSync(new URL("animtags.json.gz", here))));
const ffprobe = spawnSync("ffprobe", ["-version"]).status === 0;
const packed = path => Uint8Array.from(gunzipSync(readFileSync(new URL(path, root)))).buffer;

function harness() {
  const requests = [], sources = [];
  const fetcher = async url => {
    const path = new URL(url).pathname.replace(new URL(here).pathname, "");
    requests.push(path);
    return { ok: true, json: async () => JSON.parse(readFileSync(new URL(path, here))), arrayBuffer: async () => Object.assign(new ArrayBuffer(8), { path }) };
  };
  class Context {
    constructor() { this.currentTime = 0; this.destination = {}; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { return { stream: { id: "broadcast" } }; }
    createBufferSource() {
      const node = { loop: false, connect() {}, disconnect() {}, start(...a) { node.started = a; }, stop() { node.stopped = true; }, playbackRate: { value: 1 } };
      sources.push(node);
      return node;
    }
    async decodeAudioData(data) { return { duration: 200, path: data.path }; }
    async resume() {}
    async suspend() {}
    close() {}
  }
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null };
  const tracks = () => sources.filter(node => node.buffer?.path?.startsWith("music/"));
  return { requests, sources, tracks, options: { fetcher, Context, doc, win: { addEventListener() {}, removeEventListener() {} } } };
}

test("music manifest: levels, the captured battle list and every track's loop point agree with the files", () => {
  assert.equal(music.default, "dirty");
  const { set, primary, captures } = music.battleSongs;
  assert.equal(set.length, 16);
  assert.equal(primary, "dirty");
  assert.equal(captures.length, 2);
  for (const capture of captures) {
    assert.equal(capture.songs.length, 17);          // 16 tunes, "dirty" twice
    assert.equal(capture.songs[0], "dirty");
    assert.deepEqual([...new Set(capture.songs)].sort(), set);
  }
  assert.notDeepEqual(captures[0].songs, captures[1].songs, "the two real matches shuffled the list differently");
  assert.equal(music.gain, mix.gain.Music_Vol * mix.gain.Master_Vol);
  assert.equal(music.levels.Music_Vol, 60);
  assert.deepEqual(Object.keys(music.tracks).sort(), [...set].sort());
  assert.equal(Object.keys(music.tunes).length, 33);
  assert.equal(audioMusic.length, set.length);
  for (const track of Object.values(music.tracks)) {
    assert.ok(existsSync(new URL(track.file, here)), track.file);
    assert.equal(track.rate, 48000);
    assert.equal(track.introSeconds, track.introSourceFrames / track.sourceRate);
    assert.equal(track.loops, track.loopAt !== null);
    if (track.loops) assert.ok(track.introSeconds < track.seconds - 60, track.name + " has a song body to loop");
    if (ffprobe) {
      const out = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", new URL(track.file, here).pathname]);
      assert.ok(Math.abs(Number(out.stdout) - track.seconds) < 0.02, `${track.name} ${out.stdout}`);
    }
  }
});

test("the retail tune table stays consistent with the graph summary", () => {
  for (const [name, tune] of Object.entries(music.tunes)) {
    assert.ok(tune.mainSamples <= tune.samples, name);
    if (music.tracks[name]) {
      assert.equal(tune.ends, !music.tracks[name].loops);
      assert.ok(Math.abs(tune.introSeconds + tune.loopSeconds - music.tracks[name].seconds) < 10, name); // RAM-bank intro samples report other lengths in the table than they decode to
    }
  }
});

test("retail's song selection: an empty list falls back to dirty, otherwise dirty leads and the rest shuffles by seed", () => {
  assert.deepEqual(songQueue(music, { songs: [] }), ["dirty"]);
  assert.deepEqual(songQueue(music, { songs: ["nope"] }), ["dirty"]);
  const queue = songQueue(music, { seed: 7 });
  assert.equal(queue[0], "dirty");
  assert.deepEqual([...queue].sort(), [...music.battleSongs.set].sort());
  assert.deepEqual(queue, songQueue(music, { seed: 7 }));
  assert.notDeepEqual(queue, songQueue(music, { seed: 8 }));
  assert.deepEqual(songQueue(music, { songs: ["hitem", "pump"], seed: 1 }).sort(), ["hitem", "pump"]);
  assert.equal(chooseTune(music, { tune: "hitem" }), "hitem");
  assert.throws(() => chooseTune(music, { tune: "nwa" }));
  assert.equal(chooseTune(music, {}), "dirty");
});

test("nothing loads until the music starts, then only music.json and the one track; the track loops on the retail loop point", async () => {
  const { requests, tracks, options } = harness();
  const audio = venueAudio("V2BG_02A", options);
  const player = createMusic(audio, { tune: "hitem", fetcher: options.fetcher });
  assert.deepEqual(requests, []);
  assert.equal(await player.start(), "hitem");
  assert.deepEqual(requests.filter(path => path !== "venues.json" && !path.startsWith("ambience/")), ["music.json", "music/hitem.ogg"]);
  const node = tracks().at(-1);
  assert.equal(node.loop, true);
  assert.equal(node.loopStart, music.tracks.hitem.introSeconds);
  assert.equal(node.loopEnd, 200);
  player.stop();
  assert.equal(node.stopped, true);
  assert.equal(player.tune, undefined);
});

test("a tune that ends is followed by the next song in the queue", async () => {
  const played = [];
  const audio = { track: async (path, options) => { const handle = { path, options, stop() { handle.stopped = true; } }; played.push(handle); return handle; } };
  const player = createMusic(audio, { songs: ["hitem", "pump"] });
  const [first, second] = songQueue(music, { songs: ["hitem", "pump"] });
  assert.equal(await player.start(), first);
  assert.deepEqual(player.queue, [first, second]);
  played[0].options.onEnded();                                  // the track plays out
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(player.tune, second);
  assert.equal(played[1].path, `music/${second}.ogg`);
  played[1].options.onEnded();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(player.tune, first, "the queue wraps");
  player.stop();
  assert.equal(played[2].stopped, true);
});

test("a native Blaze/Doc fight keeps its music in the host mix while combat cues play beside it", async () => {
  const fighters = ["V2IP_113A", "V2IP_109A"].map(model => {
    const bytes = packed(`port/render/fighters/${model}.skin.gz`);
    const length = new DataView(bytes).getUint32(4, true);
    return { model, body: JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 8, length))), bank: decodePoseBank(model, packed(`port/motion/poses/${model}.poses.gz`)) };
  });
  const fight = await createFoundationFight(fighters, packed("port/kernel/battle.wasm.gz"), packed("port/kernel/foundation-start.gz"),
    null, packed("port/kernel/match-rules.gz"));
  const { sources, tracks, options } = harness();
  const audio = venueAudio("V2BG_02A", options);
  const player = createMusic(audio, { seed: 5, fetcher: options.fetcher });  // the captured list, dirty first
  const venue = venues.venues.find(entry => entry.file === "V2BG_02A");
  const cues = [];
  const match = createMatchAudio({ combat, tags, mix, venue, fighters: [{ coreID: 5 }, { coreID: 10 }], clips: library,
    play: (bank, subsong, opts) => { cues.push([bank, subsong]); return audio.cue(bank, subsong, opts); } });
  const tune = await player.start();                       // match start
  assert.equal(tune, "dirty");
  const track = tracks().at(-1);
  assert.equal(track.buffer.path, `music/${tune}.ogg`);
  const inputs = JSON.parse(readFileSync(new URL("verification/native-fight-inputs.json", root)));
  for (const actors of inputs) {
    fight.tick(actors.map(([pad], slot) => ({ buttons: pad & 0xfff0, x: pad & 0x10000 ? (slot ? -1 : 1) : 0, z: 0 })));
    match.tick(fight);
    assert.equal(track.stopped, undefined, "the music keeps playing through the fight");
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(cues.length > 20, "combat cues played: " + cues.length);
  assert.ok(sources.length > 2, "cue sources share the engine with the music");
  assert.equal(track.loop, music.tracks[tune].loops);
  player.stop();                                           // match end
  assert.equal(track.stopped, true);
});
