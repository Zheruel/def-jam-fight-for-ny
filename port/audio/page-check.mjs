// Public-entry check of the match audio on the real game page, headless Chrome: nothing audio loads before the first
// gesture; the host's click (which starts the host mix) brings in the retail battle music; a WebRTC guest hears it;
// combat cues load as the fight is fought. A second run with the music files blocked gives the bed-only baseline.
//   node port/audio/page-check.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { chromium } from "../../netplay/node_modules/playwright/index.mjs";
import { attachNetplay } from "../../netplay/server.mjs";
import { gameServer } from "../../tools/serve.mjs";

const music = JSON.parse(readFileSync(new URL("music.json", import.meta.url)));
const server = gameServer();
attachNetplay(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/`;
let browser;

// RMS of the guest's received audio over `ms`.
const guestLevel = `async (ms) => {
  const video = document.querySelector("#remote"), context = new AudioContext();
  await context.resume();
  const analyser = context.createAnalyser(); analyser.fftSize = 2048;
  context.createMediaStreamSource(video.srcObject).connect(analyser);
  const samples = new Float32Array(analyser.fftSize); let sum = 0, count = 0;
  for (let t = 0; t < ms; t += 100) {
    await new Promise(r => setTimeout(r, 100));
    analyser.getFloatTimeDomainData(samples);
    for (const v of samples) { sum += v * v; count++; }
  }
  return Math.sqrt(sum / count);
}`;

async function run({ blockMusic }) {
  const open = () => browser.newPage({ viewport: { width: 1024, height: 824 } });
  const host = await open(), errors = [], requests = [];
  host.on("pageerror", error => errors.push(error.message));
  host.on("request", r => { const p = new URL(r.url()).pathname; if (p.startsWith("/port/audio/")) requests.push(p.slice(12)); });
  if (blockMusic) await host.route("**/port/audio/music/**", route => route.abort());
  await host.goto(url);
  await host.waitForFunction(() => window.nativeBattle?.diagnostics().ticks > 5);
  await host.waitForTimeout(500);
  const before = requests.filter(p => p.startsWith("music") || p.startsWith("cues") || p.startsWith("ambience"));
  assert.deepEqual(before, [], "no audio files before the first gesture: " + before);
  assert.equal(await host.evaluate(() => nativeBattle.diagnostics().music), undefined);

  await host.locator("#host").click();                       // the first gesture; it also starts the host mix
  await host.waitForFunction(() => document.querySelector("#code").value.length === 8);
  const guest = await open();
  guest.on("pageerror", error => errors.push("guest: " + error.message));
  await guest.goto(await host.locator("#invite").getAttribute("href"));
  await guest.waitForFunction(() => window.nativeBattle);
  await guest.waitForFunction(() => document.querySelector("#remote").videoWidth > 0 && nativeBattle.diagnostics().network === "connected");

  // Fight: the host attacks for a few seconds so combat cues load.
  await host.evaluate(async () => {
    const buttons = [0x1000, 0x4000, 0x2000, 0x8000, 0x1100, 0x1400];
    let held = 0, n = 0;
    const until = performance.now() + 6000;
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame);
      const { actors, ticks } = nativeBattle.diagnostics();
      const dx = actors[1].position[0] - actors[0].position[0], dz = actors[1].position[2] - actors[0].position[2], dist = Math.hypot(dx, dz);
      if (ticks % 18 === 0) held = buttons[n++ % buttons.length];
      nativeBattle.setInput(0, { buttons: dist > 10 ? 0x2000 : ticks % 18 < 4 ? held : 0, x: dist > 7 ? dx / dist : 0, z: dist > 7 ? -dz / dist : 0 });
      nativeBattle.setInput(1, { buttons: 0, x: 0, z: 0 });
    }
  });
  const level = await guest.evaluate(`(${guestLevel})(2500)`);
  const tune = await host.evaluate(() => nativeBattle.diagnostics().music);
  const diagnostics = await host.evaluate(() => { const d = nativeBattle.diagnostics(); return { ticks: d.ticks, network: d.network }; });
  assert.deepEqual(errors.filter(e => !/Could not start battle music|ERR_FAILED|Failed to fetch|aborted/i.test(e)), []);
  await host.close(); await guest.close();
  return { requests, level, tune, diagnostics };
}

try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" && { channel: "chrome" }) });
  const baseline = await run({ blockMusic: true });
  assert.equal(baseline.tune, undefined, "blocked music files leave the match silent of music and otherwise working");
  const played = await run({ blockMusic: false });

  assert.equal(played.tune, "dirty", "the first battle song is dirty (first in both captured matches)");
  const tracks = played.requests.filter(p => /^music\//.test(p));
  assert.deepEqual(tracks, ["music/dirty.ogg"], "only the one track is fetched");
  assert.ok(played.requests.includes("music.json") && played.requests.includes("music.mjs"));
  assert.ok(played.requests.some(p => /^cues\//.test(p) && !/wcommon|fighter|grunts/.test(p)) || played.requests.includes("cues/wcommon1.ogg"), "venue or common cue banks loaded");
  assert.ok(played.requests.some(p => /^cues\/(fighter_|grunts_|wcommon)/.test(p)), "combat cue banks loaded during the fight: " + played.requests.filter(p => p.startsWith("cues")));
  assert.ok(played.level > baseline.level * 1.2, `a guest hears the music: bed only ${baseline.level.toFixed(3)}, with music ${played.level.toFixed(3)}`);
  assert.ok(music.battleSongs.set.includes(played.tune));
  console.log(`music ${played.tune}; guest rms ${baseline.level.toFixed(3)} (bed) -> ${played.level.toFixed(3)} (bed + music); fetched ${tracks.join(", ")}`);
  console.log("cue banks:", played.requests.filter(p => p.startsWith("cues")).join(", "));
  console.log("ok: the game page starts retail battle music on the first gesture and guests hear it");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
