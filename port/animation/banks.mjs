function relocateBank(sampler,bytes,base,limit) {
  const file=new DataView(bytes);
  const word=offset=>file.getUint32(offset,true);
  const size=word(4), count=word(8), relocations=word(12), start=36+4*relocations;
  if(file.getUint32(0)!==0x57523031 || start+size!==file.byteLength || size>limit)
    throw Error("Invalid motion bank");
  const ram=sampler.memory;
  sampler.ram.set(new Uint8Array(bytes,start,size),base);
  for(let i=0;i<relocations;i++) {
    const offset=word(36+4*i);
    if(offset>size-4) throw Error("Invalid motion relocation");
    const pointer=ram.getUint32(base+offset,true);
    if(pointer>=size) throw Error("Motion pointer outside bank");
    ram.setUint32(base+offset,base+pointer,true);
  }
  return {count, object:base+word(16), tables:[20,24,28,32].map(offset=>base+word(offset))};
}

// WRES resources are shared between actors. Retail clip numbers select
// the owner's bank through their thousands digit, including paired motions.
export function installWrestlingBank(sampler,slot,bytes) {
  if(!Number.isInteger(slot) || slot<0 || slot>3) throw RangeError("Invalid motion bank owner");
  const ram=sampler.memory;
  const character=ram.getUint32(0x471230+slot*4,true);
  if(!character || !ram.getUint32(character+0xaeec,true)) throw RangeError("Missing motion bank owner");
  const {count,object,tables}=relocateBank(sampler,bytes,0x2000000+slot*0x100000,0x100000);
  const record=ram.getUint32(character+0xaeec,true)+44*slot;
  ram.setUint32(record+4,count,true);
  ram.setUint32(record+32,object,true);
  for(let i=0;i<4;i++) ram.setUint32(record+12+4*i,tables[i],true);
  return count;
}

// The BASE00 manager indexes its streamed tail (clips 709..872) separately.
// Retail 0x1a6210 scans 24-byte directory entries and caches the last match.
// The four parallel tables and 12-byte handles are shared by both characters.
export function installSignatureClips(sampler,clips) {
  const ram=sampler.memory;
  const word=address=>ram.getUint32(address,true);
  const put=(address,value)=>ram.setUint32(address,value,true);
  const character=word(0x471230);
  const manager=word(character+0xaed8);
  const directory=word(manager+0x14), handles=word(manager+0x28);
  if(clips.size>word(manager+0x38) || clips.size>8) throw RangeError("Too many signature clips for this match");
  put(manager+0x2c,clips.size);
  put(manager+0x48,0xffffffff);
  put(manager+0x4c,0xffffffff);
  let index=0;
  for(const [clip,bytes] of clips) {
    if(!Number.isInteger(clip)||clip<709||clip>=873) throw RangeError("Unknown signature clip");
    const {count,object,tables}=relocateBank(sampler,bytes,0x2400000+index*0x10000,0x10000);
    if(count!==1) throw Error("Expected an individual signature animation");
    put(directory+24*index,clip);
    put(directory+24*index+4,index);
    put(handles+12*index+4,object);
    put(handles+12*index+8,1);
    for(const [j,source] of tables.entries()) {
      const stride=j<2?16:12, target=word(manager+0x18+4*j)+index*stride;
      sampler.ram.copyWithin(target,source,source+stride);
    }
    index++;
  }
}
