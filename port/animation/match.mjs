import { instantiateSampler } from "./runtime.mjs";
import { installWrestlingBank } from "./banks.mjs";
import { composePose } from "../fighters/pose.mjs";
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
  return {reset,duration:sampler.duration,
    sample(state,slot,bank,local,frame,blend,transition) {
      const root=sampler.sample(slot,bank,local,frame,{blend,transition});
      const pose=composePose(state,sampler.pose(slot));
      state.skin=pose.skin;
      state.root=root;
      return root;
    },
  };
}
