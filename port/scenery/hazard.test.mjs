import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { ACTORS, TRAIN_WORD, VENUE_ID, createTrain, finishKind, hazardKind } from "./hazard.mjs";

const packed = file => Uint8Array.from(gunzipSync(readFileSync(new URL("../" + file, import.meta.url)))).buffer;

async function match(coreID) {
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
  const venue = inventory.venues.find(v => v.coreID === coreID);
  const arena = { venue, collision: Uint8Array.from(readFileSync(new URL(`../collision/venues/${venue.file}.cli`, import.meta.url))).buffer };
  return createFoundationFight(fighters, packed("kernel/battle.wasm.gz"), packed("kernel/foundation-start.gz"),
    arena, packed("kernel/match-rules.gz"), animation);
}

const idle = [{ buttons: 0, x: 0, z: 0 }, { buttons: 0, x: 0, z: 0 }];
const half = (m, a) => m.getUint16(a, true);

const buttons = [0x1000, 0x4000, 0x2000, 0x8000, 0x1100, 0x1400, 0x1800, 0x1200, 0x4400, 0x8100, 0x400, 0x800];

// The pad script of verification/native-outcome.mjs: both fighters close in and trade the buttons; the victim has 8 health.
// Returns the loser's flags on the frame the knockdown landed (before the referee turns them into result flags).
function knockout(fight, victim, seed) {
  const m = fight.memory, max = m.getFloat32(ACTORS[victim] + 0x354, true);
  m.setFloat32(ACTORS[victim] + 0x350, 8, true);
  m.setFloat32(ACTORS[victim] + 0x35c, 8 / max, true);
  let random = seed, held = [0, 0], marked = null;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  for (let tick = 0; tick < 12000; tick++) {
    const { actors, outcome } = fight.diagnostics();
    const flags = half(m, ACTORS[victim] + 2354);
    if (marked === null && flags & 0x35) marked = { tick, flags, states: ACTORS.map(a => m.getUint32(a + 0x30, true)) };
    if (outcome.over) return { marked, outcome, finish: tick };
    const dx = actors[1].position[0] - actors[0].position[0], dz = actors[1].position[2] - actors[0].position[2], dist = Math.hypot(dx, dz);
    if (tick % 18 === 0) held = [buttons[next() % 12], buttons[next() % 12]];
    fight.tick(actors.map((_, slot) => ({ buttons: dist > 10 ? 0x2000 : tick % 18 < 4 ? (slot === victim ? 0 : held[slot]) : 0,
      x: dist > 7 ? (slot ? -1 : 1) * dx / dist : 0, z: dist > 7 ? (slot ? 1 : -1) * dz / dist : 0 })));
  }
  assert.fail("no result");
}

test("pad-driven knockouts: a Red Hook knockout marks the loser 0x4 where other venues mark 0x1", async () => {
  // Retail 0x30bb40 marks the loser 0x10 (subway), 0x4 (Red Hook) or 0x20 (Crow's Office) and G+448 8, 4 or 0x10 in those
  // venues, and the referee turns that into result type 0x100 / 0x80 / 0x200. This script reaches the Red Hook branch with
  // the loser in grapple-victim state 114; the same script elsewhere ends in other states with the generic mark 0x1. The
  // condition that selects the branch (the knockdown classifier 0x30b550 -> 0x30b928 -> 0x30bb40) is not isolated yet.
  const results = {};
  for (const [id, victim] of [[1, 0], [7, 0], [7, 1], [17, 0], [4, 0]]) {
    const fight = await match(id);
    const r = knockout(fight, victim, 17);
    results[`${id}/${victim}`] = [r.marked.flags, r.marked.states[victim], r.outcome.winner, r.outcome.loser, r.outcome.method];
    assert.equal(hazardKind(fight.memory), { 1: null, 4: "subway", 7: "inferno", 17: "garage" }[id]);
  }
  assert.deepEqual(results, {
    "1/0": [1, 98, 1, 0, "ko"], "7/0": [4, 114, 1, 0, "ko"], "7/1": [1, 34, 0, 1, "ko"],
    "17/0": [1, 104, 1, 0, "ko"], "4/0": [1, 98, 1, 0, "ko"],
  });
});

test("subway: a fighter in the pit when the train hits loses with full health; the other wins; rematch resets", async () => {
  const fight = await match(4), m = fight.memory;
  const start = JSON.stringify(fight.diagnostics());
  for (let i = 0; i < 60; i++) fight.tick(idle);
  const train = createTrain(fight.kernel);
  assert.equal(m.getUint32(TRAIN_WORD, true) & 1, 1, "the hazard is live from venue setup");
  assert.deepEqual(train.marked(), [false, false]);
  // Fighter 1 is in the pit (the retail word at +932 below -1) as the train comes, then it hits.
  m.setFloat32(ACTORS[1] + 932, -2, true);
  train.warn();
  assert.deepEqual(train.marked(), [false, true]);
  assert.equal(fight.outcome().over, false);
  train.strike();
  assert.deepEqual(train.hitBy(), [false, true]);
  assert.equal(m.getUint32(ACTORS[1] + 0x30, true), 19, "the hit fighter is put in hit state 19");
  assert.equal(m.getUint32(TRAIN_WORD, true) & 6, 0, "the consumer clears the coming and hit bits");
  fight.tick(idle);
  const outcome = fight.outcome(), actors = fight.diagnostics().actors;
  assert.deepEqual([outcome.over, outcome.winner, outcome.loser], [true, 0, 1]);
  assert.ok(actors[1].health > 0 && actors[0].health > 0, "nobody is knocked out: the train did it");
  assert.equal(finishKind(outcome, actors, train), "hazard");
  assert.equal(half(m, ACTORS[0] + 0x932) & 0x100, 0x100, "winner flag");
  assert.equal(half(m, ACTORS[1] + 0x932) & 0x200, 0x200, "loser flag");
  // Reset: the starting memory and the train hazard are back.
  fight.rematch();
  train.reset();
  assert.equal(JSON.stringify(fight.diagnostics()), start);
  assert.equal(fight.outcome().over, false);
  assert.equal(train.struck, false);
});

test("subway: nobody marked means the hit does nothing", async () => {
  const fight = await match(4);
  for (let i = 0; i < 30; i++) fight.tick(idle);
  const train = createTrain(fight.kernel);
  train.warn();
  train.strike();
  for (let i = 0; i < 5; i++) fight.tick(idle);
  assert.equal(fight.outcome().over, false);
  assert.deepEqual(train.hitBy(), [false, false]);
});
