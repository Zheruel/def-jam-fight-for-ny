// The retail match-loading poster in real browsers: it shows the selected match type, venue, fighters and logos as soon as
// the match is known (direct link or the selector), holds until the match is ready, matches the retail captures, reaches a
// hosted room's guests, and comes back for the next match of the same room.
//   node verification/native-loading-browser.mjs
// The match's start files are held back for a few seconds so the poster can be examined (the product adds no wait).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../tools/serve.mjs";
import { attachNetplay } from "../netplay/server.mjs";
import roster from "../port/menu/art/roster.json" with { type: "json" };
import venues from "../port/menu/art/venues.json" with { type: "json" };

const HOLD = 5000;
const BLAZE = "0x07000030", DOC = "0x07000025", MAGIC = "0x0700003B", HAVOC = "0x07000037", NORE = "0x07000009", CRACK = "0x07000034";
const idOf = handle => roster.find(f => f.handle === handle).id;
const numberOf = file => venues.find(v => v.file === file).feID + 1;
const server = gameServer();
attachNetplay(server);
let browser;

// Retail captures of the same posters (private/, present on the author's machine): the render must be the same picture.
const captures = {
  ffa3: { file: "private/ps2-battle/three-fight/039-menu.png", query: `mode=ffa3&p1=${BLAZE}&p2=${DOC}&p3=${MAGIC}&venue=V2BG_02A` },
  ffa4: { file: "private/ps2-battle/four-start/036-screen.png", query: `mode=ffa&p1=${BLAZE}&p2=${DOC}&p3=${MAGIC}&p4=${HAVOC}&venue=V2BG_02A` },
  team: { file: "private/ps2-battle/team-start/029-menu.png", query: `mode=team&p1=${BLAZE}&p2=${DOC}&p3=${MAGIC}&p4=${NORE}&venue=V2BG_02A`, mask: [256, 266, 384, 394] },
  duel: { file: "private/verification/special/window/045-menu.png", query: `p1=${BLAZE}&p2=${CRACK}&venue=V2BG_15A`, mask: [0, 0, 640, 100] },   // its title is the Window Match's
};

