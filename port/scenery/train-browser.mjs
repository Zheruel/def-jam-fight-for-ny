// Browser check of the 125th Street Station train in the real battle page (headless Chrome, one page, no netplay):
// the kernel's train crosses the scenery behind the fighters with its retail timing and its sound starts when it arrives.
//   node port/scenery/train-browser.mjs        (NATIVE_SCREENSHOT=dir keeps a PNG at each stage)
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { chromium } from "../../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../../tools/serve.mjs";

const server = gameServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"], ...(process.platform === "darwin" && { channel: "chrome" }) });
  const page = await browser.newPage({ viewport: { width: 1024, height: 824 } });
  const errors = [], cues = [];
  // Fixture only: a HUD card image the page asks for and the checkout may not have yet gets a blank one.
  const blank = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEklEQVR4nGNgGAWjYBSMAggAAAQQAAFVN1rQAAAAAElFTkSuQmCC", "base64");
  await page.route("**/port/hud/screens/*.png", async route => {
    const response = await route.fetch();
    return response.status() === 404 ? route.fulfill({ body: blank, contentType: "image/png" }) : route.fulfill({ response });
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/\/port\/audio\/cues\//.test(request.url())) cues.push(request.url().split("/").pop()); });
  // Log every audio cue the page starts with the tick it was on: the cue's offset and length inside its bank file.
  await page.addInitScript(() => {
    window.__starts = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
      window.__starts.push({ tick: window.nativeBattle?.diagnostics().ticks, offset, duration, length: this.buffer?.duration });
      return start.apply(this, arguments);
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/port/battle/index.html?venue=V2BG_04A`);
  await page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 5, null, { timeout: 60000 });
  await page.mouse.click(500, 300);   // the first gesture starts audio
  const seen = {};
  for (const tick of [800, 900, 1010, 1060, 1125, 1190, 1260, 1400]) {
    await page.waitForFunction(n => nativeBattle.diagnostics().ticks >= n, tick, { timeout: 120000, polling: 20 });
    seen[tick] = await page.evaluate(() => {
      const state = nativeBattle.diagnostics();
      const car = state.environment?.dynamicWeapons?.find(w => w.train);
      return { ticks: state.ticks, car: car ? [car.model, Math.round(car.matrix[12])] : null, over: state.outcome?.over };
    });
    if (process.env.NATIVE_SCREENSHOT) writeFileSync(`${process.env.NATIVE_SCREENSHOT}/train-${tick}.png`, await page.locator("canvas").first().screenshot());
  }
  // Not in the tunnel before phase -0.7 (tick 825), then head at the playfield edge at the hit (tick 1000), centred at
  // phase 0.5 (tick 1125), tail out at phase 1 (tick 1250); gone when the cycle ends (tick 1375).
  assert.equal(seen[800].car, null);
  assert.equal(seen[900].car[0], "V2BG_04A_H");
  const xs = [900, 1010, 1060, 1125, 1190, 1260].map(tick => seen[tick].car[1]);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), "moves left to right");
  assert.ok(xs[1] < -160 && Math.abs(xs[3]) < 5 && xs[5] > 170, xs.join());
  assert.equal(seen[1400].car, null);
  assert.ok(Object.values(seen).every(s => !s.over), "nobody was in the pit");
  // The train sound: one cue of the "train" bank, five seconds from the start of its file, started with the train.
  const starts = await page.evaluate(() => window.__starts.filter(s => s.tick >= 940 && s.tick < 1100));
  assert.equal(starts.length, 1, JSON.stringify(starts));
  assert.deepEqual([starts[0].offset, starts[0].duration], [0, 5]);
  assert.ok(starts[0].tick >= 1001 && starts[0].tick <= 1010, "starts when the phase passes 0 (tick 1001): " + starts[0].tick);
  assert.ok(cues.includes("train.ogg"));
  assert.deepEqual(errors, []);
  console.log("train browser check ok", JSON.stringify({ xs, audioTick: starts[0].tick }));
} finally {
  await browser?.close();
  server.close();
}
