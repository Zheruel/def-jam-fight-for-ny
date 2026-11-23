// Exercise the native 2v2 Team match (retail flags 0x20007, "2 vs 2 TAG" lineup, allies 0<->1 and 2<->3).
// --seed FIGHT_START_BIN TRACKED_WASM OUTPUT rebuilds port/kernel/team-start.gz from a retail capture
// (verification/capture-team.mjs) using a kernel build that tracks the pages it touches.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { createFoundationFight, signatureClipIds } from "../port/battle/fight.mjs";
import { createMatchAnimation } from "../port/animation/match.mjs";
import { createVoicePlayer } from "../port/audio/voice.mjs";
import inventory from "../ps2/content/inventory.json" with { type: "json" };
import lineups from "../port/battle/lineups.json" with { type: "json" };

const unpack = name => Uint8Array.from(gunzipSync(readFileSync(new URL("../port/" + name, import.meta.url)))).buffer;
const actor = slot => 0x4bc170 + slot * 0x12f8;
const args = process.argv.slice(2);
const make = args[0] === "--seed";
const formation = "2 vs 2 TAG", TEAM = 0x20007;
const mateOf = slot => slot ^ 1, team = slot => slot >> 1;
let seed, original;
function records(bytes, pages) {
  const out = [];
  for (let i = 0; i < 8192; i++) if (!pages || pages[i]) {
    const tag = Buffer.alloc(4); tag.writeUInt32LE(i); out.push(tag, bytes.subarray(i * 4096, (i + 1) * 4096));
  }
  return Uint8Array.from(Buffer.concat(out)).buffer;
}
if (make) {
  original = readFileSync(args[1]);
  assert.equal(original.length, 0x2000000);
  assert.equal(original.readUInt32LE(0x4bbd2c), TEAM);
  assert.equal(original.readUInt32LE(0x4bbf98), 1);
  for (let slot = 0; slot < 4; slot++) {
    assert.equal(original.readUInt32LE(actor(slot) + 0x28), slot);
    assert.equal(original.readUInt32LE(actor(slot) + 4), actor(mateOf(slot)), "ally pointer");
    // Player type 0 is human. Retail 0x2eda64 mirrors CPU type into actor flag bit 0.
    original.writeUInt32LE(0, 0x4bbd38 + slot * 4);
    original[actor(slot) + 0x937] &= 0xfe;
  }
  seed = records(original);
} else seed = unpack("kernel/team-start.gz");
const wasm = await WebAssembly.compile(make ? readFileSync(args[2]) : unpack("kernel/battle.wasm.gz"));
const sampler = await WebAssembly.compile(unpack("animation/sampler.wasm.gz"));
const ids = [5, 10, 11, 14], rules = unpack("kernel/match-rules.gz");
const fighters = ids.map(id => {
  const record = inventory.fighters.find(f => f.fighterXml.coreID === id);
  const binary = unpack("render/fighters/" + record.model + ".skin.gz");
  const length = new DataView(binary).getUint32(4, true);
  const body = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 8, length)));
  return { record, body, model: record.model };
});
const animation = await createMatchAnimation(sampler, unpack("animation/four-shared.gz"), ids.map(id => unpack("animation/banks/wres" + String(id).padStart(3, "0") + ".gz")));
const fight = await createFoundationFight(fighters, wasm, seed, null, rules, animation);
animation.setSignatures(new Map(signatureClipIds(fight.memory, 4).map(id => [id, unpack("animation/banks/special" + id + ".gz")])));
const voiceIndex = JSON.parse(readFileSync(new URL("../port/audio/voice/index.json", import.meta.url)));
const mix = JSON.parse(readFileSync(new URL("../port/audio/mix.json", import.meta.url)));
const played = [];
fight.setVoicePlayer(createVoicePlayer(voiceIndex, mix, { async track(file, options) { played.push({ file, options }); } }));

const m = fight.memory;
const word = a => m.getUint32(a, true), half = a => m.getUint16(a, true), real = a => m.getFloat32(a, true);
const setReal = (a, v) => m.setFloat32(a, v, true);
const pads = () => [0, 1, 2, 3].map(() => ({ buttons: 0, x: 0, z: 0 }));
const slotOf = pointer => [0, 1, 2, 3].find(s => actor(s) === pointer) ?? null;
const pos = s => [real(actor(s) + 0x44), real(actor(s) + 0x4c)];
const health = s => real(actor(s) + 0x350);
const place = (slot, x, z) => { setReal(actor(slot) + 0x44, x); setReal(actor(slot) + 0x4c, z); };
const settle = () => { for (let t = 0; t < 120; t++) fight.tick(pads()); };

