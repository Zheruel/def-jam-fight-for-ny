// Drive the retail camera with actor positions from the PS2 VBlank recorder.
// Other actor fields come from the initial snapshot, so later animated bone offsets can differ.
import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {instantiateBattle} from "../port/kernel/runtime.mjs";
import {battleCamera} from "../port/battle/camera.mjs";

const fixture = new URL("./native-camera-frames.json",import.meta.url);
if (process.argv[2] === "--extract") {
  const {samples} = JSON.parse(readFileSync(process.argv[3]));
  const rows = samples.map(({actors,camera}) => [
    ...actors.flatMap(a => [...a.position,...a.renderedPosition]), ...camera.eye,...camera.target
  ].map(n => Math.round(n*1e5)/1e5));
  writeFileSync(fixture,"[\n"+rows.map(r=>JSON.stringify(r)).join(",\n")+"\n]\n");
}
const rows = JSON.parse(readFileSync(fixture));
const packed = name => gunzipSync(readFileSync(new URL("../port/kernel/"+name,import.meta.url)));
const kernel = await instantiateBattle(packed("battle.wasm.gz"),{});
const {memory} = kernel, bytes = new Uint8Array(memory.buffer,memory.byteOffset,memory.byteLength);
const seed = packed("foundation-start.gz");
for(let i=0;i<seed.length;i+=4100) bytes.set(seed.subarray(i+4,i+4100),seed.readUInt32LE(i)*4096);
const camera = battleCamera(kernel);
let total = 0, max = 0;
for (const row of rows) {
  for(const [slot,actor] of [0x4bc170,0x4bd468].entries()) {
    for(let i=0;i<3;i++) {
      memory.setFloat32(actor+0x44+4*i,row[slot*6+i],true);
      memory.setFloat32(actor+0xc4+4*i,row[slot*6+3+i],true);
    }
  }
  camera.step();
  const transform = camera.matrix();
  assert.ok(transform.every(Number.isFinite));
  for(const [i,base] of [0x43d610,0x43d620].entries()) {
    const error = Math.hypot(...[0,1,2].map(axis=>memory.getFloat32(base+axis*4,true)-row[12+3*i+axis]));
    total+=error;
    max = Math.max(max,error);
  }
}
const mean = total/(2*rows.length);
console.log(`Compared camera eye and target across ${rows.length} captured frames. Mean error ${mean.toFixed(3)}, maximum ${max.toFixed(3)} game units.`);
assert.ok(mean<0.8 && max<5.5);

// Starting from identical RAM, the knockout impulse moves the final view-projection
// matrix for the 60-frame shake and its decay, then returns to the unshaken camera.
function stationaryCamera(shake) {
  for(let i=0;i<seed.length;i+=4100) bytes.set(seed.subarray(i+4,i+4100),seed.readUInt32LE(i)*4096);
  camera.reset();
  if (shake) kernel.callWithDelta(0x1b05c8,0x4732a4,60,6);
  const samples=[];
  for (let i=0;i<160;i++) {
    camera.step();
    if (i===0 || i===59 || i===159) samples.push(Array.from(camera.matrix()));
  }
  return samples;
}
const calm = stationaryCamera(false), knockout = stationaryCamera(true);
assert.notDeepEqual(knockout[0],calm[0]);
assert.notDeepEqual(knockout[1],calm[1]);
assert.deepEqual(knockout[2],calm[2]);
