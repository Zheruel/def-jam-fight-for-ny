// Browser check of the round result: a hosted match ends in a retail KO, the result banner is drawn on the host and on
// the guest's received video, and Enter on the host starts a rematch that clears it again.
//   node verification/native-result-browser.mjs [url]       (NATIVE_SCREENSHOT=dir keeps PNGs of each stage)
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { attachNetplay } from "../netplay/server.mjs";
import { gameServer } from "../tools/serve.mjs";

const server = gameServer();
attachNetplay(server);
server.listen(0,"127.0.0.1");
await once(server,"listening");
const url = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/`;
let browser;
// Pixels of the banner's cream lettering inside the band it is drawn in (screen rows 160..288 of 448).
// Pixels of the REMATCH? card's cream paper (screen rows 284..444, the middle of the screen).
const paperCount = `async (source) => {
  const w = 640, h = 448, surface = new OffscreenCanvas(w,h), ctx = surface.getContext("2d");
  if (source instanceof Blob) ctx.drawImage(await createImageBitmap(source),0,0,w,h);
  else ctx.drawImage(source,0,0,w,h);
  const {data} = ctx.getImageData(200,284,240,160);
  let paper = 0;
  for (let i=0;i<data.length;i+=4) if (data[i]>225 && data[i+1]>205 && data[i+2]>160 && data[i+2]<225) paper++;
  return paper;
}`;
const inkCount = `async (source) => {
  const w = 640, h = 448, surface = new OffscreenCanvas(w,h), ctx = surface.getContext("2d");
  if (source instanceof Blob) ctx.drawImage(await createImageBitmap(source),0,0,w,h);
  else ctx.drawImage(source,0,0,w,h);
  const {data} = ctx.getImageData(0,160,w,128);
  let ink = 0;
  for (let i=0;i<data.length;i+=4) if (data[i]>222 && data[i]<240 && data[i+1]>215 && data[i+1]<232 && data[i+2]>196 && data[i+2]<220) ink++;
  return ink;
}`;
try {
  browser = await chromium.launch({headless:true,...(process.platform==="darwin" && {channel:"chrome"})});
  const open = () => browser.newPage({viewport:{width:1024,height:824}});
  const host = await open(), errors = [];
  host.on("pageerror",error => errors.push(error.message));
  // Fixture only: Playwright serves fight.mjs with a hook that leaves Doc (slot 1) nearly spent, so the check needs one
  // knockdown rather than a minutes-long brawl. The shipped module and the page expose nothing of the kind.
  const fight = readFileSync(new URL("../port/battle/fight.mjs",import.meta.url),"utf8");
  const hook = "globalThis.__spend=(slot,health=8)=>{memory.setFloat32(actorAddress(slot)+0x350,health,true);"
    + "memory.setFloat32(actorAddress(slot)+0x35c,health/memory.getFloat32(actorAddress(slot)+0x354,true),true);};\n  return { states, tick, restart,";
  assert.ok(fight.includes("  return { states, tick, restart,"));
  await host.route("**/port/battle/fight.mjs",route => route.fulfill({body:fight.replace("  return { states, tick, restart,",hook),contentType:"text/javascript"}));
  await host.goto(url);
  await host.waitForFunction(()=>window.nativeBattle?.diagnostics().ticks>5);
  await host.locator("#host").click();
  await host.waitForFunction(()=>document.querySelector("#code").value.length===8);
  const guest = await open();
  guest.on("pageerror",error => errors.push("guest: "+error.message));
  await guest.goto(await host.locator("#invite").getAttribute("href"));
  await guest.waitForFunction(()=>window.nativeBattle);
  await guest.waitForFunction(()=>document.querySelector("#remote").videoWidth>0 && nativeBattle.diagnostics().network==="connected");

  const count = (counter,source) => `(${counter})(${source})`;
  const shot = async (stage) => {
    const png = await host.locator("canvas").screenshot();
    if (process.env.NATIVE_SCREENSHOT) writeFileSync(`${process.env.NATIVE_SCREENSHOT}/${stage}.png`,png);
    const blob = `await (await fetch("data:image/png;base64,${png.toString("base64")}")).blob()`;
    return { host: await host.evaluate(`(async()=>${count(inkCount,blob)})()`), card: await host.evaluate(`(async()=>${count(paperCount,blob)})()`) };
  };
  const guestInk = () => guest.evaluate(count(inkCount,`document.querySelector("#remote")`));
  const guestCard = () => guest.evaluate(count(paperCount,`document.querySelector("#remote")`));
  const view = async stage => { const h = await shot(stage); return { host: h.host, card: h.card, guest: await guestInk(), guestCard: await guestCard() }; };
  const before = await view("1-fight");

  // Blaze brawls until the retail referee calls the match.
  await host.evaluate(async () => {
    const buttons=[0x1000,0x4000,0x2000,0x8000,0x1100,0x1400,0x1800,0x1200,0x4400,0x8100,0x400,0x800];
    let random=17, held=[0,0], changed=-99;
    const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
    window.finish = (async () => {
      try { for (;;) {
        await new Promise(requestAnimationFrame);
        const {actors,ticks,outcome}=nativeBattle.diagnostics();
        if (outcome.result) return outcome;
        globalThis.__spend(1);   // keep Doc under the 10% knockout line as he regenerates (ticks can skip while hosting)
        const dx=actors[1].position[0]-actors[0].position[0], dz=actors[1].position[2]-actors[0].position[2], dist=Math.hypot(dx,dz);
        if (ticks-changed>=18) { changed=ticks; held=[buttons[next()%buttons.length],buttons[next()%buttons.length]]; }   // ticks can skip frames, so no modulo test
        nativeBattle.setInput(0,{buttons:dist>10?0x2000:ticks-changed<4?held[0]:0,x:dist>7?dx/dist:0,z:dist>7?-dz/dist:0});
        nativeBattle.setInput(1,{buttons:0,x:0,z:0});
      } } catch (error) { window.finishError = String(error?.stack ?? error); }
    })();
  });
  await host.waitForFunction(()=>nativeBattle.diagnostics().outcome.result,undefined,{timeout:120000,polling:500}).catch(async error => {
    const d = await host.evaluate(()=>{const x=nativeBattle.diagnostics();return {ticks:x.ticks,frames:x.renderedFrames,paused:x.paused,network:x.network,health:x.actors.map(a=>a.health),pos:x.actors.map(a=>a.position.map(v=>Math.round(v))),act:x.actors.map(a=>a.action),state:x.actors.map(a=>a.state),clock:x.outcome.clock,phase:x.outcome.phase,status:document.querySelector("#status").textContent,driver:window.finishError};});
    throw new Error("No result: "+JSON.stringify(d),{cause:error});
  });
  const outcome = await host.evaluate(()=>nativeBattle.diagnostics().outcome);
  // The page's 30 second limit can call the match before Blaze lands the knockdown; both are retail finishes with a banner.
  assert.ok(["ko","time"].includes(outcome.method),JSON.stringify(outcome));
  assert.equal(outcome.winner,0);
  await host.waitForFunction(()=>nativeBattle.diagnostics().outcome.ticksSinceOver>=130);
  const after = await view("2-result");
  assert.ok(after.host>before.host+400,`result banner lettering on the host (${before.host} -> ${after.host})`);
  assert.ok(after.guest>before.guest+150,`result banner reaches the guest's video (${before.guest} -> ${after.guest})`);
  assert.ok(after.card>before.card+3000,`retail REMATCH? card on the host (${before.card} -> ${after.card})`);
  assert.ok(after.guestCard>before.guestCard+3000,`retail REMATCH? card on the guest (${before.guestCard} -> ${after.guestCard})`);

  // NO closes the card (the match stays over); YES, the default choice, starts the rematch.
  await host.locator("canvas").click();
  await host.keyboard.press("ArrowRight");
  await host.keyboard.press("Enter");
  await host.waitForTimeout(400);
  const declined = await view("3-declined");
  assert.ok(await host.evaluate(()=>nativeBattle.diagnostics().outcome.over),"NO keeps the result up");
  assert.ok(declined.card<before.card+1500,`card closed after NO (${declined.card})`);
  await host.keyboard.press("Enter");
  await host.waitForFunction(()=>{const d=nativeBattle.diagnostics();return !d.outcome.over && d.ticks<60;});
  const reset = await host.evaluate(()=>nativeBattle.diagnostics());
  assert.equal(reset.outcome.phase,1);
  reset.actors.forEach(a=>assert.equal(a.health,a.maxHealth));
  await host.waitForTimeout(500);
  const cleared = await view("4-rematch");
  assert.ok(cleared.host<before.host+150,`banner gone after the rematch on the host (${cleared.host})`);
  assert.ok(cleared.guest<before.guest+150,`banner gone after the rematch on the guest (${cleared.guest})`);
  assert.ok(cleared.card<before.card+1500&&cleared.guestCard<before.guestCard+1500,"card gone after the rematch");
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({before,after,declined,cleared,finishedAtTick:outcome.ticksSinceOver}));
  console.log("A hosted match ended in a KO, showed the result banner to host and guest, and a rematch cleared it.");
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
