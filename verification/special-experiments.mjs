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
};
