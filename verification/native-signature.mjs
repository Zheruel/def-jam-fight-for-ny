// Play from full health until each fighter earns and performs their assigned Blazin’ move.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {loadFoundationFight} from "../port/battle/fight.mjs";
import {battleCamera} from "../port/battle/camera.mjs";
import {fetchPacked} from "../port/viewer/scene.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};

// Exercise the browser loader using the checked-in Pages payload on disk.
const fetched=[];
globalThis.fetch=async url=>{
  assert.equal(url.protocol,"file:");
  fetched.push(url.pathname);
  return new Response(await readFile(url));
};
const arena=inventory.venues.find(v=>v.file==="V2BG_02A");
const buttons=[0x1000,0x4000,0x2000,0x8000,0x1100,0x1400,0x1800,0x1200,0x4400,0x8100,0x400,0x800];
for(const [ids,clip] of [[[5,10],713],[[10,5],717]]) {
  fetched.length=0;
  const fighters=await Promise.all(ids.map(async id=>{
    const record=inventory.fighters.find(f=>f.fighterXml.coreID===id);
    const mesh=await fetchPacked(new URL(`../port/render/fighters/${record.model}.skin.gz`,import.meta.url));
    const body=JSON.parse(new TextDecoder().decode(new Uint8Array(mesh,8,new DataView(mesh).getUint32(4,true))));
    return {model:record.model,body,record};
  }));
  const fight=await loadFoundationFight(fighters,arena), camera=battleCamera(fight.kernel);
  assert.equal(fetched.filter(f=>f.includes("/banks/special")).length,4);
  let random=17,held=0,ready=false,activated=false,initial=null,lastFrame=0;
  for(let tick=0;tick<6500;tick++) {
    const {actors}=fight.diagnostics(),[a,b]=actors;
    const flag=fight.memory.getUint8(0x4bc170+0x93e);
    ready ||= Boolean(flag&1);
    activated ||= Boolean(flag&2);
    if(a.action===10000+clip) {
      assert.equal(b.action,10001+clip);
      assert.equal(a.frame,b.frame);
      initial ??= {health:b.health,score:a.score,tick};
      lastFrame=a.frame;
    } else if(initial) {
      assert.ok(ready && activated);
      assert.ok(lastFrame>400);
      assert.ok(b.health<initial.health);
      assert.equal(a.score-initial.score,50000);
      console.log(`${a.name} played signature clips ${clip}/${clip+1} through frame ${lastFrame} and earned 50,000 points.`);
      break;
    }
    const dx=b.position[0]-a.position[0],dz=b.position[2]-a.position[2],d=Math.hypot(dx,dz);
    if(tick%18===0) {
      random=(Math.imul(random,1664525)+1013904223)>>>0;
      held=buttons[random%buttons.length];
    }
    const button=d>10?0x2000:(flag&2)?0x4000:held;
    fight.tick([{buttons:tick%18<4||d>10?button:0,x:d>6?dx/d:0,z:d>6?-dz/d:0,
      rx:(flag&3)&&tick%24<6?1:0},{buttons:0,x:d>9?-dx/d:0,z:d>9?dz/d:0}]);
    camera.step();
    assert.ok(tick<6499,"Signature move did not complete");
  }
  fight.rematch();
  assert.equal(fight.diagnostics().actors[0].score,0);
}
