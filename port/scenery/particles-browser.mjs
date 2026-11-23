// Browser check of the stage particles and the crowd occlusion fade in the real battle page (headless Chrome, no netplay):
// Red Hook's Inferno fire is drawn (orange fills the frame; with particles off it does not), the page raises no error, and the
// frame rate holds. Foundation: the fight start keeps the front row, and the render still runs with the fade on.
//   node port/scenery/particles-browser.mjs        (NATIVE_SCREENSHOT=dir keeps PNGs)
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "../../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../../tools/serve.mjs";

const root = new URL("../../", import.meta.url);
const server = gameServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
  const open = async (query, particles) => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 824 } });
    page.errors = [];
    page.on("pageerror", error => page.errors.push(error.message));
    page.on("response", response => { if (response.status() >= 400) page.errors.push(response.status() + " " + response.url()); });
    // The test hook only switches the particle layer off for the comparison; nothing else is substituted.
    await page.route("**/port/viewer/viewer.mjs", async route => {
      const text = readFileSync(new URL("port/viewer/viewer.mjs", root), "utf8");
      await route.fulfill({ contentType: "text/javascript", body: text.replace("scenery.render({viewProjection:projection,", `scenery.render({particles:${particles},viewProjection:projection,`) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
    await page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 200, null, { timeout: 120000 });
    return page;
  };
  // Share of the picture that is flame orange (red high, green mid, blue low).
  const orange = async page => page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + png)).blob());
    const surface = new OffscreenCanvas(320, 240), ctx = surface.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, 320, 240);
    const { data } = ctx.getImageData(0, 0, 320, 240);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 90 && data[i + 1] < 215 && data[i + 2] < 90) count++;
    return count / (320 * 240);
  }, (await page.locator("canvas").screenshot()).toString("base64"));
  const withFire = await open("mode=inferno&venue=V2BG_07A", true), without = await open("mode=inferno&venue=V2BG_07A", false);
  const [lit, dark] = [await orange(withFire), await orange(without)];
  if (process.env.NATIVE_SCREENSHOT) writeFileSync(`${process.env.NATIVE_SCREENSHOT}/inferno.png`, await withFire.locator("canvas").screenshot());
  assert.ok(lit > dark + 0.02, `flames add flame-coloured pixels (${dark.toFixed(3)} -> ${lit.toFixed(3)})`);
  const state = await withFire.evaluate(() => nativeBattle.diagnostics().environment);
  assert.ok(state.fire && state.fire.intensity === 1 && state.fire.radius === 57, JSON.stringify(state.fire));
  assert.equal(state.sight.length, 2);
  const frames = async page => { const a = await page.evaluate(() => nativeBattle.diagnostics().renderedFrames); await page.waitForTimeout(3000); return ((await page.evaluate(() => nativeBattle.diagnostics().renderedFrames)) - a) / 3; };
  const fps = await frames(withFire);
  assert.ok(fps > 40, `Inferno with flames runs at ${fps} fps`);
  assert.deepEqual(withFire.errors, []);
  assert.deepEqual(without.errors, []);
  const foundation = await open("venue=V2BG_02A", true);
  assert.equal((await foundation.evaluate(() => nativeBattle.diagnostics().environment)).fire, null);
  assert.deepEqual(foundation.errors, []);
  console.log(JSON.stringify({ orange: { particlesOff: dark, particlesOn: lit }, infernoFps: fps }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
