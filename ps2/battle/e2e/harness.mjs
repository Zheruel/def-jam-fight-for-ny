// Headless Play! harness for the Battle patch. Serves runtime/play, this page and a disc
// image on a loopback port with cross-origin isolation, then drives headless Chrome.
//
//   import { launch } from './harness.mjs';
//   const run = await launch({ iso, patch: 'overlay' | 'none', outDir });
//   await run.waitFrames(600); await run.press('Enter'); await run.shot('title');
//   await run.close();

import { createServer } from 'node:http';
import { createReadStream, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
const BATTLE = path.resolve(HERE, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json' };

// Standard Gamepad bit numbers, as _setPad in runtime/play-build expects them.
export const BUTTONS = { cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7,
  select: 8, start: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15 };
export function padMask(names) {
  return [].concat(names).reduce((mask, name) => {
    if (!(name in BUTTONS)) throw new Error('unknown button ' + name);
    return mask | (1 << BUTTONS[name]);
  }, 0);
}

function serve({ iso, manifest }) {
  const routes = [
    ['/runtime/play/', path.join(REPO, 'runtime/play-build')],
    ['/battle/', BATTLE]
  ];
  const server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url, 'http://x');
    let file;
    if (url.pathname === '/') file = path.join(HERE, 'page.html');
    else if (url.pathname === '/disc.iso') file = iso;
    else if (url.pathname === '/battle-patch.json') file = manifest;
    else for (const [prefix, dir] of routes) {
      if (!url.pathname.startsWith(prefix)) continue;
      const candidate = path.resolve(dir, '.' + url.pathname.slice(prefix.length - 1));
      if (candidate.startsWith(dir + path.sep)) file = candidate;
    }
    let stat;
    try { stat = file && statSync(file); } catch { stat = null; }
    if (!stat?.isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0, end = stat.size - 1;
    if (match) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    res.writeHead(match ? 206 : 200);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export async function launch({ iso, patch = 'overlay', outDir, log = console.log,
  manifest = path.join(BATTLE, 'battle-patch.json') }) {
  const { chromium } = await import(path.join(REPO, 'netplay/node_modules/playwright/index.mjs'));
  mkdirSync(outDir, { recursive: true });
  const server = await serve({ iso, manifest });
  const port = server.address().port;
  // Always headless: these tests must never open a window.
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', error => log('page error: ' + error.message));
  await page.goto(`http://127.0.0.1:${port}/?patch=${patch}`);
  await page.waitForFunction(() => window.e2e && window.e2e.status !== 'loading', null, { timeout: 120000 });
  const state = () => page.evaluate(() => {
    const { pad, readback, ...plain } = window.e2e;
    return plain;
  });
  const first = await state();
  if (first.status !== 'running') throw new Error('boot failed: ' + first.error);
  let shots = 0;
  const run = {
    page, state,
    async waitFrames(count, timeout = 600000) {
      const target = (await state()).frames + count;
      await page.waitForFunction(t => window.e2e.frames >= t || window.e2e.status !== 'running',
        target, { timeout, polling: 250 });
      const s = await state();
      if (s.status !== 'running') throw new Error('emulation stopped: ' + s.error);
      return s;
    },
    // Holds pad buttons (names from BUTTONS, or a bitmap) on port 1 for `hold` emulated
    // frames, then releases them and waits `after` frames.
    async press(buttons, { hold = 8, after = 30, port = 0 } = {}) {
      const mask = typeof buttons === 'number' ? buttons : padMask(buttons);
      await page.evaluate(([m, p]) => window.e2e.pad(m, p), [mask, port]);
      await run.waitFrames(hold);
      await page.evaluate(p => window.e2e.pad(0, p), port);
      await run.waitFrames(after);
    },
    async shot(name) {
      const file = path.join(outDir, `${String(++shots).padStart(3, '0')}-${name}.png`);
      await page.locator('#outputCanvas').screenshot({ path: file });
      log(`shot ${file} frames=${(await state()).frames}`);
      return file;
    },
    async close() {
      await browser.close().catch(() => {});
      server.close();
    }
  };
  return run;
}
