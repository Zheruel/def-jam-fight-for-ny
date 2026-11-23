// Native round result: KO -> result -> rematch, twice in a row, driven by the retail referee (0x2dbbd8).
import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createFoundationFight} from "../port/battle/fight.mjs";
import {createMatchAnimation} from "../port/animation/match.mjs";
import {resultLines, REMATCH_DELAY, BANNER} from "../port/hud/result.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};

const packed=file=>Uint8Array.from(gunzipSync(readFileSync(new URL("../port/"+file,import.meta.url)))).buffer;
const sampler=await WebAssembly.compile(packed("animation/sampler.wasm.gz"));
const shared=packed("animation/shared.gz");
const ids=[5,10];
const fighters=ids.map(id=>{
  const record=inventory.fighters.find(f=>f.fighterXml.coreID===id);
  const asset=packed(`render/fighters/${record.model}.skin.gz`);
  const body=JSON.parse(new TextDecoder().decode(new Uint8Array(asset,8,new DataView(asset).getUint32(4,true))));
  return {model:record.model,body,record};
});
const animation=await createMatchAnimation(sampler,shared,ids.map(id=>packed(`animation/banks/wres${String(id).padStart(3,"0")}.gz`)));
let match=await createFoundationFight(fighters,packed("kernel/battle.wasm.gz"),packed("kernel/foundation-start.gz"),null,packed("kernel/match-rules.gz"),animation);

// Retail cold starts at the Foundation: Standard = 0x10007 / timer 0, Crowd Votes = 0x10007 / 1,
// No Submissions = 0x10005 / 0. Exercise a full five minutes on the actual referee clock and rematch.
for (const [rule, flags, timer] of [["votes",0x10007,1],["no-submissions",0x10005,0]]) {
  const variant = await createFoundationFight(fighters,packed("kernel/battle.wasm.gz"),packed("kernel/foundation-start.gz"),
    null,packed("kernel/match-rules.gz"),animation,rule);
  assert.equal(variant.diagnostics().ruleFlags, flags);
  assert.equal(variant.diagnostics().timerSetting, timer);
  if (timer) {
    let result;
    const idle = fighters.map(() => ({buttons:0, x:0, z:0}));
    for (let tick = 0; tick < 18500; tick++) {
      variant.tick(idle);
      result = variant.outcome();
      if (result.result) break;
    }
    assert.ok(result.result);
    assert.equal(result.method, "time");
    assert.deepEqual(result.clock, {minutes:5, seconds:0});
    assert.deepEqual(result.displayClock, {minutes:0, seconds:0});
  }
  variant.rematch();
  assert.equal(variant.diagnostics().ruleFlags, flags);
  assert.equal(variant.diagnostics().timerSetting, timer);
  assert.equal(variant.outcome().phase, 1);
  if (timer) assert.equal(variant.outcome().displayClock.minutes, 4);
}
match.rematch();

const ACTOR=[0x4bc170,0x4bd468], buttons=[0x1000,0x4000,0x2000,0x8000,0x1100,0x1400,0x1800,0x1200,0x4400,0x8100,0x400,0x800];
const word=a=>match.memory.getUint32(a,true), scalar=a=>match.memory.getFloat32(a,true);

// Enter the last animation beat of a hold with one depleted limb. The retail victim and
// attacker handlers (0x316e78 and 0x316b40) decide whether it ends the match.
for (const rule of ["standard", "no-submissions"]) {
  const bout = await createFoundationFight(fighters,packed("kernel/battle.wasm.gz"),packed("kernel/foundation-start.gz"),
    null,packed("kernel/match-rules.gz"),animation,rule);
  const m = bout.memory, [attacker, victim] = ACTOR;
  for (const actor of ACTOR) {
    m.setUint32(actor + 0x34, 1, true);
    m.setUint8(actor + 0x937, m.getUint8(actor + 0x937) | 2);
  }
  m.setUint32(attacker + 0xfa0, 0x80, true);
  m.setUint8(attacker + 0xf7b, 0);
  m.setFloat32(victim + 0x820, 0, true);
  m.setFloat32(victim + 0x390, 50, true);
  m.setFloat32(attacker + 0xa0, 0, true);
  bout.kernel.call(0x316e78, victim);
  bout.kernel.call(0x316b40, attacker);
  const idle = ACTOR.map(() => ({buttons:0, x:0, z:0}));
  for (let i = 0; i < 100; i++) bout.tick(idle);
  const outcome = bout.outcome();
  if (rule === "standard") {
    assert.ok(outcome.result);
    assert.deepEqual([outcome.winner, outcome.loser, outcome.method], [0, 1, "submission"]);
    assert.equal(resultLines(outcome, ["Blaze", "Doc"])[0].text, "SUBMIT");
  } else {
    assert.equal(outcome.over, false);
    const limit = Math.fround(m.getFloat32(victim + 0x354, true) * 0.1);
    assert.equal(m.getFloat32(victim + 0x350, true), limit);
    assert.equal(m.getFloat32(victim + 0x358, true), limit);
  }
}

