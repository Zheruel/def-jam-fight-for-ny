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
import lineups from "../port/battle/lineups.json" with { type: "json" };
import { MODES } from "../port/battle/modes.mjs";
import { matchTypes } from "../port/menu/launch.mjs";

const server = gameServer();
attachNetplay(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/`;
let browser;
const types = matchTypes(MODES, true);
// Navigates the match type step by the intended type, not by a hard-coded number of key presses.
const chooseType = async (page, type, rule = "standard") => {
  assert.ok(types.includes(type), `${type} is advertised`);
  const rows = [["1v1", "team", "ffa"], ["window", "subway", "demolition", "inferno"], ["cage", "ringout"]];
  const card = type === "ffa3" ? "ffa" : type;
  const row = rows.findIndex(cards => cards.includes(card));
  if (row > 0) await page.keyboard.press("ArrowDown");
  const column = rows[row].indexOf(card) + (row === 2 ? 1 : 0);
  for (let i = 0; i < column; i++) await page.keyboard.press("ArrowRight");
  if (row === 2) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  if (!MODES[type].venues) {
    await page.waitForFunction(() => window.nativeMenu?.popup === "rules");
    for (let i = 0; i < ["standard", "votes", "no-submissions"].indexOf(rule); i++) await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => nativeMenu.rule), rule);
    await page.keyboard.press("Enter");
  }
  if (type.startsWith("ffa")) {
    if (type === "ffa3") await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
  }
};
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
  await chooseType(page, "1v1", "no-submissions");
  await page.waitForTimeout(200);
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
  await page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 30, undefined, { timeout: 90000 }).catch(async error => {
    throw new Error(`match did not start (${page.url()}): ${await page.locator("#status").textContent()} ${errors.join(" | ")}`, { cause: error });
  });

  const query = new URL(page.url()).searchParams;
  assert.equal(query.get("rules"), "no-submissions");
  assert.equal(await page.evaluate(() => nativeBattle.diagnostics().ruleFlags), 0x10005);
  assert.equal(query.get("p1"), chosen[0].handle);
  assert.equal(query.get("p2"), chosen[1].handle);
  const venue = inventory.venues.find(v => v.file === query.get("venue"));
  assert.ok(venue, "a real venue was chosen");
  const names = await page.evaluate(() => nativeBattle.diagnostics().actors.map(a => a.name));
  assert.deepEqual(names, chosen.map(f => f.name), "the match runs the selected fighters");
  assert.equal(await page.locator("canvas[aria-label='Choose fighter and venue']").count(), 0, "menu removed");
  await shot("3-match");

  // A CPU opponent: C makes the last seat the retail CPU, and the match starts with ?cpu=1.
  const versus = await browser.newPage({ viewport: { width: 1024, height: 824 } });
  versus.on("pageerror", e => errors.push("cpu: " + e.message));
  await versus.goto(base);
  await versus.waitForSelector("canvas[aria-label='Choose fighter and venue']");
  await versus.waitForFunction(() => document.fonts.check("12px BattleNames"));
  await chooseType(versus, "1v1", "votes");
  await versus.keyboard.press("c");
  await versus.keyboard.press("Enter"); await versus.keyboard.press("Enter"); await versus.waitForTimeout(300);
  await versus.keyboard.press("Enter");
  await versus.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 30, undefined, { timeout: 90000 }).catch(async error => {
    throw new Error(`CPU match did not start (${versus.url()}): ${await versus.locator("#status").textContent()} ${errors.join(" | ")}`, { cause: error });
  });
  assert.equal(new URL(versus.url()).searchParams.get("cpu"), "1");
  assert.equal(new URL(versus.url()).searchParams.get("rules"), "votes");
  assert.equal(await versus.evaluate(() => nativeBattle.diagnostics().timerSetting), 1);
  await versus.close();

  // Multi-fighter modes the page advertises (Free For All with three or four fighters): the same menu with three or four cards; Enter locks in
  // each seat in turn, and only venues with that mode's formation are offered. A mode the page does not advertise is not offered.
  const multi = {};
  for (const mode of types.filter(m => m !== "1v1")) {
    const tab = await browser.newPage({ viewport: { width: 1024, height: 824 } });
    tab.on("pageerror", e => errors.push(mode + ": " + e.message));
    await tab.goto(base);
    await tab.waitForSelector("canvas[aria-label='Choose fighter and venue']");
    await tab.waitForFunction(() => document.fonts.check("12px BattleNames"));
    await chooseType(tab, mode);
    await tab.waitForTimeout(800);
    if (process.env.NATIVE_SCREENSHOT) writeFileSync(`${process.env.NATIVE_SCREENSHOT}/4-${mode}.png`, await tab.screenshot());
    const seats = MODES[mode].fighters;
    for (let seat = 0; seat < seats; seat++) await tab.keyboard.press("Enter");
    if (mode === "team") {
      // Put player three alongside player one. Player two and four form the other team.
      await tab.keyboard.press("Enter");
      await tab.keyboard.press("ArrowRight");
      for (let i = 0; i < 3; i++) await tab.keyboard.press("Enter");
    }
    if (!MODES[mode].venues) {
      await tab.waitForTimeout(300);
      await tab.keyboard.press("Enter");
    }
    await tab.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 30, undefined, { timeout: 120000 }).catch(async error => {
      throw new Error(`${mode} did not start (${tab.url()}): ${await tab.locator("#status").textContent()} ${errors.join(" | ")}`, { cause: error });
    });
    const params = new URL(tab.url()).searchParams;
    assert.equal(params.get("mode"), mode);
    const match = await tab.evaluate(() => nativeBattle.diagnostics());
    assert.equal(match.matchType, MODES[mode].id, mode + " uses its retail backend match type");
    const names = match.actors.map(a => a.name);
    assert.equal(names.length, seats);
    assert.equal(new Set(names).size, seats, "distinct fighters");
    const order = mode === "team" ? [1, 3, 2, 4] : Array.from({length:seats}, (_, i) => i + 1);
    if (mode === "team") assert.equal(params.get("teams"), "1324");
    assert.deepEqual(order.map(seat => inventory.fighters.find(f => f.handle === params.get("p" + seat)).name), names);
    assert.ok(Object.hasOwn(lineups[params.get("venue")], MODES[mode].formation), "the venue has the mode's formation");
    if (MODES[mode].venues) assert.ok(MODES[mode].venues.includes(params.get("venue")));
    multi[mode] = { fighters: names, venue: params.get("venue") };
    await tab.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ fighters: names, venue: venue.name, file: venue.file, portraitsFetchedBeforeMatch: portraits().size }));
  console.log(JSON.stringify(multi));
  console.log("All advertised match types reached a native fight through the retail selector.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
