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

export function startRetailTrace() {
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
  const samples = [];
  let last = -1;
  function capture() {
    const blank = vm._getVblanks();
    if (blank === last) return;
    const view = new DataView(vm.HEAPU8.buffer);
    const f = a => view.getFloat32(base+a, true);
    const u = a => view.getUint32(base+a, true);
    const actors = [];
    for (let i = 0; i < 2; i++) {
      const a = 0x4bc170 + i * 0x12f8;
      actors.push({
        slot: u(a+0x28), modelIndex: u(a+0x2c), position: [f(a+0x44),f(a+0x48),f(a+0x4c)],
        action: u(a+0x80), bank: u(a+0x84), local: u(a+0x88), motion: u(a+0x8c),
        blendCounters: [u(a+0x94),u(a+0x98)], frame: f(a+0x9c), momentum: f(a+0x364),
        blazinTimer: f(a+0x368), channels: Array.from({length:5}, (_,j)=> f(a+0x820+j*4)),
      });
    }
    const pads = [vm._getPadReadback(0), vm._getPadReadback(1)];
    if (vm._getVblanks() !== blank) return;
    samples.push({blank, pads, actors});
    last = blank;
  }
  capture();
  const timer = setInterval(capture, 3);
  window.finishRetailTrace = () => { clearInterval(timer); return samples; };
}
