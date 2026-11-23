// Browser check of the Foundation's near-crowd spectators in the real battle page (headless Chrome): the people files load
// and the page draws without errors.
//   node port/scenery/people-browser.mjs        (NATIVE_SCREENSHOT=dir keeps PNGs)
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "../../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../../tools/serve.mjs";

const server = gameServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
  const page = await browser.newPage({ viewport: { width: 1024, height: 824 } });
  const errors = [], fetched = [];
  page.on("response", response => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); else if (/\/people\//.test(response.url())) fetched.push(response.url().split("/").pop()); });
  page.on("pageerror", error => errors.push(error.message));
  const url = new URL(process.argv[2] ?? `http://127.0.0.1:${server.address().port}/`);
  url.searchParams.set("venue", "V2BG_02A");
  await page.goto(url.href);
  await page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 30, null, { timeout: 90000 });
  const shots = [await page.locator("canvas").first().screenshot()];
  await page.waitForTimeout(700);
  shots.push(await page.locator("canvas").first().screenshot());
  if (process.env.NATIVE_SCREENSHOT) shots.forEach((shot, i) => writeFileSync(`${process.env.NATIVE_SCREENSHOT}/foundation-people-${i}.png`, shot));
  const people = JSON.parse(readFileSync(new URL("./foundation/people/people.json", import.meta.url), "utf8"));
  const outfits = [...new Set(people.spectators.flatMap(s => Object.values(s.outfit)))].map(key => key + ".png");
  assert.deepEqual(fetched.sort(), ["class0.skin.gz", "class1.skin.gz", "class2.skin.gz", "people.json", "poses.bin.gz", ...outfits].sort());
  assert.ok(!shots[0].equals(shots[1]), "the frame changes over time");
  assert.deepEqual(errors, []);
  console.log("people browser check ok", JSON.stringify({ fetched }));
} finally {
  await browser?.close();
  server.close();
}
