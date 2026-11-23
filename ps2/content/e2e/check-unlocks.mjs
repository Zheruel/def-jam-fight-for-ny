// Production-launcher unlock check (headless Chrome, never opens a window).
//
//   npm start &                                   # dev server on 127.0.0.1:8174
//   node ps2/content/e2e/check-unlocks.mjs [all|select] [--record]
//
// Boots the normal launcher (which overlays ps2/content/unlock-disc-patch.json), follows the
// Battle route to CHOOSE FIGHTER, reads the live profile unlock sets and the battle list buffer
// from EE RAM (located inside the captured WebAssembly.Memory, so the page is not modified),
// counts the P1 grid, then picks a fighter and a venue that a retail profile has to buy and
// waits for the fight. Screens: private/ps2-content/unlock-check/. --record also writes the
// summary to ps2/content/unlock-verification.json. Needs the macOS Vision OCR helper at
// private/verification/ps2-match/recognize-text and Pillow in private/ps2-content/.venv.
import { chromium } from '../../../netplay/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'private/ps2-content/unlock-check';
mkdirSync(OUT, { recursive: true });
const phase = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'all';
const record = process.argv.includes('--record');
const inventory = JSON.parse(readFileSync('ps2/content/inventory.json', 'utf8'));
const byHandle = new Map([...inventory.fighters, ...inventory.venues].map(e => [Number(e.handle), e]));
const hex = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const report = { steps: [] };
const note = (...args) => { const line = args.join(' '); console.log(line); report.steps.push(line); };

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'] });
const p = await b.newPage({ viewport: { width: 960, height: 760 } });
// Record every WebAssembly.Memory so EE RAM can be read without changing the page.
await p.addInitScript(() => {
  const Original = WebAssembly.Memory;
  window.__mems = [];
  WebAssembly.Memory = function (descriptor) { const m = new Original(descriptor); window.__mems.push(m); return m; };
  WebAssembly.Memory.prototype = Original.prototype;
  const KEY = [0x8c830000, 0x3c02ff7f, 0x3442ffff, 0x03e00008];
  window.__ee = { base: null, mem: null };
  window.__eeFind = () => {
    for (const mem of window.__mems) {
      const heap = new Uint32Array(mem.buffer);
      for (let i = 0; i + 4 < heap.length; i++) {
        if (heap[i] !== KEY[0] || heap[i + 1] !== KEY[1] || heap[i + 2] !== KEY[2] || heap[i + 3] !== KEY[3]) continue;
        const base = i * 4 - 0x00360990;
        if (base < 0 || base + 0x02000000 > mem.buffer.byteLength) continue;
        const dv = new DataView(mem.buffer);
        const obj = dv.getUint32(base + 0x003fdb00, true);  // registry slot 0x18 is live only in real EE RAM
        if (obj && obj < 0x02000000) { window.__ee = { base, mem }; return base; }
      }
    }
    return null;
  };
  window.__ee32 = (address, count = 1) => {
    if (window.__ee.base === null && window.__eeFind() === null) return null;
    const dv = new DataView(window.__ee.mem.buffer);
    return Array.from({ length: count }, (_, i) => dv.getUint32(window.__ee.base + address + 4 * i, true));
  };
});
const delay = ms => p.waitForTimeout(ms);
const capture = OUT + '/current.png';
const screen = p.locator('#outputCanvas');
async function key(mask, hold = 230) { await p.evaluate(n => defJam.setPad(1, { buttons: n, axes: [0, 0, 0, 0] }), mask); await delay(hold); await p.evaluate(() => defJam.setPad(1, null)); await delay(600); }
const ocr = async (file = capture) => { await screen.screenshot({ path: file }); return JSON.parse(execFileSync('private/verification/ps2-match/recognize-text', [file], { encoding: 'utf8' })).join(' '); };
const ee = (a, c = 1) => p.evaluate(([a, c]) => window.__ee32(a, c), [a, c]);
const PAD = { cross: 1, circle: 2, triangle: 8, start: 512, up: 4096, down: 8192, left: 16384, right: 32768 };

