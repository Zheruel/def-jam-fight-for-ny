import { instantiateSampler } from "./runtime.mjs";
import { installWrestlingBank } from "./banks.mjs";
import { composePose, applyBoneEuler } from "../fighters/pose.mjs";
import { fetchPacked } from "../viewer/scene.mjs";

export async function loadMatchAnimation(fighters) {
  const load = path=>fetchPacked(new URL(path,import.meta.url));
  const ids=fighters.map(f=>f.record.fighterXml.coreID);
  const requests=new Map([...new Set(ids)].map(id=>[id,load(`./banks/wres${String(id).padStart(3,"0")}.gz`)]));
  const [source,shared,banks]=await Promise.all([load("./sampler.wasm.gz"),load("./shared.gz"),Promise.all(ids.map(id=>requests.get(id)))]);
  return createMatchAnimation(source,shared,banks);
}
export async function createMatchAnimation(source,shared,banks) {
  const sampler=await instantiateSampler(source), sharedView=new DataView(shared);
  function reset() {
    sampler.ram.fill(0);
    sampler.resetScratch();
    for(let i=0;i<shared.byteLength;i+=4100)
      sampler.ram.set(new Uint8Array(shared,i+4,4096),sharedView.getUint32(i,true)*4096);
    banks.forEach((bank,slot)=>installWrestlingBank(sampler,slot,bank));
  }
  function compose(state,slot) {
    const entries=sampler.pose(slot), pose=composePose(state,entries);
    state.entries=entries;
    state.world=pose.world;
    state.skin=pose.skin;
  }
  // 0x132bb8 leaves the previous pose in the character's +0x17c array and writes the clip pose to +0x180 with the blend weight
  // (blend = k/12 over the 12 transition frames). The game's logic (hit points, 0x132a28) keeps reading +0x17c during the
  // transition (state.entries / state.world: it is what the reference match's collisions and positions follow). The pose that is
  // shown (state.skin) and recorded at the end of each tick is lerp(previous shown pose, clip pose, weight) per component
  // (shortest-arc quaternion lerp, never renormalised); the previous pose's bone-0 x/z is first moved back by the actor's local
  // movement over the tick plus the change of the motion's root offset so the blend stays put in the world (matches 124 of 131
  // recorded blend ticks). finish() performs that step; call it once after every simulation tick.
  function finish(state,slot) {
    // `actorPosition` is the actor's own position (actor+0x44); 0x132b00's state.position runs ahead of it.
    const from=state.settled ?? state.actorPosition;
    state.settled=[...state.actorPosition];
    const pending=state.pending;
    state.pending=null;
    if(!pending) {
      state.final=Float32Array.from(sampler.pose(slot));
      return;
    }
    const dx=state.actorPosition[0]-from[0], dz=state.actorPosition[2]-from[2], a=state.yaw*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
    const character=sampler.memory.getUint32(0x471230+slot*4,true);
    const target=new Float32Array(sampler.ram.buffer,sampler.ram.byteOffset+sampler.memory.getUint32(character+0x180,true),94*12);
    const shown=state.final ?? Float32Array.from(sampler.pose(slot)), {weight}=pending, keep=1-weight;
    // The engine edits the array that holds the previous pose, so this tick's aim joins the lerp (and carries into later blend ticks).
    for(const [id,euler] of pending.aim) applyBoneEuler(shown,id,euler);
    shown[8]-=keep*(dx*c-dz*s+pending.root[0]);
    shown[10]-=keep*(dx*s+dz*c+pending.root[1]);
    for(let k=0;k<94;k++) {
      const o=k*12;
      const sign=shown[o+4]*target[o+4]+shown[o+5]*target[o+5]+shown[o+6]*target[o+6]+shown[o+7]*target[o+7]<0 ? -1 : 1;
      for(let j=4;j<11;j++) shown[o+j]=shown[o+j]*keep+(j<8 ? sign : 1)*target[o+j]*weight;
    }
    state.final=shown;
    state.skin=composePose(state,shown).skin;
  }
  return {reset,duration:sampler.duration,finish,
    sample(state,slot,bank,local,frame,blendWeight,transition) {
      const root=sampler.sample(slot,bank,local,frame,{blend:blendWeight,transition});
      state.pending=blendWeight===undefined ? null : {weight:blendWeight,root:[root[0]-state.root[0],root[2]-state.root[2]],aim:[]};
      compose(state,slot);
      state.root=root;
      return root;
    },
    /** Retail 0x132ab8: layer a procedural Euler rotation (degrees) on a named bone of the current pose, in place like the engine. */
    rotate(state,slot,id,euler) {
      applyBoneEuler(sampler.pose(slot),id,euler);
      state.pending?.aim.push([id,euler]);
      compose(state,slot);
    },
  };
}
