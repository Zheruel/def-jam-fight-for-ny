import { execFile } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '../../netplay/node_modules/playwright/index.mjs';
import { gameServer } from '../../tools/serve.mjs';

const [buildArgument, outputArgument] = process.argv.slice(2);
if (!buildArgument || !outputArgument) throw new Error('Usage: node ps2/diagnostics/benchmark.mjs PLAY_BUILD_DIR OUTPUT_DIR');
const build = resolve(buildArgument);
const output = resolve(outputArgument);
const ocr = resolve(process.env.BENCHMARK_OCR || 'private/ps2-diagnostics/ocr');
const run = promisify(execFile);
await mkdir(output, { recursive: true });
const pageSource = await readFile(new URL('./benchmark.html', import.meta.url));
const playAssets = new Map(await Promise.all(['Play.js', 'Play.wasm'].map(async name => [name, await readFile(join(build, name))])));
const server = gameServer(undefined, { reference: true });
const [serveGame] = server.listeners('request');
server.removeListener('request', serveGame);
server.on('request', (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const asset = playAssets.get(path.slice(6));
  if (path !== '/diag/' && (!path.startsWith('/diag/') || !asset)) return serveGame(request, response);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : asset ? 'text/javascript' : 'text/html');
  response.end(asset ?? pageSource);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.on('console', message => {
    if (!message.text().includes('Registered function')) console.log('PLAY', message.type(), message.text().trim());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/diag/`);
  await page.waitForFunction(() => window.benchmark?.samples.frames > 5, null, { timeout: 60_000 });
  const canvas = page.locator('canvas');
  let step = 0;
  async function snap(label) {
    const state = await page.evaluate(() => benchmark.snapshot());
    const file = `${String(++step).padStart(3, '0')}-${label}.png`;
    await canvas.screenshot({ path: join(output, file), timeout: 10_000 });
    console.log('SAMPLE', JSON.stringify({ file, ...state }));
    if (state.failure) throw new Error(state.failure);
    return join(output, file);
  }
  async function screenText(file) {
    if (!file) {
      file = join(output, 'screen-probe.png');
      await canvas.screenshot({ path: file, timeout: 10_000 });
    }
    const { stdout } = await run(ocr, [file]);
    return stdout.split('\t').at(-1).trim();
  }
  async function waitScreen(label, expected, tick) {
    let screen;
    for (let i = 0; i < 45; i++) {
      screen = await screenText();
      if (expected.test(screen)) {
        console.log('SCREEN', label, screen);
        await snap(label);
        return;
      }
      if (tick) await tick();
      await page.waitForTimeout(1_000);
    }
    throw new Error(`Did not recognize ${label}. Last text: ${screen}`);
  }
  async function press(button, delay = 500) {
    await page.evaluate(button => benchmark.press(button), button);
    await page.waitForTimeout(delay);
  }
  const CROSS = 1;
  const START = 1 << 9;
  const DOWN = 1 << 13;
  const RIGHT = 1 << 15;
  await waitScreen('autosave', /Autosave Warning/i);
  await press(CROSS, 3_000);
  await press(DOWN);
  await press(CROSS, 1_000);
  await press(DOWN);
  await press(CROSS, 3_000);
  await waitScreen('main-menu', /main menu|fighters and venues/i, () => press(START));
  await press(RIGHT);
  await press(CROSS, 2_000);
  await snap('battle');
  await press(CROSS, 800);
  await press(CROSS, 2_000);
  await snap('character-profile');
  await press(CROSS, 2_000);
  await press(START, 600);
  await press(CROSS, 800);
  await press(CROSS, 3_000);
  await snap('choose-fighter');
  await press(CROSS);
  await press(CROSS);
  await press(RIGHT);
  await press(CROSS);
  await press(CROSS, 2_000);
  await snap('choose-venue');
  await page.evaluate(() => { benchmark.resetMeasurement(); return benchmark.press(1); });
  let seenLoading = false;
  let fightHudSeen = false;
  let samplesSinceLoading = 0;
  for (let sample = 0; sample < Number(process.env.BENCHMARK_SAMPLES || 45); sample++) {
    const file = await snap('match');
    const screen = await screenText(file);
    console.log('MATCH SCREEN', screen);
    if (samplesSinceLoading >= 2 && /^BLAZE\s*\|.*\bDOC\b/i.test(screen)) {
      fightHudSeen = true;
      if (process.env.BENCHMARK_COMBAT) {
        await press(1 << 2, 1_000);
        await press(1 << 2, 1_000);
        await snap('combat');
      }
      break;
    }
    if (process.env.BENCHMARK_DUMP_STATE) await page.evaluate(() => benchmark.module._dumpMachineState?.());
    if (/oadin[egc]/i.test(screen)) {
      seenLoading = true;
      samplesSinceLoading = 0;
    } else if (seenLoading) {
      samplesSinceLoading++;
    }
    if (process.env.BENCHMARK_COMBAT && samplesSinceLoading >= 2) {
      await press(CROSS, 200);
    }
    await page.waitForTimeout(4_000);
  }
  if (process.env.BENCHMARK_COMBAT && !fightHudSeen) throw new Error('Fight HUD was not recognized. Check the captured match frames.');
} finally {
  await browser.close();
  server.close();
}
