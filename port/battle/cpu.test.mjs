// Retail CPU opponents on the native kernel: seat semantics, authentic tables and a deterministic, human-equivalent input path.
//   node --test port/battle/cpu.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createFoundationFight, signatureClipIds } from "./fight.mjs";
import { createMatchAnimation } from "../animation/match.mjs";
import { AI_DATA, AI_READY, CPU_FLAG, PAD_BASE, TYPE_BASE, cpuSeats, mergeCpuPages } from "./cpu.mjs";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };

const unpack = name => Uint8Array.from(gunzipSync(readFileSync(new URL("../" + name, import.meta.url)))).buffer;
const actor = slot => 0x4bc170 + slot * 0x12f8;
const wasm = await WebAssembly.compile(unpack("kernel/battle.wasm.gz"));
const sampler = await WebAssembly.compile(unpack("animation/sampler.wasm.gz"));
const rules = unpack("kernel/match-rules.gz");
const cpuPages = unpack("kernel/cpu-pages.gz");
const record = id => inventory.fighters.find(f => f.fighterXml.coreID === id);
const rig = model => {
  const binary = unpack("render/fighters/" + model + ".skin.gz");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 8, new DataView(binary).getUint32(4, true))));
};

// ids: coreIDs of the fighters, seat 0 first; cpu: how many of the last seats the CPU plays.
async function match(ids, cpu, { merge = true } = {}) {
  const fighters = ids.map((id, slot) => ({ record: record(id), body: rig(record(id).model), model: record(id).model, cpu: slot >= ids.length - cpu }));
  const four = ids.length === 4;
  const start = unpack(four ? "kernel/four-start.gz" : "kernel/foundation-start.gz");
  const animation = await createMatchAnimation(sampler, unpack(four ? "animation/four-shared.gz" : "animation/shared.gz"),
    ids.map(id => unpack("animation/banks/wres" + String(id).padStart(3, "0") + ".gz")));
  const fight = await createFoundationFight(fighters, wasm, cpu && merge ? mergeCpuPages(start, cpuPages) : start, null, rules, animation);
  animation.setSignatures(new Map(signatureClipIds(fight.memory, ids.length).map(id => [id, unpack("animation/banks/special" + id + ".gz")])));
  return { fight, fighters, memory: fight.memory };
}
const digest = (hash, fight) => { for (const a of fight.diagnostics().actors) hash.update(JSON.stringify([a.position, a.health, a.score, a.action, a.state])); };
const read = memory => pad => [0, 1, 2, 3, 4, 5].map(k => k < 2 ? memory.getUint32(pad + 4 * k, true) : memory.getFloat32(pad + 4 * k, true));
// The seat-0 person's script: walks in circles and throws a punch now and then.
const person = t => ({ buttons: t % 40 < 6 ? 0x1000 : 0, x: Math.sin(t / 50), z: Math.cos(t / 70) });
function run({ fight, fighters }, ticks, { cpuInput = () => ({ buttons: 0, x: 0, z: 0 }), record: log } = {}) {
  const hash = createHash("sha1");
  const inputs = fighters.map(() => ({ buttons: 0, x: 0, z: 0 }));
  const pads = fighters.map((_, i) => PAD_BASE + 32 * fight.memory.getUint32(0x4bbd48 + 4 * i, true));
  for (let t = 0; t < ticks && !fight.outcome().result; t++) {
    fighters.forEach((f, i) => { inputs[i] = i === 0 ? person(t) : cpuInput(i, t); });
    // the pad records as the actor update will read them: after the CPU's decisions were copied, before the kernel tick
    if (log) { const tick = fight.kernel.tick; fight.kernel.tick = () => { log.push(pads.map(read(fight.memory))); fight.kernel.tick = tick; return tick(); }; }
    fight.tick(inputs);
    digest(hash, fight);
  }
  return hash.digest("hex");
}

test("the CPU seats are the last seats, one seat always stays a person", () => {
  assert.deepEqual(cpuSeats(4, 3), [1, 2, 3]);
  assert.deepEqual(cpuSeats(2, 1), [1]);
  assert.deepEqual(cpuSeats(4, 0), []);
  assert.throws(() => cpuSeats(2, 2), RangeError);
});

test("the AI decision tables are the retail capture's own file", () => {
  const pages = new Uint8Array(0x2000000), view = new DataView(cpuPages);
  for (let at = 0; at < cpuPages.byteLength; at += 4100) pages.set(new Uint8Array(cpuPages, at + 4, 4096), view.getUint32(at, true) * 4096);
  const table = pages.subarray(AI_DATA, AI_DATA + 0x15558);
  assert.equal(new DataView(table.buffer, table.byteOffset).getUint32(0, true), 0x20204941, "AI file magic");
  assert.equal(createHash("sha256").update(table).digest("hex"), "a380101778acbd8cb896a905366abd3d28ecbab6508c99ac578481ac758b3520");
});

