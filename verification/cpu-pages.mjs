// Derive, for each match formation, the RAM pages the retail CPU decision code needs beyond that formation's person-only
// start data, from that formation's own pristine retail capture.
//   node verification/cpu-pages.mjs [--only duel,three,four,team]
//
// Every formation's capture holds the AI decision file ("AI  ", 0x15558 bytes, identical in all four) at the address its
// own pointer 0x4c4ce0 names, so nothing is carried between captures: each formation's delta comes from its own RAM.
// For each formation:
// 1. Reference: the formation's pristine capture, overlaid with its start's own pages (the seat setup the start carries). CPU opponents play several fighter sets on the instrumented kernel
//    (private/native-kernel/instrumented/battle.wasm, which marks the pages it touches in fight.observedPages).
// 2. The touched pages and the AI file that the person-only start lacks are written to
//    port/kernel/cpu-<start file> (merged by cpu.mjs withCpuPages without replacing anything the start has).
// 3. Every scenario replays on the shipped kernel from the start plus only those pages and must match the reference
//    tick for tick. Any error in either run, or any difference, fails the generation and nothing is written.
import {readFileSync,writeFileSync} from "node:fs";
import {gunzipSync,gzipSync} from "node:zlib";
import {createHash} from "node:crypto";
import {createFoundationFight,signatureClipIds} from "../port/battle/fight.mjs";
import {createMatchAnimation} from "../port/animation/match.mjs";
import {AI_TABLE} from "../port/battle/cpu.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};

const root=new URL("../",import.meta.url);
const unpack=name=>Uint8Array.from(gunzipSync(readFileSync(new URL("port/"+name,root)))).buffer;
const capture=path=>{const ram=readFileSync(new URL(path,root));if(ram.length!==0x2000000)throw Error(path+" is not a 32 MB RAM capture");return ram;};
const only=process.argv.includes("--only")?process.argv[process.argv.indexOf("--only")+1].split(","):null;

const AI_SIZE=0x15558,AI_SHA256="a380101778acbd8cb896a905366abd3d28ecbab6508c99ac578481ac758b3520";

// Fighter sets, seat 0 first; cpu: how many of the last seats the CPU plays.
const sets4=[[5,10,11,16],[20,33,48,60],[4,25,41,57],[6,7,8,9],[12,13,14,15],[30,31,32,34]];
const formations={
  duel:{start:"foundation-start.gz",ram:"private/verification/ps2-match/run-BjNMn0/fighter-ram-0.bin",
    scenarios:[[5,10],[20,33],[4,25],[6,7]].map(ids=>({ids,cpu:1}))},
  three:{start:"three-start.gz",ram:"private/ps2-battle/three-fight/fight-start.bin",
    scenarios:[[5,10,11],[20,33,48],[4,25,41],[6,7,8]].map((ids,i)=>({ids,cpu:i%2?1:2}))},
  four:{start:"four-start.gz",ram:"private/ps2-battle/four-start/start-0.bin",
    scenarios:sets4.map((ids,i)=>({ids,cpu:i%3===2?1:3}))},
  team:{start:"team-start.gz",ram:"private/verification/team/fight-start.bin",
    scenarios:sets4.slice(0,4).map((ids,i)=>({ids,cpu:i%2?1:3}))},
};

const sampler=await WebAssembly.compile(unpack("animation/sampler.wasm.gz"));
const rules=unpack("kernel/match-rules.gz");
const shipped=await WebAssembly.compile(unpack("kernel/battle.wasm.gz"));
const tracked=await WebAssembly.compile(readFileSync(new URL("private/native-kernel/instrumented/battle.wasm",root)));
const record=id=>inventory.fighters.find(f=>f.fighterXml.coreID===id);
const rig=model=>{const binary=unpack("render/fighters/"+model+".skin.gz");const length=new DataView(binary).getUint32(4,true);return JSON.parse(new TextDecoder().decode(new Uint8Array(binary,8,length)));};

function seedPages(name) {
  const seed=Buffer.from(gunzipSync(readFileSync(new URL("port/kernel/"+name,root))));
  const pages=new Set();
  for(let at=0;at<seed.length;at+=4100)pages.add(seed.readUInt32LE(at));
  return {seed,pages};
}
const empty=(ram,page)=>!ram.subarray(page*4096,page*4096+4096).some(byte=>byte);
const records=(ram,pages)=>{
  const out=Buffer.alloc(pages.length*4100);
  pages.forEach((page,index)=>{out.writeUInt32LE(page,index*4100);ram.copy(out,index*4100+4,page*4096,page*4096+4096);});
  return out;
};

