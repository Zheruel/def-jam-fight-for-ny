// Check the crowd pose recorder without an emulator: a stub `referenceVm` holds a saved Foundation RAM image whose frame counter and
// spectator poses advance on a timer, as the retail game's do. The recorder must find the spectators, keep one sample per counter
// value, list the frames it missed and drop torn copies.
//   node verification/crowd-recorder-check.mjs [ram.bin]      (default private/ps2-battle/four-start/start-70.bin)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { FRAME_COUNTER, startCrowdRecording, finishCrowdRecording, packCrowdRecording } from "../ps2/battle/e2e/crowd-recorder.mjs";

const ram = readFileSync(path.resolve(process.argv[2] ?? "private/ps2-battle/four-start/start-70.bin"));
const browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
try {
  const page = await browser.newPage();
  await page.route("**/ram.bin", route => route.fulfill({ body: ram, contentType: "application/octet-stream" }));
  await page.route("**/", route => route.fulfill({ body: "<!doctype html><title>stub</title>", contentType: "text/html", headers: {"Cross-Origin-Opener-Policy":"same-origin", "Cross-Origin-Embedder-Policy":"require-corp"} }));
  await page.goto("http://127.0.0.1:9/");   // intercepted
  await page.evaluate(async counter => {
    const source = await (await fetch("/ram.bin")).arrayBuffer();
    const image = new Uint8Array(new SharedArrayBuffer(source.byteLength));
    image.set(new Uint8Array(source));
    window.referenceVm = { HEAPU8: image };
    const view = new DataView(image.buffer);
    // The emulator thread: a frame every 16 ms; the first spectator's root height and the counter move with it.
    // Every tenth step skips a frame, every 17th writes the counter late (a torn copy).
    const found = [];
    for (let at = 0x571000; at < 0x575000; at++) if (image[at] === 0x63 && String.fromCharCode(...image.subarray(at, at + 6)) === "crowd_") { found.push(view.getUint32(view.getUint32(at + 0x8c, true) + 0x14c, true)); at += 20; }
    let frame = view.getUint32(counter, true), n = 0;
    window.truth = [];
    setInterval(() => {
      n++;
      frame += n % 10 === 0 ? 2 : 1;
      for (const [i, at] of found.entries()) view.setFloat32(at + 40, frame / 1000 + i, true);   // root translation y
      view.setUint32(counter, frame, true);
      window.truth.push(frame);
    }, 16);
  }, FRAME_COUNTER);
  const info = await startCrowdRecording(page, { frames: 60 });
  assert.equal(info.names.length, 26);
  await page.waitForFunction(() => !window.crowdRecording.running, null, { timeout: 30000 });
  const recording = await finishCrowdRecording(page);
  assert.equal(recording.counters.length, 60);
  assert.deepEqual(recording.counters, [...recording.counters].sort((a, b) => a - b));
  assert.ok(new Set(recording.counters).size === 60, "one sample per counter value");
  // Every sample's pose matches the counter it was taken at: root y = counter/1000 + instance index.
  const stride = 26 * 13 * 7;
  recording.counters.forEach((counter, f) => {
    if (f === 0) return;   // sampled before the stub's first frame
    for (const i of [0, 7, 25]) assert.ok(Math.abs(recording.data[f * stride + i * 91 + 6] - (counter / 1000 + i)) < 1e-3, `frame ${f} instance ${i}`);
  });
  // Skipped frames (the stub skips every tenth) are reported, not silently joined.
  assert.ok(recording.gaps.length >= 3 && recording.gaps.every(([a, b]) => b > a + 1), JSON.stringify(recording.gaps));
  const packed = packCrowdRecording(recording);
  assert.equal(packed.subarray(0, 4).toString(), "DJCR");
  const header = JSON.parse(packed.subarray(8, 8 + packed.readUInt32LE(4)).toString());
  assert.equal(header.frames, 60);
  console.log("crowd recorder ok", JSON.stringify({ frames: header.frames, gaps: recording.gaps.length, torn: recording.torn, bytes: packed.length }));
} finally { await browser.close(); }
