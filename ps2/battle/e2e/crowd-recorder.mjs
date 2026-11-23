// Per-VBlank recorder of the Foundation spectators' poses for the headless reference harness (no RAM dumps).
//
//   import { startCrowdRecording, finishCrowdRecording } from "./crowd-recorder.mjs";
//   await startCrowdRecording(run.page, { frames: 900 });     // once the match is up (referee phase 1)
//   ... run.waitFrames(...)                                    // the recorder samples on its own
//   const recording = await finishCrowdRecording(run.page);   // { names, counters, gaps, torn, data: Float32Array }
//
// The game keeps a frame counter at EE 0x4a2d8c (one per VBlank; the only word in the four-player start captures that rose by
// exactly the captured frame gaps). Each sample reads the counter, copies the current-pose buffer of every `crowd_*`
// instance (13 bones x quaternion xyzw + translation xyz), reads the counter again and keeps the sample only when it did not
// move, so a copy that raced the emulator thread is dropped and counted in `torn`. Frames the page missed are listed in
// `gaps`. Layout (see port/scenery/crowd_pose.py): record `crowd_*` at 0x571000.. -> u32[record+0x8c] = object ->
// u32[object+0x14c] = current pose (13 x 48 bytes: scale xyz 1, quat xyzw, trans xyz 1).
// The sampler runs on the page's main thread with setTimeout(0) (about 250 samples a second against 60 frames).

export const FRAME_COUNTER = 0x4a2d8c;

/** Runs in the page. */
function install({ frames, counter }) {
  const vm = window.referenceVm;
  const signature = [0x8c830000, 0x3c02ff7f, 0x3442ffff, 0x03e00008];
  let words = new Uint32Array(vm.HEAPU8.buffer), base = -1;
  for (let i = 0; i < words.length && base < 0; i++) {
    if (words[i] !== signature[0] || !signature.every((n, j) => words[i + j] === n)) continue;
    const candidate = i * 4 - 0x360990;
    if (candidate >= 0 && candidate + 0x2000000 <= vm.HEAPU8.length && words[(candidate + 0x471230) / 4] === 0x445330) base = candidate;
  }
  if (base < 0) throw new Error("EE RAM base not found");
  const view = () => new DataView(vm.HEAPU8.buffer);   // the heap can be replaced when it grows
  const u32 = at => view().getUint32(base + at, true);
  const heap = new Uint8Array(vm.HEAPU8.buffer);
  const found = [];
  for (let at = 0x571000; at < 0x575000; at++) {
    if (heap[base + at] !== 0x63 || heap[base + at + 1] !== 0x72 || String.fromCharCode(...heap.subarray(base + at, base + at + 6)) !== "crowd_") continue;
    let end = at;
    while (heap[base + end]) end++;
    const object = u32(at + 0x8c);
    if (!object || object > 0x1fffe00) continue;
    const [current, previous, reference] = [0x14c, 0x150, 0x154].map(o => u32(object + o));
    if (!current || !previous || !reference || new Set([current, previous, reference]).size !== 3) continue;
    const addresses = [current, previous, reference].sort((a, b) => a - b);
    if (addresses[1] - addresses[0] !== 0x280 || addresses[2] - addresses[1] !== 0x280) continue;
    found.push({ name: String.fromCharCode(...heap.subarray(base + at, base + end)), object });
    at = end;
  }
  if (!found.length) throw new Error("no crowd instances found: is the match up?");
  const stride = found.length * 13 * 7;
  const state = window.crowdRecording = { names: found.map(f => f.name), counters: [], gaps: [], torn: 0, chunks: [], running: true, stride, base };
  let last = null, chunk = null, used = 0;
  const out = new Float32Array(stride);
  const sample = () => {
    if (!state.running) return;
    const before = u32(counter);
    if (before !== last) {
      const dv = view();
      let n = 0;
      for (const { object } of found) {
        const current = dv.getUint32(base + object + 0x14c, true);
        for (let bone = 0; bone < 13; bone++) {
          const at = base + current + bone * 48 + 16;
          for (let k = 0; k < 7; k++) out[n++] = dv.getFloat32(at + k * 4, true);
        }
      }
      if (u32(counter) !== before) state.torn++;
      else {
        if (last !== null && before !== last + 1) state.gaps.push([last, before]);
        last = before;
        state.counters.push(before);
        if (!chunk || used === 64) { chunk = new Float32Array(64 * stride); state.chunks.push(chunk); used = 0; }
        chunk.set(out, used++ * stride);
        if (state.counters.length >= frames) { state.running = false; return; }
      }
    }
    setTimeout(sample, 0);
  };
  setTimeout(sample, 0);
  return { names: state.names, base };
}

/** Runs in the page: how many frames are recorded and whether it is still running. */
function progress() { const s = window.crowdRecording; return { frames: s.counters.length, running: s.running, torn: s.torn, gaps: s.gaps.length }; }

/** Runs in the page: the next 1 MiB of the recording as base64. */
function slice({ offset, size }) {
  const s = window.crowdRecording;
  const bytes = new Uint8Array(size);
  const chunkBytes = 64 * s.stride * 4;
  for (let written = 0; written < size;) {
    const at = offset + written;
    const start = at % chunkBytes;
    const count = Math.min(chunkBytes - start, size - written);
    bytes.set(new Uint8Array(s.chunks[Math.floor(at / chunkBytes)].buffer, start, count), written);
    written += count;
  }
  return bytes.toBase64();
}

export async function startCrowdRecording(page, { frames = 900, counter = FRAME_COUNTER } = {}) {
  return page.evaluate(install, { frames, counter });
}

export async function crowdRecordingProgress(page) { return page.evaluate(progress); }

/** Stops the recorder and returns the recording: `data` is Float32Array[frame][instance][bone][qx qy qz qw tx ty tz]. */
export async function finishCrowdRecording(page) {
  await page.evaluate(() => { window.crowdRecording.running = false; });
  await new Promise(resolve => setTimeout(resolve, 50));
  const meta = await page.evaluate(() => { const s = window.crowdRecording; return { names: s.names, counters: s.counters, gaps: s.gaps, torn: s.torn, stride: s.stride }; });
  const frames = meta.counters.length, bytes = frames * meta.stride * 4;
  const parts = [];
  for (let offset = 0; offset < bytes; offset += 1 << 20) parts.push(Buffer.from(await page.evaluate(slice, { offset, size: Math.min(1 << 20, bytes - offset) }), "base64"));
  const joined = Buffer.concat(parts);
  const data = new Float32Array(joined.buffer.slice(joined.byteOffset, joined.byteOffset + bytes));
  return { names: meta.names, counters: meta.counters, gaps: meta.gaps, torn: meta.torn, data };
}

/** The gzip file layout: "DJCR", u32 header length, JSON header, then the float32 frames. */
export function packCrowdRecording({ names, counters, gaps, torn, data }) {
  const header = Buffer.from(JSON.stringify({ format: "def-jam-ps2-crowd-recording/1", venue: "V2BG_02A", names, frames: counters.length,
    counters, gaps, torn, entry: "frame x instance x 13 bones x [qx qy qz qw tx ty tz], local to the parent",
    bones: ["root", "L_Leg1", "L_Leg2", "eff5", "R_Leg1", "R_Leg2", "eff4", "Chest", "Head", "R_Arm1", "R_Arm2", "L_Arm1", "L_Arm2"] }));
  const pad = Buffer.alloc((4 - header.length % 4) % 4, 0x20), size = Buffer.alloc(4);
  size.writeUInt32LE(header.length + pad.length);
  return Buffer.concat([Buffer.from("DJCR"), size, header, pad, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
}
