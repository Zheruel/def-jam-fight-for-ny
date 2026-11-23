import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };
import { venueAudio } from "./venue.mjs";
import { audioBeds, audioFiles } from "./files.mjs";

const here = new URL("./", import.meta.url);
const read = name => readFileSync(new URL(name, here));
const manifest = JSON.parse(read("venues.json"));
const ffprobe = spawnSync("ffprobe", ["-version"]).status === 0;

function duration(file) {
  const out = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", new URL(file, here).pathname]);
  return Number(out.stdout);
}

test("all 24 selectable venues carry retail audio", () => {
  assert.equal(manifest.venues.length, 24);
  assert.deepEqual(manifest.venues.map(v => v.file).sort(), inventory.venues.map(v => v.file).sort());
  for (const venue of manifest.venues) {
    assert.ok(venue.bed, venue.file + " has a bed");
    assert.ok(manifest.beds[venue.bedBank], venue.file);
    assert.ok(existsSync(new URL(venue.bed, here)), venue.bed);
  }
});

test("retail table agrees with VENUE.XML wherever the XML names an ambient bed or crowd", () => {
  for (const venue of manifest.venues) {
    const xml = venue.xml.dispname;
    assert.ok(xml);
  }
  const bed = file => manifest.venues.find(v => v.file === file);
  // Inferno has no ambient entry: the bed is the fire bank named by its crowd entry.
  assert.equal(bed("V2BG_07A").ambient, null);
  assert.equal(bed("V2BG_07A").bedBank, "fire");
  // The 125th Street Station keeps its train ambient2 and the retail venues share beds, not files.
  assert.equal(bed("V2BG_04A").ambient2, "train");
  assert.equal(bed("V2BG_10A").bed, bed("V2BG_10B").bed);
  assert.equal(bed("V2BG_22A").bed, bed("V2BG_22B").bed);
  assert.equal(bed("V2BG_02A").bed, "ambience/bsmt.ogg");
});

test("every bed keeps its retail loop points and plays for exactly the loop length", { skip: !ffprobe }, () => {
  for (const bed of Object.values(manifest.beds)) {
    assert.equal(bed.loopFrames, bed.loopEnd - bed.loopStart);
    assert.equal(bed.loopStart, bed.introFrames);
    assert.ok(Math.abs(bed.loopSeconds - bed.loopFrames / bed.sourceRate) < 1e-12);
    assert.ok(Math.abs(bed.frames / bed.rate - bed.loopSeconds) < 1 / bed.rate + 1e-9, bed.file);
    // ffprobe counts the 312-sample Opus pre-skip; decoders drop it (bed.frames is the decoded count).
    assert.ok(Math.abs(duration(bed.file) - bed.loopSeconds) < 0.01, bed.file);
  }
  const foundation = manifest.beds.bsmt;
  assert.deepEqual([foundation.loopStart, foundation.loopEnd], [3526972, 7053944]);
});

test("cue banks stay inside their files and do not overlap", { skip: !ffprobe }, () => {
  const cues = JSON.parse(read("cues.json"));
  const wanted = ["Fighter_Big_Hits_Ring", "Fighter_Small_Hits_Out", "Spec_Punch", "Grunts_BBGuy", "csmall", "cmed", "fire", "BsmntSFX"];
  for (const name of wanted) assert.ok(cues.banks[name]?.file, name);
  for (const [name, bank] of Object.entries(cues.banks)) {
    if (!bank.file) continue;
    assert.ok(existsSync(new URL(bank.file, here)), name);
    assert.ok(Math.abs(duration(bank.file) - bank.frames / bank.rate) < 0.02, name);
    let end = 0;
    for (const cue of bank.cues.filter(c => c.frames)) {
      assert.ok(cue.start >= end, `${name} #${cue.i} overlaps`);
      end = cue.start + cue.frames;
      assert.ok(end <= bank.frames);
    }
  }
});

test("animation tags decode completely", () => {
  const tags = JSON.parse(gunzipSync(read("animtags.json.gz")));
  assert.equal(tags.anims.length, 2669);
  assert.equal(new Set(tags.anims.map(a => a[0])).size, 2669);
  for (const [, list] of tags.anims) for (const tag of list) assert.equal(tag.length, 2 + tag[1] + 1);
});

function harness() {
  const requests = [];
  const fetcher = async url => {
    const path = new URL(url).pathname.replace(new URL(here).pathname, "");
    requests.push(path);
    return { ok: true, json: async () => JSON.parse(read(path)), arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const nodes = [];
  class Context {
    constructor(options) { this.options = options; this.currentTime = 0; this.destination = {}; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { return { stream: { id: "broadcast" } }; }
    createBufferSource() {
      const node = { loop: false, connect() {}, disconnect() {}, start(...a) { node.started = a; }, stop() { node.stopped = true; },
        playbackRate: { value: 1 } };
      nodes.push(node);
      return node;
    }
    async decodeAudioData() { return { duration: 200 }; }
    async resume() {}
    async suspend() {}
    close() {}
  }
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null };
  const win = { addEventListener() {}, removeEventListener() {} };
  return { requests, nodes, options: { fetcher, Context, doc, win } };
}

test("cold boot loads nothing; the chosen venue's bed loads on demand and loops on the retail loop length", async () => {
  const { requests, nodes, options } = harness();
  const audio = venueAudio("V2BG_21A", options);
  assert.deepEqual(requests, []);
  assert.equal(audio.stream().id, "broadcast");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(requests, ["venues.json", "ambience/carib.ogg"]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].loop, true);
  assert.equal(nodes[0].loopEnd, manifest.beds.carib.loopFrames / 36000);
  audio.restart();
  assert.equal(nodes[0].stopped, true);
  assert.equal(nodes.length, 2);
  assert.deepEqual(requests, ["venues.json", "ambience/carib.ogg"]);
});

test("cues load their bank on first use and play the packed slice", async () => {
  const { requests, nodes, options } = harness();
  const audio = venueAudio("V2BG_02A", options);
  await audio.cue("Fighter_Big_Hits_Ring", 1);
  const bank = JSON.parse(read("cues.json")).banks.Fighter_Big_Hits_Ring;
  assert.ok(requests.includes("cues.json") && requests.includes(bank.file));
  const cue = bank.cues.find(c => c.i === 1);
  const played = nodes.at(-1).started;
  assert.deepEqual(played, [0, cue.start / bank.rate, cue.frames / bank.rate]);
  await assert.rejects(audio.cue("Fighter_Big_Hits_Ring", 999));
});

test("publication list names existing files and one bed per distinct ambience", () => {
  for (const file of audioFiles) assert.ok(existsSync(new URL("../../" + file, here)), file);
  assert.equal(audioBeds.length, Object.keys(manifest.beds).length);
});
