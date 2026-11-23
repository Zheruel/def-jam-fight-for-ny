import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createEnvironment } from "./environment.mjs";
import { createTrainAudio, trainVolume, trainX } from "./train.mjs";
import { parseSkinned } from "./scenery.mjs";

const json = name => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const manifest = json("./V2BG_04A/scenery.json");
const { names, weaponModels } = json("./events.json");
const packed = file => Uint8Array.from(gunzipSync(readFileSync(new URL("../" + file, import.meta.url)))).buffer;
const idle = [{ buttons: 0, x: 0, z: 0 }, { buttons: 0, x: 0, z: 0 }];

async function subwayMatch() {
  const { createFoundationFight } = await import("../battle/fight.mjs");
  const { createMatchAnimation } = await import("../animation/match.mjs");
  const { default: inventory } = await import("../../ps2/content/inventory.json", { with: { type: "json" } });
  const sampler = await WebAssembly.compile(packed("animation/sampler.wasm.gz"));
  const ids = [5, 10];
  const fighters = ids.map(id => {
    const record = inventory.fighters.find(f => f.fighterXml.coreID === id);
    const asset = packed(`render/fighters/${record.model}.skin.gz`);
    const body = JSON.parse(new TextDecoder().decode(new Uint8Array(asset, 8, new DataView(asset).getUint32(4, true))));
    return { model: record.model, body, record };
  });
  const animation = await createMatchAnimation(sampler, packed("animation/shared.gz"),
    ids.map(id => packed(`animation/banks/wres${String(id).padStart(3, "0")}.gz`)));
  const venue = inventory.venues.find(v => v.coreID === 4);
  const arena = { venue, collision: Uint8Array.from(readFileSync(new URL(`../collision/venues/${venue.file}.cli`, import.meta.url))).buffer };
  return createFoundationFight(fighters, packed("kernel/battle.wasm.gz"), packed("kernel/foundation-start.gz"),
    arena, packed("kernel/match-rules.gz"), animation);
}

test("the retail volume curve and the path of the cars", () => {
  assert.deepEqual([trainVolume(0.0001).cents, trainVolume(0.1).cents, trainVolume(0.25).cents, trainVolume(1).cents], [-199, -120, 0, 0]);
  assert.ok(Math.abs(trainVolume(0.0001).gain - 0.795) < 0.001);
  const { subway } = manifest;
  assert.equal(subway.width, 180);
  assert.ok(Math.abs(trainX(subway, 0, subway.bounds) + 180.94) < 0.01, "the head reaches the playfield edge at phase 0");
  assert.ok(Math.abs(trainX(subway, 1, subway.bounds) - 180.94) < 0.01, "the tail leaves the other edge at phase 1");
  assert.ok(Math.abs(trainX(subway, 0.5, subway.bounds)) < 1e-9);
});

test("the cars ship with the venue: five models that differ in one texture", () => {
  const cars = manifest.subway.objects.map(name => parseSkinned(packed(`scenery/V2BG_04A/trains/${name}.skin.gz`)));
  assert.deepEqual(cars.map(c => c.mesh.vertices), [1333, 1333, 1333, 1333, 1333]);
  const texture = cars.map(c => c.mesh.batches.map(b => b.shape).join());
  assert.deepEqual(new Set(texture).size, 3, "three distinct side textures across the five cars");
  assert.ok(cars.every(c => c.mesh.bones.length === 1));
});

