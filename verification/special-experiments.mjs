// RAM-poke experiments on the live retail match (headless reference), used to read the finish rule of each special format.
// Each experiment is driven through capture-special.mjs and logs one JSON line per sample: the referee phase (G+8), the
// loser/winner marks (+0x932), the match flags (G+0x1c0, G+448), health, position, state and the environment-event queue.
const A = [0x4bc170, 0x4bd468], G = 0x4bbf90, QUEUE = 0x476e28;

export async function sample(run, label) {
  return run.page.evaluate(([actors, g, queue, label]) => {
    const w = a => window.eeWord(a), f = a => +window.eeFloat(a).toFixed(2);
    return { label, phase: w(g + 8), g1c0: w(g + 0x1c0), g1c8: w(g + 448), clock: [w(g + 0x1a8), w(g + 0x1ac)],
      queue: [0, 1].map(i => [w(queue + i * 16), w(queue + i * 16 + 4)]),
      actors: actors.map(a => ({ mark: w(a + 0x932) & 0xffff, f924: w(a + 0x924) & 0xffff, hp: f(a + 0x350), state: w(a + 0x30), pos: [f(a + 0x44), f(a + 0x48), f(a + 0x4c)] })) };
  }, [A, G, QUEUE, label]);
}
const log = (run, x) => console.log("S " + JSON.stringify(x));
const mask = names => names.reduce((m, n) => m | (1 << { cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7, up: 12, down: 13, left: 14, right: 15 }[n]), 0);
const poke = (run, address, value) => run.page.evaluate(([a, v]) => window.eePoke(a, v), [address, value]);
const pokeFloat = (run, address, value) => run.page.evaluate(([a, v]) => window.eePokeFloat(a, v), [address, value]);
const place = async (run, slot, x, z) => { for (const o of [0x44, 0xc4]) { await pokeFloat(run, A[slot] + o, x); await pokeFloat(run, A[slot] + o + 8, z); } };

// Watches `frames` frames in steps of `step`, logging each sample; stops once the referee leaves phase 1 for `after` more frames.
async function watch(run, label, frames, { step = 20, after = 240, pad = null } = {}) {
  let ended = null, still = 0, last = "";
  for (let t = 0; t < frames; t += step) {
    if (pad) await run.page.evaluate(m => window.e2e.pad(m, 0), pad(t));
    await run.waitFrames(step);
    const s = await sample(run, `${label}@${t}`);
    log(run, s);
    // A tutorial card (a first DANGER, a first environment attack...) pauses the round until X: clock and positions stand still.
    const key = JSON.stringify([s.clock, s.actors.map(a => a.pos)]);
    still = key === last ? still + 1 : 0; last = key;
    if (still === 6) { await run.shot(label + "-stalled"); await run.page.evaluate(() => window.e2e.pad(0, 0)); await dismiss(run, 2); still = 0; }
    if (s.phase >= 2 && ended === null) ended = t;
    if (ended !== null && t >= ended + after) break;
  }
  await run.page.evaluate(() => window.e2e.pad(0, 0));
  await run.shot(label);
}

// The first DANGER shows a tutorial card that pauses the round until X is pressed.
async function dismiss(run, times = 4) { for (let i = 0; i < times; i++) await run.press("cross", { hold: 8, after: 40 }); }


// Turns the CPU seat into an idle person seat (the native fixtures' idle second pad): seat type 0 and the actor's CPU bit off.
async function quiet(run, slot) {
  await poke(run, 0x4bbd38 + 4 * slot, 0);
  await run.page.evaluate(([a]) => window.eePoke(a, window.eeWord(a) & ~(1 << 24)), [A[slot] + 0x934]);
}


// The pad stick is camera relative: measure which world direction each pad direction walks player one toward.
async function calibrate(run) {
  const out = {};
  for (const d of ["up", "down", "left", "right"]) {
    const before = await sample(run, "cal"), a = before.actors[0].pos;
    await run.page.evaluate(m => window.e2e.pad(m, 0), mask([d])); await run.waitFrames(6);
    const after = await sample(run, "cal"), b = after.actors[0].pos;
    await run.page.evaluate(() => window.e2e.pad(0, 0)); await run.waitFrames(30);
    const v = [b[0] - a[0], b[2] - a[2]], n = Math.hypot(...v) || 1;
    out[d] = [v[0] / n, v[1] / n];
  }
  return out;
}
// The pad direction (one or two of up/down/left/right) whose measured walk best matches the world direction `want`.
function padToward(map, want) {
  const names = Object.keys(map); let best = [0, []];
  const combos = names.map(n => [n]).concat(names.flatMap(a => names.filter(b => b > a).map(b => [a, b])));
  for (const c of combos) {
    const v = c.reduce((s, n) => [s[0] + map[n][0], s[1] + map[n][1]], [0, 0]), n = Math.hypot(...v) || 1;
    const score = (v[0] * want[0] + v[1] * want[1]) / n;
    if (score > best[0]) best = [score, c];
  }
  return best[1];
}

