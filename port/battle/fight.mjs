import { loadMatchAnimation } from "../animation/match.mjs";
import { loadMatchRules, initializeFighterProfile } from "./roster.mjs";
import { installArena,loadArena } from "./arena.mjs";
import { createOutcome } from "./outcome.mjs";
import { instantiateBattle } from "../kernel/runtime.mjs";
import { poseIndex } from "../motion/pose-bank.mjs";
import { actorMatrix, boneWorldMatrix } from "../fighters/pose.mjs";
import { fetchPacked } from "../viewer/scene.mjs";

const ACTOR = [0x4bc170,0x4bd468];
const rad = Math.PI / 180;

export async function loadFoundationFight(fighters,venue) {
  const [source,seed,arena,rules,animation]=await Promise.all([
    fetchPacked(new URL("../kernel/battle.wasm.gz",import.meta.url)),
    fetchPacked(new URL("../kernel/foundation-start.gz",import.meta.url)),
    venue.file==="V2BG_02A" ? null : loadArena(venue),
    fetchPacked(new URL("../kernel/match-rules.gz",import.meta.url)),
    loadMatchAnimation(fighters),
  ]);
  return createFoundationFight(fighters,source,seed,arena,rules,animation);
}

export async function createFoundationFight(fighters,source,seed,arena,rules,animation) {
  let memory, outcome;
  const word = address => memory.getUint32(address,true);
  const scalar = address => memory.getFloat32(address,true);
  const readVector = address => [scalar(address),scalar(address+4),scalar(address+8)];
  const states = fighters.map(({body,bank,model}) => ({ bones: body.bones, bank, model,
    position: [0,0,0], yaw: 0, root: [0,0,0,0], skin: null, aim: new Map(), damage: 0 }));
  function clip(slot,bank,local) {
    const action = bank === 0 ? 10000 + local : local;
    // BASE00 is the shared action bank. Both body rigs have identical body
    // bind matrices; their facial control binds differ. Prefer a slot capture.
    const match = states[slot].bank.clips[action] ?? (bank === 0 && states[1-slot].bank.clips[action]);
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
  outcome = createOutcome(kernel,ACTOR);
  const bytes = new Uint8Array(memory.buffer,memory.byteOffset,memory.byteLength);
  const file = new DataView(seed);
  if (!file.byteLength || file.byteLength % 4100) throw new Error("Invalid Foundation start data");
  const pads = [];
  let ticks;
  function restart() {
    bytes.fill(0);
    for (let at=0;at<file.byteLength;at+=4100) {
      const page = file.getUint32(at,true);
      bytes.set(new Uint8Array(seed,at+4,4096),page*4096);
    }
    if(rules) loadMatchRules(kernel,rules);
    animation?.reset();
    if(animation) fighters.forEach((f,slot)=>{
      initializeFighterProfile(kernel,slot,f.record);
      const idle=kernel.call(0x2ff908,ACTOR[slot],1,0,0);
      kernel.call(0x2e4808,ACTOR[slot],idle,0,0);
    });
    if(arena) installArena(kernel,arena,ACTOR);
    ACTOR.forEach((a,i) => {
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
    outcome.reset();
    ticks = 0;
  }
  restart();
  function tick(inputs) {
    // Retail runs the match referee (0x2dbbd8, delta 1.0) before the actor update; once it calls the finish the pads go dead.
    const finished = outcome.advance().over;
    pads.forEach((p,i) => {
      const {buttons,x,z} = finished ? {buttons:0,x:0,z:0} : inputs[i];
      const previous = word(p);
      memory.setUint32(p,buttons,true);
      memory.setUint32(p+4,buttons & ~previous,true);
      memory.setFloat32(p+8,x,true);
      memory.setFloat32(p+12,z,true);
    });
    kernel.tick();
    states.forEach((state,slot) => {
      state.actorPosition = readVector(ACTOR[slot]+0x44);
      animation?.finish(state,slot);
    });
    ticks++;
  }
  function diagnostics() {
    return {ticks,actors: ACTOR.map((a,i)=>({name:fighters[i].record?.name,action:word(a+0x80),state:word(a+0x30),
      frame:scalar(a+0x9c),position:readVector(a+0x44),health:scalar(a+0x350),maxHealth:scalar(a+0x354),
      score:word(a+0x480),momentum:scalar(a+0x364)})),outcome:outcome.read()};
  }
  return { states, tick, restart, rematch: restart, outcome: () => outcome.read(), diagnostics, observedPages:kernel.observedPages, memory, kernel };
}
