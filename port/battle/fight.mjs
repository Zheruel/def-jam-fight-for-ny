import { MODES } from "./modes.mjs";
import { loadMatchAnimation } from "../animation/match.mjs";
import { loadMatchRules, initializeFighterProfile } from "./roster.mjs";
import { installArena,loadArena } from "./arena.mjs";
import { createOutcome } from "./outcome.mjs";
import { instantiateBattle } from "../kernel/runtime.mjs";
import { poseIndex } from "../motion/pose-bank.mjs";
import { actorMatrix, boneWorldMatrix } from "../fighters/pose.mjs";
import { fetchPacked } from "../viewer/scene.mjs";
import { copyDecisions, neutralPad, withCpuPages, writeSeatTypes } from "./cpu.mjs";

const actorAddress = slot => 0x4bc170 + slot * 0x12f8;
const rad = Math.PI / 180;

export async function loadFoundationFight(fighters,venue,format) {
  const mode=MODES[format] ?? Object.values(MODES).find(m=>m.fighters===fighters.length && (!format || m.formation===format));
  if(mode?.fighters!==fighters.length) throw RangeError("No Battle start for "+fighters.length+" fighters in "+format);
  const [source,seed,arena,rules,animation]=await Promise.all([
    fetchPacked(new URL("../kernel/battle.wasm.gz",import.meta.url)),
    fetchPacked(new URL("../kernel/"+mode.start,import.meta.url)),
    venue.file==="V2BG_02A" ? null : loadArena(venue),
    fetchPacked(new URL("../kernel/match-rules.gz",import.meta.url)),
    loadMatchAnimation(fighters),
  ]);
  const fight=await createFoundationFight(fighters,source,await withCpuPages(seed,fighters,mode.start),arena,rules,animation);
  const clips=signatureClipIds(fight.memory,fighters.length);
  animation.setSignatures(new Map(await Promise.all(clips.map(async clip=>[
    clip,await fetchPacked(new URL(`../animation/banks/special${clip}.gz`,import.meta.url))
  ]))));
  return fight;
}

// The WPAR parser writes the four right-stick assignments to the fighter profile.
// Retail 0x30a580 converts the assignment to a pair of BASE00 clip numbers.
export function signatureClipIds(memory,count=2) {
  const ids=new Set();
  for(let slot=0;slot<count;slot++) for(let direction=0;direction<4;direction++) {
    const actor=actorAddress(slot);
    const move=memory.getUint32(actor+0xbb8+4*direction,true);
    if(move>=82) throw RangeError("Invalid signature move in fighter profile");
    ids.add(709+2*move);
    ids.add(710+2*move);
  }
  return [...ids];
}