// Drives a scripted pad trace for player one near a Dragon House railing and logs each change of the fighters' states.
// ARGS=railX,railZ,seed-free. Positions equal the native fixture (/port/battle/special.test.mjs): player one 7 units from the
// rail, the CPU 3.5; player one walks to the rail, grabs (cross), then throws with `button` held with the stick toward the rail.
async function throwScenario(run, label, { rail = [3, -42.25], steps, tail = 160, hp = null }) {
  const L = Math.hypot(...rail), u = [rail[0] / L, rail[1] / L];
  await quiet(run, 1);
  await dismiss(run);
  // Fighters face each other on their own, so a throw with no stick sends the CPU along the line to the rail: no camera mapping needed.
  await place(run, 0, rail[0] - u[0] * 6, rail[1] - u[1] * 6); await place(run, 1, rail[0] - u[0] * 3.5, rail[1] - u[1] * 3.5);
  await run.waitFrames(10);
  if (hp !== null) { await pokeFloat(run, A[1] + 0x350, hp); await pokeFloat(run, A[1] + 0x35c, hp / 300); }
  const trace = []; let last = "";
  for (let t = 0; t < tail; t += 2) {
    const step = steps.findLast(s => t >= s.from);
    await run.page.evaluate(m => window.e2e.pad(m, 0), mask(step?.buttons ?? []));
    await run.waitFrames(2);
    const s = await sample(run, `${label}@${t}`);
    const key = JSON.stringify([s.actors.map(a => a.state), s.actors.map(a => a.mark), s.phase, s.g1c0]);
    if (key !== last) { last = key; log(run, { ...s, ac0: await run.page.evaluate(() => [window.eeWord(0x4bc170 + 0xac0), window.eeWord(0x4bd468 + 0xac0)]) }); }
  }
  await run.page.evaluate(() => window.e2e.pad(0, 0));
  await run.shot(label);
}

export const experiments = {
  // ARGS=x,z: put the CPU fighter outside the ring (or anywhere) and watch the referee.
  async outside(run, { args: [x = -62, z = 0] }) {
    log(run, await sample(run, "before"));
    await place(run, 1, x, z);
    await watch(run, "outside", 1200, { step: 30 });
  },
  // ARGS=x,z,seed: both fighters next to a point (an object), the CPU nearly spent; the player mashes pad buttons toward it.
  async mash(run, { args: [x = 0, z = 0, seed = 1] }) {
    await pokeFloat(run, A[1] + 0x350, 8); await pokeFloat(run, A[1] + 0x35c, 8 / 300);
    await place(run, 0, x, z + 7); await place(run, 1, x, z);
    await dismiss(run);
    log(run, await sample(run, "after-dismiss"));
    let random = seed;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const names = ["square", "triangle", "circle", "cross", "l1", "r1", "l2", "r2"];
    const dirs = ["up", "down", "left", "right"];
    let dir = "up";
    await watch(run, "mash", 3600, { step: 10, pad: t => { if (t % 60 === 0) dir = dirs[next() % 4];
      return mask([names[next() % 8], ...(next() % 3 ? [dir] : []), ...(next() % 5 === 0 ? [names[next() % 8]] : [])]); } });
  },
  // Does a plain KO at this venue (CPU nearly spent, player mashing at the spawn) end with the same marks? Baseline.
  async baseline(run) {
    await pokeFloat(run, A[1] + 0x350, 8); await pokeFloat(run, A[1] + 0x35c, 8 / 300);
    await dismiss(run);
    let random = 7;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const names = ["square", "triangle", "circle", "cross", "l1", "r1", "l2", "r2"];
    await watch(run, "baseline", 3600, { step: 10, pad: () => mask([names[next() % 8], ...(next() % 3 ? ["right"] : [])]) });
  },
  // Grab at the rail then throw at it: ARGS=buttonIndex (0 circle,1 cross,2 square,3 triangle)
  async throw(run, { args: [button = 0, hp = 0] }) {
    const names = ["circle", "square", "triangle", "cross"];
    await throwScenario(run, "throw-" + names[button], { hp: hp || null,
      steps: [{ from: 0, buttons: [] }, { from: 4, buttons: ["cross"] }, { from: 10, buttons: [] }, { from: 60, buttons: [names[button]] }, { from: 66, buttons: [] }], tail: 240 });
  },

  // Forces a referee mark on the CPU (ARGS=mark, default 0x80 = ring out) and records everything that follows: the finish
  // banner, the score sheet, the RAM with the result word and the screens up to the rematch prompt.
  async finish(run, { args: [mark = 0x80, wait = 40], outDir, read, dump }) {
    await dismiss(run);
    log(run, await sample(run, "before"));
    await run.page.evaluate(([a, m]) => window.eePoke(a, (window.eeWord(a) | (m << 16)) >>> 0), [A[1] + 0x930, mark]);
    let ended = null, shots = 0;
    for (let t = 0; t < 4000; t += 30) {
      await run.waitFrames(30);
      const s = await sample(run, `finish@${t}`);
      const result = await run.page.evaluate(() => [0, 1, 2, 3].map(i => window.eeWord(0x4c1c58 + i * 16 + 0xc)).concat(window.eeWord(0x4bbf90 + 0x1bc), window.eeWord(0x4bbf90 + 0x1d8)));
      log(run, { ...s, result });
      if (s.phase >= 2 && ended === null) { ended = t; await dump("finish-over.bin"); }
      if (ended !== null) {
        const text = await read(); log(run, { label: "ocr", t, text });
        await run.shot(`finish-${String(shots++).padStart(2, "0")}`);
        if (t === ended + 360) await dump("finish-sheet.bin");
        if (/REMATCH|PLAY AGAIN|MAIN MENU/i.test(text)) { await dump("finish-rematch.bin"); break; }
        if (t > ended + 300 && t % 120 === 0) await run.press("cross", { hold: 8, after: 20 });
      }
    }
  },
};