async function profile(label) {
  const obj = (await ee(0x003fdb00))?.[0];
  if (!obj) { note(label, 'EE RAM not found'); return null; }
  const body = (await ee(obj + 4))[0];
  const sets = {};
  for (const [kind, off] of [['venues', 0x0c], ['fighters', 0x20]]) {
    const [capacity, count, mirror, data] = await ee(body + off, 4);
    const entries = count && count <= capacity ? await ee(data, count) : [];
    const have = new Set(entries.map(h => (h & 0xff7fffff) >>> 0));
    const missing = inventory[kind].filter(e => !have.has(Number(e.handle))).map(e => e.name);
    sets[kind] = { capacity, count, mirror: (await ee(mirror))[0], entries: entries.map(hex), missing };
    note(label, kind, `count ${count}/${capacity} mirror ${sets[kind].mirror} coverage ${inventory[kind].length - missing.length}/${inventory[kind].length}`,
      missing.length ? 'missing ' + missing.join(', ') : '');
  }
  return { obj: hex(obj), body: hex(body), sets };
}
// The battle setup screen writes the list it shows to the static array at 0x004E2D28.
async function battleList(label) {
  const words = await ee(0x004e2d28, 96);
  const list = [];
  for (const w of words) {
    const e = byHandle.get((w & 0xff7fffff) >>> 0);
    if (!e || (w >>> 24) !== (words[0] >>> 24)) break;  // the buffer is shared by both lists
    list.push(e);
  }
  note(label, `battle list ${list.length}: ${list.map(e => e.name).join(', ')}`);
  return list;
}

