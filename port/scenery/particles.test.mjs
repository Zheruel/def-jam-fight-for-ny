import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { classify, createSimulation, infernoFire, trainLights } from "./particles.mjs";

const here = new URL("./", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", here), "utf8"));
const effectsOf = dir => JSON.parse(readFileSync(new URL(`${dir}/particles.json`, here), "utf8"));

test("all 24 stages ship their JDI effect table and sprite sheet", () => {
  const venues = Object.entries(index).filter(([, entry]) => entry.particles);
  assert.equal(venues.length, 24);
  for (const [, entry] of venues) {
    const manifest = effectsOf(entry.dir);
    assert.equal(manifest.format, "def-jam-ps2-particles/1");
    assert.equal(Object.keys(manifest.effects).length, entry.particles);
    assert.ok(existsSync(new URL(`${entry.dir}/particles.png`, here)));
    for (const effect of Object.values(manifest.effects)) {
      assert.equal(effect.start.length, 4);
      assert.ok(effect.tiles.every(([u, v, size]) => u >= 0 && v >= 0 && size > 0 && u + size <= 1.0001 && v + size <= 1.0001));
    }
  }
});

test("the subway's head and tail light colours are the retail ones (white and red) at the sprite's glow tile", () => {
  const { effects } = effectsOf("V2BG_04A");
  assert.deepEqual(effects.fx_trainF1.start, [247, 255, 251, 229]);
  assert.deepEqual(effects.fx_trainR1.start, [229, 0, 1, 255]);
  assert.deepEqual(effects.fx_trainF1.tiles, [[0, 0, 0.25]]);
});

test("Foundation glass is the fx_bottle effect of its own stage, a breaking-glass sprite pair", () => {
  const { effects } = effectsOf("foundation");
  assert.equal(effects.fx_bottlel.count, 3);
  assert.equal(effects.fx_bottlel.life, 5000);
  assert.equal(effects.fx_bottlel.tiles.length, 2);
  assert.ok(effects.fx_bottlel.rise[0] < 0, "falls");
});

test("effects are classified from their data", () => {
  const { effects } = effectsOf("foundation");
  assert.equal(classify("fx_bottlel", effects.fx_bottlel), "debris");
  assert.equal(classify("fx_plfire1", effectsOf("V2BG_07A").effects.fx_plfire1), "flame");
});

test("the Inferno's fire is full for 7200 clock ticks, then dies out over 4500 (retail 0x2dea90)", () => {
  assert.deepEqual(infernoFire(0), { intensity: 1, radius: 57 });
  assert.equal(infernoFire(7200).intensity, 1);
  const half = infernoFire(7200 + 2250);
  assert.ok(Math.abs(half.intensity - (1 - 2250 * 2.1555e-4)) < 1e-9 && Math.abs(half.radius - (37 + 20 * half.intensity)) < 1e-9);
  assert.ok(infernoFire(20000).intensity < 0.05);
});

test("a burst is deterministic and bounded; the simulation draws the same sprites twice", () => {
  const { effects } = effectsOf("foundation");
  const run = () => {
    const sim = createSimulation(effects, { seed: 3 });
    assert.ok(sim.burst("fx_bottlel", [10, 5, 4]) > 0);
    for (let i = 0; i < 40; i++) sim.step();
    return JSON.stringify(sim.sprites());
  };
  assert.equal(run(), run());
  const sim = createSimulation(effects);
  assert.equal(sim.burst("not_an_effect", [0, 0, 0]), 0);
  for (let i = 0; i < 400; i++) sim.step();
  assert.equal(sim.count, 0, "every sprite dies");
});

test("the fire keeps the sprite count bounded and fades with its intensity", () => {
  const { effects } = effectsOf("V2BG_07A");
  const sim = createSimulation(effects);
  for (let i = 0; i < 600; i++) { sim.fire(infernoFire(i * 1.2)); sim.step(); }
  const full = sim.count;
  assert.ok(full > 100 && full < 3000, String(full));
  for (let i = 0; i < 200; i++) { sim.fire({ intensity: 0, radius: 37 }); sim.step(); }
  assert.equal(sim.count, 0);
});

test("train lights follow the car (world = car matrix x car-local point)", () => {
  const manifest = JSON.parse(readFileSync(new URL("V2BG_04A/scenery.json", here), "utf8"));
  const { effects } = effectsOf("V2BG_04A");
  const car = { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 25, 0, 0, 1]), train: true };
  const lights = trainLights(manifest.subway, effects, car, 0.5);
  assert.equal(lights.length, 4);
  const head = lights.find(l => l.name === "fx_trainF1");
  assert.deepEqual(head.position.map(v => +v.toFixed(2)), [88.7 + 25, 4.08, -72.2]);
  assert.deepEqual(trainLights(manifest.subway, effects, null, 0), [], "no car, no lights");
});
