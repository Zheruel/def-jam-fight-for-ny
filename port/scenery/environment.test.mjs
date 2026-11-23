import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createEnvironment, drainEventQueue, readEventQueue, EVENT_QUEUE, FREE } from "./environment.mjs";

const json = name => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const manifest = json("./foundation/scenery.json");
const names = json("./events.json").names;

test("event table: 468 retail names, the Foundation's are 25..44 in script order", () => {
  assert.equal(names.length, 468);
  assert.deepEqual(names.slice(25, 29), ["02A_1A", "02A_1B", "02A_1C", "02A_2A"]);
  assert.equal(names[30], "02A_3");
  assert.equal(names[34], "02A_6");
  assert.equal(names[44], "02A_10C");
  const own = manifest.environmentAttacks.map(a => a.name);
  assert.deepEqual(own, names.slice(25, 25 + own.length));
});

test("a pillar breaks in three stages and the third drops its hidden weapon", () => {
  const env = createEnvironment(manifest, names);
  assert.deepEqual(env.state(), { props: {}, weapons: {}, hiddenWeapons: [] });
  env.trigger("02A_1A");
  assert.equal(env.state().props.V2BG_02A_D, "break1");
  env.trigger("02A_1B");
  assert.equal(env.state().props.V2BG_02A_D, "break2");
  assert.deepEqual(env.state().hiddenWeapons, [], "the weapon stays hidden until break3");
  env.trigger("02A_1C");
  const state = env.state();
  assert.equal(state.props.V2BG_02A_D, "break3");
  assert.deepEqual(state.weapons.weapon_1C_011D.translate, [42, 19, 35], "drops from the retail spawn position");
  env.advance(60);
  const landed = env.state().weapons.weapon_1C_011D;
  assert.deepEqual([landed.translate[0], landed.translate[1], landed.translate[2]], [42, -2, 35]);
  assert.ok(env.effects().some(e => e.kind === "sound" && e.sound === "break"));
  // The other three pillars are untouched.
  for (const pillar of ["V2BG_02A_A", "V2BG_02A_B", "V2BG_02A_C"]) assert.equal(env.state().props[pillar], undefined);
});

test("a speaker that held a bottle sends it down and removes it at the break sound", () => {
  const env = createEnvironment(manifest, names);
  env.trigger("02A_2A");
  assert.equal(env.state().props.V2BG_02A_I, "break");
  const start = env.state().weapons.weapon_02_029A.translate;
  assert.deepEqual(start, [16.89, 17.57, -47.11]);
  env.advance(30);
  const mid = env.state().weapons.weapon_02_029A.translate;
  assert.ok(mid[1] < 17.57);
  env.advance(124);
  assert.notEqual(env.state().weapons.weapon_02_029A, false);
  env.advance(2);
  assert.equal(env.state().weapons.weapon_02_029A, false, "gone at frame 155");
  const effects = env.effects();
  assert.deepEqual(effects.filter(e => e.at === 155 && e.kind !== "weaponGone").map(e => e.particle ?? e.sound), ["fx_bottlel", "fx_bottles", "break"]);
  assert.ok(effects.some(e => e.kind === "weaponGone" && e.weapon === "02_029A" && e.at === 155));
  assert.equal(env.state().weapons.weapon_05_029A, undefined, "the other bottle is not touched");
});

test("a bottle smash in hand removes it at once; unknown events are reported, not thrown", () => {
  const env = createEnvironment(manifest, names);
  assert.equal(env.trigger(30), true);
  assert.equal(env.state().weapons.weapon_02_029A, false);
  assert.equal(env.trigger("24A_9"), false);
  assert.match(env.ignored[0], /no script/);
});

test("the queue is read and freed the way the retail manager frees it", () => {
  const memory = new DataView(new ArrayBuffer(EVENT_QUEUE + 64));
  for (let i = 0; i < 2; i++) memory.setUint32(EVENT_QUEUE + i * 16, FREE, true);
  memory.setUint32(EVENT_QUEUE + 16, 25, true);
  memory.setUint32(EVENT_QUEUE + 16 + 4, 7, true);
  assert.deepEqual(readEventQueue(memory), [{ slot: 1, id: 25, attacker: 7, target: 0, flag: 0 }]);
  const env = createEnvironment(manifest, names);
  assert.equal(env.update(memory).length, 1);
  assert.equal(env.state().props.V2BG_02A_D, "break1");
  assert.deepEqual(readEventQueue(memory), []);
});

// The tests below run the real native match: the recompiled retail fight code takes player input and queues
// the environment events itself.
const packed = file => Uint8Array.from(gunzipSync(readFileSync(new URL("../" + file, import.meta.url)))).buffer;

async function nativeMatch() {
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
  return createFoundationFight(fighters, packed("kernel/battle.wasm.gz"), packed("kernel/foundation-start.gz"),
    null, packed("kernel/match-rules.gz"), animation);
}

// Two fighters mash a deterministic pad script (a fixed random seed) and wander the ring. Returns each environment
// event the retail code queued, with the tick it did so on and what the adapter drew afterwards.
async function playUntil(seed, stop) {
  const match = await nativeMatch();
  const env = createEnvironment(manifest, names);
  const buttons = [0x1000, 0x4000, 0x2000, 0x8000, 0x1100, 0x1400, 0x1800, 0x1200, 0x4400, 0x8100, 0x400, 0x800];
  let random = seed;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const held = [0, 0], seen = [];
  for (let tick = 0; tick < 60000; tick++) {
    const inputs = [0, 1].map(slot => {
      if (tick % 20 === 0) held[slot] = next() < 0.5 ? buttons[Math.floor(next() * 12)] : 0;
      return { buttons: held[slot], x: Math.sin(tick / 60 + slot * 3), z: Math.cos(tick / 90 + slot) };
    });
    try { match.tick(inputs); } catch (error) {
      // A move whose retail routine is outside the kernel yet: restart the round and keep playing.
      if (!/Missing Battle service/.test(error.message)) throw error;
      match.rematch();
      env.reset();
      continue;
    }
    const events = env.update(match.memory);
    for (const e of events) seen.push({ tick, name: names[e.id], flag: e.flag, state: env.state() });
    if (match.outcome().over) match.rematch();
    if (seen.length && stop(seen)) break;
  }
  return { seen, env };
}

test("native match: a fighter's bottle strike queues 02A_3 and the bottle leaves the speaker", async () => {
  const { seen } = await playUntil(2, s => s.some(e => e.name === "02A_3"));
  const hit = seen.find(e => e.name === "02A_3");
  assert.ok(hit, "the retail fight code queued 02A_3");
  assert.equal(hit.tick, 3389);
  assert.equal(hit.state.weapons.weapon_02_029A, false);
  assert.equal(hit.state.weapons.weapon_05_029A, undefined, "the left bottle is still on its speaker");
});

test("native match: a fighter hits the right-front pillar and it shows its first break", async () => {
  const { seen, env } = await playUntil(16, s => s.some(e => e.name === "02A_1A"));
  const hit = seen.find(e => e.name === "02A_1A");
  assert.ok(hit, "the retail fight code queued 02A_1A");
  assert.equal(hit.tick, 7701);
  assert.deepEqual(hit.state.props, { V2BG_02A_D: "break1" });
  assert.deepEqual(seen.filter(e => e.tick < 7701).map(e => e.name), ["02A_6"], "an earlier left-bottle smash");
  assert.equal(env.effects().filter(e => e.event === "02A_1A" && e.kind === "particle").length, 2);
});
