// A real browser host and guest pause one match. Native time and health stay still until either resumes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../tools/serve.mjs";
import { attachNetplay } from "../netplay/server.mjs";

const server = gameServer();
attachNetplay(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({headless:true,...(process.platform === "darwin" && {channel:"chrome"})});
  const origin = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/`;
  const host = await browser.newPage({viewport:{width:1024,height:824}});
  const errors = [];
  host.on("pageerror", e => errors.push(e.message));
  host.on("response", response => {
    if(response.status()>=400 && !response.url().endsWith("favicon.ico")) errors.push(response.status()+" "+response.url());
  });
  await host.goto(new URL("?mode=1v1",origin).href);
  await host.waitForFunction(()=>window.nativeBattle?.diagnostics().ticks > 5);
  await host.locator("#host").click();
  await host.waitForFunction(()=>document.querySelector("#code").value.length === 8);
  const guest = await browser.newPage();
  await guest.goto(await host.locator("#invite").getAttribute("href"));
  await guest.waitForFunction(()=>document.querySelector("#remote").videoWidth > 0);
  async function stable() {
    const state = () => host.evaluate(()=>{ const d=nativeBattle.diagnostics(); return [d.ticks,d.actors.map(a=>[a.health,a.position])]; });
    const before = await state();
    await host.waitForTimeout(350);
    assert.deepEqual(await state(), before);
  }
  const loaded = host.waitForResponse(r => r.url().endsWith("/port/hud/pause.png") && r.ok());
  await host.keyboard.press("Escape");
  await loaded;
  await host.waitForFunction(()=>nativeBattle.diagnostics().pause?.row === 0);
  if (process.env.NATIVE_SCREENSHOT) {
    await host.waitForTimeout(600);
    await host.locator("main canvas").screenshot({path:process.env.NATIVE_SCREENSHOT});
  }
  // The paper panel must travel in the room video as well as appearing on the host canvas.
  await guest.waitForFunction(() => {
    const canvas = new OffscreenCanvas(640,480), ctx = canvas.getContext("2d");
    ctx.drawImage(document.querySelector("#remote"),0,0,640,480);
    const {data} = ctx.getImageData(120,209,395,61);
    let cream = 0;
    for(let i=0;i<data.length;i+=4) if(data[i]>160 && data[i+1]>145 && data[i+2]>98 && data[i]>data[i+2]+16) cream++;
    return cream > 7500;
  },null,{timeout:12000});

  await stable();
  for(const key of ["ArrowLeft","ArrowLeft","ArrowDown","ArrowRight","ArrowDown","ArrowLeft"]) await host.keyboard.press(key);
  assert.deepEqual(await host.evaluate(()=>nativeBattle.diagnostics().pause.levels),[82,88,84]);
  await host.keyboard.press("Escape");
  await host.waitForFunction(()=>!nativeBattle.diagnostics().paused);
  await guest.locator("h1").click();
  await guest.keyboard.down("Escape");
  await host.waitForFunction(()=>nativeBattle.diagnostics().paused);
  await guest.keyboard.up("Escape");
  await stable();
  await guest.keyboard.down("Escape");
  await host.waitForFunction(()=>!nativeBattle.diagnostics().paused);
  await guest.keyboard.up("Escape");
  await host.keyboard.press("Escape");
  for(let i=0;i<4;i++) await host.keyboard.press("ArrowDown");
  await host.keyboard.press("Enter");
  await host.waitForFunction(()=>nativeBattle.diagnostics().pause.confirming);
  await host.keyboard.press("Enter");
  assert.equal(await host.evaluate(()=>nativeBattle.diagnostics().pause.confirming),false);
  await host.keyboard.press("Enter");
  await host.keyboard.press("ArrowLeft");
  await host.keyboard.press("Enter");
  await host.waitForSelector("canvas[aria-label='Choose fighter and venue']");
  assert.deepEqual(errors,[]);
  console.log("Host and guest each paused and resumed. The simulation held its state, three sound levels changed independently, and confirming Quit returned to match selection.");
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
