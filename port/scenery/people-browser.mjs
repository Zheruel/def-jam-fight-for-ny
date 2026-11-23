// Browser check of the near-crowd spectators in the real battle page (headless Chrome): each venue's people files load (and
// nothing else 404s), the spectators draw, and the frame rate with them is compared with the same venue without them.
//   node port/scenery/people-browser.mjs [venue ...]        (default: Foundation, Gun Hill Garage, Club Murder, The Pit)
//   NATIVE_SCREENSHOT=dir keeps a PNG per venue; PEOPLE_PERF=<cpu slowdown, e.g. 6> also prints the frame rate with and without spectators
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "../../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../../tools/serve.mjs";

const here = new URL("./", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", here), "utf8"));
const venues = process.argv.slice(2).length ? process.argv.slice(2) : ["V2BG_02A", "V2BG_17A", "V2BG_14A", "V2BG_13A"];
const server = gameServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;

async function load(venue, { people }) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 824 } });
  const errors = [], fetched = new Set();
  page.on("response", response => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); else if (/\/scenery\/(people\/|[^/]+\/people\.json)/.test(response.url())) fetched.add(new URL(response.url()).pathname.split("/scenery/")[1]); });
  page.on("pageerror", error => errors.push(error.message));
  if (!people) await page.route(/\/people\.json$/, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ classes: [], classParts: [], spectators: [] }) }));
  const url = new URL(`http://127.0.0.1:${server.address().port}/`);
  url.searchParams.set("venue", venue);
  if (process.env.PEOPLE_PERF) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.PEOPLE_PERF) > 1 ? Number(process.env.PEOPLE_PERF) : 1 });
  await page.goto(url.href);
  await page.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 30, null, { timeout: 90000 });
  return { page, errors, fetched };
}

async function frameRate(page, ms = Number(process.env.PEOPLE_SECONDS ?? 4) * 1000) {
  return page.evaluate(duration => new Promise(resolve => {
    const times = [];
    const step = now => { times.push(now); now - times[0] < duration ? requestAnimationFrame(step) : resolve(times); };
    requestAnimationFrame(step);
  }).then(times => { const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b); return { fps: 1000 * gaps.length / (times.at(-1) - times[0]), median: gaps[gaps.length >> 1], p95: gaps[Math.floor(gaps.length * 0.95)] }; }), ms);
}

try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
  for (const venue of venues) {
    const entry = index[venue];
    assert.ok(entry?.people, `${venue} has no spectators`);
    const manifest = JSON.parse(readFileSync(new URL(`${entry.dir}/people.json`, here), "utf8"));
    const wanted = new Set([`${entry.dir}/people.json`, "people/poses.bin.gz", ...manifest.classes.map(id => `people/classes/${id}.skin.gz`),
      ...manifest.spectators.flatMap(s => Object.values(s.outfit)).map(key => `people/outfits/${key}.png`)]);
    const { page, errors, fetched } = await load(venue, { people: true });
    const shots = [await page.locator("canvas").first().screenshot()];
    await page.waitForTimeout(700);
    shots.push(await page.locator("canvas").first().screenshot());
    if (process.env.NATIVE_SCREENSHOT) shots.forEach((shot, i) => writeFileSync(`${process.env.NATIVE_SCREENSHOT}/${venue}-people-${i}.png`, shot));
    assert.deepEqual([...fetched].sort(), [...wanted].sort(), venue);
    assert.ok(!shots[0].equals(shots[1]), `${venue}: the frame changes over time`);
    assert.deepEqual(errors, [], venue);
    let perf = "";
    if (process.env.PEOPLE_PERF) {
      const withPeople = await frameRate(page);
      await page.close();
      const bare = await load(venue, { people: false });
      const without = await frameRate(bare.page);
      await bare.page.close();
      perf = ` fps ${withPeople.fps.toFixed(1)} (median ${withPeople.median.toFixed(1)} ms, p95 ${withPeople.p95.toFixed(1)}) with, ${without.fps.toFixed(1)} (median ${without.median.toFixed(1)} ms) without`;
    } else await page.close();
    console.log(`${venue}: ${manifest.spectators.length} spectators, ${manifest.classes.length} classes, ${wanted.size} files ok${perf}`);
  }
} finally {
  await browser?.close();
  server.close();
}
