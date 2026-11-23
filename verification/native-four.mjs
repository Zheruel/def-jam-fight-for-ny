// Exercise the same four-character match loader and sampler used by the browser.
// --seed FIRST_FIGHT_FRAME TRACKED_WASM OUTPUT rebuilds the native match start.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {gunzipSync,gzipSync} from "node:zlib";
import {createFoundationFight,signatureClipIds} from "../port/battle/fight.mjs";
import {createMatchAnimation} from "../port/animation/match.mjs";
import {installArena} from "../port/battle/arena.mjs";
import {createVoicePlayer} from "../port/audio/voice.mjs";
import {battleCamera} from "../port/battle/camera.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};
import lineups from "../port/battle/lineups.json" with {type:"json"};

const unpack=name=>Uint8Array.from(gunzipSync(readFileSync(new URL("../port/"+name,import.meta.url)))).buffer;
const actor=slot=>0x4bc170+slot*0x12f8;
const make=process.argv[2]==="--seed";
let seed,original;
function records(bytes,pages) {
  const records=[];
  for(let i=0;i<8192;i++) if(!pages || pages[i]) {
    const tag=Buffer.alloc(4);tag.writeUInt32LE(i);records.push(tag,bytes.subarray(i*4096,(i+1)*4096));
  }
  return Uint8Array.from(Buffer.concat(records)).buffer;
}
if(make) {
  original=readFileSync(process.argv[3]);
  assert.equal(original.length,0x2000000);
  assert.equal(original.readUInt32LE(0x4bbd2c),0x80007);
  assert.equal(original.readUInt32LE(0x4bbf98),1);
  assert.equal(original.readUInt32LE(0x4bc14c),2);
  assert.equal(original.readUInt32LE(0x4bc13c),0);
  for(let slot=0;slot<4;slot++) {
    assert.equal(original.readUInt32LE(actor(slot)+0x28),slot);
    // Player type 0 is human. Retail 0x2eda64 mirrors CPU type into actor flag bit 0.
    original.writeUInt32LE(0,0x4bbd38+slot*4);
    original[actor(slot)+0x937]&=0xfe;
  }
  seed=records(original);
} else seed=unpack("kernel/four-start.gz");
const wasm=await WebAssembly.compile(make?readFileSync(process.argv[4]):unpack("kernel/battle.wasm.gz"));
const sampler=await WebAssembly.compile(unpack("animation/sampler.wasm.gz"));
const ids=[5,10,11,16],rules=unpack("kernel/match-rules.gz");
const fighters=ids.map(id=>{
  const record=inventory.fighters.find(f=>f.fighterXml.coreID===id);
  const binary=unpack("render/fighters/"+record.model+".skin.gz");
  const length=new DataView(binary).getUint32(4,true);
  const body=JSON.parse(new TextDecoder().decode(new Uint8Array(binary,8,length)));
  return {record,body,model:record.model};
});
const animation=await createMatchAnimation(sampler,unpack("animation/four-shared.gz"),ids.map(id=>unpack("animation/banks/wres"+String(id).padStart(3,"0")+".gz")));
const fight=await createFoundationFight(fighters,wasm,seed,null,rules,animation);
animation.setSignatures(new Map(signatureClipIds(fight.memory,4).map(id=>[id,unpack("animation/banks/special"+id+".gz")])));
const voiceIndex=JSON.parse(readFileSync(new URL("../port/audio/voice/index.json",import.meta.url)));
const mix=JSON.parse(readFileSync(new URL("../port/audio/mix.json",import.meta.url)));
const played=[];
fight.setVoicePlayer(createVoicePlayer(voiceIndex,mix,{async track(file,options){played.push({file,options});}}));
const camera=battleCamera(fight.kernel,"V2BG_02A");
const pads=()=>fighters.map(()=>({buttons:0,x:0,z:0}));
const start=fight.diagnostics().actors.map(a=>[a.position[0],a.position[2]]);
assert.deepEqual(start,lineups.V2BG_02A["FREE FOR ALL 4"]);
for(let i=0;i<4;i++){
  fight.restart();
  const input=pads();input[i].x=0.8;
  for(let j=0;j<30;j++)fight.tick(input);
  fight.diagnostics().actors.forEach((a,k)=>{
    const d=Math.hypot(a.position[0]-start[k][0],a.position[2]-start[k][1]);
    if(k===i)assert.ok(d>1,"Player "+(i+1)+" can move");
    else assert.ok(d<0.1,"Neutral player "+(k+1)+" stays still");
  });
}
fight.restart();
const touched=new Set(),angles=[0,Math.PI,0,Math.PI],inputs=pads();
for(let t=0;t<18000;t++) {
  const actors=fight.diagnostics().actors;
  actors.forEach((a,i)=>{
    const dest=actors.filter((b,j)=>j!==i && !(fight.memory.getUint16(actor(j)+0x932,true)&0x200)).sort((b,c)=>dist(b)-dist(c))[0];
    function dist(b){return Math.hypot(b.position[0]-a.position[0],b.position[2]-a.position[2]);}
    if(dest)angles[i]=Math.atan2(dest.position[2]-a.position[2],dest.position[0]-a.position[0]);
    inputs[i]={buttons:t%27<11?[0x1000,0x2000,0x4000,0x8000][(i+Math.floor(t/27))%4]:0,
      x:Math.cos(angles[i]),z:Math.sin(angles[i])};
    if(a.score)touched.add(i);
    assert.ok(a.position.every(Number.isFinite));
  });
  try {fight.tick(inputs);camera.step()} catch(error) {throw new Error("Four-way tick "+t,{cause:error})}
  if(fight.outcome().over)break;
  if(played.length && touched.size===4)break;
}
assert.ok(camera.matrix().every(Number.isFinite));
assert.equal(touched.size,4,"All four fighters scored");
assert.ok(played.length>0,"Retail SND requested a playable voice line");
assert.ok(played.every(({file,options})=>file.startsWith("voice/") && options.duration>0 && Number.isFinite(options.gain)));
console.log("Speech requests",played.length,fight.diagnostics().voice.last);
console.log("Four independent controllers, four scoring fighters, and a finite retail camera.");
fight.rematch();
const strikes=[0x1000,0x4000,0x2000,0x8000,0x1100,0x1400,0x1800,0x1200,0x4400,0x8100,0x400,0x800];
let random=17, held=pads().map(()=>0);
for(let tick=0;tick<36000 && !fight.outcome().over;tick++) {
  const {actors}=fight.diagnostics();
  if(tick%18===0)held=held.map(()=>{
    random=(Math.imul(random,1664525)+1013904223)>>>0;
    return strikes[random%strikes.length];
  });
  fight.tick(actors.map((a,i)=>{
    const available=actors.map((other,j)=>({other,j})).filter(({j})=>
      j!==i && !(fight.memory.getUint16(actor(j)+0x932,true)&0x200));
    const distance=b=>Math.hypot(b.position[0]-a.position[0],b.position[2]-a.position[2]);
    available.sort((b,c)=>distance(b.other)-distance(c.other));
    const target=available[0]?.other;
    if(!target)return {buttons:0,x:0,z:0};
    const d=distance(target),dx=target.position[0]-a.position[0],dz=target.position[2]-a.position[2];
    return {buttons:d>10?0x2000:tick%18<4?held[i]:0,
      x:d>7?dx/d:0,z:d>7?-dz/d:0};
  }));
}
assert.equal(fight.outcome().method,"ko","Full-health four-way match reaches a knockout");
assert.ok(fight.outcome().winner!==null);
console.log("Full-health Free For All",fight.outcome(),fight.diagnostics().actors.map(a=>[a.score,a.health]));
fight.rematch();
fight.memory.setUint32(0x4bbd30,9,true);
for(let t=0;t<900&&!fight.outcome().result;t++)fight.tick(pads());
assert.equal(fight.outcome().method,"time");
assert.equal(fight.outcome().draw,true);
console.log("Four-way time limit reached a draw and all four fighters restarted.");
for(const venue of inventory.venues) {
  const positions=lineups[venue.file]["FREE FOR ALL 4"];
  if(!positions)continue;
  fight.restart();
  const file=readFileSync(new URL("../port/collision/venues/"+venue.file+".cli",import.meta.url));
  installArena(fight.kernel,{venue,collision:Uint8Array.from(file).buffer},fighters.map((_,i)=>actor(i)));
  assert.deepEqual(fight.diagnostics().actors.map(a=>[a.position[0],a.position[2]]),positions,venue.file);
  const view=battleCamera(fight.kernel,venue.file);
  for(let t=0;t<30;t++){fight.tick(pads());view.step();}
  assert.ok(view.matrix().every(Number.isFinite),venue.file);
}
if(make){
  const pages=fight.observedPages,common=new DataView(unpack("kernel/foundation-start.gz"));
  for(let off=0;off<common.byteLength;off+=4100) pages[common.getUint32(off,true)]=1;
  writeFileSync(process.argv[5],gzipSync(new Uint8Array(records(original,pages)),{level:9}));
}
