// Headless Play! harness for the unlock patch. Serves runtime/play-build, page.html,
// ps2/content (overlay and manifests) and the disc on a loopback
// port with cross-origin isolation, then drives headless Chrome. Never opens a window.
//
//   const run = await launch({ iso, unlocks: true, outDir });
//   await run.waitFrames(600); await run.press('cross'); console.log(await run.profile());

import { createServer } from 'node:http';
import { createReadStream, statSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json' };

export const BUTTONS = { cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7,
  select: 8, start: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15 };
const mask = names => [].concat(names).reduce((m, n) => {
  if (!(n in BUTTONS)) throw new Error('unknown button ' + n);
  return m | (1 << BUTTONS[n]);
}, 0);

const inventory = JSON.parse(readFileSync(path.join(HERE, '../inventory.json'), 'utf8'));
const HANDLE_MASK = 0xff7fffff;

function serve(iso) {
  const routes = [['/runtime/play/', path.join(REPO, 'runtime/play-build')],
    ['/content/', path.join(REPO, 'ps2/content')]];
  const server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url, 'http://x');
    let file;
    if (url.pathname === '/') file = path.join(HERE, 'page.html');
    else if (url.pathname === '/disc.iso') file = iso;
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

export async function launch({ iso = path.join(REPO, 'private/ps2/reference.iso'), unlocks = true,
  outDir, log = console.log }) {
  const { chromium } = await import(path.join(REPO, 'netplay/node_modules/playwright/index.mjs'));
  if (outDir) mkdirSync(outDir, { recursive: true });
  const server = await serve(iso);
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', error => log('page error: ' + error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?unlocks=${unlocks ? 1 : 0}`);
  await page.waitForFunction(() => window.e2e && window.e2e.status !== 'loading', null, { timeout: 120000 });
  const state = () => page.evaluate(() => {
    const { pad, ram, read32, ...plain } = window.e2e;
    return plain;
  });
  const first = await state();
  if (first.status !== 'running') throw new Error('boot failed: ' + first.error);
  let shots = 0;
  const run = {
    page, state,
    async waitFrames(count, timeout = 900000) {
      const target = (await state()).frames + count;
      await page.waitForFunction(t => window.e2e.frames >= t || window.e2e.status !== 'running',
        target, { timeout, polling: 250 });
      const s = await state();
      if (s.status !== 'running') throw new Error('emulation stopped: ' + s.error);
      return s;
    },
    async press(buttons, { hold = 8, after = 30 } = {}) {
      await page.evaluate(m => window.e2e.pad(m, 0), typeof buttons === 'number' ? buttons : mask(buttons));
      await run.waitFrames(hold);
      await page.evaluate(() => window.e2e.pad(0, 0));
      await run.waitFrames(after);
    },
    async shot(name) {
      if (!outDir) return null;
      const file = path.join(outDir, `${String(++shots).padStart(3, '0')}-${name}.png`);
      await page.locator('#outputCanvas').screenshot({ path: file });
      log(`shot ${file} frames=${(await state()).frames}`);
      return file;
    },
    // EE words at `address` from every candidate RAM view.
    async read32(address, count = 1) {
      return page.evaluate(([a, c]) => { if (!window.e2e.read32(0, 1).length) window.e2e.ram(); return window.e2e.read32(a, c); },
        [address, count]);
    },
    // Decodes the live unlock sets: R = [[0x3FDB00] + 4]; venue set R+0x0C, fighter set R+0x20.
    async profile() {
      await page.evaluate(() => window.e2e.ram());
      const views = await page.evaluate(() => window.e2e.read32(0, 0).length);
      const results = [];
      for (let v = 0; v < views; v++) {
        const read = async (a, c = 1) => (await page.evaluate(([a, c]) => window.e2e.read32(a, c), [a, c]))[v];
        const obj = (await read(0x003fdb00))[0];
        if (!obj || obj >= 0x02000000) { results.push({ view: v, obj, valid: false }); continue; }
        const body = (await read(obj + 4))[0];
        if (!body || body >= 0x02000000) { results.push({ view: v, obj, body, valid: false }); continue; }
        const words = {};
        const sync = async (a, c = 1) => {
          const out = await read(a, c);
          for (let i = 0; i < c; i++) words[a + 4 * i] = out[i];
          return out;
        };
        const venue = await sync(body + 0x0c, 4), fighter = await sync(body + 0x20, 4);
        const setOf = async ([capacity, count, mirror, data]) => {
          if (!data || data >= 0x02000000 || count > capacity || capacity > 256) return { capacity, count, valid: false };
          return { capacity, count, mirror: mirror ? (await read(mirror))[0] : null,
            entries: count ? await read(data, count) : [], valid: true };
        };
        const points = (await read(body + 0x50))[0];
        results.push({ view: v, obj, body, points, venues: await setOf(venue), fighters: await setOf(fighter), valid: true });
      }
      return results;
    },
    // Compares a decoded set with the full handle list from inventory.json.
    coverage(set, kind) {
      const all = inventory[kind].map(e => Number(e.handle));
      const have = new Set((set?.entries ?? []).map(h => (h & HANDLE_MASK) >>> 0));
      const missing = inventory[kind].filter(e => !have.has(Number(e.handle))).map(e => e.name);
      return { total: all.length, present: all.length - missing.length, missing };
    },
    async close() {
      await browser.close().catch(() => {});
      server.close();
    }
  };
  return run;
}
