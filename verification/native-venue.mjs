import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../tools/serve.mjs";

const server = gameServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ ...(process.platform === "darwin" && { channel: "chrome" }), headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const requests = [];
  const errors = [];
  page.on("request", r => requests.push(new URL(r.url()).pathname));
  page.on("pageerror", e => errors.push(e.message));
  // Sample before the browser clears the default WebGL drawing buffer.
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function (...args) {
      original.apply(this, args);
      const w = this.drawingBufferWidth, h = this.drawingBufferHeight;
      const data = new Uint8Array(w * h * 4);
      this.readPixels(0, 0, w, h, this.RGBA, this.UNSIGNED_BYTE, data);
      const colors = new Set();
      let checksum = 0, visible = 0;
      for (let y = 0; y < h; y += 4) {
        for (let x = 0; x < w; x += 4) {
          const i = (y * w + x) * 4;
          const rgb = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
          colors.add(rgb);
          if (rgb !== (data[0] << 16 | data[1] << 8 | data[2])) visible++;
          checksum = (Math.imul(31, checksum) + rgb) | 0;
        }
      }
      window.drawSample = { colors: colors.size, visible, checksum };
    };
  });
  const url = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/port/viewer/index.html`;
  await page.goto(url);
  await page.waitForFunction(() => window.drawSample?.visible > 200 && window.drawSample.colors > 20);
  const initial = await page.evaluate(() => drawSample);
  await page.locator("canvas").press("ArrowRight");
  await page.waitForFunction(first => drawSample.checksum !== first, initial.checksum);
  // Exercise the independent Battle modules through browser module loading.
  const native = await page.evaluate(async () => {
    const { createBattleLineup } = await import("../battle/setup.mjs");
    const { getFighter } = await import("../assets/combat.mjs");
    const { applyHitChannelDelta } = await import("../combat/combat.mjs");
    const lineup = createBattleLineup("0x17000004", "SINGLE", ["0x07000030", "0x07000025"]);
    const channels = new Float32Array([20, 30, 15, 10, 2]);
    applyHitChannelDelta(channels, 2, -25);
    return { stage: lineup.background, moves: lineup.participants.map(p => getFighter(p.fighter).blazin.motionKey),
      channels: [...channels] };
  });
  assert.deepEqual(native, { stage: "V2BG_02A", moves: ["blazin_02", "blazin_04"], channels: [20, 30, 0, 10, 2] });
  assert.deepEqual(errors, []);
  assert.ok(requests.some(url => url.endsWith("/geometry/foundation.json")));
  assert.ok(requests.every(url => !/\.wasm$|\/runtime\/|\/game-assets\/|\.iso$/.test(url)),
    "Native rendering must run independently of the PS2 player");
  console.log(`Native Foundation render verified with ${initial.colors} sampled colors; camera rotation changed pixels.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
