import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { parseSkinned } from "./scenery.mjs";
import { bankPose, parseBank, skinPalette, POSE_FLOATS } from "./people.mjs";

const dir = new URL("./foundation/people/", import.meta.url);
const buffer = name => {
  const bytes = gunzipSync(readFileSync(new URL(name, dir)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const people = JSON.parse(readFileSync(new URL("people.json", dir), "utf8"));
const bank = parseBank(buffer(people.bank.file));
const classes = people.classes.map(file => parseSkinned(buffer(file)));
const scenery = JSON.parse(readFileSync(new URL("./foundation/scenery.json", import.meta.url), "utf8"));

/** Skinned vertex positions of a class mesh under a palette (row-major inverseBind x world per bone). */
function skin(model, palette) {
  const out = [];
  for (let v = 0; v < model.mesh.vertices; v++) {
    const at = v * 52, view = new DataView(model.vertices.buffer, model.vertices.byteOffset + at, 52);
    const p = [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true)];
    const sum = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const weight = view.getFloat32(36 + 4 * k, true);
      if (!weight) continue;
      const m = view.getUint8(32 + k) * 16;
      for (let a = 0; a < 3; a++) sum[a] += weight * (p[0] * palette[m + a] + p[1] * palette[m + 4 + a] + p[2] * palette[m + 8 + a] + palette[m + 12 + a]);
    }
    out.push(sum);
  }
  return out;
}

test("the people manifest names every spectator the stage places, with a class mesh and a bank pose", () => {
  const placed = new Map(scenery.nearCrowd.map(p => [p.name, p]));
  assert.equal(people.spectators.length, 30);
  assert.deepEqual(bank.names, people.spectators.map(s => s.name));
  for (const s of people.spectators) {
    assert.deepEqual(s.translate, placed.get(s.name).translate);
    assert.ok(classes[s.class], s.name);
    assert.ok(s.scale > 0.5 && s.scale < 1.5, s.name);
  }
  assert.equal(bank.data.length, bank.frames * bank.names.length * POSE_FLOATS);
});

test("class meshes are five-part people on the 13-bone rig; every spectator wears an atlas per part", () => {
  for (const { mesh } of classes) {
    assert.equal(mesh.bones.length, 13);
    assert.deepEqual(mesh.batches.map(b => b.shape), ["M1", "M2", "M4", "M6", "M3"]);
  }
  for (const s of people.spectators) for (const { shape } of classes[s.class].mesh.batches) {
    const png = readFileSync(new URL(`outfits/${s.outfit[shape]}.png`, dir));
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], `${s.name} ${shape}`);
  }
});

test("every spectator stands upright, feet near the ground, in every bank frame", () => {
  for (const spectator of people.spectators) {
    const model = classes[spectator.class];
    for (let frame = 0; frame < bank.frames; frame++) {
      const points = skin(model, skinPalette(bankPose(bank, spectator.index, frame), model.mesh.bones));
      const ys = points.map(p => p[1]);
      assert.ok(Math.min(...ys) > -1.5 && Math.min(...ys) < 1.5, `${spectator.name} feet ${Math.min(...ys)}`);
      assert.ok(Math.max(...ys) > 14 && Math.max(...ys) < 28, `${spectator.name} top ${Math.max(...ys)}`);
    }
  }
});

test("the bank animates: poses differ between frames and blend continuously", () => {
  const a = bankPose(bank, 3, 0), b = bankPose(bank, 3, 1), half = bankPose(bank, 3, 0.5);
  assert.ok(a.some((v, i) => Math.abs(v - b[i]) > 0.01));
  for (let i = 0; i < POSE_FLOATS; i += 7) {
    const length = Math.hypot(half[i], half[i + 1], half[i + 2], half[i + 3]);
    assert.ok(Math.abs(length - 1) < 1e-4);
  }
  // The loop closes: the frame after the last is the first.
  assert.deepEqual([...bankPose(bank, 3, bank.frames)], [...bankPose(bank, 3, 0)]);
});