test("seat types follow the match setup and the actor flag mirrors them", async () => {
  const four = await match([5, 10, 11, 16], 3);
  assert.deepEqual([0, 1, 2, 3].map(i => four.memory.getUint32(TYPE_BASE + 4 * i, true)), [0, 1, 1, 1]);
  assert.deepEqual([0, 1, 2, 3].map(i => four.memory.getUint8(actor(i) + CPU_FLAG) & 1), [0, 1, 1, 1]);
  assert.equal(four.memory.getUint32(0x4c4ce0, true), AI_DATA);
  const duel = await match([5, 10], 1);
  assert.deepEqual([0, 1].map(i => duel.memory.getUint8(actor(i) + CPU_FLAG) & 1), [0, 1]);
  // No CPU is ever added on its own: person-only matches keep type 0 everywhere and never run the AI bridge.
  const people = await match([5, 10, 11, 16], 0);
  assert.deepEqual([0, 1, 2, 3].map(i => people.memory.getUint8(actor(i) + CPU_FLAG) & 1), [0, 0, 0, 0]);
  const calls = [];
  const call = people.fight.kernel.call;
  people.fight.kernel.call = (target, ...rest) => { calls.push(target); return call(target, ...rest); };
  run(people, 30);
  assert.ok(!calls.includes(0x2f1338), "a person-only match never asks the CPU for decisions");
});

for (const [name, ids, cpu] of [["four-way", [5, 10, 11, 16], 3], ["one-on-one", [5, 10], 1], ["Free For All with a person pair", [5, 10, 11, 16], 2]]) {
  test(`${name}: the CPU moves, fights and scores on its own, deterministically`, async () => {
    const a = await match(ids, cpu), b = await match(ids, cpu);
    const start = a.fight.diagnostics().actors.map(x => x.position);
    const first = run(a, 1200), second = run(b, 1200);
    assert.equal(first, second, "two runs of the same match are identical");
    const after = a.fight.diagnostics().actors;
    const cpuSlots = ids.map((_, i) => i).filter(i => i >= ids.length - cpu);
    for (const slot of cpuSlots) {
      const moved = Math.hypot(after[slot].position[0] - start[slot][0], after[slot].position[2] - start[slot][2]);
      assert.ok(moved > 3 || after[slot].score > 0, `CPU seat ${slot + 1} acts (moved ${moved.toFixed(1)}, score ${after[slot].score})`);
    }
    assert.ok(after.some((x, i) => cpuSlots.includes(i) && x.score > 0) || after.some(x => x.health < x.maxHealth), "the match is a fight");
  });
}

test("a CPU seat ignores the host's input for it", async () => {
  const quiet = run(await match([5, 10, 11, 16], 3), 600);
  const noisy = run(await match([5, 10, 11, 16], 3), 600, { cpuInput: (i, t) => ({ buttons: (t * 7 + i) % 3 ? 0x2000 : 0x4000, x: 1, z: -1 }) });
  assert.equal(quiet, noisy);
});

test("pads: a person's record is the host's input, a CPU seat's record is its decision block", async () => {
  const { fight, memory } = await match([5, 10], 1);
  const pad = seat => PAD_BASE + 32 * memory.getUint32(0x4bbd48 + 4 * seat, true);
  const block = seat => 0x4c3ae0 + 0xb8 * seat;
  const seen = { buttons: new Set(), axes: new Set() };
  let copied = 0;
  for (let t = 0; t < 600; t++) {
    const mine = person(t);
    const tick = fight.kernel.tick;
    // after the bridge, before the actor update: the pad records the update will read
    fight.kernel.tick = () => {
      fight.kernel.tick = tick;
      assert.equal(memory.getUint32(pad(0), true), mine.buttons, "the person's pad holds the host's buttons");
      assert.ok(Math.abs(memory.getFloat32(pad(0) + 8, true) - mine.x) < 1e-6, "and the host's stick");
      seen.buttons.add(memory.getUint32(pad(1), true));
      const axes = [0, 1, 2, 3].map(k => memory.getFloat32(pad(1) + 8 + 4 * k, true));
      axes.forEach(axis => seen.axes.add(axis));
      if (axes.every((axis, k) => axis === memory.getFloat32(block(1) + 0x84 + 4 * k, true))) copied++;
      return tick();
    };
    fight.tick([mine, { buttons: 0x4000, x: 1, z: 1 }]);
    if (fight.outcome().result) break;
  }
  assert.ok(seen.buttons.size > 2, `the CPU pad's buttons vary (${seen.buttons.size} states)`);
  assert.ok(copied > 100, "the CPU pad carries the decision block's sticks");
});
