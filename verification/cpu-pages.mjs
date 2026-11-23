// Derive the RAM pages the retail CPU decision code needs beyond the person-only start data, from a reference capture
// whose seats 1..3 were CPU (private/ps2-battle/four-start/start-0.bin, the first active frame of a retail Free For All).
//   node verification/cpu-pages.mjs SNAPSHOT [--out port/kernel/cpu-pages.gz]
// 1. The reference run gives the native kernel every non-empty page of the capture, three CPU opponents play many
//    fighter sets, and the instrumented kernel (private/native-kernel/instrumented/battle.wasm, the build that marks
//    accessed pages in fight.observedPages) reports which pages the original AI and its helpers touched.
// 2. Touched pages that the person-only starts (four-start.gz, foundation-start.gz) lack are written to the output.
// 3. Every scenario is replayed on the shipped kernel with only those pages and must match the reference tick for tick.
import {readFileSync,writeFileSync} from "node:fs";
import {gunzipSync,gzipSync} from "node:zlib";
import {createHash} from "node:crypto";
import {createFoundationFight,signatureClipIds} from "../port/battle/fight.mjs";
import {createMatchAnimation} from "../port/animation/match.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};

const [snapshot]=process.argv.slice(2).filter((a,i,all)=>!a.startsWith("--") && all[i-1]!=="--out");
const out=process.argv.includes("--out")?process.argv[process.argv.indexOf("--out")+1]:new URL("../port/kernel/cpu-pages.gz",import.meta.url).pathname;
const unpack=name=>Uint8Array.from(gunzipSync(readFileSync(new URL("../port/"+name,import.meta.url)))).buffer;
const ram=readFileSync(snapshot);
const seedPages=name=>{const seed=Buffer.from(gunzipSync(readFileSync(new URL("../port/kernel/"+name,import.meta.url))));const pages=new Set();for(let at=0;at<seed.length;at+=4100)pages.add(seed.readUInt32LE(at));return {seed,pages};};
const four=seedPages("four-start.gz"),duel=seedPages("foundation-start.gz");
const sampler=await WebAssembly.compile(unpack("animation/sampler.wasm.gz"));
const rules=unpack("kernel/match-rules.gz");
const shipped=await WebAssembly.compile(unpack("kernel/battle.wasm.gz"));
const tracked=await WebAssembly.compile(readFileSync(new URL("../private/native-kernel/instrumented/battle.wasm",import.meta.url)));
const record=id=>inventory.fighters.find(f=>f.fighterXml.coreID===id);
const rig=model=>{const binary=unpack("render/fighters/"+model+".skin.gz");const length=new DataView(binary).getUint32(4,true);return JSON.parse(new TextDecoder().decode(new Uint8Array(binary,8,length)));};
function pagesOf(start,present,all) { // the capture's non-empty pages the start lacks (all) or only the listed ones
  const extra=[];
  for(let page=0;page<8192;page++) if(!start.pages.has(page) && (all ? ram.subarray(page*4096,page*4096+4096).some(b=>b) : present.has(page))) extra.push(page);
  return extra;
}
function seedWith(start,pages) {
  const extra=Buffer.alloc(pages.length*4100);
  pages.forEach((page,index)=>{extra.writeUInt32LE(page,index*4100);ram.copy(extra,index*4100+4,page*4096,page*4096+4096);});
  return Uint8Array.from(Buffer.concat([start.seed,extra])).buffer;
}
// A scenario: fighter ids (seat 0 is the person, played by a script), the match size and the seed used.
const scenarios=[
  {ids:[5,10,11,16]},{ids:[20,33,48,60]},{ids:[4,25,41,57]},{ids:[6,7,8,9]},{ids:[12,13,14,15]},{ids:[30,31,32,34]},
  {ids:[5,10]},{ids:[20,33]},{ids:[4,25]},{ids:[6,7]},
];
async function play({ids},wasm,seed,{ticks=4000,watch}={}) {
  const fighters=ids.map((id,slot)=>({record:record(id),body:rig(record(id).model),model:record(id).model,cpu:slot>0}));
  const animation=await createMatchAnimation(sampler,unpack(ids.length===4?"animation/four-shared.gz":"animation/shared.gz"),ids.map(id=>unpack("animation/banks/wres"+String(id).padStart(3,"0")+".gz")));
  const fight=await createFoundationFight(fighters,wasm,seed,null,rules,animation);
  animation.setSignatures(new Map(signatureClipIds(fight.memory,ids.length).map(id=>[id,unpack("animation/banks/special"+id+".gz")])));
  watch?.(fight);
  const hash=createHash("sha1"),inputs=fighters.map(()=>({buttons:0,x:0,z:0}));
  let t=0,error=null;
  try {
    for(;t<ticks && !fight.outcome().result;t++) {
      inputs[0]={buttons:t%40<6?0x1000:0,x:Math.sin(t/50),z:Math.cos(t/70)};
      fight.tick(inputs);
      for(const a of fight.diagnostics().actors) hash.update(JSON.stringify([a.position,a.health,a.score,a.action,a.state]));
    }
  } catch(e) { error=e.message; }
  return {digest:hash.digest("hex"),ticks:t,error,fight};
}
const touched=new Set();
const referenceSeed=[...[four,duel]].map(start=>seedWith(start,pagesOf(start,null,true)));
const reference=[];
for(const [index,scenario] of scenarios.entries()) {
  const start=scenario.ids.length===4?0:1;
  const {digest,ticks,error,fight}=await play(scenario,tracked,referenceSeed[start],{watch:fight=>fight.observedPages.fill(0)});
  fight.observedPages.forEach((used,page)=>used&&touched.add(page));
  reference.push({digest,ticks,error});
  console.log("reference",scenario.ids.join(","),ticks,"ticks",error??"ok");
}
touched.delete(0);
// The AI decision tables are one file ("AI  ", size in its second word) that a match reads only where the situation sends
// it, so every page of the file is kept, not just the pages these scenarios happened to read.
const AI_DATA=0x15760c0,aiSize=ram.readUInt32LE(AI_DATA+4);
if(ram.readUInt32LE(AI_DATA)!==0x20204941)throw Error("The capture has no AI table at "+AI_DATA.toString(16));
for(let page=AI_DATA>>>12;page<=(AI_DATA+aiSize-1)>>>12;page++) touched.add(page);
const needed=[...touched].filter(page=>!(four.pages.has(page)&&duel.pages.has(page))).sort((a,b)=>a-b);
console.log("pages touched",touched.size,"lacking from a person-only start",needed.length);
const records=Buffer.alloc(needed.length*4100);
needed.forEach((page,index)=>{records.writeUInt32LE(page,index*4100);ram.copy(records,index*4100+4,page*4096,page*4096+4096);});
// The replay uses each start plus only the pages it lacks, exactly as the player merges kernel/cpu-pages.gz.
let failed=0;
for(const [index,scenario] of scenarios.entries()) {
  const start=scenario.ids.length===4?four:duel;
  const {digest,ticks}=await play(scenario,shipped,seedWith(start,needed.filter(page=>!start.pages.has(page))));
  const same=digest===reference[index].digest && ticks===reference[index].ticks;
  console.log("replay",scenario.ids.join(","),ticks,"ticks",same?"identical to the full capture":"DIFFERS");
  if(!same)failed++;
}
if(failed)throw Error(failed+" scenarios differ from the full-capture reference");
writeFileSync(out,gzipSync(records,{level:9}));
console.log("wrote",out,needed.length,"pages");
process.exit(0);