async function run(ticks, pit = null) {
  const fight = await subwayMatch();
  const env = createEnvironment(manifest, names, { weaponModels });
  const seen = [], cars = [], m = fight.memory;
  for (let tick = 0; tick < ticks; tick++) {
    // A fighter over the track bed (the pit) before the first train comes.
    if (tick === 960 && pit !== null) {
      m.setFloat32(0x4bc170 + 0x12f8 * pit + 0x44, 0, true); m.setFloat32(0x4bc170 + 0x12f8 * pit + 0x4c, -58, true);
      m.setFloat32(0x4bc170 + 0x12f8 * (1 - pit) + 0x4c, 20, true);
    }
    fight.tick(idle);
    env.update(fight.memory, 1, fight.states);
    for (const e of env.effects().filter(e => e.kind === "train")) seen.push({ tick, ...e });
    const car = env.state().dynamicWeapons.find(w => w.train);
    cars.push(car ? [car.model, Math.round(car.matrix[12])] : null);
  }
  return { seen, cars };
}
const brief = seen => seen.filter(e => e.action !== "volume").map(e => `${e.tick} ${e.action}${e.on === undefined ? "" : e.on ? " on" : " off"}${e.slot === undefined ? "" : " " + e.slot}`);

test("native match: the kernel's train arrives, passes and leaves; the adapter follows it, car by car", async () => {
  const { seen, cars } = await run(5300);
  assert.deepEqual(brief(seen).slice(0, 4), ["975 siren on", "1001 audio on", "1250 siren off", "1376 audio off"]);
  const audio = seen.find(e => e.action === "audio" && e.on);
  assert.deepEqual([audio.bank, audio.subsong, audio.cents], ["train", 1, -196]);
  assert.deepEqual(seen.filter(e => e.action === "volume" && e.tick < 2000).length, 61, "the volume ramps over the first quarter of the phase");
  // Not in the tunnel until phase -0.7 (tick 825), then crossing the playfield from the left to the right.
  assert.equal(cars[800], null);
  assert.equal(cars[900][0], "V2BG_04A_H");
  assert.ok(cars[1000][1] < -170 && cars[1000][1] > -190, "at the hit the head is at the playfield edge: " + cars[1000]);
  assert.ok(Math.abs(cars[1125][1]) < 3, "mid pass at phase 0.5: " + cars[1125]);
  assert.ok(cars[1250][1] > 170, "tail leaves at phase 1: " + cars[1250]);
  assert.equal(cars[1400], null);
  // The next train is the next car.
  const second = seen.find(e => e.action === "siren" && e.on && e.tick > 2000);
  assert.ok(second && second.cycle === 2, JSON.stringify(second));
  assert.equal(cars[second.tick + 150][0], "V2BG_04A_I");
  assert.equal(seen.find(e => e.action === "audio" && e.on && e.tick > 2000).subsong, 2);
});

test("native match: the effects name the fighter the train hit", async () => {
  const { seen } = await run(1100, 1);
  assert.deepEqual(brief(seen).slice(0, 3), ["975 siren on", "1000 hit 1", "1001 audio on"]);
  const other = await run(1100, 0);
  assert.deepEqual(brief(other.seen).slice(0, 3), ["975 siren on", "1000 hit 0", "1001 audio on"]);
});

test("train audio: the train sound starts and stops on the effects, the hit plays the fighter's scream", async () => {
  const played = [];
  const audio = { cue: async (bank, subsong, options) => { const entry = { bank, subsong, options, stopped: false }; played.push(entry); return { stop() { entry.stopped = true; } }; } };
  const combat = { fighters: { 5: { grunts: "WGuy" }, 10: { grunts: "BGirl" } } };
  const trainAudio = createTrainAudio(audio, { fighters: [{ coreID: 5 }, { coreID: 10 }], combat });
  await trainAudio.effects([{ kind: "train", action: "siren", on: true }, { kind: "train", action: "audio", on: true, bank: "train", subsong: 3, gain: 0.8 }]);
  await trainAudio.effects([{ kind: "train", action: "hit", slot: 1 }, { kind: "train", action: "hit", slot: 0 }, { kind: "sound", sound: "hit" }]);
  assert.deepEqual(played.map(p => [p.bank, p.subsong]), [["train", 3], ["Train_Kill_Female", 1], ["Train_Kill_Male", 1]]);
  assert.equal(played[0].options.gain, 0.8);
  await trainAudio.effects([{ kind: "train", action: "audio", on: false, bank: "train" }]);
  assert.equal(played[0].stopped, true);
});
