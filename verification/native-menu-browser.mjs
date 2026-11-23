// Headless proof of the default menu: a bare page shows the retail fighter selector, two players pick with their own keys,
// the venue map takes a pin, and the chosen match starts on the native kernel with exactly those fighters and venue.
//   node verification/native-menu-browser.mjs [url]       (NATIVE_SCREENSHOT=dir keeps PNGs)
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { attachNetplay } from "../netplay/server.mjs";
import { gameServer } from "../tools/serve.mjs";
import inventory from "../ps2/content/inventory.json" with { type: "json" };

const server = gameServer();
attachNetplay(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
  const page = await browser.newPage({ viewport: { width: 1024, height: 824 } });
  const errors = [], requests = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => requests.push(new URL(r.url()).pathname));
  const shot = async name => { if (process.env.NATIVE_SCREENSHOT) writeFileSync(`${process.env.NATIVE_SCREENSHOT}/${name}.png`, await page.screenshot()); };

  await page.goto(base);
  await page.waitForSelector("canvas[aria-label='Choose fighter and venue']");
  await page.waitForFunction(() => document.fonts.check("12px BattleNames"));
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => typeof window.nativeBattle), "undefined", "no match runs behind the menu");
  // only the visible fighters' pictures are fetched (two cards), not the whole roster
  const portraits = () => new Set(requests.filter(p => /\/art\/fighters\/\d+-h\.png$/.test(p)));
  assert.ok(portraits().size <= 4, `lazy portraits: ${portraits().size}`);
  await shot("1-fighters");

  const roster = JSON.parse(readFileSync(new URL("../port/menu/art/roster.json", import.meta.url), "utf8"));
  const start = ["0x07000030", "0x07000025"].map(h => roster.findIndex(f => f.handle === h));
  // player 1 (WASD + I): two to the right; player 2 (arrows): one to the left; each confirms with their own button
  await page.keyboard.press("d"); await page.keyboard.press("d"); await page.keyboard.press("i");
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("[");
  await page.waitForTimeout(300);
  await shot("2-venue");
  const chosen = [roster[start[0] + 2], roster[start[1] - 1]];
  assert.notEqual(chosen[0].handle, chosen[1].handle);
  // venue: move to a neighbouring pin and take it
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 30, undefined, { timeout: 90000 });

  const query = new URL(page.url()).searchParams;
  assert.equal(query.get("p1"), chosen[0].handle);
  assert.equal(query.get("p2"), chosen[1].handle);
  const venue = inventory.venues.find(v => v.file === query.get("venue"));
  assert.ok(venue, "a real venue was chosen");
  const names = await page.evaluate(() => nativeBattle.diagnostics().actors.map(a => a.name));
  assert.deepEqual(names, chosen.map(f => f.name), "the match runs the selected fighters");
  assert.equal(await page.locator("canvas[aria-label='Choose fighter and venue']").count(), 0, "menu removed");
  await shot("3-match");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ fighters: names, venue: venue.name, file: venue.file, portraitsFetchedBeforeMatch: portraits().size }));
  console.log("The retail selector chose two fighters and a venue and started the native match.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
