// node --test port/fighters/pose.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bounds, composePose, readPose, skinPositions, actorMatrix, characterAddress, readLocalPose, applyBoneEuler } from "./pose.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const json = (path) => JSON.parse(readFileSync(join(here, path), "utf8"));
const model = (name) => json(`models/${name}.json`);
const pose = (name) => json(`poses/${name}.json`);
const posed = (m, p) => skinPositions(m, composePose(m, Float32Array.from(p.entries)).skin);
const near = (a, b, d) => assert.ok(Math.abs(a - b) <= d, `${a} vs ${b}`);

test("the reference array skins the mesh back to the bind pose", () => {
  const blaze = model("V2IP_113A");
  const out = posed(blaze, pose("blaze-reference-bind"));
  const diffs = Array.from(out, (v, i) => Math.abs(v - blaze.positions[i])).sort((a, b) => a - b);
  assert.ok(diffs[Math.floor(diffs.length * 0.9)] < 0.02);   // hierarchy and TRS composition are right
  assert.ok(diffs.at(-1) < 0.5);                              // lips/ponytail bones with unresolved parents
});

test("idle poses stand on the ground at fighter height", () => {
  for (const [name, file] of [["blaze-idle-a112-f16", "V2IP_113A"], ["doc-idle-a117-f18", "V2IP_109A"]]) {
    const { min, max } = bounds(posed(model(file), pose(name)));
    near(min[1], 0, 0.1);
    assert.ok(max[1] > 19.5 && max[1] < 22, `${name} height ${max[1]}`);
    assert.ok(max[0] - min[0] < 14 && max[2] - min[2] < 14);
  }
});

test("blaze idle golden bounds (cross-checked against an independent Python implementation)", () => {
  const { min, max } = bounds(posed(model("V2IP_113A"), pose("blaze-idle-a112-f16")));
  [-6.3348, -0.0168, -4.2709].forEach((v, k) => near(min[k], v, 1e-3));
  [5.6634, 20.3650, 6.1481].forEach((v, k) => near(max[k], v, 1e-3));
});

test("actor placement rotates about Y and translates", () => {
  const m = actorMatrix([10, 0, 5], 90);
  near(m[0], 0, 1e-6); near(m[2], -1, 1e-6); near(m[8], 1, 1e-6); assert.deepEqual([m[12], m[13], m[14]], [10, 0, 5]);
});

test("pointers outside EE RAM are rejected", () => {
  const view = new DataView(new ArrayBuffer(0x480000));
  assert.throws(() => characterAddress(view, 0), /no character/);
  view.setUint32(0x471230, 0x445330, true);
  assert.throws(() => readLocalPose(view, 0x445330), /not a pose array/);
});

const SNAP = join(here, "../../private/verification/ps2-match/run-zUpaXW/fighter-ram-0.bin");
test("live snapshot read matches the checked-in example", { skip: !existsSync(SNAP) }, () => {
  const b = readFileSync(SNAP);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const live = readPose(view, model("V2IP_113A"), 0);
  assert.equal(live.character, 0x445330);
  const example = pose("blaze-idle-a112-f16");
  live.entries.forEach((v, i) => near(v, example.entries[i], 1e-5));
});

test("applyBoneEuler matches the recompiled retail 0x132ab8 on A112 t=5 (head, euler 12/-25/33)", () => {
  const entries = new Float32Array(94 * 12);
  const q = [0.035, 0.0888, 0.0141, 0.9953];
  entries.set(q, 58 * 12 + 4);
  applyBoneEuler(entries, 7, [0, 0, 0]);
  q.forEach((v, i) => near(entries[58 * 12 + 4 + i], v, 1e-6));
  applyBoneEuler(entries, 7, [10, 0, 0]);   // x -> quaternion Y axis
  near(entries[58 * 12 + 5], 0.1753, 2e-4);
});

const sampler = join(here, "../../private/fighter-sampler/sampler");
const snapshot = join(here, "../../private/verification/ps2-match/run-BjNMn0/fighter-ram-0.bin");
test("composePose x actorMatrix equals the retail bone world matrices (0x132a28) for all 40 named bones", { skip: !(existsSync(sampler) && existsSync(snapshot)) }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { NAMED_BONES, boneWorldMatrix } = await import("./pose.mjs");
  const bytes = readFileSync(snapshot);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [slot, file, facing, position, tolerance] of [[0, "V2IP_113A", 90, [-24.367, 0, 0], 2e-3], [1, "V2IP_109A", -90, [22.718, 0.001, -0.191], 2e-3]]) {
    const m = model(file), { entries } = readPose(view, m, slot);
    const out = execFileSync(sampler, [snapshot, "b"], { input: NAMED_BONES.map((_, i) => `${slot} ${i + 1}\n`).join(""), maxBuffer: 1 << 24, stdio: ["pipe", "pipe", "ignore"] });
    const retail = new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
    const actor = actorMatrix(position, facing), world = composePose(m, entries).world;
    let worst = 0;
    NAMED_BONES.forEach((_, i) => {
      const mine = boneWorldMatrix(m, entries, actor, i + 1, world);
      for (let j = 0; j < 16; j++) worst = Math.max(worst, Math.abs(mine[j] - retail[i * 16 + j]));
    });
    assert.ok(worst < tolerance, `slot ${slot} worst ${worst}`);
  }
});
