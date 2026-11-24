// Browser check of the retail versus score sheet between the result word and the REMATCH? card (port/hud/postmatch.mjs).
// A hosted match ends in a retail KO; the matchSm2 sheet appears on the host and on the guest's video, Enter dismisses it and
// the REMATCH? card follows, and a rematch brings the sheet back. Every fighter has a panel, a CPU's included, and the sheet
// follows a lone human's loss too (the reference capture of a person against a CPU shows it).
//   node verification/native-postmatch-browser.mjs        (NATIVE_SCREENSHOT=dir keeps PNGs)
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { attachNetplay } from "../netplay/server.mjs";
import { gameServer } from "../tools/serve.mjs";

const server = gameServer();
attachNetplay(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}/?p1=0x07000030&p2=0x07000025&venue=V2BG_02A`;
let browser;
// Pixels of the REMATCH? card's cream paper (screen rows 284..444), in the host canvas or the guest's video.
const paperCount = `async (source) => {
  const w = 640, h = 448, surface = new OffscreenCanvas(w,h), ctx = surface.getContext("2d");
  if (source instanceof Blob) ctx.drawImage(await createImageBitmap(source),0,0,w,h); else ctx.drawImage(source,0,0,w,h);
  const {data} = ctx.getImageData(200,284,240,160);
  let paper = 0;
  for (let i=0;i<data.length;i+=4) if (data[i]>225 && data[i+1]>205 && data[i+2]>160 && data[i+2]<225) paper++;
  return paper;
}`;
// A 32 x 24 luminance thumbnail of whatever the page presents: the sheet canvas or the guest's video.
const thumbnail = `(source) => {
  const surface = new OffscreenCanvas(32,24), ctx = surface.getContext("2d");
  ctx.drawImage(source,0,0,32,24);
  const {data} = ctx.getImageData(0,0,32,24);
  return Array.from({length:32*24},(_,i)=>(data[i*4]+data[i*4+1]+data[i*4+2])/3);
}`;
const distance = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
const errors = [];

async function scenario(name, query, { loser = 1, humans, outcomeWinner, cpuPanels = 0 }) {
  const open = () => browser.newPage({ viewport: { width: 1024, height: 824 } });
  const host = await open();
  host.on("pageerror", error => errors.push(name + ": " + error.message));
  const fight = readFileSync(new URL("../port/battle/fight.mjs", import.meta.url), "utf8");
  const hook = "globalThis.__spend=(slot,health=8)=>{memory.setFloat32(actorAddress(slot)+0x350,health,true);"
    + "memory.setFloat32(actorAddress(slot)+0x35c,health/memory.getFloat32(actorAddress(slot)+0x354,true),true);};\n  return { states, tick, restart,";
  await host.route("**/port/battle/fight.mjs", route => route.fulfill({ body: fight.replace("  return { states, tick, restart,", hook), contentType: "text/javascript" }));
  await host.goto(base + query);
  await host.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 5, undefined, { timeout: 90000 });
  // A match against a CPU has no seat for a guest (the room refuses to host it), so only the two-human match is hosted.
  let guest;
  if (humans > 1) {
    await host.locator("#host").click();
    await host.waitForFunction(() => document.querySelector("#code").value.length === 8);
    guest = await open();
    guest.on("pageerror", error => errors.push(name + " guest: " + error.message));
    await guest.goto(await host.locator("#invite").getAttribute("href"));
    await guest.waitForFunction(() => window.nativeBattle);
    await guest.waitForFunction(() => document.querySelector("#remote").videoWidth > 0 && nativeBattle.diagnostics().network === "connected");
  }

  async function playToResult() {
    await host.evaluate(async loser => {
      const buttons = [0x1000, 0x4000, 0x2000, 0x8000, 0x1100, 0x1400, 0x1800, 0x1200, 0x4400, 0x8100, 0x400, 0x800];
      let random = 17, held = [0, 0], changed = -99;
      const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
      window.finish = (async () => {
        try { for (;;) {
          await new Promise(requestAnimationFrame);
          const { actors, ticks, outcome } = nativeBattle.diagnostics();
          if (outcome.result) return outcome;
          globalThis.__spend(loser);
          const winner = 1 - loser, dx = actors[loser].position[0] - actors[winner].position[0], dz = actors[loser].position[2] - actors[winner].position[2], dist = Math.hypot(dx, dz);
          if (ticks - changed >= 18) { changed = ticks; held = [buttons[next() % buttons.length], buttons[next() % buttons.length]]; }
          // Seat 0 plays; a CPU seat plays itself. The loser seat stands still when a human.
          nativeBattle.setInput(winner, { buttons: dist > 10 ? 0x2000 : ticks - changed < 4 ? held[0] : 0, x: dist > 7 ? dx / dist : 0, z: dist > 7 ? -dz / dist : 0 });
          nativeBattle.setInput(loser, { buttons: 0, x: 0, z: 0 });
        } } catch (error) { window.finishError = String(error?.stack ?? error); }
      })();
    }, loser);
    await host.waitForFunction(() => nativeBattle.diagnostics().outcome.result, undefined, { timeout: 180000, polling: 500 }).catch(async error => {
      const d = await host.evaluate(() => { const x = nativeBattle.diagnostics(); return { ticks: x.ticks, frames: x.renderedFrames, paused: x.paused, health: x.actors.map(a => a.health), phase: x.outcome.phase, driver: window.finishError, post: window.nativePostmatch?.() }; });
      throw new Error(name + " no result: " + JSON.stringify(d), { cause: error });
    });
    await host.waitForFunction(() => nativeBattle.diagnostics().outcome.ticksSinceOver >= 130);
  }
  const sheet = () => host.evaluate(() => window.nativePostmatch?.());
  const hostCard = async () => { const png = await host.locator("canvas").last().screenshot(); return host.evaluate(`(async()=>(${paperCount})(await (await fetch("data:image/png;base64,${png.toString("base64")}")).blob()))()`); };
  const guestCard = () => guest ? guest.evaluate(`(${paperCount})(document.querySelector("#remote"))`) : Promise.resolve(Infinity);

  await playToResult();
  const result = await host.evaluate(() => nativeBattle.diagnostics().outcome);
  assert.equal(result.winner, outcomeWinner, name + " " + JSON.stringify(result));
  const shown = await sheet();
  let summary = { name, sheet: shown };
  {
    await host.waitForFunction(() => window.nativePostmatch?.().state === "shown", undefined, { timeout: 20000 });
    const view = await sheet();
    assert.equal(view.sheet, 2, name + " matchSm2");
    assert.equal(view.panels.length, 2);
    assert.equal(view.panels.filter(panel => panel.cpu).length, cpuPanels, name + " CPU panels");
    assert.ok(view.panels.some(panel => panel.winner), name + " a winner is marked");
    const winner = view.panels.find(panel => panel.winner);
    assert.equal(winner.slot, outcomeWinner);
    assert.ok(winner.score >= 0);
    // The guest sees the host's sheet canvas, not the match, and the REMATCH? card is not up yet.
    let theirs;
    if (guest) {
      await guest.waitForTimeout(1500);
      const mine = await host.evaluate(`(${thumbnail})(document.querySelector("canvas[aria-label='Match score sheet']"))`);
      theirs = await guest.evaluate(`(${thumbnail})(document.querySelector("#remote"))`);
      summary.guestDistance = distance(mine, theirs);
      assert.ok(summary.guestDistance < 18, `${name}: the guest's video shows the sheet (difference ${summary.guestDistance.toFixed(1)})`);
    }
    if (process.env.NATIVE_SCREENSHOT) writeFileSync(`${process.env.NATIVE_SCREENSHOT}/${name}-sheet.png`, await host.locator("canvas[aria-label='Match score sheet']").screenshot());
    // Enter dismisses it and the retail card follows on both sides.
    await host.keyboard.press("Enter");
    await host.waitForFunction(() => window.nativePostmatch?.().state === "done");
    assert.equal(await host.locator("canvas[aria-label='Match score sheet']").count(), 0);
    await host.waitForTimeout(800);
    if (guest) {
      const after = await guest.evaluate(`(${thumbnail})(document.querySelector("#remote"))`);
      assert.ok(distance(theirs, after) > 8, name + " the guest's video moved on from the sheet (" + distance(theirs, after).toFixed(1) + ")");
    }
    assert.ok(await hostCard() > 3000, name + " REMATCH? card on the host after the sheet");
    assert.ok(await guestCard() > 3000, name + " REMATCH? card on the guest after the sheet");
    // YES replays; the next result brings the sheet back and NO leaves.
    await host.keyboard.press("Enter");
    await host.waitForFunction(() => { const d = nativeBattle.diagnostics(); return !d.outcome.over && d.ticks < 60; });
    assert.equal((await sheet()).state, "idle");
    await playToResult();
    await host.waitForFunction(() => window.nativePostmatch?.().state === "shown", undefined, { timeout: 20000 });
    await host.keyboard.press("Enter");
    await host.waitForFunction(() => window.nativePostmatch?.().state === "done");
    await host.waitForTimeout(500);
    await host.keyboard.press("ArrowRight"); await host.keyboard.press("Enter");
    await host.waitForURL(u => !u.search);
  }
  await host.close(); await guest?.close();
  return summary;
}

try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
  const results = [];
  const only = process.env.ONLY;
  const scenarios = [["two-humans", "", { humans: 2, outcomeWinner: 0 }], ["one-human-wins", "&cpu=1", { humans: 1, outcomeWinner: 0, cpuPanels: 1 }],
    ["one-human-loses", "&cpu=1", { humans: 1, loser: 0, outcomeWinner: 1, cpuPanels: 1 }]];
  for (const [name, query, options] of scenarios) if (!only || only === name) results.push(await scenario(name, query, options));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results.map(r => ({ name: r.name, sheet: r.sheet?.sheet, guestDistance: r.guestDistance }))));
  console.log("The score sheet follows the result word, reaches the guest, gives way to the REMATCH? card and returns after a rematch, against a person and against a CPU, win or lose.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
