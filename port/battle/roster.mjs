// The engine indexes WPAR and WWAZ by FIGHTER.XML coreID minus one.
// MAIN_ALL.DAT contains the common move data and all 141 fighter tables.
const RULES_BASE=0xd7ab80;
const ACTOR_BASE=0x4bc170;
const ACTOR_BYTES=0x12f8;
export function loadMatchRules(kernel,bytes) {
  if(bytes.byteLength!==282904 || new DataView(bytes).getUint32(0)!==0x57415a41) throw Error("Invalid retail match rules");
  const memory=kernel.memory;
  new Uint8Array(memory.buffer,memory.byteOffset+RULES_BASE,bytes.byteLength).set(new Uint8Array(bytes));
  kernel.call(0x2db790,RULES_BASE,0,0,0);
}
export function initializeFighterProfile(kernel,slot,record) {
  const id=record.fighterXml.coreID-1;
  if(!Number.isInteger(slot) || slot<0 || slot>3 || !Number.isInteger(id) || id<0 || id>=141) throw RangeError("Unknown Battle participant");
  const actor=ACTOR_BASE+slot*ACTOR_BYTES, memory=kernel.memory;
  memory.setUint32(0x4bbd68+slot*4,id,true);
  memory.setUint32(actor+0x28,slot,true);
  memory.setUint32(actor+0x2c,id,true);
  kernel.call(0x2eddb8,actor,0,0,0);
  kernel.call(0x2ddc90,actor,0,0,0);
  return {
    stats:Array.from({length:7},(_,i)=>memory.getInt32(actor+0xb34+i*4,true)),
    maxHealth:memory.getFloat32(actor+0x354,true),
    profile:new Uint8Array(memory.buffer,memory.byteOffset+actor+0xae4,0xe8).slice(),
  };
}
