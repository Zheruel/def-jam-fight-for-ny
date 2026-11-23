// node --test port/fighters/motion.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionBank } from "./motion.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const motions = (name) => join(here, "motions", `fixture-${name}.`);
const rig = (who) => JSON.parse(readFileSync(motions(`rig-${who}`) + "json", "utf8"));
function load(name, who) {
  const bin = readFileSync(motions(name) + "bin");
  return new MotionBank(JSON.parse(readFileSync(motions(name) + "json", "utf8")), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), rig(who));
}
const base = { blaze: load("base00", "blaze"), doc: load("base00", "doc") };
const wres = { blaze: load("wres005-blaze", "blaze"), doc: load("wres010-doc", "doc") };

test("clip ends are the retail 0x132c60 durations", () => {
  const ends = (b) => Object.fromEntries(b.index.clips.map((c) => [c.local, c.end]));
  assert.deepEqual(ends(base.blaze), { 11: 67, 16: 65, 62: 29, 66: 12, 69: 35, 72: 21, 328: 25, 334: 25 });
  assert.deepEqual(ends(wres.blaze), { 67: 39 });
  assert.deepEqual(ends(wres.doc), { 1069: 54 });
});

test("shared clips pose each fighter with its own rest translations", () => {
  const a = new Float32Array(94 * 12), b = new Float32Array(94 * 12);
  base.blaze.sample(16, 10, a);
  base.doc.sample(16, 10, b);
  const r = { blaze: rig("blaze").defaultTranslations, doc: rig("doc").defaultTranslations };
  for (const k of [68, 69, 72, 73, 75, 78]) {
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(a[k * 12 + 8 + i] - r.blaze[k][i]) < 1e-4);
      assert.ok(Math.abs(b[k * 12 + 8 + i] - r.doc[k][i]) < 1e-4);
    }
  }
});

test("sampling is synchronous, holds outside the clip and loops on request", () => {
  const out = new Float32Array(94 * 12);
  const end = base.blaze.sample(11, 67, out);
  const first = out.slice();
  base.blaze.sample(11, 500, out);
  assert.deepEqual(out, first);
  const looped = base.blaze.sample(11, 67 + 5, new Float32Array(94 * 12), { loop: true });
  assert.ok(looped && end);
});

const runs = join(here, "../../private/verification/ps2-match");
test("idle clips match the recorded retail poses", { skip: !existsSync(join(runs, "run-xo8asY/combat-trace.json")) }, () => {
  const trace = JSON.parse(readFileSync(join(runs, "run-xo8asY/combat-trace.json"), "utf8"));
  const best = new Map();
  const out = new Float32Array(94 * 12);
  for (const s of trace.samples) for (const a of s.actors) {
    if (a.blendCounters[0] !== 0 || a.bank !== 0 || a.local !== (a.slot ? 16 : 11)) continue;
    (a.slot ? base.doc : base.blaze).sample(a.local, a.frame, out);
    const raw = Buffer.from(a.pose, "base64");
    const ref = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + 94 * 48));
    let err = 0;
    for (let k = 0; k < 94; k++) {
      if ((a.slot ? base.doc : base.blaze).held.has(k) || k === 13 || k === 58) continue;
      const sg = Math.sign(out[k * 12 + 4] * ref[k * 12 + 4] + out[k * 12 + 5] * ref[k * 12 + 5] + out[k * 12 + 6] * ref[k * 12 + 6] + out[k * 12 + 7] * ref[k * 12 + 7]) || 1;
      for (let j = 4; j < 11; j++) err = Math.max(err, Math.abs(out[k * 12 + j] - (j < 8 ? sg : 1) * ref[k * 12 + j]));
    }
    const key = `${a.slot}/${a.frame}`;
    best.set(key, Math.min(best.get(key) ?? 9, err));
  }
  assert.ok(best.size > 100);
  for (const [key, err] of best) assert.ok(err < 0.01, `${key} ${err}`);
});

test("strike quaternions keep the engine's raw (non-unit) lerp", { skip: !existsSync(join(runs, "run-xo8asY/combat-trace.json")) }, () => {
  // Retail composes bone matrices from the unnormalised quaternions (0x132a28 world matrices); clip 67 bone 18 dips to |q| ~ 0.89.
  const out = new Float32Array(94 * 12);
  let lowest = 9;
  for (let t = 0; t <= 39; t += 0.5) {
    wres.blaze.sample(67, t, out);
    lowest = Math.min(lowest, Math.hypot(out[18 * 12 + 4], out[18 * 12 + 5], out[18 * 12 + 6], out[18 * 12 + 7]));
  }
  assert.ok(lowest < 0.95 && lowest > 0.8, `lowest |q| ${lowest}`);
});
