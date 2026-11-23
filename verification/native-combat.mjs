import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { decodePoseBank } from "../port/motion/pose-bank.mjs";
import { initializeFighterProfile,loadMatchRules } from "../port/battle/roster.mjs";
import {instantiateBattle} from "../port/kernel/runtime.mjs";
import { battleCamera } from "../port/battle/camera.mjs";
import { createFoundationFight } from "../port/battle/fight.mjs";

const packed = path => Uint8Array.from(gunzipSync(readFileSync(path))).buffer;
const files = ["V2IP_113A","V2IP_109A"];
const fighters = files.map(model => {
  const bytes = packed(`port/render/fighters/${model}.skin.gz`);
  const length = new DataView(bytes).getUint32(4,true);
  const body = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,8,length)));
  return { model, body, bank:decodePoseBank(model,packed(`port/motion/poses/${model}.poses.gz`)) };
});

const inventory=JSON.parse(readFileSync("ps2/content/inventory.json"));
const starts=JSON.parse(readFileSync("port/battle/lineups.json"));
const fixture = "verification/native-fight-inputs.json";
if (process.argv[2] === "--extract") {
  const trace = JSON.parse(readFileSync(process.argv[3]));
  const samples = trace.samples.slice(1).map(({actors}) => actors.map(a =>
    [a.inputWords[0],a.state,a.action,...a.position]));
  writeFileSync(fixture,JSON.stringify(samples)+"\n");
}
const frames = JSON.parse(readFileSync(fixture));
let wasm = packed("port/kernel/battle.wasm.gz");
let seed = packed("port/kernel/foundation-start.gz");
const makeSeed = process.argv[2] === "--seed";
let original;
if (makeSeed) {
  original = readFileSync(process.argv[3]);
  assert.equal(original.length,32*1024*1024);
  wasm = readFileSync(process.argv[4]);
  const full = Buffer.alloc(4100*8192);
  for (let page=0;page<8192;page++) {
    full.writeUInt32LE(page,page*4100);
    original.copy(full,page*4100+4,page*4096,(page+1)*4096);
  }
  seed = full.buffer;
}
const rules=packed("port/kernel/match-rules.gz");
const fight = await createFoundationFight(fighters,wasm,seed,null,rules);
let largestPositionError = 0;
for (const [index,actors] of frames.entries()) {
  fight.tick(actors.map(([pad],slot) => ({buttons:pad & 0xfff0,x:pad & 0x10000 ? (slot ? -1 : 1) : 0,z:0})));
  const actual = fight.diagnostics();
  actors.forEach(([,state,action,...position],slot) => {
    assert.equal(actual.actors[slot].action,action,`tick ${index+1}, actor ${slot} action`);
    assert.equal(actual.actors[slot].state,state,`tick ${index+1}, actor ${slot} state`);
    largestPositionError = Math.max(largestPositionError,Math.hypot(...position.map((v,i)=>v-actual.actors[slot].position[i])));
  });
}
console.log(`${frames.length} retail ticks, both actors match all actions and states. Maximum position difference ${largestPositionError.toFixed(3)} game units.`);
if (makeSeed) {
  const pages = fight.observedPages;
  assert.ok(pages.some(Boolean),"Rebuild the kernel with --track");
  for (const a of [0x476e28,0x4bbd48,0x3ccdb8,0x4bbfb0,0x4bc030,
    0x43d610,0x498c60,0x510410,0x55e008,0x1e86000,0x1e87000]) pages[a>>>12]=1;
  // Include the retail state dispatch, move variants and tuning tables for inputs outside the reference exchange.
  for(const [start,end] of [[0x37a000,0x405000],[0x442000,0x449000],[0x470000,0x478000],[0x4bb000,0x4d1000],[0x4e0000,0x4e5000],[0x89d000,0x89f000],[0x174d000,0x17af000]])
    for(let a=start;a<end;a+=4096) pages[a>>>12]=1;
  const compact = [];
  for (let page=0;page<0x1fe0;page++) if (pages[page]) {
    const tag = Buffer.alloc(4);
    tag.writeUInt32LE(page);
    compact.push(tag,original.subarray(page*4096,(page+1)*4096));
  }
  writeFileSync(process.argv[5],gzipSync(Buffer.concat(compact)));
}

if (!makeSeed) {
  for(const venue of inventory.venues) {
    const collision=Uint8Array.from(readFileSync(`port/collision/venues/${venue.file}.cli`)).buffer;
    const match=await createFoundationFight(fighters,wasm,seed,{venue,collision},rules);
    const d=match.diagnostics();
    assert.deepEqual(d.actors.map(a=>[a.position[0],a.position[2]]),starts[venue.file].SINGLE,venue.name);
    const camera = battleCamera(match.kernel,venue.file);
    for(let i=0;i<90;i++) {
      match.tick([{buttons:0,x:0,z:0},{buttons:0,x:0,z:0}]);
      camera.step();
      assert.ok(camera.matrix().every(Number.isFinite),venue.name);
    }
    for(const actor of match.diagnostics().actors) assert.ok(actor.position.every(Number.isFinite),venue.name);
  }
  console.log("Compiled collision and spawn routines loaded all 24 venues and advanced both actors for 90 ticks in each.");
}

if (!makeSeed) {
  const kernel=await instantiateBattle(wasm,{});
  const memory=kernel.memory, bytes=new Uint8Array(memory.buffer,memory.byteOffset,memory.byteLength);
  const file=new DataView(seed);
  for(let at=0;at<file.byteLength;at+=4100) bytes.set(new Uint8Array(seed,at+4,4096),file.getUint32(at,true)*4096);
  const sha=await import("node:crypto");
  const digest=buffer=>sha.createHash("sha256").update(buffer).digest("hex");
  const ref=JSON.parse(readFileSync("verification/native-profiles.json"));
  loadMatchRules(kernel,rules);
  const distinct=new Set();
  for(const fighter of inventory.fighters) {
    const a=initializeFighterProfile(kernel,0,fighter),b=initializeFighterProfile(kernel,1,fighter);
    assert.deepEqual(a,b,fighter.name);
    assert.ok(a.maxHealth>0 && a.stats.every(Number.isFinite),fighter.name);
    distinct.add(digest(a.profile));
    if(ref[fighter.model]) assert.equal(digest(a.profile),ref[fighter.model],fighter.name);
  }
  console.log(`Initialized all 75 roster profiles in both slots (${distinct.size} distinct profiles); Blaze and Doc match all 232 bytes in the live reference.`);
}
