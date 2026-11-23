// Exercise every selected fighter through the same native match entry used on Pages.
import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import assert from "node:assert/strict";
import {createFoundationFight} from "../port/battle/fight.mjs";
import {createMatchAnimation} from "../port/animation/match.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};
import frames from "./native-fight-inputs.json" with {type:"json"};

const packed=file=>Uint8Array.from(gunzipSync(readFileSync(new URL("../port/"+file,import.meta.url)))).buffer;
const battle=await WebAssembly.compile(packed("kernel/battle.wasm.gz"));
const sampler=await WebAssembly.compile(packed("animation/sampler.wasm.gz"));
const seed=packed("kernel/foundation-start.gz"), shared=packed("animation/shared.gz"), rules=packed("kernel/match-rules.gz");
function loadFighter(record) {
  const model=record.model, asset=packed(`render/fighters/${model}.skin.gz`);
  const length=new DataView(asset).getUint32(4,true);
  const body=JSON.parse(new TextDecoder().decode(new Uint8Array(asset,8,length)));
  return {model,body,record};
}
let tested=0,scored=0;
const results=[];
for(let index=-1;index<inventory.fighters.length;index++) {
  const records=index<0 ? [5,10].map(id=>inventory.fighters.find(f=>f.fighterXml.coreID===id)) :
    [inventory.fighters[index],inventory.fighters[(index+1)%inventory.fighters.length]];
  const fighters=records.map(loadFighter);
  const banks=records.map(f=>packed(`animation/banks/wres${String(f.fighterXml.coreID).padStart(3,"0")}.gz`));
  const animation=await createMatchAnimation(sampler,shared,banks);
  const match=await createFoundationFight(fighters,battle,seed,null,rules,animation);
  let maxError=0;
  try{
    for(const [tick,row] of frames.entries()) {
      match.tick(row.map(([pad],slot)=>({buttons:pad&0xfff0,x:pad&0x10000?(slot?-1:1):0,z:0})));
      const actors=match.diagnostics().actors;
      for(const [slot,actor] of actors.entries()) {
        assert.ok(actor.position.every(Number.isFinite) && Number.isFinite(actor.health));
        if(index<0) {
          assert.equal(actor.state,row[slot][1],`state at tick ${tick}`);
          assert.equal(actor.action,row[slot][2],`action at tick ${tick}`);
          maxError=Math.max(maxError,Math.hypot(...actor.position.map((v,i)=>v-row[slot][3+i])));
        }
      }
    }
    const actors=match.diagnostics().actors;
    if(index<0) {
      assert.deepEqual(actors.map(a=>a.score),[250,250]);
      assert.ok(maxError<0.71);
      console.log(`Original live motions match both actors' states and actions across 460 ticks. Maximum position difference ${maxError.toFixed(3)}.`);
    } else {
      tested++;
      scored+=Number(actors.some(a=>a.score>0));
    }
  }catch(e){ results.push(`${records.map(f=>f.name).join(" vs. ")}: ${e.message}`); }
}
console.log(`${tested} native matches completed, representing each fighter in both slots. ${scored} recorded a scoring hit on this input sequence.`);
assert.deepEqual(results,[]);
