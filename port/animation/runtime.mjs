const ramSize = 0x2600000;
const rootAddress = 0x1e10000;
export async function instantiateSampler(source) {
  let query;
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const {exports:core} = await WebAssembly.instantiate(module,{env:{
    battle_fault(site,target) { throw Error(`Motion sampler fault in ${query} at ${site.toString(16)} accessing ${target.toString(16)}`); }
  }});
  core._initialize();
  const ram = new Uint8Array(core.memory.buffer,core.buffer(),ramSize);
  const memory = new DataView(ram.buffer,ram.byteOffset,ram.byteLength);
  const word = at => memory.getUint32(at,true);
  const float = at => memory.getFloat32(at,true);
  function pose(slot) {
    const character = word(0x471230+slot*4);
    return new Float32Array(ram.buffer,ram.byteOffset+word(character+0x17c),94*12);
  }
  return {ram,memory,pose,invoke:core.invoke,resetScratch:core.resetScratch,
    pages:new Uint8Array(ram.buffer,core.pages(),ramSize/4096),
    duration(slot,bank,clip) { query=`duration ${slot}/${bank}/${clip}`; return core.invoke(0x132c60,slot,bank,clip,0,0,0,0); },
    sample(slot,bank,clip,frame,{blend,transition=-1}={}) {
      query=`pose ${slot}/${bank}/${clip} frame ${frame}`;
      core.invoke(blend===undefined ? 0x132b48 : 0x132bb8,slot,bank,clip,rootAddress,transition,frame,blend??0);
      return [float(rootAddress),float(rootAddress+4),float(rootAddress+8),core.invoke(0x132c38,slot,0,0,0,0,0,0)];
    },
  };
}
