import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { covered, frameAt, RATE, strips } from "./texanim.mjs";

const here = new URL("./", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", here), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("V2BG_07A/texanim.json", here), "utf8"));

test("Red Hook ships its 68 flame planes and the 33-frame sheet, and nobody else does", () => {
  assert.deepEqual(Object.entries(index).filter(([, v]) => v.texanim).map(([k, v]) => [k, v.texanim]), [["V2BG_07A", 68]]);
  assert.ok(existsSync(new URL("V2BG_07A/texanim.png", here)));
  assert.equal(manifest.planes.length, 68);
  assert.deepEqual(manifest.atlas, { file: "texanim.png", tile: 128, grid: 6, frames: 33 });
});

test("the sequence table: torches are the 16 torc frames, flames the 16 flam frames, rotated; the coal is one frame", () => {
  const { sequences } = manifest;
  assert.deepEqual(sequences.torch0, [...Array(16).keys()]);
  assert.deepEqual(sequences.flame0, [...Array(16).keys()].map(i => 16 + i));
  assert.deepEqual(sequences.torch2.slice(0, 3), [2, 3, 4]);
  assert.deepEqual(sequences.flame1.slice(0, 3), [19, 20, 21]);
  assert.deepEqual(sequences.flame3.slice(0, 6), [27, 28, 29, 30, 31, 16]);
  assert.deepEqual(sequences.ta_coal, [32]);
  for (const plane of manifest.planes) assert.ok(sequences[plane.sequence], plane.sequence);
});

test("the planes keep the retail world positions: a ring of flames at radius 47-58 around the arena", () => {
  const first = manifest.planes[0];
  assert.deepEqual(first.vertices[0], [-30.056, 22.489, -27.021]);   // wall torch (retail packet)
  assert.equal(first.sequence, "torch0");
  const flames = manifest.planes.filter(p => p.sequence.startsWith("flame"));
  assert.equal(flames.length, 48);
  for (const plane of flames.filter(p => p.vertices[0][2] > -60 && Math.abs(p.vertices[0][0]) < 60 && p.vertices[0][1] < 3)) {
    const r = Math.hypot(plane.vertices[0][0], plane.vertices[0][2]);
    assert.ok(r > 36 && r < 60, `${plane.sequence} ring radius ${r}`);
  }
  for (const plane of manifest.planes) assert.equal(plane.scale, 0.849);
});

test("a plane's vertices are strips; the coal wedges split where their radial pairs jump", () => {
  assert.equal(strips(manifest.planes[13].vertices).length, 1);
  const coal = manifest.planes[63];
  const parts = strips(coal.vertices);
  assert.ok(parts.length > 1 && parts.every(s => s.length >= 4 && s.length % 2 === 0), parts.map(s => s.length).join());
});

test("frames advance one per RATE ticks and loop; the fire covers only what its radius has not left behind", () => {
  const frames = manifest.sequences.flame0;
  assert.equal(frameAt(frames, 0), 16);
  assert.equal(frameAt(frames, RATE - 1), 16);
  assert.equal(frameAt(frames, RATE), 17);
  assert.equal(frameAt(frames, RATE * 16), 16);
  assert.equal(covered(50, null), 1);
  assert.equal(covered(50, { radius: 57 }), 1);
  assert.equal(covered(60, { radius: 57 }), 1);
  assert.equal(covered(70, { radius: 57 }), 0);
  assert.ok(covered(60, { radius: 55 }) > 0 && covered(60, { radius: 55 }) < 1);
});
