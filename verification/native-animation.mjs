// Build the shared animation seed or check every original WRES bank in both slots.
import fs from "node:fs";
import { gzipSync,gunzipSync } from "node:zlib";
import { strict as assert } from "node:assert";
import { instantiateSampler } from "../port/animation/runtime.mjs";
import { installWrestlingBank } from "../port/animation/banks.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};
const read = file=>fs.readFileSync(new URL(file,import.meta.url));
const unzip = file=>Uint8Array.from(gunzipSync(read(file))).buffer;
const sampler=await instantiateSampler(unzip("../port/animation/sampler.wasm.gz"));
const seedMode=process.argv[2]==="--seed";
const original=seedMode ? fs.readFileSync(process.argv[3]) : null;
const shared=seedMode ? null : new Uint8Array(unzip("../port/animation/shared.gz"));
function restore() {
  sampler.ram.fill(0);
  sampler.resetScratch();
  if(original) sampler.ram.set(original);
  else {
    const view=new DataView(shared.buffer);
    for(let i=0;i<shared.length;i+=4100) sampler.ram.set(shared.subarray(i+4,i+4100),view.getUint32(i,true)*4096);
  }
}
restore();
const bank=n=>unzip(`../port/animation/banks/wres${String(n).padStart(3,"0")}.gz`);
const originalPair=[5,10];
function frame(slot,type,id,t) {
  const root=sampler.sample(slot,type,id,t);
  assert(root.every(Number.isFinite));
  const pose=sampler.pose(slot);
  assert(pose.every(Number.isFinite));
  return new Uint8Array(new Float32Array([...root,...pose]).buffer);
}
if(seedMode) {
  const other=await instantiateSampler(unzip("../port/animation/sampler.wasm.gz"));
  other.ram.set(original);
  for(const [slot,id] of originalPair.entries()) {
    const count=installWrestlingBank(sampler,slot,bank(id));
    for(let i=0;i<count;i++) {
      const local=slot*1000+i, duration=sampler.duration(slot,1,local);
      assert.equal(duration,other.duration(slot,1,local));
      for(const t of [0,duration/2,duration-1]) {
        const expected=other.sample(slot,1,local,t);
        const actual=sampler.sample(slot,1,local,t);
        assert.deepEqual(actual,expected,`Root, bank ${id} clip ${i} at ${t}`);
        assert.deepEqual(sampler.pose(slot),other.pose(slot),`Pose, bank ${id} clip ${i} at ${t}`);
      }
    }
  }
}
if(process.env.TRACE_MOTION_BANK) console.log("BASE00");
for(let i=0;i<709;i++) {
  const slot=i%2, end=sampler.duration(slot,0,i);
  assert(end>0 && end<10000,`BASE00/${i} duration ${end}`);
  frame(slot,0,i,end/2);
}
let clips=0;
for(const id of new Set(inventory.fighters.map(record=>record.fighterXml.coreID))) {
  restore();
  const payload=bank(id);
  if(process.env.TRACE_MOTION_BANK) console.log("WRES",id);
  for(const slot of [0,1]) {
    const count=installWrestlingBank(sampler,slot,payload);
    for(let i=0;i<count;i++) {
      const local=slot*1000+i, end=sampler.duration(slot,1,local);
      assert(end>0 && end<10000,`WRES${id}/${local} duration ${end}`);
      frame(slot,1,local,end/2);
      clips++;
    }
  }
}
if(seedMode) {
  const pages=sampler.pages;
  // Entire shared BASE00 resource, including variable-length compressed streams and lookup tables.
  for(let i=0x1273000;i<0x14cd000;i+=4096) pages[i>>>12]=1;
  // Fallback and blend poses and the actor headers used by host-side slot lookup.
  for(let slot=0;slot<2;slot++){
    const char=original.readUInt32LE(0x471230+4*slot);
    for(let i=(char&~4095);i<=char+0xb000;i+=4096) pages[i>>>12]=1;
    for(const off of [0x17c,0x180,0x184]){
      const ptr=original.readUInt32LE(char+off);
      for(let i=(ptr&~4095);i<ptr+94*48;i+=4096) pages[i>>>12]=1;
    }
  }
  const records=[];
  for(let i=0;i<original.length/4096;i++) {
    if(!pages[i]) continue;
    const page=original.subarray(i*4096,(i+1)*4096);
    if(!page.some(Boolean)) continue;
    const record=Buffer.alloc(4100);record.writeUInt32LE(i);page.copy(record,4);records.push(record);
  }
  fs.writeFileSync(new URL("../port/animation/shared.gz",import.meta.url),gzipSync(Buffer.concat(records),{level:9}));
}
console.log(`Verified 709 common clips and ${clips} fighter clip/slot combinations.`);