// Normalised correlation of two pictures' luminance over the 640 x 448 picture band (image sources are scaled to 640 x 480).
const correlate = async ({a, b, mask}) => {
  const load = async source => {
    if (typeof source === "string") { const image = new Image(); image.src = source; await image.decode(); return image; }
    return source;
  };
  const luma = async (source, selector) => {
    const element = selector ? document.querySelector(selector) : await load(source);
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    context.drawImage(element, 0, 0, 640, 480);
    return context.getImageData(0, 16, 640, 448).data;
  };
  const x = await luma(a.source, a.selector), y = await luma(b.source, b.selector);
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let row = 0; row < 448; row++) for (let col = 0; col < 640; col++) {
    if (mask && col >= mask[0] && col < mask[2] && row + 16 >= mask[1] && row + 16 < mask[3]) continue;
    const i = (row * 640 + col) * 4;
    const u = 0.299 * x[i] + 0.587 * x[i + 1] + 0.114 * x[i + 2], v = 0.299 * y[i] + 0.587 * y[i + 1] + 0.114 * y[i + 2];
    n++; sx += u; sy += v; sxx += u * u; syy += v * v; sxy += u * v;
  }
  return (sxy - sx * sy / n) / Math.sqrt((sxx - sx * sx / n) * (syy - sy * sy / n));
};

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = process.env.BATTLE_URL ?? `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
  const errors = [];
  async function open(url, { hold = true } = {}) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 824 } });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); });
    // Hold the match's start state back so the match takes a few seconds to load.
    if (hold) await page.route(/\/port\/kernel\/[a-z-]*start\.gz$/, async route => { await new Promise(resolve => setTimeout(resolve, HOLD)); await route.continue(); });
    await page.goto(url);
    return page;
  }
  const poster = page => page.locator("canvas[aria-label='Match loading']");
  const showing = page => page.waitForFunction(() => document.querySelector("canvas[aria-label='Match loading']")?.dataset.state === "shown", null, { timeout: 30000 });
  const state = page => page.evaluate(() => window.nativeLoading?.() ?? null);
  const ready = page => page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 20, null, { timeout: 120000 });

  // 1. Direct links: the poster is the first thing on the page, shows the whole selection and matches the retail frame.
  for (const [name, { file, query, mask }] of Object.entries(captures)) {
    const page = await open(`${origin}?${query}`);
    await showing(page);
    const shown = await state(page);
    const params = new URLSearchParams(query);
    const handles = [1, 2, 3, 4].map(n => params.get("p" + n)).filter(Boolean);
    assert.deepEqual(shown.ids, handles.map(idOf), `${name}: the poster's fighters`);
    assert.equal(shown.venue, numberOf(params.get("venue")), `${name}: the poster's venue`);
    assert.equal(await page.locator("canvas[aria-label='Native Battle']").isHidden(), true, `${name}: the match canvas stays behind the poster`);
    assert.equal(await page.evaluate(() => window.nativeBattle?.diagnostics().ticks ?? 0), 0, `${name}: the match has not started`);
    let line = `${name}: ${shown.mode} ${shown.ids.join(",")} venue ${shown.venue}`;
    if (existsSync(new URL("../" + file, import.meta.url))) {
      const capture = "data:image/png;base64," + readFileSync(new URL("../" + file, import.meta.url)).toString("base64");
      const similarity = await page.evaluate(correlate, { a: { selector: "canvas[aria-label='Match loading']" }, b: { source: capture }, mask });
      assert.ok(similarity > 0.93, `${name}: the render matches the retail capture (correlation ${similarity.toFixed(3)})`);
      line += `, correlation with the retail frame ${similarity.toFixed(3)}`;
    } else line += " (no retail capture on this machine)";
    // The poster goes when the match is ready, with no leftovers.
    await ready(page);
    assert.equal(await poster(page).count(), 0, `${name}: the poster is gone once the match runs`);
    assert.equal(await page.evaluate(() => window.nativeLoading), undefined);
    assert.equal(await page.locator("canvas[aria-label='Native Battle']").isVisible(), true);
    console.log(line);
    await page.context().close();
  }

  // 2. Cold start: the poster appears well before the held match files arrive, and only its own art was fetched.
  {
    const context = await browser.newContext({ viewport: { width: 1024, height: 824 } });
    const page = await context.newPage();
    const fetched = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.includes("/art/loading/")) fetched.push(url.pathname.split("/").pop()); });
    await page.route(/\/port\/kernel\/[a-z-]*start\.gz$/, async route => { await new Promise(resolve => setTimeout(resolve, HOLD)); await route.continue(); });
    const started = Date.now();
    await page.goto(`${origin}?mode=ffa3&p1=${BLAZE}&p2=${DOC}&p3=${MAGIC}&venue=V2BG_02A`);
    await showing(page);
    assert.ok(Date.now() - started < HOLD, "the poster shows before the match's files arrive");
    const wanted = ["layout.json", "paper-ffa3.webp", "front.webp", "vignette.webp", "title-ffa.webp", "venue-2.webp",
      ...[56, 55, 22].flatMap(id => [`portrait-${id}-3p.webp`, `logo-${id}-3p.webp`])].sort();
    assert.deepEqual([...new Set(fetched)].sort(), wanted, "only the selection's art is fetched");
    console.log(`cold start: poster in ${Date.now() - started} ms, ${wanted.length} art files`);
    await context.close();
  }

  // 3. From the selector, in a hosted room: the poster shows the picks and the guest sees it; the next match brings it back.
  async function chooseType(page, type) {
    for (let i = 0; i < ["1v1", "team", "ffa"].indexOf(type === "ffa3" ? "ffa" : type); i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    if (await page.evaluate(() => window.nativeMenu?.popup === "rules")) await page.keyboard.press("Enter");
    if (type.startsWith("ffa")) {
      if (type === "ffa3") await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
    }
  }
  const host = await open(origin);
  await host.waitForSelector("canvas[aria-label='Choose fighter and venue']");
  await host.waitForFunction(() => document.fonts.check("12px BattleNames"));
  await host.waitForTimeout(500);
  await chooseType(host, "ffa3");
  await host.waitForFunction(() => window.nativeMenu?.screen === "fighters");
  await host.locator("#host").click();
  await host.waitForFunction(() => document.querySelector("#code").value.length === 8);
  const invite = new URL(await host.locator("#invite").getAttribute("href"));
  const code = await host.locator("#code").inputValue();
  invite.searchParams.set("seat", "2");
  const guest = await open(invite.href, { hold: false });
  await guest.waitForFunction(() => window.nativeBattle?.diagnostics().network === "connected" && document.querySelector("#remote").videoWidth > 0, null, { timeout: 60000 });
  await host.waitForFunction(() => nativeMenu.seats.some(s => s.remote));

  async function playSelection(label, guestSteps) {
    await guest.locator("h1").click();
    for (let step = 0; step < guestSteps; step++) await guest.keyboard.press("ArrowRight");
    await guest.keyboard.press("Enter");
    await host.waitForFunction(() => nativeMenu.seats[1].ready);
    const remaining = await host.evaluate(() => nativeMenu.seats.filter((s, i) => !s.ready).length);
    for (let i = 0; i < remaining; i++) await host.keyboard.press("Enter");
    await host.waitForFunction(() => nativeMenu.screen === "venue");
    const handles = await host.evaluate(() => nativeMenu.seats.map(s => s.handle));
    if (label === "second") await host.keyboard.press("ArrowRight");
    await host.keyboard.press("Enter");
    // The poster is up for the selector's own choice, in the host page and (through the room) on the guest.
    await showing(host);
    const shown = await state(host);
    assert.deepEqual(shown.ids, handles.map(idOf), `${label}: the host's poster shows the picks, in seat order`);
    const hostVenue = shown.venue;
    // The guest's picture is the poster (the room sends the poster canvas while the match loads).
    const posterShot = await host.evaluate(() => document.querySelector("canvas[aria-label='Match loading']").toDataURL("image/png"));
    const similar = () => guest.evaluate(correlate, { a: { selector: "#remote" }, b: { source: posterShot } });
    let similarity = 0;
    for (let attempt = 0; attempt < 30 && similarity < 0.9; attempt++) { await guest.waitForTimeout(300); similarity = await similar(); }
    assert.ok(similarity > 0.9, `${label}: the guest sees the poster (correlation ${similarity.toFixed(3)})`);
    await ready(host);
    assert.equal(await poster(host).count(), 0, `${label}: the poster is gone once the match runs`);
    // ...and then the guest's picture is the match, not the poster.
    let after = 1;
    for (let attempt = 0; attempt < 30 && after > 0.8; attempt++) { await guest.waitForTimeout(300); after = await similar(); }
    assert.ok(after <= 0.8, `${label}: the guest's picture moves on to the match (correlation with the poster ${after.toFixed(3)})`);
    console.log(`${label}: poster ids ${shown.ids.join(",")} venue ${hostVenue}, guest correlation ${similarity.toFixed(3)}`);
    assert.equal(await guest.evaluate(() => nativeBattle.diagnostics().network), "connected");
    return { handles, venue: hostVenue };
  }
  const first = await playSelection("first", 2);
  assert.deepEqual(await host.evaluate(() => nativeRoom().slots), ["host", "connected", "open"]);

  // Quit to the selector (pause menu), pick again: same room, the poster again with the new picks.
  await host.locator("canvas").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await host.keyboard.press("Escape");
  await host.waitForFunction(() => nativeBattle.diagnostics().pause !== null);
  for (let i = 0; i < 4; i++) await host.keyboard.press("ArrowDown");
  await host.keyboard.press("Enter");
  await host.keyboard.press("ArrowLeft");
  await host.keyboard.press("Enter");
  await host.waitForFunction(() => window.nativeMenu?.screen === "type");
  assert.equal(await poster(host).count(), 0, "no poster behind the selector");
  await chooseType(host, "ffa");
  await host.waitForFunction(() => window.nativeMenu?.screen === "fighters");
  assert.equal(await host.locator("#code").inputValue(), code, "same room");
  const second = await playSelection("second", 4);
  assert.notDeepEqual(second.handles, first.handles, "a different lineup");
  assert.notEqual(second.venue, first.venue, "a different venue");
  assert.equal(await host.locator("#code").inputValue(), code);
  assert.equal((await host.evaluate(() => nativeRoom().captures)), 1, "one picture capture");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
