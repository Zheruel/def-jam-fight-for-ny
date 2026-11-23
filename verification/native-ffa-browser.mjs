// Browser check of four-fighter Free For All, run headless with scripted input: selection and query schema, one-on-one
// still working, four pads 0..3, the four-seat HUD, a hosted match shared with three isolated guests, and a guest
// rejoining its seat. It needs the shipped four-body assets (port/kernel/four-start.gz, port/animation/four-shared.gz);
// a missing one fails the run.
//   node verification/native-ffa-browser.mjs                       local server (127.0.0.1)
//   node verification/native-ffa-browser.mjs --url=https://host/path/   a deployed build (or FFA_URL=...), four people
//                                                                   over its own signaling; Free For All must be enabled there
// Local runs also read the pad records through a read-only hook added to a copy of fight.mjs by Playwright; the shipped
// module and the page expose nothing of the kind. Against a deployed build seats are checked by moving fighters instead.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { attachNetplay } from "../netplay/server.mjs";
import { gameServer } from "../tools/serve.mjs";

const flag = process.argv.find(argument => argument.startsWith("--url="))?.slice(6) ?? process.env.FFA_URL;
const pub = flag ? new URL(flag.endsWith("/") || /\.\w+$/.test(flag) ? flag : flag + "/") : null;
for (const asset of ["kernel/four-start.gz", "animation/four-shared.gz"]) {
  assert.ok(existsSync(new URL("../port/" + asset, import.meta.url)), `missing four-body asset port/${asset}`);
}
let server, base;
if (pub) base = pub.origin + pub.pathname.replace(/[^/]*$/, "");
else {
  server = gameServer();
  attachNetplay(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/`;
}
const shots = new URL("../private/ffa-browser/", import.meta.url);
mkdirSync(shots, { recursive: true });
let browser;
const errors = [], report = {};

const fight = readFileSync(new URL("../port/battle/fight.mjs", import.meta.url), "utf8");
const hook = "globalThis.__pads=()=>pads.map(p=>[word(p),scalar(p+8),scalar(p+12)]);\n  return { states, tick, restart,";
assert.ok(fight.includes("  return { states, tick, restart,"));

async function open(path) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 824 } });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(path + ": " + error.message));
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  if (!pub) await page.route("**/port/battle/fight.mjs", route => route.fulfill({ body: fight.replace("  return { states, tick, restart,", hook), contentType: "text/javascript" }));
  await page.goto(path.startsWith("http") ? path : base + path.replace(/^\//, ""));
  return page;
}
const ticking = page => page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 5, undefined, { timeout: 90000 });
// Start the match over so every fighter stands still before a movement check.
const fresh = async page => { await page.evaluate(() => document.getElementById("restart").click()); await page.waitForTimeout(400); };
const positions = page => page.evaluate(() => nativeBattle.diagnostics().actors.map(a => a.position));

// Cream HUD lettering found in the four name boxes of a picture (a canvas or a guest's video), as fractions of the
// 640x448 picture inside a 640x480 frame: the top names sit at y 20..34, the bottom ones at y 408..428.
const nameInk = `async (source) => {
  const w = 640, h = 480, surface = new OffscreenCanvas(w, h), ctx = surface.getContext("2d");
  ctx.drawImage(source, 0, 0, w, h);
  const count = (x0, y0, x1, y1) => {
    const { data } = ctx.getImageData(x0, y0 + 16, x1 - x0, y1 - y0);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 165 && data[i + 1] > 160 && data[i + 2] > 140 && Math.abs(data[i] - data[i + 2]) < 60) n++;
    return n;
  };
  return { topLeft: count(16, 20, 150, 34), topRight: count(490, 20, 624, 34), bottomLeft: count(16, 408, 150, 428), bottomRight: count(490, 408, 624, 428) };
}`;
// The host canvas is WebGL without a preserved buffer, so it is read from a screenshot; a guest's video is read directly.
const hudNames = async (page, selector) => selector === "canvas"
  ? page.evaluate(`(async()=>(${nameInk})(await createImageBitmap(await (await fetch("data:image/png;base64,${(await page.locator("canvas").screenshot()).toString("base64")}")).blob())))()`)
  : page.evaluate(`(${nameInk})(document.querySelector(${JSON.stringify(selector)}))`);

try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });

  // One on one is unchanged: the entry page forwards its query, two fighters, two pads, the same rate and picture.
  const duel = await open("/?p1=0x07000030&p2=0x07000025");
  await ticking(duel);
  const duelShape = await duel.evaluate(() => ({
    mode: document.body.dataset.mode, actors: nativeBattle.diagnostics().actors.length,
    shown: [1, 2, 3, 4].map(n => !document.querySelector("#player" + n).hidden),
  }));
  assert.deepEqual(duelShape, { mode: "1v1", actors: 2, shown: [true, true, false, false] });
  if (!pub) assert.equal(await duel.evaluate(() => __pads().length), 2);
  const duelHud = await hudNames(duel, "canvas");
  assert.ok(duelHud.topLeft > 40 && duelHud.topRight > 40, "one-on-one names are drawn: " + JSON.stringify(duelHud));
  assert.ok(duelHud.bottomLeft < 15 && duelHud.bottomRight < 15, "one-on-one has no lower strip: " + JSON.stringify(duelHud));
  const rate = async page => {
    const before = await page.evaluate(() => ({ t: performance.now(), ...nativeBattle.diagnostics() }));
    await page.waitForTimeout(5000);
    const after = await page.evaluate(() => ({ t: performance.now(), ...nativeBattle.diagnostics() }));
    const seconds = (after.t - before.t) / 1000;
    return { ticksPerSecond: +((after.ticks - before.ticks) / seconds).toFixed(1), framesPerSecond: +((after.renderedFrames - before.renderedFrames) / seconds).toFixed(1) };
  };
  report.duel = { ...(await rate(duel)), canvas: await duel.evaluate(() => (c => [c.width, c.height])(document.querySelector("canvas"))) };
  await duel.locator("canvas").screenshot({ path: new URL("duel.png", shots).pathname });
  await duel.context().close();

  // Free For All: four distinct fighters, the venue list limited to venues with the formation, a mode switch.
  const ffa = await open("/?mode=ffa&p1=0x07000030&p2=0x07000040&p3=0x07000030&venue=V2BG_07A");
  await ticking(ffa);
  const menu = await ffa.evaluate(() => ({
    mode: document.body.dataset.mode, picked: [1, 2, 3, 4].map(n => document.querySelector("#player" + n).value),
    names: [1, 2, 3, 4].map(n => document.querySelector("#player" + n).selectedOptions[0].textContent),
    shown: [1, 2, 3, 4].map(n => !document.querySelector("#player" + n).hidden),
    venue: document.querySelector("#venue").value,
    off: [...document.querySelector("#venue").options].filter(o => o.disabled).map(o => o.value),
    taken: [...document.querySelector("#player2").options].filter(o => o.disabled && o.selected === false).length,
  }));
  assert.equal(menu.mode, "ffa");
  assert.equal(new Set(menu.picked).size, 4);
  assert.equal(new Set(menu.names.map(name => name.replace(/ \(\d+\)$/, ""))).size, 4, "namesakes are not drafted twice: " + menu.names);
  assert.deepEqual(menu.shown, [true, true, true, true]);
  assert.equal(menu.venue, "V2BG_02A");
  assert.deepEqual(menu.off.sort(), ["V2BG_07A", "V2BG_15A", "V2BG_17A"]);
  assert.ok(menu.taken >= 3, "another seat's fighter cannot be picked twice");
  const names = await ffa.evaluate(() => nativeBattle.diagnostics().actors.map(a => a.name));
  assert.equal(new Set(names).size, 4);

  // The HUD carries all four fighters' names in the four corners of the match picture.
  const hud = await hudNames(ffa, "canvas");
  for (const [corner, ink] of Object.entries(hud)) assert.ok(ink > 40, `${corner} name is drawn: ${JSON.stringify(hud)}`);
  report.ffa = { ...(await rate(ffa)), canvas: await ffa.evaluate(() => (c => [c.width, c.height])(document.querySelector("canvas"))), names };
  await ffa.locator("canvas").screenshot({ path: new URL("host.png", shots).pathname });

  // Pads 0..3 each reach their own pad record (local) and move only their own fighter.
  const fixed = [0x1000, 0x2000, 0x4000, 0x8000];
  if (!pub) {
    await ffa.evaluate(() => [0x1000, 0x2000, 0x4000, 0x8000].forEach((buttons, slot) => nativeBattle.setInput(slot, { buttons, x: (slot + 1) / 8, z: -(slot + 1) / 16 })));
    await ffa.waitForFunction(() => __pads().every(([buttons]) => buttons !== 0));
    (await ffa.evaluate(() => __pads())).forEach(([buttons, x, z], slot) => {
      assert.equal(buttons, fixed[slot], `pad ${slot} buttons`);
      assert.ok(Math.abs(x - (slot + 1) / 8) < 1e-6 && Math.abs(z + (slot + 1) / 16) < 1e-6, `pad ${slot} sticks`);
    });
    await ffa.evaluate(() => { for (let slot = 0; slot < 4; slot++) nativeBattle.setInput(slot, null); });
  }
  for (let slot = 0; slot < 4; slot++) {
    await fresh(ffa);
    const before = await positions(ffa);
    await ffa.evaluate(slot => nativeBattle.setInput(slot, { buttons: 0, x: slot % 2 ? -1 : 1, z: 0 }), slot);
    await ffa.waitForTimeout(700);
    await ffa.evaluate(slot => nativeBattle.setInput(slot, null), slot);
    const after = await positions(ffa);
    const moved = after.map((position, index) => Math.hypot(position[0] - before[index][0], position[2] - before[index][2]));
    assert.ok(moved[slot] > 2, `pad ${slot} moves its own fighter: ${moved}`);
    moved.forEach((distance, index) => index === slot || assert.ok(distance < moved[slot], `pad ${slot} leaves fighter ${index} alone: ${moved}`));
  }

  // Local fallback: with no guest hosted, seats 2 and 3 take the gamepad of that number. No pad means they hold still.
  if (!pub) {
    await ffa.evaluate(() => {
      window.__poll = Array.from({ length: 4 }, (_, index) => ({
        index, id: "pad " + index, connected: true, axes: [index === 2 ? 0.8 : 0, 0, 0, 0],
        buttons: Array.from({ length: 16 }, (_, button) => ({ pressed: index === 3 && button === 0 })),
      }));
      navigator.getGamepads = () => window.__poll;
    });
    await ffa.waitForFunction(() => { const p = __pads(); return p[3][0] !== 0 && Math.abs(p[2][1] - 0.8) < 1e-6; });
    await ffa.evaluate(() => { window.__poll[0] = null; });
    await ffa.waitForFunction(() => {
      const p = __pads();
      return p[0][0] === 0 && Math.abs(p[2][1] - 0.8) < 1e-6 && p[3][0] === 0x4000;
    });
    await ffa.evaluate(() => { navigator.getGamepads = () => []; });
    await ffa.waitForFunction(() => __pads().every(([buttons, x]) => buttons === 0 && x === 0));
  }

  // A hosted Free For All room: shared match video on every guest, each guest drives its own seat.
  await ffa.locator("#host").click();
  await ffa.waitForFunction(() => document.querySelector("#code").value.length === 8, undefined, { timeout: 30000 });
  const invite = await ffa.locator("#invite").getAttribute("href");
  assert.equal(await ffa.evaluate(() => document.querySelector("#seats").textContent), "P1 host · P2 open · P3 open · P4 open");
  const guests = [];
  for (let n = 0; n < 3; n++) {
    const guest = await open(invite);
    await guest.waitForFunction(() => document.querySelector("#remote").videoWidth > 0 && nativeBattle.diagnostics().network === "connected", undefined, { timeout: 60000 });
    guests.push(guest);
  }
  await ffa.waitForFunction(() => document.querySelector("#seats").textContent === "P1 host · P2 connected · P3 connected · P4 connected", undefined, { timeout: 30000 });
  if (!pub) {
    for (const guest of guests) await guest.evaluate(() => {
      window.motorCalls = [];
      const pad = {connected:true, buttons:[], axes:[], vibrationActuator:{
        async playEffect(type, params) { window.motorCalls.push({type, ...params}); }
      }};
      navigator.getGamepads = () => [null, pad];
    });
    await ffa.evaluate(async () => {
      const {roomSession} = await import("/port/battle/controls.mjs");
      for (let seat=1; seat<=3; seat++) roomSession().vibration(seat, seat);
    });
    for (let i=0; i<guests.length; i++) {
      await guests[i].waitForFunction(() => window.motorCalls.length > 0);
      assert.deepEqual(await guests[i].evaluate(() => window.motorCalls), [{
        type:"dual-rumble", duration:160, strongMagnitude:[0.4,0.8,1][i], weakMagnitude:i===2 ? 1 : 0,
      }]);
    }
  }
  const overflow = await open(invite);
  await overflow.waitForFunction(() => /full/i.test(document.querySelector("#network").textContent), undefined, { timeout: 30000 });
  await overflow.context().close();

  // The shared view carries the whole match: every guest's picture has all four names, at the host's size.
  report.guests = [];
  for (const [index, guest] of guests.entries()) {
    await guest.locator("#remote").screenshot({ path: new URL(`guest-${index + 2}.png`, shots).pathname });
    const ink = await hudNames(guest, "#remote");
    for (const [corner, count] of Object.entries(ink)) assert.ok(count > 20, `guest ${index + 2} sees the ${corner} name: ${JSON.stringify(ink)}`);
    const first = await guest.evaluate(() => { const q = document.querySelector("#remote").getVideoPlaybackQuality(); return { t: performance.now(), frames: q.totalVideoFrames }; });
    await guest.waitForTimeout(4000);
    const video = await guest.evaluate(() => {
      const element = document.querySelector("#remote"), q = element.getVideoPlaybackQuality();
      return { t: performance.now(), frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, width: element.videoWidth, height: element.videoHeight };
    });
    report.guests.push({ seat: index + 2, video: [video.width, video.height], framesPerSecond: +((video.frames - first.frames) / ((video.t - first.t) / 1000)).toFixed(1), dropped: video.dropped });
    if (index === 0) await guest.locator("#remote").screenshot({ path: new URL("guest.png", shots).pathname });
  }
  const hostSize = await ffa.evaluate(() => (c => [c.width, c.height])(document.querySelector("canvas")));
  report.guests.forEach(guest => assert.ok(guest.video[0] > 0 && guest.video[1] > 0 && guest.framesPerSecond >= 20, "guest picture flows: " + JSON.stringify(guest)));
  report.hostCanvasWhileHosting = hostSize;

  // Each guest's own keyboard drives only its seat: its fighter moves, the others stay put.
  for (const [index, guest] of guests.entries()) {
    const seat = index + 1;
    await guest.bringToFront();
    await fresh(ffa);
    const before = await positions(ffa);
    await guest.keyboard.down("ArrowLeft");
    await ffa.waitForTimeout(800);
    await guest.keyboard.up("ArrowLeft");
    const after = await positions(ffa);
    const moved = after.map((position, slot) => Math.hypot(position[0] - before[slot][0], position[2] - before[slot][2]));
    assert.ok(moved[seat] > 2, `guest seat ${seat + 1} moves its own fighter: ${moved}`);
    moved.forEach((distance, slot) => slot === seat || assert.ok(distance < moved[seat], `guest seat ${seat + 1} leaves fighter ${slot + 1} alone: ${moved}`));
    if (!pub) {
      await guest.keyboard.down("KeyK"); // second keyboard map: Square
      await ffa.waitForFunction(slot => __pads()[slot][0] === 0x8000, seat);
      const state = await ffa.evaluate(() => __pads().map(p => p[0]));
      state.forEach((buttons, slot) => assert.equal(buttons, slot === seat ? 0x8000 : 0, `only seat ${seat + 1} is pressed: ${state}`));
      await guest.keyboard.up("KeyK");
      await ffa.waitForFunction(slot => __pads()[slot][0] === 0, seat);
    }
  }

  // Seat 3 leaves and the seat falls back to local control; the same seat can be retaken.
  await guests[1].evaluate(() => document.querySelector("#leave").click());
  await ffa.waitForFunction(() => /P3 open/.test(document.querySelector("#seats").textContent), undefined, { timeout: 30000 });
  if (!pub) {
    await ffa.evaluate(() => {
      const pad = pressed => ({ connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, (_, b) => ({ pressed: b === pressed })) });
      navigator.getGamepads = () => [pad(-1), pad(-1), pad(1)]; // the third connected controller is seat 3's
    });
    await ffa.waitForFunction(() => __pads()[2][0] === 0x2000, undefined, { timeout: 10000 });
    await ffa.evaluate(() => { navigator.getGamepads = () => []; });
  }
  const seat = new URL(invite); seat.searchParams.set("seat", "3");
  const returning = await open(seat.href);
  await returning.waitForFunction(() => window.nativeBattle?.diagnostics().network === "connected", undefined, { timeout: 60000 });
  await ffa.waitForFunction(() => document.querySelector("#seats").textContent === "P1 host · P2 connected · P3 connected · P4 connected", undefined, { timeout: 30000 });
  await fresh(ffa);
  const before = await positions(ffa);
  await returning.keyboard.down("ArrowLeft");
  await ffa.waitForTimeout(800);
  await returning.keyboard.up("ArrowLeft");
  const after = await positions(ffa);
  assert.ok(Math.hypot(after[2][0] - before[2][0], after[2][2] - before[2][2]) > 2, "the returning guest drives seat 3 again");

  assert.deepEqual(errors, []);
  mkdirSync(new URL("./", shots), { recursive: true });
  writeFileSync(new URL("report.json", shots), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  console.log(`native Free For All browser check passed (${pub ? pub.href : "local"})`);
} finally {
  await browser?.close();
  server?.close();
}
process.exit(0);
