import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { ACTORS, TRAIN_WORD, VENUE_ID, createTrain, hazardKind } from "./hazard.mjs";

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

// The train is the retail frame update 0x2e75e8, so it runs by itself in the native kernel: bit 2 of 0x4c2178 (coming) rises
// around tick 975 and the hit lands at tick 1000 of the first cycle. 0x2e78d0 flags whoever is then in a hazard state or over
// the track floor (the ground word at +932 below -1; the pit floor is -11, the platform 0). Pad walking stops at the ring
// edge (|z| ~43), so the fighter is put over the pit the way a throw would leave them.
function runTrain(fight, pit) {
  const m = fight.memory;
  for (let tick = 0; tick < 1200; tick++) {
    if (tick === 960 && pit !== null) {
      m.setFloat32(ACTORS[pit] + 0x44, 0, true); m.setFloat32(ACTORS[pit] + 0x4c, -58, true);
      m.setFloat32(ACTORS[1 - pit] + 0x44, 0, true); m.setFloat32(ACTORS[1 - pit] + 0x4c, 20, true);
    }
    fight.tick(idle);
    if (fight.outcome().over) return tick;
  }
  return null;
}

test("subway: the natural train hits a fighter in the pit; they lose at full health and the other wins; rematch resets", async () => {
  const fight = await match(4), m = fight.memory;
  const start = JSON.stringify(fight.diagnostics());
  const tick = runTrain(fight, 1);
  assert.equal(tick, 1001, "the train hits at tick 1000 and the referee ends the round on the next frame");
  const outcome = fight.outcome(), actors = fight.diagnostics().actors;
  assert.deepEqual([outcome.winner, outcome.loser, outcome.method], [0, 1, "hazard"]);
  assert.ok(actors[1].health > 0 && actors[0].health > 0, "nobody is knocked out: the train did it");
  assert.equal(m.getFloat32(ACTORS[1] + 932, true), m.getFloat32(ACTORS[1] + 932, true));
  assert.ok(m.getFloat32(ACTORS[1] + 932, true) < -1, "the loser stood over the track floor");
  assert.equal(m.getUint32(ACTORS[1] + 0x30, true), 19, "the hit fighter is in state 19");
  assert.deepEqual([half(m, ACTORS[0] + 0x932), half(m, ACTORS[1] + 0x932)], [0x100, 0x600], "winner 0x100; loser 0x200 plus 0x400, which a time-up loser has too");
  assert.equal(m.getUint32(0x4bbf90 + 448, true) & 0x20, 0x20, "match flag 0x20 tells the train from a time-up");
  assert.equal(m.getUint32(TRAIN_WORD, true) & 1, 1, "the hazard stays live");
  // The same fight with the other fighter in the pit ends the other way round.
  const other = await match(4);
  runTrain(other, 0);
  assert.deepEqual([other.outcome().winner, other.outcome().method], [1, "hazard"]);
  // Reset: the starting memory is back.
  fight.rematch();
  assert.equal(JSON.stringify(fight.diagnostics()), start);
  assert.equal(fight.outcome().over, false);
});

// Controller-driven: a closed-loop pad script (nothing is placed). Both fighters walk to the platform edge and mash the
// buttons; one is pushed or thrown over it. The pit is what retail tests (the floor word at +932 below -1: the track bed).
// Returns what the retail code did when the first train hit.
const edgeButtons = [...buttons, 0x2100, 0x2400, 0x2800, 0x2200, 0x8800, 0x8400, 0x4800];
function edgeFight(fight, seed) {
  const m = fight.memory, word = a => m.getUint32(a, true), scalar = a => m.getFloat32(a, true);
  let random = seed * 7919 + 1, held = [0, 0];
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  const at = i => [scalar(ACTORS[i] + 0x44), scalar(ACTORS[i] + 0x4c)];
  const go = (i, tx, tz) => { const [x, z] = at(i), dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz); return d < 2 ? { x: 0, z: 0 } : { x: dx / d, z: -dz / d }; };
  const attacker = seed % 2, victim = 1 - attacker, warning = [];
  for (let tick = 0; tick < 1100; tick++) {
    if (fight.outcome().over) return { tick, warning, outcome: fight.outcome(), actors: fight.diagnostics().actors };
    if (tick % 12 === 0) held = [edgeButtons[next() % 19], edgeButtons[next() % 19]];
    const [vx, vz] = at(victim);
    const pads = tick < 500 ? [go(attacker, vx, vz + 6), go(victim, (seed % 5 - 2) * 6, -37)] : [go(attacker, vx, vz + 5), go(victim, vx, -40)];
    pads[attacker] = { ...pads[attacker], buttons: tick > 300 && tick % 12 < 4 ? held[attacker] : 0 };
    pads[victim] = { ...pads[victim], buttons: tick > 300 && tick % 12 < 3 && seed % 3 === 0 ? held[victim] : 0 };
    fight.tick(pads);
    if (tick === 995) for (const a of ACTORS) warning.push({ state: word(a + 0x30), floor: scalar(a + 932), zone: half(m, a + 2344) });
  }
  return null;
}

test("subway: a pad-driven fight at the platform edge ends under the first train as a hazard result", async () => {
  const results = {};
  for (const seed of [3, 2, 6]) {
    const fight = await match(4);
    const r = edgeFight(fight, seed);
    assert.ok(r, "round over before tick 1100");
    results[seed] = [r.tick, r.outcome.winner, r.outcome.loser, r.outcome.method, r.actors.map(a => a.health > 0)];
    // Retail marked whoever was in a hazard state or over the track bed as the train came in.
    const lost = r.outcome.winner === null ? [0, 1] : [r.outcome.loser];
    for (const slot of lost) assert.ok(r.warning[slot].floor < -1 || [12, 13, 19, 86, 90, 91].includes(r.warning[slot].state), JSON.stringify(r.warning[slot]));
  }
  // Seed 3 and 2: one fighter is in the pit, the other wins. Seed 6: both are over the track, so nobody wins.
  assert.deepEqual(results, { 3: [1002, 0, 1, "hazard", [true, true]], 2: [1002, 0, 1, "hazard", [true, true]], 6: [1002, null, 0, "hazard", [true, true]] });
});

test("subway: with nobody in the pit the natural train hits nothing", async () => {
  const fight = await match(4);
  assert.equal(runTrain(fight, null), null);
  assert.deepEqual(createTrain(fight.kernel).hitBy(), [false, false]);
});

test("subway: warn() and strike() drive the retail consumer 0x2e78d0 without waiting for the train", async () => {
  const fight = await match(4), m = fight.memory;
  for (let i = 0; i < 60; i++) fight.tick(idle);
  const train = createTrain(fight.kernel);
  m.setFloat32(ACTORS[1] + 932, -2, true);
  train.warn();
  assert.deepEqual(train.marked(), [false, true]);
  train.strike();
  assert.deepEqual(train.hitBy(), [false, true]);
  assert.equal(m.getUint32(ACTORS[1] + 0x30, true), 19);
  fight.tick(idle);
  assert.deepEqual([fight.outcome().winner, fight.outcome().method], [0, "hazard"]);
});
