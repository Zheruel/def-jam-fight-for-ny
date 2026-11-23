// Records reproducible controller traces for the specialty arenas (port/battle/special-traces.json).
//   node verification/special-traces.mjs
// A scripted player one grapples player two (cross), throws him at the arena wall (circle, no stick: the fighters face each
// other, so he flies along the line to the wall), walks up to the slumped fighter and grabs him again (cross): at a wall
// object that is the retail slam pair, states 103/104, which damages the object (rail health 3 -> 0, events nA, nB, nC).
// Player two only mashes cross to get up. Fighter positions are poked at the start of each round (setup, not input).
// The trace stores every poke and every pad frame, so port/battle/special.test.mjs replays it without any logic.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createEnvironment } from "../port/scenery/environment.mjs";
import inventory from "../ps2/content/inventory.json" with { type: "json" };

const root = new URL("../port/", import.meta.url);
const packed = file => Uint8Array.from(gunzipSync(readFileSync(new URL(file, root)))).buffer;
const A = [0x4bc170, 0x4bd468], G = 0x4bbf90;

export async function nativeMatch(venueId) {
  const { createFoundationFight } = await import("../port/battle/fight.mjs");
  const { createMatchAnimation } = await import("../port/animation/match.mjs");
  const sampler = await WebAssembly.compile(packed("animation/sampler.wasm.gz"));
  const ids = [5, 17];
  const fighters = ids.map(id => {
    const record = inventory.fighters.find(f => f.fighterXml.coreID === id);
    const asset = packed(`render/fighters/${record.model}.skin.gz`);
    const body = JSON.parse(new TextDecoder().decode(new Uint8Array(asset, 8, new DataView(asset).getUint32(4, true))));
    return { model: record.model, body, record };
  });
  const animation = await createMatchAnimation(sampler, packed("animation/shared.gz"), ids.map(id => packed(`animation/banks/wres${String(id).padStart(3, "0")}.gz`)));
  const venue = inventory.venues.find(v => v.coreID === venueId);
  const arena = { venue, collision: Uint8Array.from(readFileSync(new URL(`collision/venues/${venue.file}.cli`, root))).buffer };
  return createFoundationFight(fighters, packed("kernel/battle.wasm.gz"), packed("kernel/foundation-start.gz"), arena, packed("kernel/match-rules.gz"), animation);
}

export const SCENARIOS = {
  "ringout-rail-break": { venue: 5, file: "V2BG_05A", target: [9.5, -42.25], hp: 300, ticks: 2000 },
  "window-slam": { venue: 17, file: "V2BG_15A", target: [-48.5, -8.3], hp: 300, ticks: 400 },
  "window-slam-ko-ready": { venue: 17, file: "V2BG_15A", target: [-48.5, -1], hp: 20, ticks: 400 },
};

const IDLE = { buttons: 0, x: 0, z: 0 };

// Plays a scenario with the closed-loop script and returns the trace: pokes ([tick, slot, x, z] or [tick, slot, "hp", value]),
// pads ([tick, slot, buttons] on change) and what happened (events, finish).
export async function record(name) {
  const s = SCENARIOS[name];
  const fight = await nativeMatch(s.venue), m = fight.memory;
  const names = JSON.parse(readFileSync(new URL("scenery/events.json", root), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL(`scenery/${s.file}/scenery.json`, root), "utf8"));
  const env = createEnvironment(manifest, names.names, { weaponModels: names.weaponModels });
  const fl = a => m.getFloat32(a, true), w = a => m.getUint32(a, true);
  const pokes = [], pads = [], events = [];
  for (let t = 0; t < 30; t++) fight.tick([IDLE, IDLE]);
  const base = 30;
  const [tx, tz] = s.target, L = Math.hypot(tx, tz), ux = tx / L, uz = tz / L;
  const put = (t, slot, x, z) => { for (const o of [0x44, 0xc4]) { m.setFloat32(A[slot] + o, x, true); m.setFloat32(A[slot] + o + 8, z, true); } pokes.push([t, slot, +x.toFixed(4), +z.toFixed(4)]); };
  let episode = -1, placed = -1, cooldown = 0, last = [-1, -1], finish = null;
  for (let t = 0; t < s.ticks; t++) {
    const s0 = w(A[0] + 0x30), s1 = w(A[1] + 0x30);
    if (episode < 0 && s0 === 1 && s1 === 1) {
      put(t, 0, tx - ux * 6, tz - uz * 6); put(t, 1, tx - ux * 3.5, tz - uz * 3.5);
      m.setFloat32(A[1] + 0x350, s.hp, true); pokes.push([t, 1, "hp", s.hp]);
      episode = t; placed = -1; cooldown = 0;
    }
    const e = episode < 0 ? -1 : t - episode;
    const p0 = { buttons: 0, x: 0, z: 0 };
    if (e >= 4 && e < 10) p0.buttons = 0x4000;
    else if (e >= 60 && e < 66) p0.buttons = 0x2000;
    else if (e >= 66 && s1 === 55 && s0 === 1) {
      if (placed < 0) { put(t, 0, fl(A[1] + 0x44) - ux * 2, fl(A[1] + 0x4c) - uz * 2); placed = t; }
      else if (cooldown === 0) { p0.buttons = 0x4000; cooldown = 6; }
    }
    if (cooldown > 0) cooldown--;
    if (s0 === 1 && s1 === 1 && e > 120) episode = -1;
    const p1 = { buttons: (s1 === 21 || s1 === 104) && t % 8 < 4 ? 0x4000 : 0, x: 0, z: 0 };
    if (p0.buttons !== last[0]) pads.push([t, 0, p0.buttons]);
    if (p1.buttons !== last[1]) pads.push([t, 1, p1.buttons]);
    last = [p0.buttons, p1.buttons];
    fight.tick([p0, p1]);
    for (const ev of env.update(m, 1, fight.states)) events.push([t, names.names[ev.id]]);
    if (fight.outcome().over && finish === null) { finish = { tick: t, method: fight.outcome().method, loser: fight.outcome().loser, flags: [0, 1].map(i => m.getUint16(A[i] + 0x932, true)) }; break; }
  }
  return { scenario: name, ...s, base, pokes, pads, events, finish, G1bc: w(G + 0x1bc) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = {};
  for (const name of Object.keys(SCENARIOS)) {
    out[name] = await record(name);
    console.log(name, "events", JSON.stringify(out[name].events), "finish", JSON.stringify(out[name].finish));
  }
  writeFileSync(new URL("battle/special-traces.json", root), JSON.stringify(out));
}
