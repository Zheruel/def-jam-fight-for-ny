// Extract only the pages used by the retail four-character animation sampler.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {gzipSync,gunzipSync} from "node:zlib";
import {instantiateSampler} from "../port/animation/runtime.mjs";
import {installWrestlingBank,installSignatureClips} from "../port/animation/banks.mjs";

const original=readFileSync(process.argv[2]), output=process.argv[3];
assert.equal(original.length,0x2000000);
const unpack=name=>Uint8Array.from(gunzipSync(readFileSync(new URL("../port/animation/"+name,import.meta.url)))).buffer;
const wasm=await WebAssembly.compile(unpack("sampler.wasm.gz"));
const sampler=await instantiateSampler(wasm), oracle=await instantiateSampler(wasm);
sampler.ram.set(original);
oracle.ram.set(original);
const word=a=>original.readUInt32LE(a);
const chars=Array.from({length:4},(_,slot)=>word(0x471230+4*slot));
const ids=chars.map((_,slot)=>word(0x4bc170+slot*0x12f8+0x2c)+1);
const counts=ids.map((id,slot)=>installWrestlingBank(sampler,slot,unpack("banks/wres"+String(id).padStart(3,"0")+".gz")));
for(let slot=0;slot<4;slot++) for(let owner=0;owner<4;owner++) {
  for(let i=0;i<counts[owner];i++) {
    const clip=1000*owner+i,end=sampler.duration(slot,1,clip);
    assert.equal(end,oracle.duration(slot,1,clip));
    assert.deepEqual(sampler.sample(slot,1,clip,end/2),oracle.sample(slot,1,clip,end/2));
    assert.deepEqual(sampler.pose(slot),oracle.pose(slot));
  }
}
for(let clip=0;clip<709;clip++) {
  const slot=clip%4,end=sampler.duration(slot,0,clip);
  assert.ok(end>0 && end<10000);
  for(let t=0;t<end;t++) sampler.sample(slot,0,clip,t);
}
const specials=new Map(Array.from({length:8},(_,i)=>[709+i,unpack("banks/special"+(709+i)+".gz")]));
installSignatureClips(sampler,specials);
for(const clip of specials.keys()) for(let slot=0;slot<4;slot++) sampler.sample(slot,0,clip,1,{blend:0.5,transition:0});
function include(start,size) {sampler.pages.fill(1,start>>>12,Math.ceil((start+size)/4096))}
include(0x471230,16);
for(const ch of chars) {
  include(ch,0xb000);
  for(const offset of [0x17c,0x180,0x184]) include(word(ch+offset),94*48);
}
const pages=[];
for(let i=0;i<original.length/4096;i++) if(sampler.pages[i]) {
  const bytes=original.subarray(i*4096,(i+1)*4096);
  if(!bytes.some(Boolean))continue;
  const tag=Buffer.alloc(4);tag.writeUInt32LE(i);pages.push(tag,bytes);
}
writeFileSync(output,gzipSync(Buffer.concat(pages),{level:9}));
console.log("Checked the retail duration, root and pose on all four targets for each of the four captured fighters' moves.");