// Both fighters brawl on a fixed input script. The victim either starts nearly spent (a hard knockdown ends the match
// quickly) or, with spent=false, plays the whole match from full health on retail's own rules.
function play(victim,seed,{spent=true,limit=12000}={}) {
  match.rematch();
  const start=match.diagnostics();
  assert.equal(start.outcome.phase,1,"a fresh match starts in the fight phase");
  assert.equal(start.outcome.over,false);
  if(spent) {
    const max=scalar(ACTOR[victim]+0x354);
    match.memory.setFloat32(ACTOR[victim]+0x350,8,true);
    match.memory.setFloat32(ACTOR[victim]+0x35c,8/max,true);
  }
  let random=seed,held=[0,0];
  const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  const phases=[];
  let finishTick=null, frozen=null;
  for(let tick=0;tick<limit;tick++) {
    const {actors,outcome}=match.diagnostics();
    if(phases.at(-1)!==outcome.phase) phases.push(outcome.phase);
    if(outcome.over&&finishTick===null) finishTick=tick;
    if(outcome.ticksSinceOver>=REMATCH_DELAY+30) return {victim,finishTick,phases,outcome,actors,frozen};
    const dx=actors[1].position[0]-actors[0].position[0], dz=actors[1].position[2]-actors[0].position[2], dist=Math.hypot(dx,dz);
    if(tick%18===0) held=[buttons[next()%buttons.length],buttons[next()%buttons.length]];
    match.tick(actors.map((_,slot)=>({buttons:dist>10?0x2000:tick%18<4?(slot===victim?0:held[slot]):0,
      x:dist>7?(slot?-1:1)*dx/dist:0,z:dist>7?(slot?1:-1)*dz/dist:0})));
    // After the finish the pads are dead: whatever is pressed must not reach the actors.
    if(outcome.over) frozen=[ACTOR.map(a=>word(a+0x30)),ACTOR.map((_,i)=>word(0x4bbfb0+word(0x4bbd48+i*4)*32))];
  }
  assert.fail(`no result within ${limit} ticks (victim ${victim})`);
}

// Time limit: timer setting 9 is ten seconds (table 0x392db8). Idle fighters; retail 0x2e5ff8 ranks them by score only when
// the match rules enable it (0x4bbd2c bit 0x40), otherwise the time-up is a draw.
function timeUp(scores,ranked) {
  match.rematch();
  match.memory.setUint32(0x4bbd30,9,true);
  if(ranked) match.memory.setUint16(0x4bbd2c,match.memory.getUint16(0x4bbd2c,true)|0x40,true);
  ACTOR.forEach((a,i)=>match.memory.setUint32(a+0x480,scores[i],true));
  const phases=[];
  for(let tick=0;tick<1200;tick++) {
    const {outcome}=match.diagnostics();
    if(phases.at(-1)!==outcome.phase) phases.push(outcome.phase);
    if(outcome.ticksSinceOver>=REMATCH_DELAY+30) return {phases,outcome,tick,names:match.diagnostics().actors.map(a=>a.name)};
    match.tick([{buttons:0,x:0,z:0},{buttons:0,x:0,z:0}]);
  }
  assert.fail("the ten second limit never ended the match");
}

// A rematch must restore the exact starting RAM, whatever the previous match did to it.
const ram=()=>createHash("sha256").update(new Uint8Array(match.memory.buffer,match.memory.byteOffset,match.memory.byteLength)).digest("hex");
match.rematch();
const startingRam=ram(), startingState=JSON.stringify(match.diagnostics());

const rounds=[];
for(const [victim,seed,options] of [[1,17],[0,17],[1,9],[1,17,{spent:false,limit:16000}]]) {
  const r=play(victim,seed,options), winner=1-victim, {outcome}=r;
  assert.deepEqual(r.phases,[1,2,3],`match phases for victim ${victim}: ${r.phases}`);
  assert.equal(outcome.winner,winner,"the survivor wins");
  assert.equal(outcome.loser,victim);
  assert.equal(outcome.method,"ko");
  assert.equal(r.actors[victim].health,0,"retail 0x30bb40 spends the loser's health");
  assert.ok(r.actors[winner].health>0,"the winner keeps health");
  assert.equal(word(ACTOR[winner]+0x932)&0x100,0x100,"winner flag");
  assert.equal(word(ACTOR[victim]+0x932)&0x200,0x200,"loser flag");
  assert.ok(outcome.effects.some(e=>e.kind===6&&e.frames===60),"referee raised its 60 frame finish effect");
  assert.equal(word(0x4732a4+0x80),6,"knockout selects the original finishing camera shake");
  assert.equal(scalar(0x4732a4+0x7c),60,"full shake duration before the renderer advances it");
  assert.equal(Math.abs(scalar(0x4732a4+0x70)),1,"knockout shake uses the retail amplitude");
  assert.ok(outcome.clock.minutes*60+outcome.clock.seconds>0,"retail clock ran");
  assert.deepEqual(r.frozen[1],[0,0],"pads were released after the finish");
  const lines=resultLines(outcome,r.actors.map(a=>a.name));
  assert.equal(lines[0].text,"KO");
  assert.ok(lines.some(l=>l.text===`${r.actors[winner].name.toUpperCase()} WINS`));
  assert.ok(lines.some(l=>l.text==="ENTER  REMATCH"),"rematch offered after the hold");
  lines.forEach(l=>assert.ok(l.y>=0&&l.y+l.size<=BANNER.height&&l.x>=0&&l.x<=BANNER.width,`banner line ${l.text} inside the ${BANNER.width}x${BANNER.height} surface`));
  rounds.push(r);
}