// Start state: retail flags, lineup, allies and targets.
assert.equal(word(0x4bbd2c) & 0xf0000, 0x20000, "Team formation bit");
assert.deepEqual(fight.diagnostics().actors.map(a => [a.position[0], a.position[2]]), lineups.V2BG_02A[formation]);
assert.deepEqual([0, 1, 2, 3].map(s => slotOf(word(actor(s) + 4))), [1, 0, 3, 2], "allies");
assert.deepEqual([0, 1, 2, 3].map(s => slotOf(word(actor(s)))), [3, 2, 1, 0], "opening targets are opponents");
const outcome = fight.outcome();
assert.deepEqual(outcome.teams, [[0, 1], [2, 3]]);
console.log("Team start: lineup, allies, targets and teams match retail.");

// Each seat is independently controllable.
const start = fight.diagnostics().actors.map(a => [a.position[0], a.position[2]]);
for (let i = 0; i < 4; i++) {
  fight.restart();
  const input = pads(); input[i].x = 0.8;
  for (let j = 0; j < 30; j++) fight.tick(input);
  fight.diagnostics().actors.forEach((a, k) => {
    const d = Math.hypot(a.position[0] - start[k][0], a.position[2] - start[k][1]);
    if (k === i) assert.ok(d > 1, "Player " + (i + 1) + " can move");
    else assert.ok(d < 0.1, "Neutral player " + (k + 1) + " stays still");
  });
}
console.log("Team: all four seats move independently.");

// Allies never hurt each other: the same strike string hurts the retail target (an opponent) standing in front of the
// attacker and does nothing to the ally standing there.
function strike(attacker, front) {
  fight.restart(); settle();
  const [ax, az] = pos(attacker);
  place(front, ax + 4, az);
  [0, 1, 2, 3].filter(s => s !== attacker && s !== front).forEach((s, i) => place(s, 40, i ? 40 : -40));
  const before = [0, 1, 2, 3].map(health);
  for (let t = 0; t < 600; t++) {
    const input = pads();
    input[attacker] = { buttons: t % 20 < 4 ? [0x1000, 0x4000, 0x8000][Math.floor(t / 20) % 3] : 0, x: 1, z: 0 };
    fight.tick(input);
  }
  return [0, 1, 2, 3].map(s => before[s] - health(s));
}
for (const attacker of [0, 1, 2, 3]) {
  const ally = mateOf(attacker), target = slotOf(word(actor(attacker)));
  assert.notEqual(team(target), team(attacker), `slot ${attacker} targets an opponent`);
  const hitAlly = strike(attacker, ally);
  assert.equal(hitAlly[ally], 0, `slot ${attacker} cannot damage ally ${ally}`);
  const hitFoe = strike(attacker, target);
  assert.ok(hitFoe[target] > 0, `slot ${attacker} damages its opponent ${target}`);
  assert.equal(hitFoe[ally] + hitFoe[attacker], 0, `slot ${attacker} and its ally stay unhurt`);
}
console.log("Team: no friendly fire; opponents take damage.");

