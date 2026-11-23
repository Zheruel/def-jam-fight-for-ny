// WRES resources are shared between actors. Retail clip numbers select
// the owner's bank through their thousands digit, including paired motions.
export function installWrestlingBank(sampler,slot,bytes) {
  if(slot!==0 && slot!==1) throw RangeError("Invalid motion bank owner");
  const file=new DataView(bytes);
  const word=offset=>file.getUint32(offset,true);
  const size=word(4), count=word(8), relocations=word(12), start=36+4*relocations;
  if(file.getUint32(0)!==0x57523031 || start+size!==file.byteLength || size>0x300000)
    throw Error("Invalid wrestling motion bank");
  const base=0x2000000+slot*0x300000, ram=sampler.memory;
  sampler.ram.set(new Uint8Array(bytes,start,size),base);
  for(let i=0;i<relocations;i++) {
    const offset=word(36+4*i);
    if(offset>size-4) throw Error("Invalid motion relocation");
    const pointer=ram.getUint32(base+offset,true);
    if(pointer>=size) throw Error("Motion pointer outside bank");
    ram.setUint32(base+offset,base+pointer,true);
  }
  const character=ram.getUint32(0x471230+slot*4,true);
  const record=ram.getUint32(character+0xaeec,true)+44*slot;
  ram.setUint32(record+4,count,true);
  ram.setUint32(record+32,base+word(16),true);
  for(let i=0;i<4;i++) ram.setUint32(record+12+4*i,base+word(20+4*i),true);
  return count;
}