// Same inputs, same match: the result is deterministic across a rematch.
const again=play(1,17);
assert.equal(again.finishTick,rounds[0].finishTick,"rematch reproduces the finish tick");
assert.deepEqual(again.outcome.clock,rounds[0].outcome.clock);

const timed=[[[300,100],true,0],[[100,300],true,1],[[100,300],false,null]].map(([scores,ranked,winner])=>{
  const r=timeUp(scores,ranked);
  assert.deepEqual(r.phases,[1,2,3]);
  assert.equal(r.outcome.method,"time");
  assert.equal(r.outcome.winner,winner,`scores ${scores} ranked ${ranked}`);
  assert.equal(r.outcome.draw,winner===null);
  assert.deepEqual(r.outcome.clock,{minutes:0,seconds:10},"retail clock stops at the limit");
  const lines=resultLines(r.outcome,r.names);
  assert.equal(lines[0].text,"TIME OVER");
  assert.ok(lines.some(l=>l.text===(winner===null?"DRAW":`${r.names[winner].toUpperCase()} WINS`)));
  return {...r,winner,ranked};
});

// Venue rules: 0x30b928 applies the same under-10% knockdown rule on most venues but has its own branches for 125th Street
// Station (4), Red Hook (7) and Crow's Office (17); run the real arena and collision for a spread of venues.
const foundation=match, venues=[];
for(const id of [1,4,7,17,11]) {
  const venue=inventory.venues.find(v=>v.coreID===id);
  const collision=Uint8Array.from(readFileSync(new URL(`../port/collision/venues/${venue.file}.cli`,import.meta.url))).buffer;
  match=await createFoundationFight(fighters,packed("kernel/battle.wasm.gz"),packed("kernel/foundation-start.gz"),{venue,collision},packed("kernel/match-rules.gz"),animation);
  const r=play(1,17,{limit:4000});
  assert.deepEqual(r.phases,[1,2,3],venue.name);
  assert.equal(r.outcome.winner,0,venue.name);
  assert.equal(r.outcome.method,"ko",venue.name);
  assert.equal(r.actors[1].health,0,venue.name);
  venues.push({venue:venue.name,finishTick:r.finishTick});
}
match=foundation;

// A hazard finish (subway train) is a knockout on the banner, not a time-up.
const hazard=resultLines({...timed[0].outcome,method:"hazard"},timed[0].names);
assert.equal(hazard[0].text,"KO");
assert.ok(hazard.some(l=>l.text===`${timed[0].names[0].toUpperCase()} WINS`));

// Rematch restores a clean match.
match.rematch();
assert.equal(ram(),startingRam,"rematch restores the starting RAM byte for byte");
assert.equal(JSON.stringify(match.diagnostics()),startingState,"rematch restores the starting diagnostics");
const fresh=match.diagnostics();
assert.equal(fresh.ticks,0);
assert.equal(fresh.outcome.phase,1);
assert.equal(fresh.outcome.winner,null);
assert.deepEqual(fresh.outcome.effects,[]);
fresh.actors.forEach(a=>assert.equal(a.health,a.maxHealth));
assert.equal(resultLines(fresh.outcome,[]),null);

console.log(`${rounds.length+1} consecutive native matches ended in a retail KO and rematched cleanly (the last of them from full health):`);
rounds.forEach(r=>console.log(`  victim slot ${r.victim}: finish at tick ${r.finishTick}, phases ${r.phases.join(">")}, winner ${r.outcome.winner}, clock ${r.outcome.clock.minutes}:${String(r.outcome.clock.seconds).padStart(2,"0")}`));
timed.forEach(r=>console.log(`  ten second limit, ${r.ranked?"scored":"unscored"}: ${r.winner===null?"draw":"winner slot "+r.winner} at tick ${r.tick}`));
venues.forEach(v=>console.log(`  ${v.venue}: KO at tick ${v.finishTick}`));
