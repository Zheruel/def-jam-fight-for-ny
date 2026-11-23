import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decodeCollision, contactPlane } from "./contact.mjs";

const dir = new URL("./venues/", import.meta.url);
const names = readdirSync(dir).filter(name => name.endsWith(".cli"));
const fixtures = names.map(name => {
  const bytes = readFileSync(new URL(name, dir));
  const planes = decodeCollision(Uint8Array.from(bytes).buffer);
  return {name, planes, bytes};
});

test("all Battle venues contain their own contact surfaces", () => {
  assert.equal(names.length, 24);
  for (const {planes} of fixtures) {
    assert.ok(planes.length > 0);
    assert.ok(planes.some(plane => plane.normal[1] > 0.75));
    for (const p of planes) assert.ok(p.vertices.length >= 3 && Number.isFinite(p.area));
  }
});

test("inside, outside and corner contacts match the original PS2 query", {
  skip: !process.env.DEFJAM_RETAIL_ELF && "Requires a verified local game executable",
}, () => {
  const cases = [], actual = [], labels = [];
  for (const {name, planes, bytes} of fixtures) {
    const off = bytes.length - planes.length * 72;
    for (const [index, plane] of planes.entries()) {
      const center = [0,1,2].map(i => plane.vertices.reduce((v,p) => v + p[i], 0) / plane.vertices.length);
      const vertex = plane.vertices[0];
      const points = [center, vertex, center.map((v,i) => v + 0.4*plane.normal[i]),
        center.map((v,i) => v - 10*plane.normal[i]), vertex.map((v,i) => v + 0.7*(v-center[i])),
        vertex.map((v,i) => v + 0.02*(v-center[i]) + 0.6*plane.normal[i])];
      for (const position of points) {
        const p = position.map(Math.fround);
        cases.push([bytes.subarray(off+index*72,off+(index+1)*72).toString("hex"),p,1,2]);
        actual.push(contactPlane(plane,p,1,2));
        labels.push(name + " plane " + index + " at " + p);
      }
    }
  }
  const run = spawnSync(process.env.DEFJAM_UNICORN_PYTHON ?? "python3",
    [fileURLToPath(new URL("./retail-oracle.py", import.meta.url)),process.env.DEFJAM_RETAIL_ELF],
    {input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 8 * 1024 * 1024});
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  assert.deepEqual(new Set(expected.map(contact => contact?.type ?? 0)), new Set([0,1,2,3]));
  assert.equal(expected.length, actual.length);
  expected.forEach((value, i) => assert.deepEqual(actual[i],value, labels[i]));
});
