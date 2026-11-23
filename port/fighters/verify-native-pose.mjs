// Differential: run the production native match (Blaze vs Doc, the 460-tick recorded input) and compare every tick's final pose
// and named-bone world matrices with the retail poses recorded in private/verification/ps2-match/run-BjNMn0.
//   node port/fighters/verify-native-pose.mjs [--offset N] [--verbose]
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createFoundationFight } from "../battle/fight.mjs";
import { createMatchAnimation } from "../animation/match.mjs";
import { composePose, actorMatrix, boneWorldMatrix, NAMED_BONES } from "./pose.mjs";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };
import frames from "../../verification/native-fight-inputs.json" with { type: "json" };

const trace = new URL("../../private/verification/ps2-match/run-BjNMn0/combat-trace.json", import.meta.url);
if (!existsSync(trace)) { console.log("run-BjNMn0 trace missing, nothing to compare"); process.exit(0); }
const recorded = JSON.parse(readFileSync(trace, "utf8")).samples;
const packed = file => Uint8Array.from(gunzipSync(readFileSync(new URL("../" + file, import.meta.url)))).buffer;
const records = [5, 10].map(id => inventory.fighters.find(f => f.fighterXml.coreID === id));
const fighters = records.map(record => {
  const asset = packed(`render/fighters/${record.model}.skin.gz`);
  const body = JSON.parse(new TextDecoder().decode(new Uint8Array(asset, 8, new DataView(asset).getUint32(4, true))));
  return { model: record.model, body, record };
});
const banks = records.map(f => packed(`animation/banks/wres${String(f.fighterXml.coreID).padStart(3, "0")}.gz`));
const animation = await createMatchAnimation(await WebAssembly.compile(packed("animation/sampler.wasm.gz")), packed("animation/shared.gz"), banks);
const match = await createFoundationFight(fighters, await WebAssembly.compile(packed("kernel/battle.wasm.gz")), packed("kernel/foundation-start.gz"), null, packed("kernel/match-rules.gz"), animation);
const HELD = new Set([...Array(15).keys()].flatMap(i => [21 + i, 42 + i]).concat([70, 71, 74, 76, 77, 79, 80]));
const arg = name => process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : undefined;
const verbose = process.argv.includes("--verbose");

function compare(state, slot, ref, position, facing) {
  const mine = state.final;
  let local = 0, bone = -1;
  for (let k = 0; k < 94; k++) {
    if (HELD.has(k)) continue;
    const sign = Math.sign(mine[k * 12 + 4] * ref[k * 12 + 4] + mine[k * 12 + 5] * ref[k * 12 + 5] + mine[k * 12 + 6] * ref[k * 12 + 6] + mine[k * 12 + 7] * ref[k * 12 + 7]) || 1;
    for (let j = 4; j < 11; j++) { const e = Math.abs(mine[k * 12 + j] - (j < 8 ? sign : 1) * ref[k * 12 + j]); if (e > local) { local = e; bone = k; } }
  }
  const actor = actorMatrix(position, facing), world = composePose(state, ref).world, worldMine = composePose(state, mine).world;
  let named = 0;
  for (let id = 1; id <= NAMED_BONES.length; id++) {
    if (HELD.has(NAMED_BONES[id - 1])) continue;
    const a = boneWorldMatrix(state, mine, actor, id, worldMine), b = boneWorldMatrix(state, ref, actor, id, world);
    named = Math.max(named, Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]));
  }
  return { local, bone, named };
}

const offset = arg("--offset") ?? 0;
const results = [[], []];
for (const [tick, row] of frames.entries()) {
  match.tick(row.map(([pad]) => ({ buttons: pad & 0xfff0, x: pad & 0x10000 ? 1 : 0, z: 0 })).map((v, slot) => slot ? { ...v, x: -v.x } : v));
  const sample = recorded[tick + offset];
  if (!sample) continue;
  match.states.forEach((state, slot) => {
    const a = sample.actors[slot];
    if (!a || !state.final) return;
    const raw = Buffer.from(a.pose, "base64");
    const ref = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + 94 * 48));
    const r = compare(state, slot, ref, a.position, a.facing);
    results[slot].push({ tick, action: a.action, blend: a.blendCounters[0], ...r });
  });
}
for (const slot of [0, 1]) {
  const rows = results[slot], settled = rows.filter(r => r.blend === 0);
  const pct = (list, key, p) => list.map(r => r[key]).sort((x, y) => x - y)[Math.floor(list.length * p)] ?? 0;
  console.log(`slot ${slot}: ${rows.length} ticks (${settled.length} not blending); named-bone position error median ${pct(rows, "named", .5).toFixed(3)} p95 ${pct(rows, "named", .95).toFixed(3)} max ${pct(rows, "named", 1 - 1e-9).toFixed(3)}; local pose error median ${pct(rows, "local", .5).toFixed(4)} p95 ${pct(rows, "local", .95).toFixed(3)}`);
  if (verbose) for (const r of rows.filter(r => r.named > .1)) console.log("  tick", r.tick, "action", r.action, "blend", r.blend, "named", r.named.toFixed(3), "local", r.local.toFixed(3), "bone", r.bone);
}