async function play({ids,cpu},wasm,seed,{ticks=4000,track=false,ai}={}) {
  const fighters=ids.map((id,slot)=>({record:record(id),body:rig(record(id).model),model:record(id).model,cpu:slot>=ids.length-cpu}));
  const animation=await createMatchAnimation(sampler,unpack(ids.length>2?"animation/four-shared.gz":"animation/shared.gz"),ids.map(id=>unpack("animation/banks/wres"+String(id).padStart(3,"0")+".gz")));
  const fight=await createFoundationFight(fighters,wasm,seed,null,rules,animation);
  animation.setSignatures(new Map(signatureClipIds(fight.memory,ids.length).map(id=>[id,unpack("animation/banks/special"+id+".gz")])));
  if(track)fight.observedPages.fill(0);
  const hash=createHash("sha1"),inputs=fighters.map(()=>({buttons:0,x:0,z:0}));
  let t=0;
  for(;t<ticks && !fight.outcome().result;t++) {
    inputs[0]={buttons:t%40<6?0x1000:0,x:Math.sin(t/50),z:Math.cos(t/70)};
    fight.tick(inputs);
    for(const a of fight.diagnostics().actors) hash.update(JSON.stringify([a.position,a.health,a.score,a.action,a.state]));
  }
  // The AI file must still be intact: nothing the match allocates or writes may land on it.
  const file=Buffer.from(fight.memory.buffer,fight.memory.byteOffset+ai,AI_SIZE);
  if(createHash("sha256").update(file).digest("hex")!==AI_SHA256)throw Error("the AI file changed during the match");
  return {digest:hash.digest("hex"),ticks:t,fight,result:fight.outcome().result};
}

const written=[];
for(const [name,formation] of Object.entries(formations)) {
  if(only && !only.includes(name))continue;
  const label=(scenario)=>`${name} ${scenario.ids.join(",")} cpu=${scenario.cpu}`;
  const start=seedPages(formation.start);
  const ram=Buffer.from(capture(formation.ram));
  // Pages the start carries override the capture (the seat setup the start was made with).
  const view=start.seed;
  for(let at=0;at<view.length;at+=4100)view.copy(ram,view.readUInt32LE(at)*4096,at+4,at+4100);
  const ai=ram.readUInt32LE(AI_TABLE);
  if(createHash("sha256").update(ram.subarray(ai,ai+AI_SIZE)).digest("hex")!==AI_SHA256)throw Error(`${name}: no AI file at its pointer ${ai.toString(16)}`);
  console.log(name,"AI file at",ai.toString(16));
  const all=[];for(let page=0;page<8192;page++)if(!empty(ram,page))all.push(page);
  const reference=Uint8Array.from(records(ram,all)).buffer;
  const touched=new Set();
  for(let page=ai>>>12;page<=(ai+AI_SIZE-1)>>>12;page++)touched.add(page);
  const results=[];
  for(const scenario of formation.scenarios) {
    const run=await play(scenario,tracked,reference,{track:true,ai});
    run.fight.observedPages.forEach((used,page)=>used&&touched.add(page));
    results.push(run);
    console.log("reference",label(scenario),run.ticks,"ticks",run.result?"finished":"ok");
  }
  touched.delete(0);
  const needed=[...touched].filter(page=>!start.pages.has(page)).sort((a,b)=>a-b);
  const delta=records(ram,needed);
  for(const [index,scenario] of formation.scenarios.entries()) {
    const seed=Uint8Array.from(Buffer.concat([start.seed,delta])).buffer;
    const run=await play(scenario,shipped,seed,{ai});
    if(run.digest!==results[index].digest || run.ticks!==results[index].ticks)throw Error(label(scenario)+": the replay from the start plus the CPU pages differs from the full capture");
    console.log("replay   ",label(scenario),run.ticks,"ticks identical to the full capture");
  }
  written.push([new URL("port/kernel/cpu-"+formation.start,root),delta,needed.length,name]);
}
for(const [path,delta,pages,name] of written) {
  writeFileSync(path,gzipSync(delta,{level:9}));
  console.log("wrote",path.pathname,name,pages,"pages");
}
process.exit(0);