export async function createFoundationFight(fighters,source,seed,arena,rules,animation) {
  if(fighters.length<2 || fighters.length>4) throw RangeError("Battle requires two to four fighters");
  const actors=fighters.map((_,slot)=>actorAddress(slot));
  let memory, outcome, voice;
  const word = address => memory.getUint32(address,true);
  const scalar = address => memory.getFloat32(address,true);
  const readVector = address => [scalar(address),scalar(address+4),scalar(address+8)];
  const states = fighters.map(({body,bank,model}) => ({ bones: body.bones, bank, model,
    position: [0,0,0], yaw: 0, root: [0,0,0,0], skin: null, aim: new Map(), damage: 0 }));
  function clip(slot,bank,local) {
    const action = bank === 0 ? 10000 + local : local;
    // BASE00 is the shared action bank. Both body rigs have identical body
    // bind matrices; their facial control binds differ. Prefer a slot capture.
    const match = states[slot].bank.clips[action] ?? (bank === 0 && states.find(state=>state.bank?.clips[action])?.bank.clips[action]);
    if (!match) throw new Error(`Motion ${action} is still being recovered for ${states[slot].model}.`);
    return match;
  }
  function sample(slot,bank,local,frame,blend,transition) {
    if(animation) return animation.sample(states[slot],slot,bank,local,frame,blend,transition);
    const state = states[slot], capture = clip(slot,bank,local);
    const index = poseIndex(capture,frame);
    state.skin = capture.poses[index];
    state.root = capture.roots[index];
    return state.root;
  }
  function place(slot,position,angles) {
    states[slot].position = readVector(position);
    states[slot].yaw = scalar(angles+4);
  }
  const engine = {
    sample, place,
    playSpeech: (name,offset,channel) => voice?.play(name,offset,channel,ticks),
    speaking: channel => voice?.playing(channel,ticks),
    duration(slot,bank,index) { return animation ? animation.duration(slot,bank,index) : clip(slot,bank,index).end; },
    rootYaw(slot) { return states[slot].root[3]; },
    damage(slot,level) { states[slot].damage = level; },
    timeScale(kind,frames) { outcome?.timeScale(kind,frames); },
    gameSpeed(scale) { outcome?.gameSpeed(scale); },
    rotateBone(slot,id,address) {
      const euler = readVector(address);
      // The sampler's pose array is edited in place, as retail 0x132ab8 does; recorded captures can only keep the request.
      if(animation) animation.rotate(states[slot],slot,id,euler);
      else states[slot].aim.set(id,euler);
    },
    writeBone(slot,id,address) {
      const state = states[slot];
      if(state.world) {
        // Retail 0x132a28: bone world matrix x actor matrix (yaw about +Y, then position).
        const m = boneWorldMatrix(state,state.entries,actorMatrix(state.position,state.yaw),id,state.world);
        for(let i=0;i<16;i++) memory.setFloat32(address+i*4,m[i],true);
        return;
      }
      const index = word(0x3ccdb8 + (id-1)*4);
      const bind = state.bones[index].bindWorld;
      const start = index*16, cosine = Math.cos(state.yaw*rad), sine = Math.sin(state.yaw*rad);
      for (let row=0;row<4;row++) {
        const j = row*4;
        let x = 0, y = 0, z = 0, w = 0;
        for (let k=0;k<4;k++) {
          const a = bind[j+k], at = start+k*4;
          x += a*state.skin[at]; y += a*state.skin[at+1];
          z += a*state.skin[at+2]; w += a*state.skin[at+3];
        }
        memory.setFloat32(address+j*4, x*cosine+z*sine+(row===3 ? state.position[0] : 0),true);
        memory.setFloat32(address+j*4+4, y+(row===3 ? state.position[1] : 0),true);
        memory.setFloat32(address+j*4+8, z*cosine-x*sine+(row===3 ? state.position[2] : 0),true);
        memory.setFloat32(address+j*4+12,w,true);
      }
    },
  };
  const kernel = await instantiateBattle(source,engine);
  memory = kernel.memory;
  outcome = createOutcome(kernel,actors);
  const bytes = new Uint8Array(memory.buffer,memory.byteOffset,memory.byteLength);
  const file = new DataView(seed);
  if (!file.byteLength || file.byteLength % 4100) throw new Error("Invalid Foundation start data");
  const pads = [];
  const hasCpu = fighters.some(f=>f.cpu);
  let ticks;
  function restart() {
    bytes.fill(0);
    for (let at=0;at<file.byteLength;at+=4100) {
      const page = file.getUint32(at,true);
      bytes.set(new Uint8Array(seed,at+4,4096),page*4096);
    }
    if(rules) loadMatchRules(kernel,rules);
    writeSeatTypes(memory,fighters);
    animation?.reset();
    if(animation) fighters.forEach((f,slot)=>{
      initializeFighterProfile(kernel,slot,f.record);
      const idle=kernel.call(0x2ff908,actors[slot],1,0,0);
      kernel.call(0x2e4808,actors[slot],idle,0,0);
    });
    if(arena) installArena(kernel,arena,actors);
    actors.forEach((a,i) => {
      place(i,a+0xc4,a+0xd0);
      sample(i,word(a+0x84),word(a+0x88),scalar(a+0x9c));
      pads[i] = 0x4bbfb0 + word(0x4bbd48+i*4)*32;
      states[i].aim.clear();
      states[i].damage = 0;
      states[i].actorPosition = readVector(a+0x44);
      states[i].settled = [...states[i].actorPosition];
      states[i].pending = null;
      states[i].final = null;
    });
    voice?.reset();
    outcome.reset();
    ticks = 0;
  }
  restart();
  function tick(inputs) {
    // Retail runs the match referee (0x2dbbd8, delta 1.0) before the actor update; once it calls the finish the pads go dead.
    const finished = outcome.advance().over;
    pads.forEach((p,i) => {
      if(fighters[i].cpu) return;
      const {buttons,x,z,rx=0,rz=0} = finished ? {buttons:0,x:0,z:0} : inputs[i];
      const previous = word(p);
      memory.setUint32(p,buttons,true);
      memory.setUint32(p+4,buttons & ~previous,true);
      memory.setFloat32(p+8,x,true);
      memory.setFloat32(p+12,z,true);
      memory.setFloat32(p+16,rx,true);
      memory.setFloat32(p+20,rz,true);
    });
    if(hasCpu) {
      copyDecisions(kernel);
      if(finished) pads.forEach((p,i) => fighters[i].cpu && neutralPad(memory,p));
    }
    kernel.tick();
    states.forEach((state,slot) => {
      state.actorPosition = readVector(actors[slot]+0x44);
      animation?.finish(state,slot);
    });
    ticks++;
  }
  function diagnostics() {
    return {ticks,voice:voice?.diagnostics(),actors: actors.map((a,i)=>({name:fighters[i].record?.name,action:word(a+0x80),state:word(a+0x30),
      frame:scalar(a+0x9c),position:readVector(a+0x44),health:scalar(a+0x350),maxHealth:scalar(a+0x354),
      eliminated:Boolean(memory.getUint16(a+0x932,true)&0x200),score:word(a+0x480),momentum:scalar(a+0x364),blazin:memory.getUint8(a+0x93e)&3})),outcome:outcome.read()};
  }
  return { states, tick, restart, setVoicePlayer(player) {voice=player;}, rematch: restart, outcome: () => outcome.read(), diagnostics, observedPages:kernel.observedPages, memory, kernel };
}
