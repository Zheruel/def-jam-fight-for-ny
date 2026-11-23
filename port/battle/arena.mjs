import lineups from "./lineups.json" with {type:"json"};
import {decodeCollision} from "../collision/contact.mjs";

export async function loadArena(venue) {
  const url=new URL(`../collision/venues/${venue.file}.cli`,import.meta.url);
  const response=await fetch(url);
  if(!response.ok) throw Error("Unable to load collision for "+venue.name);
  return {venue,collision:await response.arrayBuffer()};
}

// Run the retail CLLI loader and spawn resolver. The browser owns this data
// window, which is separate from the starting state, actor buffers and stack.
export function installArena(kernel,{venue,collision},actors) {
  decodeCollision(collision);
  const {memory,call}=kernel;
  const base=0x1d00000;
  const starts=lineups[venue.file].SINGLE;
  memory.setUint32(0x4bbd34,venue.coreID,true);
  starts.flat().forEach((n,i)=>memory.setFloat32(0x4c2be8+128*venue.coreID+4*i,n,true));
  new Uint8Array(memory.buffer,memory.byteOffset+base,collision.byteLength).set(new Uint8Array(collision));
  memory.setUint32(0x444e00,base,true);
  call(0x2dff60,base,0,0,0);
  for(const actor of actors) call(0x2ede90,actor,0,0,0);
  for(const [i,actor] of actors.entries()) {
    const other=starts[1-i], [x,z]=starts[i];
    const yaw=Math.atan2(other[0]-x,other[1]-z)*180/Math.PI;
    memory.setFloat32(actor+0x54,yaw,true);
    memory.setFloat32(actor+0xd4,yaw,true);
    for(let j=0;j<3;j++) memory.setFloat32(actor+0xc4+j*4,memory.getFloat32(actor+0x44+j*4,true),true);
  }
}
