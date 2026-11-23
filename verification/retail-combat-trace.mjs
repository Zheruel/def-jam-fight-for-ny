// Test-only reference instrumentation. Never loaded by the native player.
export async function exposeReferenceMemory(page) {
  await page.route("**/web/runtime.mjs", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const init = "    vm = module;";
    if (!source.includes(init)) throw new Error("Reference VM setup changed");
    await route.fulfill({ response, body: source.replace(init, init + "\n    window.traceVM = module;") });
  });
}

export function startRetailTrace({memorySnapshots = false, poses = false} = {}) {
  const vm = window.traceVM;
  const signature = [0x8c830000, 0x3c02ff7f, 0x3442ffff, 0x03e00008];
  const heap = new Uint32Array(vm.HEAPU8.buffer);
  let base;
  for (let i = 0; i < heap.length - 4; i++) {
    if (heap[i] !== signature[0] || !signature.every((word, j) => heap[i+j] === word)) continue;
    const address = i * 4 - 0x360990;
    if (address < 0 || address + 0x2000000 > heap.byteLength) continue;
    // The two live actor slots contain valid motion banks and an active entity index.
    if ([0, 1].every(n => {
      const word = (address + 0x4bc170 + n*0x12f8) / 4;
      return heap[word+0x28/4] < 16 && heap[word+0x84/4] <= 1 && heap[word+0x80/4] > 0;
    })) { base = address; break; }
  }
  if (base === undefined) throw new Error("Could not locate active USA retail fighters in RAM");
  const snapshots = [];
  if (memorySnapshots) window.readRetailSnapshot = (index, offset) => {
    const bytes = snapshots[index].subarray(offset, offset+1048576);
    return bytes.toBase64();
  };
  const samples = [];
  const motionData = {};
  let last = -1;
  function capture() {
    const blank = vm._getVblanks();
    if (blank === last) return;
    if (memorySnapshots && [0,5].includes(samples.length) && snapshots.length === Number(samples.length > 0)) snapshots.push(vm.HEAPU8.slice(base,base+0x2000000));
    const view = new DataView(vm.HEAPU8.buffer);
    const f = a => view.getFloat32(base+a, true);
    const u = a => view.getUint32(base+a, true);
    const actors = [];
    for (let i = 0; i < 2; i++) {
      const a = 0x4bc170 + i * 0x12f8;
      const key = u(a+0x84) + "/" + u(a+0x8c);
      if (!motionData[key]) {
        motionData[key] = { duration: f(a+0xa0), end: f(a+0xa4), tick: f(0x4bbf94),
          words: Array.from({length:34}, (_,j) => u(a+0x2bc+j*4)) };
      }
      let pose;
      if (poses) {
        const character = u(0x471230 + i*4);
        const posePtr = u(character+0x17c);
        if (posePtr % 16 || !posePtr || posePtr + 94*48 > 0x2000000) throw new Error("Invalid live fighter pose");
        pose = new Uint8Array(vm.HEAPU8.buffer,base+posePtr,94*48).toBase64();
      }
      actors.push({
        pose, rootOffset: [f(a+0xac), f(a+0xb0), f(a+0xb4)], rootYaw: f(a+0xbc),
        renderedPosition: [f(a+0xc4), f(a+0xc8), f(a+0xcc)], renderedYaw: f(a+0xd4),
        inputWords: Array.from({length:7}, (_,j) => u(a+0x9e0+j*4)),
        rate: f(a+0xa8), end: f(a+0xa4), remaining: f(a+0xa0),
        state: u(a+0x30), previous: u(a+0x34), facing: f(a+0x54), flags: view.getUint16(base+a+0x91a,true),
        slot: u(a+0x28), modelIndex: u(a+0x2c), position: [f(a+0x44),f(a+0x48),f(a+0x4c)],
        action: u(a+0x80), bank: u(a+0x84), local: u(a+0x88), motion: u(a+0x8c),
        blendCounters: [u(a+0x94),u(a+0x98)], frame: f(a+0x9c), momentum: f(a+0x364),
        blazinTimer: f(a+0x368), channels: Array.from({length:5}, (_,j)=> f(a+0x820+j*4)),
      });
    }
    const pads = [vm._getPadReadback(0), vm._getPadReadback(1)];
    if (vm._getVblanks() !== blank) return;
    // SLUS-21004 camera subsystem: final eye, target and up passed to EAGL.
    const vector = address => [f(address),f(address+4),f(address+8)];
    const camera = {eye:vector(0x43d610),target:vector(0x43d620),up:vector(0x43d630)};
    samples.push({blank, pads, actors, camera});
    last = blank;
  }
  capture();
  const timer = setInterval(capture, 3);
  window.finishRetailTrace = () => { clearInterval(timer); return { samples, motionData }; };
}
