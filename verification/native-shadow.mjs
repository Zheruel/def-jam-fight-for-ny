import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {shadowProjection} from "../port/render/shadow.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};
import foundation from "../port/scenery/foundation/lighting.json" with {type:"json"};

// Original model and flattened matrices at model+0x280 in the retail match.
const bytes=process.argv[2] && readFileSync(process.argv[2]);
for(const [actor,shadow,x,z,side] of [
  [0x445360,0x4457b0,-24.36669921875,0,-1],
  [0x450320,0x450770,22.717927932739258,-0.19083121418952942,1],
]) {
  const source=bytes ? Array.from({length:16},(_,i)=>bytes.readFloatLE(actor+0x280+4*i)) :
    [0,0,side,0,0,1,0,0,-side,0,0,0,x,-0.00006323,z,1];
  const projected=shadowProjection(foundation.settings[0].sets[0],source.slice(12,15),new Float32Array(16),[]);
  const expected=bytes ? Array.from({length:16},(_,i)=>bytes.readFloatLE(shadow+0x280+4*i)) :
    [0,0,79.5*side,0,0,-0.5,0,-1,-79.5*side,0,0,0,side<0?-1937.153:1806.075,40,side<0?0:-15.171,80];
  for(let i=0;i<16;i++) {
    let v=0;for(let j=0;j<4;j++) v+=projected[j*4+i%4]*source[(i&~3)+j];
    assert.ok(Math.abs(v-expected[i])<0.001,`Shadow matrix entry ${i}: ${v} vs ${expected[i]}`);
  }
}
for(const venue of inventory.venues) {
  const name=venue.file==="V2BG_02A"?"foundation":venue.file;
  const data=JSON.parse(readFileSync(new URL(`../port/scenery/${name}/lighting.json`,import.meta.url)));
  for(const {sets} of data.settings) for(const set of sets) {
    if(!set.shadowLights.length) continue;
    for(const position of [[0,0,0],...set.shadowLights]) {
      const matrix=shadowProjection(set,position,new Float32Array(16),new Float32Array(3));
      assert.ok(matrix.every(Number.isFinite));
      const y=19;
      assert.ok(Math.abs((matrix[5]*y+matrix[13])/(matrix[7]*y+matrix[15])-0.5)<1e-5);
    }
  }
}
console.log("Both fighter shadow matrices match the PS2 capture, and every venue projects onto a finite receiver plane.");
