// Browser check of Free For All entry, run headless with scripted input: selection and query schema, one-on-one still
// working, four pads 0..3, a hosted match shared with up to three isolated guests, and a guest rejoining its seat.
//   node verification/native-ffa-browser.mjs
// FIXTURE ONLY until port/kernel/four-start.gz exists: Playwright serves a copy of foundation-start.gz whose pad table
// gives seats 2 and 3 their own pad records (the two-body seed leaves them unassigned), and fight.mjs with a read-only
// hook for the pad records. The shipped modules and the page expose neither. With the real seed present, none of it applies.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { attachNetplay } from "../netplay/server.mjs";
import { gameServer } from "../tools/serve.mjs";

const server = gameServer();
attachNetplay(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const realSeed = existsSync(new URL("../port/kernel/four-start.gz", import.meta.url));
let browser;
const errors = [];

function fixtureSeed() {
  const bytes = gunzipSync(readFileSync(new URL("../port/kernel/foundation-start.gz", import.meta.url)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; at += 4100) {
    if (view.getUint32(at, true) !== 0x4bb) continue;
    const table = at + 4 + (0x4bbd48 & 0xfff);
    view.setUint32(table + 8, 5, true);
    view.setUint32(table + 12, 6, true);
    return gzipSync(bytes);
  }
  throw new Error("The seed has no pad table page");
}
const fight = readFileSync(new URL("../port/battle/fight.mjs", import.meta.url), "utf8");
const hook = "globalThis.__pads=()=>pads.map(p=>[word(p),scalar(p+8),scalar(p+12)]);\n  return { states, tick, restart,";
assert.ok(fight.includes("  return { states, tick, restart,"));

async function open(path, { fixture = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 824 } });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(path + ": " + error.message));
  if (fixture && !realSeed) {
    const seed = fixtureSeed();
    await page.route("**/port/kernel/four-start.gz", route => route.fulfill({ body: seed, contentType: "application/gzip" }));
  }
  await page.route("**/port/battle/fight.mjs", route => route.fulfill({ body: fight.replace("  return { states, tick, restart,", hook), contentType: "text/javascript" }));
  await page.goto(path.startsWith("http") ? path : base + path);
  return page;
}
const ticking = page => page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 5, undefined, { timeout: 60000 });

