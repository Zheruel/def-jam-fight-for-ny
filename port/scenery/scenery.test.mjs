import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { irradiance, sampleIrradiance } from "./irradiance.mjs";
import { crowdFrame, instancePhase, parseCrowd, parseProps, placementMatrix } from "./scenery.mjs";

const readBuffer = url => {
  const bytes = gunzipSync(readFileSync(url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const read = name => {
  const bytes = gunzipSync(readFileSync(new URL(`./foundation/${name}`, import.meta.url)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const manifest = JSON.parse(readFileSync(new URL("./foundation/scenery.json", import.meta.url), "utf8"));

test("Foundation props: every state batch indexes real vertices and a packed texture", () => {
  const { mesh, vertices, indices, textures } = parseProps(read("props.scene.gz"));
  assert.equal(mesh.objects.length, 8);
  assert.equal(vertices.length, mesh.vertices * 24);
  const index = mesh.indexBytes === 2 ? new Uint16Array(indices.buffer.slice(indices.byteOffset, indices.byteOffset + indices.length))
    : new Uint32Array(indices.buffer.slice(indices.byteOffset, indices.byteOffset + indices.length));
  assert.equal(index.length, mesh.indices);
  assert.ok(Math.max(...index) < mesh.vertices);
  for (const object of mesh.objects) for (const state of object.states) {
    assert.ok(state.batches.length > 0, `${object.name}/${state.name}`);
    for (const { shape, first, count } of state.batches) {
      assert.equal(count % 3, 0);
      assert.ok(first + count <= mesh.indices);
      assert.ok(textures.has(shape), `${object.name} shape ${shape}`);
    }
  }
  for (const png of textures.values()) assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(manifest.props.map(p => p.name), mesh.objects.map(o => o.name));
});

test("Foundation crowd: 383 retail frames of 60 variant-tagged instances", () => {
  const { mesh, positions, uv, indices, texture } = parseCrowd(read("crowd.bin.gz"));
  assert.equal(mesh.frames, 383);
  assert.equal(mesh.instances.length, 60);
  assert.equal(positions.length, mesh.frames * mesh.vertices * 3);
  assert.equal(uv.length, mesh.vertices * 2);
  assert.equal(indices.length, mesh.indices);
  assert.ok(Math.max(...indices) < mesh.vertices);
  assert.deepEqual([...texture.slice(1, 4)], [0x50, 0x4e, 0x47]);
  for (const i of mesh.instances) {
    assert.ok([1, 2, 3, 4].includes(i.variant), i.name);
    assert.equal(i.name, `${i.group}_${i.row}_${i.variant}`);
  }
  // Frames 0, 1, 241, 242 and 382 are the shared rest pose, so loops hand over cleanly.
  const stride = mesh.vertices * 3;
  const frame = f => positions.subarray(f * stride, (f + 1) * stride);
  for (const f of mesh.loops.rest) assert.deepEqual(frame(f), frame(0));
});

test("crowd frame selection stays inside the active retail loop", () => {
  const loops = { idle: [0, 240], excited: [243, 383] };
  for (let tick = 0; tick < 1000; tick += 7) for (let n = 0; n < 60; n++) {
    const idle = crowdFrame(loops, false, tick, n), excited = crowdFrame(loops, true, tick, n);
    assert.ok(idle >= 0 && idle < 240 && excited >= 243 && excited < 383);
  }
  assert.equal(instancePhase(0), 0);
});

test("placement matrix is column-major with translation last", () => {
  const m = placementMatrix({ translate: [1, 2, 3], rotate: [0, 90, 0] });
  assert.deepEqual([...m.slice(12, 15)], [1, 2, 3]);
  assert.ok(Math.abs(m[0]) < 1e-6 && Math.abs(m[2] + 1) < 1e-6 && Math.abs(m[8] - 1) < 1e-6);
});

test("every Battle venue has an index entry, valid props and a crowd layout where the retail data has one", () => {
  const dir = new URL("./", import.meta.url);
  const index = JSON.parse(readFileSync(new URL("index.json", dir), "utf8"));
  const inventory = JSON.parse(readFileSync(new URL("../../ps2/content/inventory.json", dir), "utf8"));
  assert.deepEqual(Object.keys(index).sort(), inventory.venues.map(v => v.file).sort());
  const shared = parseCrowd(readBuffer(new URL("crowd/icrowd01.crowd.gz", dir)));
  let crowdVenues = 0;
  for (const [venue, entry] of Object.entries(index)) {
    const where = new URL(`${entry.dir}/`, dir);
    const manifest = JSON.parse(readFileSync(new URL("scenery.json", where), "utf8"));
    assert.equal(manifest.venue, venue);
    assert.deepEqual(manifest.props.map(p => p.name), entry.props, venue);
    if (manifest.propsFile) {
      const { mesh, textures } = parseProps(readBuffer(new URL(manifest.propsFile, where)));
      assert.deepEqual(mesh.objects.map(o => o.name), entry.props, venue);
      for (const o of mesh.objects) for (const st of o.states) for (const b of st.batches)
        assert.ok(textures.has(b.shape) && b.first + b.count <= mesh.indices, `${venue} ${o.name}`);
    } else assert.equal(entry.props.length, 0, venue);
    const crowd = manifest.instancedCrowd;
    assert.equal(crowd ? crowd.instances : 0, entry.crowdInstances, venue);
    if (crowd && venue !== "V2BG_02A") {
      crowdVenues++;
      assert.equal(crowd.placements.length, crowd.instances);
      for (const i of crowd.placements) {
        assert.ok(i.variant >= 1 && i.variant <= 5 && Number.isFinite(i.yawDegrees), `${venue} ${i.name}`);
        assert.equal(i.translate.length, 3);
      }
    }
  }
  assert.equal(shared.mesh.frames, 383);
  assert.equal(crowdVenues, 10);
});

test("irradiance lighting: every venue setting has two coherent light sets and the sampler blends them", () => {
  const dir = new URL("./", import.meta.url);
  const index = JSON.parse(readFileSync(new URL("index.json", dir), "utf8"));
  let settings = 0;
  for (const [venue, entry] of Object.entries(index)) {
    const { settings: list } = JSON.parse(readFileSync(new URL(`${entry.dir}/lighting.json`, dir), "utf8"));
    assert.deepEqual(list.map(x => x.name), entry.lighting, venue);
    for (const { sets } of list) {
      settings++;
      assert.equal(sets.length, 2, venue);
      for (const set of sets) {
        assert.equal(set.matrices.length, set.spheres.length);
        assert.equal(set.intensity.length, set.spheres.length);
        for (const m of set.matrices) assert.equal(m.length, 10);
        assert.ok(set.intensityMultiplier > 0 && set.lane.length === 10, venue);
      }
    }
  }
  assert.equal(settings, 88);
  const { settings: foundation } = JSON.parse(readFileSync(new URL("foundation/lighting.json", dir), "utf8"));
  const set = foundation[0].sets[0];
  // On a probe the blend is dominated by that probe; far away it is the normalised average.
  const [x, y, z] = set.spheres[0];
  const near = sampleIrradiance(set, [x + 1e-3, y, z]);
  assert.ok(Math.abs(near[0] - set.intensityMultiplier * set.matrices[0][0][0]) < 0.05);
  const up = irradiance(sampleIrradiance(set, [0, 10, 0]), [0, 1, 0]);
  const down = irradiance(sampleIrradiance(set, [0, 10, 0]), [0, -1, 0]);
  assert.ok(up[0] > down[0], "the Foundation is lit from above");
});