let prev, stage = 0, titleAttempts = 0;
try {
  await p.goto('http://127.0.0.1:8174/');
  await p.locator('#play-installed').click({ timeout: 3000 }).catch(() => {});  // older launcher only
  for (let z = 0; z < 160; z++) {
    await delay(1500);
    const text = await ocr();
    if (text !== prev) { console.log(z, text.slice(0, 170)); prev = text; }
    if (/AUTOSAVE WARNING/i.test(text)) { await key(1); continue; }
    if (/enable the autosave feature/i.test(text)) { await key(8192); await key(1); continue; }
    if (/Are you sure.+without/i.test(text)) { await key(8192); await key(1); continue; }
    if (/Press START button/i.test(text) && !stage) { await key(512); titleAttempts++; continue; }
    if (/NO EXCUSES|CHOOSE MATCH TYPE/i.test(text) && stage === 0) { note('BATTLE MODE REACHED'); copyFileSync(capture, OUT + '/1-match-type.png'); report.before = await profile('before-select'); stage = 1; await key(1); continue; }
    if (/MAIN MENU/i.test(text) && stage === 0) { note('UNRESTRICTED MAIN MENU'); copyFileSync(capture, OUT + '/0-main-menu.png'); break; }
    if (/STANDARD RULES/i.test(text) && stage === 1) { stage = 2; await key(1); continue; }
    if (/PICK MEMORY CARD SLOT/i.test(text) && stage === 2) { await key(1); continue; }
    if (/ENTER USER ID/i.test(text) && stage === 2) { await key(1); continue; }
    if (/NO USER ID SELECTED/i.test(text) && stage === 2) { await key(1); continue; }
    if (/PRESS START BUTTON/i.test(text) && stage === 2) { await key(512); continue; }
    if (/CHOOSE FIGHTER|WRESTLING/.test(text) && stage === 2) { note('FIGHTER SELECT REACHED'); copyFileSync(capture, OUT + '/2-choose-fighter.png'); stage = 3; break; }
    if (stage === 0 && z > 20 && !titleAttempts && z % 3 === 0) await key(512);
  }
  if (stage !== 3) throw new Error('fighter select not reached');
  // A press carried over from the user-ID screen can already have picked P1's fighter and
  // opened the costume picker (1 2 3) or READY; back out to the grid.
  for (let i = 0; i < 4; i++) {
    await delay(2500);
    await ocr();
    const white = Number(execFileSync('private/ps2-content/.venv/bin/python', ['-I', 'ps2/content/e2e/picker.py', capture], { encoding: 'utf8' }));
    if (white < 0.08) break;  // grid ~0.02, costume boxes ~0.16
    note('P1 already committed; backing out to the grid');
    await key(PAD.triangle, 400);
  }
  copyFileSync(capture, OUT + '/2-choose-fighter.png');
  report.profile = await profile('at-select');
  report.fighterList = await battleList('fighters');
  if (phase === 'select') throw new Error('stop');
  // Count the P1 grid by walking the cursor: the P1 name banner is static art, so identical
  // banner pixels mean the cursor did not move (edge) or came back to a fighter already seen.
  const { createHash } = await import('node:crypto');
  await delay(5000);  // the select screen drops presses while it is still streaming portraits
  const box = await screen.boundingBox();
  const banner = async () => createHash('sha1').update(await p.screenshot({ clip: {
    x: box.x + box.width * 0.20, y: box.y + box.height * 0.18, width: box.width * 0.27, height: box.height * 0.13 } })).digest('hex');
  const names = [];
  const seen = new Map();
  const settled = async () => { await delay(1500); return banner(); };
  const visit = async (label) => {
    const h = await settled();
    if (!seen.has(h)) { seen.set(h, label); names.push(label); return true; }
    return false;
  };
  // Moves once; if the banner is not new, presses again to tell a dropped press from an edge.
  const step = async (button, label) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await key(button, 400);
      if (await visit(label)) return true;
    }
    return false;
  };
  await visit('r0c0');
  let rows = 1;
  for (; rows < 20; rows++) if (!(await step(PAD.down, `r${rows}c0`))) break;
  await screen.screenshot({ path: `${OUT}/3-grid-last-row.png` });
  let lastCols = 1;
  for (; lastCols < 8; lastCols++) if (!(await step(PAD.right, `r${rows - 1}c${lastCols}`))) break;
  await screen.screenshot({ path: `${OUT}/3-grid-last-cell.png` });
  report.grid = { rows, lastRowCells: lastCols, columns: 6, uiFighters: (rows - 1) * 6 + lastCols };
  note('UI grid', `${rows} rows, ${lastCols} in the last row -> ${(rows - 1) * 6 + lastCols} selectable fighters`);
  // Back to the first cell: up to the top row, then left until the r0c0 banner is back.
  const origin = [...seen.entries()].find(([, label]) => label === 'r0c0')[0];
  for (let i = 0; i < rows; i++) await key(PAD.up);
  for (let i = 0; i < 80 && (await settled()) !== origin; i++) await key(PAD.left);
  // Pick a fighter the retail profile does not own (Crow, cost 250). The grid shows the battle
  // list without the story variants, so Crow's cell is its index in that filtered list.
  const shown = report.fighterList.filter(e => e.listed);
  report.uiFighterOrder = shown.map(e => e.name);
  const crowAt = shown.findIndex(e => e.key === 'Crow');
  for (let i = 0; i < crowAt; i++) await key(PAD.right);
  await delay(900);
  const banner1 = await ocr();
  const found = /CROW|Crow/.test(banner1);
  report.pickedFighterOcr = banner1.slice(0, 80);
  note('paid fighter cursor', `grid cell ${crowAt}`, found ? 'OCR confirms Crow' : 'banner OCR: ' + banner1.slice(0, 60) + ' (see 4-paid-fighter.png)');
  copyFileSync(capture, OUT + '/4-paid-fighter.png');
  if (crowAt >= 0) {
    await key(PAD.cross);                      // P1 picks
    await delay(1500); copyFileSync(capture, OUT + '/5-after-p1.png');
    let venueScreen = false;
    for (let z = 0; z < 40 && !venueScreen; z++) {
      await delay(1000);
      const text = await ocr();
      if (text !== prev) { console.log('v', z, text.slice(0, 170)); prev = text; }
      if (/CHOOSE VENUE/i.test(text)) { venueScreen = true; note('VENUE SELECT REACHED'); copyFileSync(capture, OUT + '/6-venue-select.png'); }
      // P1 also confirms the CPU fighter (cursor default: Blaze); retry until the venue map shows.
      else if (/CHOOSE FIGHTER/i.test(text) && z % 3 === 0) await key(PAD.cross, 400);
    }
    if (!venueScreen) throw new Error('venue select not reached');
    report.venueList = await battleList('venues');
    report.profileAfter = await profile('at-venue');
    // Cycle the venue cursor and record every venue title it lands on.
    const seen = [];
    let office = false;
    for (let step = 0; step < 40; step++) {
      const text = await ocr();
      const title = (text.match(/CHOOSE VENUE\s+(?:BACK\s+)?(.*?)\s+(?:[A-Z][a-z]|\S*SELECT|$)/) || [])[1] ?? text.slice(0, 40);
      seen.push(title);
      // Hunt's Point Scrapyard (index 18, cost 75) is not in the retail starting set.
      if (/SCRAP|SCHA|SCRA|Y[AÄ][RŘ]D/i.test(text)) { office = true; copyFileSync(capture, OUT + '/7-paid-venue.png'); break; }
      await key(PAD.right, 400);
      await delay(800);
    }
    note('venue cursor stops', seen.length, office ? 'reached Hunt\'s Point Scrapyard' : 'paid venue not found', '|', seen.join(' / '));
    if (office) {
      for (let z = 0; z < 6 && /CHOOSE VENUE/i.test(await ocr()); z++) await key(PAD.cross, 400);
      for (let z = 0; z < 60; z++) {
        await delay(2000);
        const text = await ocr();
        if (text !== prev) { console.log('f', z, text.slice(0, 170)); prev = text; }
        if (/CONTINUE/i.test(text) && z < 50) await key(PAD.cross);   // dismiss in-fight tutorial cards
        if (z === 25 || z === 45) await screen.screenshot({ path: `${OUT}/8-fight-${z}.png` });
      }
      await screen.screenshot({ path: OUT + '/9-fight-final.png' });
      const world = await ee(0x004e2d28, 1);
      note('fight loaded; shots 8-fight-*.png, 9-fight-final.png', hex(world[0]));
    }
  }
} catch (error) {
  if (error.message !== 'stop') { note('error', error.message); process.exitCode = 1; }
} finally {
  writeFileSync(OUT + '/report.json', JSON.stringify(report, null, 2));
  if (record && report.profile && report.profileAfter) {
    const names = list => list?.map(e => e.name);
    const before = report.before?.sets;
    writeFileSync('ps2/content/unlock-verification.json', JSON.stringify({
      format: 'def-jam-ps2-unlock-verification/1',
      runtime: 'web launcher (Play! wasm, headless Chrome), unlock-disc-patch.json overlay',
      retailStartingSet: before && { fighters: before.fighters.entries, venues: before.venues.entries },
      afterFill: { fighters: report.profile.sets.fighters.count, venues: report.profile.sets.venues.count,
        fighterMirror: report.profile.sets.fighters.mirror, venueMirror: report.profile.sets.venues.mirror,
        missing: [...report.profile.sets.fighters.missing, ...report.profile.sets.venues.missing] },
      battleFighterList: { count: report.fighterList.length, names: names(report.fighterList) },
      battleFighterGrid: { ...report.grid, order: report.uiFighterOrder,
        hiddenFromGrid: names(report.fighterList.filter(e => !e.listed)),
        notInBattleList: inventory.fighters.filter(f => !report.fighterList.includes(f)).map(f => f.name) },
      battleVenueList: { count: report.venueList.length, names: names(report.venueList) },
      targetedPicks: report.steps.filter(line => /paid|venue cursor|fight loaded/.test(line)),
    }, null, 2) + '\n');
  }
  await b.close();
}