try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });

  // One on one is unchanged: the entry page forwards its query, two fighters, two pads.
  const duel = await open("/?p1=0x07000030&p2=0x07000025", { fixture: false });
  await ticking(duel);
  assert.deepEqual(await duel.evaluate(() => ({
    mode: document.body.dataset.mode, actors: nativeBattle.diagnostics().actors.length,
    shown: [1, 2, 3, 4].map(n => !document.querySelector("#player" + n).hidden), pads: __pads().length,
  })), { mode: "1v1", actors: 2, shown: [true, true, false, false], pads: 2 });
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
  const first = await ffa.evaluate(() => nativeBattle.diagnostics().actors.map(a => a.name));
  assert.equal(first.length, 4);
  assert.equal(new Set(first).size, 4);

  // Pads 0..3 each reach their own pad record, independently.
  const drive = () => ffa.evaluate(() => {
    [0x1000, 0x2000, 0x4000, 0x8000].forEach((buttons, slot) => nativeBattle.setInput(slot, { buttons, x: (slot + 1) / 8, z: -(slot + 1) / 16 }));
  });
  await drive();
  await ffa.waitForFunction(() => __pads().every(([buttons]) => buttons !== 0));
  const pads = await ffa.evaluate(() => __pads());
  const fixed = [0x1000, 0x2000, 0x4000, 0x8000];
  pads.forEach(([buttons, x, z], slot) => {
    assert.equal(buttons, fixed[slot], `pad ${slot} buttons`);
    assert.ok(Math.abs(x - (slot + 1) / 8) < 1e-6 && Math.abs(z + (slot + 1) / 16) < 1e-6, `pad ${slot} sticks`);
  });
  await ffa.evaluate(() => { for (let slot = 0; slot < 4; slot++) nativeBattle.setInput(slot, null); });

  // Local fallback: with no guest hosted, seats 2 and 3 take the gamepad of that number. No pad means they hold still.
  await ffa.evaluate(() => {
    window.__poll = Array.from({ length: 4 }, (_, index) => ({
      index, id: "pad " + index, connected: true, axes: [index === 2 ? 0.8 : 0, 0, 0, 0],
      buttons: Array.from({ length: 16 }, (_, button) => ({ pressed: index === 3 && button === 0 })),
    }));
    navigator.getGamepads = () => window.__poll;
  });
  await ffa.waitForFunction(() => { const p = __pads(); return p[3][0] !== 0 && Math.abs(p[2][1] - 0.8) < 1e-6; });
  await ffa.evaluate(() => { navigator.getGamepads = () => []; });
  await ffa.waitForFunction(() => __pads().every(([buttons, x]) => buttons === 0 && x === 0));

  // A hosted Free For All room: shared match video on every guest, each guest drives its own seat.
  await ffa.locator("#host").click();
  await ffa.waitForFunction(() => document.querySelector("#code").value.length === 8);
  const invite = await ffa.locator("#invite").getAttribute("href");
  assert.equal(await ffa.evaluate(() => document.querySelector("#seats").textContent), "P1 host · P2 open · P3 open · P4 open");
  const guests = [];
  for (const seat of [null, null, null]) {
    const guest = await open(invite, { fixture: false });
    await guest.waitForFunction(() => document.querySelector("#remote").videoWidth > 0 && nativeBattle.diagnostics().network === "connected", undefined, { timeout: 30000 });
    guests.push(guest);
  }
  await ffa.waitForFunction(() => document.querySelector("#seats").textContent === "P1 host · P2 connected · P3 connected · P4 connected");
  const overflow = await open(invite, { fixture: false });
  await overflow.waitForFunction(() => /full/i.test(document.querySelector("#network").textContent));

  // The shared view carries all four fighters: the guest's picture matches the host's, same dimensions, not blank.
  for (const guest of guests) {
    const view = await guest.evaluate(async () => {
      const video = document.querySelector("#remote"), surface = new OffscreenCanvas(64, 48), ctx = surface.getContext("2d");
      ctx.drawImage(video, 0, 0, 64, 48);
      const data = ctx.getImageData(0, 0, 64, 48).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
      return { width: video.videoWidth, height: video.videoHeight, lit };
    });
    assert.ok(view.width >= 200 && view.height >= 150 && view.lit > 200, "guest sees the shared match: " + JSON.stringify(view));
  }

  // Each guest's own keyboard drives only its seat (the host's pad for that seat), the others stay released.
  const press = async (guest, key) => { await guest.keyboard.down(key); };
  const seatOf = async slot => ffa.evaluate(slot => __pads()[slot], slot);
  for (const [index, guest] of guests.entries()) {
    await guest.bringToFront();
    await guest.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await guest.keyboard.down("KeyK"); // second keyboard map: Square
    await ffa.waitForFunction(slot => __pads()[slot][0] === 0x8000, index + 1);
    const state = await ffa.evaluate(() => __pads().map(p => p[0]));
    state.forEach((buttons, slot) => assert.equal(buttons, slot === index + 1 ? 0x8000 : 0, `only seat ${index + 2} is pressed: ${state}`));
    await guest.keyboard.up("KeyK");
    await ffa.waitForFunction(slot => __pads()[slot][0] === 0, index + 1);
  }

  // Seat 3 leaves and the seat falls back to local control; the same seat can be retaken.
  await guests[1].evaluate(() => document.querySelector("#leave").click());
  await ffa.waitForFunction(() => /P3 open/.test(document.querySelector("#seats").textContent));
  await ffa.evaluate(() => {
    const pad = pressed => ({ connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, (_, b) => ({ pressed: b === pressed })) });
    navigator.getGamepads = () => [pad(-1), pad(-1), pad(1)]; // the third connected controller is seat 3's
  });
  await ffa.waitForFunction(() => __pads()[2][0] === 0x2000, undefined, { timeout: 10000 });
  await ffa.evaluate(() => { navigator.getGamepads = () => []; });
  const seat = new URL(invite); seat.searchParams.set("seat", "3");
  const returning = await open(seat.href, { fixture: false });
  await returning.waitForFunction(() => nativeBattle.diagnostics().network === "connected", undefined, { timeout: 30000 });
  await ffa.waitForFunction(() => document.querySelector("#seats").textContent === "P1 host · P2 connected · P3 connected · P4 connected");
  await returning.keyboard.down("KeyK");
  await ffa.waitForFunction(() => __pads()[2][0] === 0x8000);
  await returning.keyboard.up("KeyK");

  assert.deepEqual(errors, []);
  console.log(`native Free For All browser check passed (${realSeed ? "four-start.gz" : "fixture seed"})`);
} finally {
  await browser?.close();
  server.close();
}
process.exit(0);