// A full-health match, played by pad scripts, ends in a knockout with a Team winner.
const strikes = [0x1000, 0x4000, 0x2000, 0x8000, 0x1100, 0x1400, 0x1800, 0x1200, 0x4400, 0x8100, 0x400, 0x800];
function play(seed, weak = []) {
  fight.rematch(); settle();
  for (const s of weak) { const max = real(actor(s) + 0x354); setReal(actor(s) + 0x350, 8); setReal(actor(s) + 0x35c, 8 / max); }
  let random = seed, held = [0, 0, 0, 0], retargeted = false;
  const knocked = new Set();
  let submissionMeterSeen = false;
  for (let tick = 0; tick < 40000 && !fight.outcome().over; tick++) {
    const { actors } = fight.diagnostics();
    if (!submissionMeterSeen && actors.some(a => a.state === 66)) {
      fight.kernel.call(0x2dd1d8, 0x43d6a8);
      const hold = fight.diagnostics().actors.find(a => a.state === 66)?.hold;
      if (hold && hold.health > 0 && hold.escape >= 0 && hold.escape <= 1) submissionMeterSeen = true;
    }
    if (tick % 18 === 0) held = held.map(() => strikes[(random = (Math.imul(random, 1664525) + 1013904223) >>> 0) % strikes.length]);
    // Once an opponent is out, every survivor on the other team is retargeted onto the remaining foe, never an ally.
    for (let s = 0; s < 4; s++) if (half(actor(s) + 0x932) & 0x200) knocked.add(s);
    if (knocked.size === 1 && !fight.outcome().over) {
      const out = [...knocked][0];
      for (let s = 0; s < 4; s++) {
        if (knocked.has(s) || team(s) === team(out)) continue;
        const target = slotOf(word(actor(s)));
        assert.ok(target !== null && team(target) !== team(s), `slot ${s} never targets an ally`);
        if (target !== out) retargeted = true;
      }
    }
    fight.tick(actors.map((a, i) => {
      const foes = actors.map((b, j) => ({ b, j })).filter(({ j }) => team(j) !== team(i) && !(half(actor(j) + 0x932) & 0x200));
      const dist = b => Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]);
      foes.sort((x, y) => dist(x.b) - dist(y.b));
      const target = foes[0]?.b;
      if (!target) return { buttons: 0, x: 0, z: 0 };
      const d = dist(target), dx = target.position[0] - a.position[0], dz = target.position[2] - a.position[2];
      return { buttons: d > 10 ? 0x2000 : tick % 18 < 4 ? held[i] : 0, x: d > 7 ? dx / d : 0, z: d > 7 ? -dz / d : 0 };
    }));
  }
  return { result: fight.outcome(), retargeted, submissionMeterSeen };
}
const full = play(17);
assert.equal(full.result.method, "ko", "Full-health Team match reaches a knockout");
assert.ok(full.result.winner !== null && full.result.loser !== null);
assert.equal(team(full.result.winner) === team(full.result.loser), false, "winner and loser are on opposing teams");
assert.deepEqual(full.result.winners, [team(full.result.winner) * 2, team(full.result.winner) * 2 + 1]);
assert.deepEqual(full.result.losers, [team(full.result.loser) * 2, team(full.result.loser) * 2 + 1]);
console.log("Full-health Team match: winning team", full.result.winners, "losers", full.result.losers, "tick winner flags",
  [0, 1, 2, 3].map(s => half(actor(s) + 0x932).toString(16)).join(","));

// Weakened teams make a quick match from each side; the survivors retarget the remaining opponent.
// Seed 3 first knocks Doc out, then Magic finishes Blaze in a submission hold (states 65/66).
for (const [seed, weak, method] of [[17, [2, 3], "ko"], [3, [0, 1], "submission"], [5, [2, 3], "ko"]]) {
  const { result, retargeted, submissionMeterSeen } = play(seed, weak);
  if (method === "submission") assert.ok(submissionMeterSeen, "the retail hold shows the victim’s limb and escape gauges");
  assert.equal(result.method, method);
  assert.ok(retargeted, `seed ${seed}: survivors retarget after a knockout`);
  assert.deepEqual(result.winners, weak[0] === 2 ? [0, 1] : [2, 3], `seed ${seed}: the stronger team wins`);
  assert.deepEqual(result.losers, weak);
  console.log("Team seed", seed, "weak", weak.join(","), "-> winners", result.winners);
}

// The time limit ends a Team match without a winner unless the rules score it.
fight.rematch();
m.setUint32(0x4bbd30, 9, true);
for (let t = 0; t < 900 && !fight.outcome().result; t++) fight.tick(pads());
assert.equal(fight.outcome().method, "time");
assert.equal(fight.outcome().draw, true);
assert.deepEqual(fight.outcome().winners, []);
fight.rematch();
assert.deepEqual(fight.diagnostics().actors.map(a => [a.position[0], a.position[2]]), lineups.V2BG_02A[formation], "rematch restores the lineup");
console.log("Team time limit: draw, then restarted.");

if (make) {
  // Widen the observed pages: every page a differently played match can touch must be in the compact seed.
  for (let seed = 1; seed <= 40; seed++) play(seed, seed % 3 === 0 ? [] : seed % 3 === 1 ? [2, 3] : [0, 1]);
  const pages = fight.observedPages, common = new DataView(unpack("kernel/foundation-start.gz"));
  for (let off = 0; off < common.byteLength; off += 4100) pages[common.getUint32(off, true)] = 1;
  writeFileSync(args[3], gzipSync(new Uint8Array(records(original, pages)), { level: 9 }));
}
