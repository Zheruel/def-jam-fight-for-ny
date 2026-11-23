// Drive the production frame loop with high-refresh timestamps on a high-DPI viewport.
import assert from "node:assert/strict";
import {once} from "node:events";
import {chromium} from "../netplay/node_modules/playwright/index.mjs";
import {gameServer} from "../tools/serve.mjs";

const server = gameServer().listen(0,"127.0.0.1");
await once(server,"listening");
let browser;
try {
  browser = await chromium.launch({headless:true,...(process.platform==="darwin" && {channel:"chrome"})});
  const page = await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:2});
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => {
      if (callback.name !== "frame") return request(callback);
      window.nextMatchFrame = callback;
      return 1;
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.nativeBattle && window.nextMatchFrame);
  for (const hz of [120,144]) {
    const result = await page.evaluate(hz => {
      document.querySelector("#restart").click();
      const initial = nativeBattle.diagnostics();
      for (let i=0;i<=hz*2;i++) {
        const next = window.nextMatchFrame;
        window.nextMatchFrame = null;
        next(i*1000/hz);
      }
      const {ticks,renderedFrames,paused} = nativeBattle.diagnostics();
      const canvas = document.querySelector("canvas");
      return {ticks,frames:renderedFrames-initial.renderedFrames,paused,size:[canvas.width,canvas.height]};
    },hz);
    assert.deepEqual([result.ticks,result.frames,result.paused],[120,120,false]);
    assert.ok(result.size[0] <= 1280 && result.size[1] <= 960);
    console.log(`${hz} Hz: ${result.frames} draws in 2 simulated seconds at ${result.size.join(" × ")}.`);
  }
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
