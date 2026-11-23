import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createEnvironment } from "./environment.mjs";
import { parseSkinned, placementMatrix } from "./scenery.mjs";

const json = name => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const manifest = json("./V2BG_17A/scenery.json"), names = json("./events.json").names;
const packed = file => { const b = gunzipSync(readFileSync(new URL("./V2BG_17A/" + file, import.meta.url))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const cars = manifest.cars.map(car => ({ car, model: parseSkinned(packed(car.file)) }));

test("Gun Hill has two cars: the left one is V2BG_17A_B, the right V2BG_17A_A, both placed approximately", () => {
  assert.deepEqual(manifest.cars.map(c => c.name), ["V2BG_17A_B", "V2BG_17A_A"]);
  assert.ok(manifest.cars.every(c => c.approximate));
  assert.ok(manifest.cars[0].placement.translate[0] < 0 && manifest.cars[1].placement.translate[0] > 0);
  assert.deepEqual(manifest.undecodedProps.filter(p => /^V2BG_17A_[AB]/.test(p.name)), [], "every car model decodes");
});

test("every panel has its modelled damage states and each state draws something", () => {
  for (const { car, model } of cars) {
    const body = model.mesh.batches.filter(b => b.object === undefined);
    assert.ok(body.length > 0, car.name + " body");
    for (const panel of car.objects) {
      assert.ok(panel.modelled.length >= 1, panel.name);
      for (const state of panel.modelled) {
        const draws = model.mesh.batches.filter(b => b.object === panel.name && b.state === state);
        assert.ok(draws.length > 0, `${panel.name} ${state}`);
        for (const { first, count, shape } of draws) {
          assert.ok(model.mesh.textures[shape], `${panel.name} ${state} texture ${shape}`);
          assert.ok(first + count <= model.mesh.indices);
        }
      }
      // The four-state panels get cumulative damage: later states do not draw fewer triangles than base.
      if (panel.modelled.length === 4) {
        const tris = state => model.mesh.batches.filter(b => b.object === panel.name && b.state === state).reduce((n, b) => n + b.count, 0);
        assert.ok(tris("break3") >= tris("base"), panel.name);
      }
    }
    const indices = new Uint16Array(model.indices.buffer, model.indices.byteOffset, model.mesh.indices);
    assert.ok(indices.every(i => i < model.mesh.vertices));
  }
});

test("every environment attack names a panel and a state the cars can show", () => {
  const panels = new Map(manifest.cars.flatMap(c => c.objects).map(p => [p.name, new Set([...p.states, ...p.hidden])]));
  const used = new Set();
  for (const attack of manifest.environmentAttacks) for (const [, object, state] of attack.geometry) {
    assert.ok(panels.get(object)?.has(state), `${attack.name}: ${object} ${state}`);
    used.add(object);
  }
  assert.equal(used.size, 46, "all 22 + 24 panels are broken by some event");
});

test("events drive the car panels: the left car's rear window cracks through three states", () => {
  const env = createEnvironment(manifest, names);
  for (const [event, state] of [["17A_3A", "break1"], ["17A_3B", "break2"], ["17A_3C", "break3"]]) {
    env.trigger(event);
    assert.equal(env.state().props.V2BG_17A_B_P, state);
  }
  env.trigger("17A_7B");   // the windscreen's second stage hides the inner pieces
  assert.equal(env.state().props.V2BG_17A_B_X, "null");
  env.trigger("17A_21D");  // a window's fourth stage
  assert.equal(env.state().props.V2BG_17A_A_M, "break4");
});

test("cars stand on the floor in front of the garage wall, wheels at y = 0, the left car's flank toward the ring", () => {
  for (const { car, model } of cars) {
    const matrix = placementMatrix(car.placement);
    const vertices = new Float32Array(model.vertices.buffer, model.vertices.byteOffset, model.mesh.vertices * 13);
    let low = Infinity, high = -Infinity, rear = Infinity;
    const xs = [], zs = [];
    for (let i = 0; i < model.mesh.vertices; i++) {
      const [x, y, z] = [vertices[i * 13], vertices[i * 13 + 1], vertices[i * 13 + 2]];
      const wx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12], wz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      low = Math.min(low, y); high = Math.max(high, y); xs.push(wx); zs.push(wz);
    }
    assert.ok(Math.abs(low) < 0.2 && high > 20 && high < 30, `${car.name} y ${low}..${high}`);
    // The cars sit behind the ring edge, left and right of centre, inside the garage floor.
    assert.ok(Math.min(...zs) > -80 && Math.max(...zs) < 5, `${car.name} z ${Math.min(...zs)}..${Math.max(...zs)}`);
    assert.ok(car.name.endsWith("B") ? Math.max(...xs) < 15 : Math.min(...xs) > -15, car.name);
  }
});
