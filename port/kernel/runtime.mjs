// The WASM contains statically linked rules. Host services provide poses, audio
// and other engine callbacks as those boundaries are recovered.
export async function instantiateBattle(source, engine) {
  let core, memory, registers;
  const hex = address => "0x" + (address >>> 0).toString(16);
  const arg = i => registers.getUint32(i * 16, true);
  const float = i => registers.getFloat32(512 + i * 4, true);
  const result = n => registers.setBigInt64(32, BigInt(n), true);
  const fpResult = n => registers.setFloat32(512,n,true);
  const env = {
    battle_fault(site, address) { throw new Error(`Battle memory fault at ${hex(site)} accessing ${hex(address)}`); },
    memcpy(dst,src,count) {
      new Uint8Array(core.memory.buffer).copyWithin(dst,src,src+count);
      return dst;
    },
    battle_service(site, target) {
      switch (target) {
        case 0x35e458: return registers.setFloat64(32,float(12),true);
        case 0x3608a8: return;
        // The host owns this audio context on a single JS thread. Both native
        // audio lock wrappers return zero after acquiring/releasing the lock.
        case 0x2577a8:
        case 0x257808: return result(0);
        case 0x346b54: {
          const address = arg(4), count = arg(6);
          new Uint8Array(memory.buffer,memory.byteOffset+address,count).fill(arg(5)&255);
          return result(address);
        }
        case 0x340500: return fpResult(Math.cos(float(12)));
        case 0x3406f0: return fpResult(Math.sin(float(12)));
        case 0x340fe8: return fpResult(Math.atan2(float(12),float(13)));
        case 0x133070: return engine.damage?.(arg(4),arg(5));
        case 0x132a28: return engine.writeBone(arg(5),arg(6),arg(4),memory);
        case 0x132b48:
        case 0x132bb8: {
          const offset = engine.sample(arg(4),arg(5),arg(6),float(12),target === 0x132bb8 ? float(13) : undefined,arg(8)|0);
          for (let i=0;i<3;i++) memory.setFloat32(arg(7)+i*4,offset[i],true);
          return;
        }
        case 0x132c38: return fpResult(engine.rootYaw(arg(4)));
        case 0x132c60: return fpResult(engine.duration(arg(4),arg(5),arg(6)));
        case 0x132b00: return engine.place(arg(4),arg(5),arg(6),memory);
        case 0x132ab8: return engine.rotateBone(arg(4),arg(5),arg(6),memory);
        default: throw new Error(`Missing Battle service ${hex(target)} called at ${hex(site)}`);
      }
    },
  };
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  core = (await WebAssembly.instantiate(module,{env})).exports;
  memory = new DataView(core.memory.buffer,core.battle_data(),0x2000000);
  registers = new DataView(core.memory.buffer,core.battle_context());
  return { memory, observedPages: new Uint8Array(core.memory.buffer,core.battle_pages(),8192), call: core.battle_call, tick: () => core.battle_call(0x2dbdd0,0,0,0,0) };
}
