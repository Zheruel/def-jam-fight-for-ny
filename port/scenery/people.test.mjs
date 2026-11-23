import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { parseSkinned } from "./scenery.mjs";
import { bankPose, parseBank, skinPalette, POSE_FLOATS } from "./people.mjs";

const here = new URL("./", import.meta.url);
const buffer = url => {
  const bytes = gunzipSync(readFileSync(url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const index = JSON.parse(readFileSync(new URL("index.json", here), "utf8"));
const bank = parseBank(buffer(new URL("people/poses.bin.gz", here)));
const venues = Object.entries(index).filter(([, entry]) => entry.people);
const manifestOf = (venue, entry) => JSON.parse(readFileSync(new URL(`${entry.dir}/people.json`, here), "utf8"));
const classCache = new Map();
const classOf = id => classCache.get(id) ?? classCache.set(id, parseSkinned(buffer(new URL(`people/classes/${id}.skin.gz`, here)))).get(id);

/** Skinned vertex positions of a class mesh under a palette (row-major inverseBind x world per bone). */
function skin(model, palette) {
  const out = [];
  for (let v = 0; v < model.mesh.vertices; v++) {
    const view = new DataView(model.vertices.buffer, model.vertices.byteOffset + v * 52, 52);
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

test("every venue with retail near-crowd positions has spectators (index.json and the scenery manifest agree)", () => {
  const withCrowd = Object.entries(index).filter(([, e]) => e.nearCrowdPositions > 0).map(([venue]) => venue);
  assert.deepEqual(venues.map(([venue]) => venue), withCrowd);
  for (const [venue, entry] of venues) {
    const scenery = JSON.parse(readFileSync(new URL(`${entry.dir}/scenery.json`, here), "utf8"));
    assert.equal(scenery.people, true, venue);
    assert.equal(manifestOf(venue, entry).spectators.length, entry.people, venue);
  }
});

test("each spectator is a stage position with a class mesh, a recorded track and an atlas per part", () => {
  for (const [venue, entry] of venues) {
    const people = manifestOf(venue, entry);
    const placed = new Map(JSON.parse(readFileSync(new URL(`${entry.dir}/scenery.json`, here), "utf8")).nearCrowd.map(p => [p.name, p]));
    assert.equal(people.classes.length, people.classParts.length, venue);
    for (const s of people.spectators) {
      assert.deepEqual(s.translate, placed.get(s.name).translate, `${venue} ${s.name}`);
      assert.deepEqual(s.rotate, placed.get(s.name).rotate, `${venue} ${s.name}`);
      assert.ok(bank.index.has(s.track), `${venue} ${s.name} track ${s.track}`);
      assert.ok(Number.isInteger(s.phase) && s.phase >= 0, `${venue} ${s.name} phase`);
      assert.ok(!/^(sit|dancer|gym)/.test(s.name.split("_")[1]), `${venue} ${s.name}: seated clips were never recorded`);
      const model = classOf(people.classes[s.class]);
      assert.equal(model.mesh.bones.length, 13);
      for (const { shape } of model.mesh.batches) {
        const file = new URL(`people/outfits/${s.outfit[shape]}.png`, here);
        assert.ok(existsSync(file), `${venue} ${s.name} ${shape}`);
        assert.deepEqual([...readFileSync(file).subarray(1, 4)], [0x50, 0x4e, 0x47]);
      }
    }
  }
});

test("every part's UVs fall inside its cropped atlas, which is a PNG of the cropped size", () => {
  const size = { 1: [256, 256], 3: [256, 256], 2: [128, 128], 4: [128, 128], 6: [128, 128] };
  for (const [venue, entry] of venues) {
    const people = manifestOf(venue, entry);
    for (const s of people.spectators) {
      const model = classOf(people.classes[s.class]);
      for (const { shape, first, count } of model.mesh.batches) {
        const png = readFileSync(new URL(`people/outfits/${s.outfit[shape]}.png`, here));
        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], size[shape[1]], `${venue} ${s.name} ${shape}`);
        const view = new DataView(model.vertices.buffer, model.vertices.byteOffset);
        const indices = new Uint16Array(model.indices.buffer.slice(model.indices.byteOffset, model.indices.byteOffset + model.indices.length));
        for (let i = first; i < first + count; i++) {
          const u = view.getFloat32(indices[i] * 52 + 24, true), v = view.getFloat32(indices[i] * 52 + 28, true);
          assert.ok(u > -0.02 && u < 1.02 && v > -0.02 && v < 1.02, `${shape} uv ${u},${v}`);
        }
      }
    }
  }
});

test("every class stands upright with feet near the ground under every recorded track", () => {
  const used = new Map();
  for (const [venue, entry] of venues) { const people = manifestOf(venue, entry); for (const id of people.classes) used.set(id, true); }
  assert.ok(used.size >= 20);
  for (const id of used.keys()) {
    const model = classOf(id);
    for (let track = 0; track < bank.names.length; track++) {
      const { frames, rate } = bank.tracks[track];
      for (let frame = 0; frame < frames; frame += 61) {
        const ys = skin(model, skinPalette(bankPose(bank, track, frame * rate), model.mesh.bones)).map(p => p[1]);
        const low = Math.min(...ys), high = Math.max(...ys);
        assert.ok(low > -3 && low < 3, `${id} ${bank.names[track]} frame ${frame} feet ${low}`);
        assert.ok(high > 8 && high < 34, `${id} ${bank.names[track]} frame ${frame} top ${high}`);
      }
    }
  }
});

test("the recording is looped: 30 tracks of 1740 ticks whose end meets the start", () => {
  assert.equal(bank.names.length, 30);
  for (let t = 0; t < 30; t++) {
    const { frames, rate } = bank.tracks[t];
    assert.equal(frames * rate, 1740);
    const last = bankPose(bank, t, (frames - 1) * rate), first = bankPose(bank, t, 0), mid = bankPose(bank, t, (frames - 2) * rate);
    // the step across the loop point is no bigger than its neighbours' (no jump)
    const gap = (p, q) => { let sum = 0; for (let i = 0; i < POSE_FLOATS; i += 7) { const dot = p[i] * q[i] + p[i + 1] * q[i + 1] + p[i + 2] * q[i + 2] + p[i + 3] * q[i + 3]; const s = dot < 0 ? -1 : 1; for (let k = 0; k < 4; k++) sum += (p[i + k] - s * q[i + k]) ** 2; } return sum; };
    assert.ok(gap(last, first) < 0.2 && gap(last, first) < 20 * (gap(mid, last) + 1e-4), `track ${t} jumps at the loop point: ${gap(last, first)} vs ${gap(mid, last)}`);
  }
});

test("the bank animates: tracks differ between frames and blend continuously, and loops close", () => {
  const track = bank.index.get([...bank.index.keys()].find(n => n.startsWith("crowd_act1")));
  const { rate } = bank.tracks[track];
  const a = bankPose(bank, track, 0), b = bankPose(bank, track, rate), half = bankPose(bank, track, rate / 2);
  assert.ok(a.some((v, i) => Math.abs(v - b[i]) > 0.01));
  for (let i = 0; i < POSE_FLOATS; i += 7) assert.ok(Math.abs(Math.hypot(half[i], half[i + 1], half[i + 2], half[i + 3]) - 1) < 1e-4);
  const { frames } = bank.tracks[track];
  assert.deepEqual([...bankPose(bank, track, frames * rate)], [...bankPose(bank, track, 0)]);
});
