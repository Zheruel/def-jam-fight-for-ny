import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };
import { SPECIAL, SPECIAL_IDS, createFinishLatch, specialByType, specialOf } from "./special.mjs";

const retail = JSON.parse(readFileSync(new URL("./special-retail.json", import.meta.url), "utf8")).facts;
const packed = file => Uint8Array.from(gunzipSync(readFileSync(new URL("../" + file, import.meta.url)))).buffer;
const A = [0x4bc170, 0x4bd468], G = 0x4bbf90, VENUE = 0x4bbd34;
const idle = { buttons: 0, x: 0, z: 0 };

// Blaze (5) v Crack (17): the pair of the retail captures. The native start is the Foundation start with the venue's own
// collision, spawn table and stage objects installed by the retail loaders.
async function nativeMatch(venueId) {
  const { createFoundationFight } = await import("./fight.mjs");
  const { createMatchAnimation } = await import("../animation/match.mjs");
  const sampler = await WebAssembly.compile(packed("animation/sampler.wasm.gz"));
  const ids = [5, 17];
  const fighters = ids.map(id => {
    const record = inventory.fighters.find(f => f.fighterXml.coreID === id);
    const asset = packed(`render/fighters/${record.model}.skin.gz`);
    const body = JSON.parse(new TextDecoder().decode(new Uint8Array(asset, 8, new DataView(asset).getUint32(4, true))));
    return { model: record.model, body, record };
  });
  const animation = await createMatchAnimation(sampler, packed("animation/shared.gz"),
    ids.map(id => packed(`animation/banks/wres${String(id).padStart(3, "0")}.gz`)));
  const venue = inventory.venues.find(v => v.coreID === venueId);
  const arena = { venue, collision: Uint8Array.from(readFileSync(new URL(`../collision/venues/${venue.file}.cli`, import.meta.url))).buffer };
  return createFoundationFight(fighters, packed("kernel/battle.wasm.gz"), packed("kernel/foundation-start.gz"),
    arena, packed("kernel/match-rules.gz"), animation);
}
const scalar = (fight, a) => fight.memory.getFloat32(a, true);
const word = (fight, a) => fight.memory.getUint32(a, true);
const XYZ = [0x44, 0x48, 0x4c];

test("the table matches the retail match-type ids and the venue inventory", () => {
  assert.deepEqual(SPECIAL_IDS, ["demolition", "inferno", "subway", "window", "cage", "ringout"]);
  assert.deepEqual(SPECIAL_IDS.map(mode => SPECIAL[mode].id), [6, 7, 8, 9, 10, 11]);
  for (const mode of SPECIAL_IDS) {
    const { id, venue, file } = SPECIAL[mode];
    assert.equal(inventory.venues.find(v => v.coreID === venue)?.file, file, mode);
    assert.equal(specialOf(venue), mode);
    assert.equal(specialByType(id), mode);
    // The retail capture of this format agrees: its match type and its forced venue.
    assert.equal(retail[mode].matchType, id, mode);
    assert.equal(retail[mode].venue, venue, mode);
  }
  assert.equal(retail.single.matchType, 0, "a standard one-on-one is type 0");
});

test("retail: a special start is a standard one-on-one apart from the match type", () => {
  for (const mode of SPECIAL_IDS) {
    const { rules, seats, phase } = retail[mode];
    assert.deepEqual([rules, seats, phase], [retail.single.rules, retail.single.seats, retail.single.phase], mode);
  }
});

test("native start of every format: the venue, player one's spawn and the stage objects equal the retail capture", async () => {
  for (const mode of SPECIAL_IDS) {
    const fight = await nativeMatch(SPECIAL[mode].venue);
    for (let i = 0; i < 80; i++) fight.tick([idle, idle]);   // the capture is taken about 80 frames into the round
    const facts = retail[mode];
    assert.equal(word(fight, VENUE), facts.venue, mode);
    assert.equal(word(fight, 0x4bbd2c), facts.rules, mode);
    assert.deepEqual(XYZ.map(o => +scalar(fight, A[0] + o).toFixed(1)), facts.player1, `${mode} player one (idle) stands where retail's did`);
    assert.deepEqual([word(fight, 0x4c1ad4), word(fight, 0x4c1adc)], [facts.stageObjects.definitions, facts.stageObjects.objects], `${mode} stage objects`);
    assert.equal(fight.outcome().phase, 1, mode);
  }
});

test("native stage objects are byte-identical to retail's apart from the relocated definition pointer", async () => {
  // The retail capture is private; the fixture keeps the per-venue digest of the 0x48-byte object records instead.
  const digests = JSON.parse(readFileSync(new URL("./special-retail.json", import.meta.url), "utf8")).stageObjectDigest;
  const { createHash } = await import("node:crypto");
  for (const mode of SPECIAL_IDS) {
    const fight = await nativeMatch(SPECIAL[mode].venue);
    for (let i = 0; i < 80; i++) fight.tick([idle, idle]);
    const hash = createHash("sha256"), objects = word(fight, 0x4c1ae0);
    for (let i = 0; i < word(fight, 0x4c1adc); i++) {
      const record = new Uint8Array(fight.memory.buffer, fight.memory.byteOffset + objects + i * 0x48, 0x48).slice();
      record.fill(0, 0x44, 0x48);   // +0x44 points at the definition, which sits at a different address natively
      hash.update(record);
    }
    assert.equal(hash.digest("hex"), digests[mode], mode);
  }
});

test("inferno: the fire clock runs as retail's did and the ring-edge fire burns only the fighter who walks into it", async () => {
  const fight = await nativeMatch(7);
  const clock = () => scalar(fight, 0x4c1930);
  let at80, at693;
  for (let t = 0; t <= 693; t++) {
    if (t === 80) at80 = clock();
    if (t === 693) at693 = clock();
    fight.tick([{ buttons: 0, x: 0, z: 0 }, idle]);
  }
  assert.ok(Math.abs(at80 - retail.inferno.fireClock[0]) < 0.01, `clock at tick 80: ${at80} v retail ${retail.inferno.fireClock[0]}`);
  assert.ok(Math.abs(at693 - retail.inferno.fireClock[1]) < 0.05, `clock at tick 693: ${at693} v retail ${retail.inferno.fireClock[1]}`);
  // A pad-driven walk to the edge of the ring: the retail fire code (0x2def80) sets the burn state and flags.
  const burning = await nativeMatch(7);
  const hp = slot => scalar(burning, A[slot] + 0x350), flags = slot => burning.memory.getUint16(A[slot] + 0x924, true);
  const before = [hp(0), hp(1)];
  for (let t = 0; t < 120; t++) {
    const [x, z] = [scalar(burning, A[0] + 0x44), scalar(burning, A[0] + 0x4c)], d = Math.hypot(x, z) || 1;
    burning.tick([{ buttons: 0, x: x / d, z: -z / d }, idle]);
  }
  assert.equal(word(burning, A[0] + 0x30), 113, "the walker is on fire");
  assert.equal(flags(0) & 0xc000, 0xc000, "in the fire zone");
  assert.ok(hp(0) < before[0] - 1, "and loses health");
  assert.equal(hp(1), before[1], "the other fighter is untouched");
  const mid = hp(0);
  for (let t = 0; t < 60; t++) burning.tick([{ buttons: 0, x: -1, z: 0 }, idle]);
  assert.ok(hp(0) < mid, "the fire keeps burning at the edge");
});

// The pad script of verification/native-outcome.mjs: both fighters close in and trade buttons; the victim starts nearly spent.
const buttons = [0x1000, 0x4000, 0x2000, 0x8000, 0x1100, 0x1400, 0x1800, 0x1200, 0x4400, 0x8100, 0x400, 0x800];
function knockout(fight, victim, seed, latch) {
  const m = fight.memory, max = scalar(fight, A[victim] + 0x354);
  m.setFloat32(A[victim] + 0x350, 8, true);
  m.setFloat32(A[victim] + 0x35c, 8 / max, true);
  let random = seed, held = [0, 0];
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  for (let tick = 0; tick < 12000; tick++) {
    const { actors, outcome } = fight.diagnostics();
    latch.observe();
    if (outcome.over) return { tick, outcome, actors };
    const dx = actors[1].position[0] - actors[0].position[0], dz = actors[1].position[2] - actors[0].position[2], dist = Math.hypot(dx, dz);
    if (tick % 18 === 0) held = [buttons[next() % 12], buttons[next() % 12]];
    fight.tick(actors.map((_, slot) => ({ buttons: dist > 10 ? 0x2000 : tick % 18 < 4 ? (slot === victim ? 0 : held[slot]) : 0,
      x: dist > 7 ? (slot ? -1 : 1) * dx / dist : 0, z: dist > 7 ? (slot ? 1 : -1) * dz / dist : 0 })));
  }
  assert.fail("no result");
}

test("every format ends in a retail knockout driven by pads; the finish latch calls Red Hook's fire and a plain knockout everywhere else", async () => {
  const expected = { demolition: "ko", inferno: "inferno", window: "ko", cage: "ko", ringout: "ko" };
  for (const mode of Object.keys(expected)) {   // the subway round is decided by the first train (next test)
    const fight = await nativeMatch(SPECIAL[mode].venue), latch = createFinishLatch(fight.memory);
    const victim = mode === "inferno" ? 0 : 1;   // Red Hook's script reaches the fire finish with slot 0 as the loser
    const { outcome, actors } = knockout(fight, victim, 17, latch);
    assert.equal(outcome.method, "ko", mode);
    assert.equal(outcome.winner, 1 - victim, mode);
    assert.equal(actors[victim].health, 0, mode);
    assert.ok(actors[1 - victim].health > 0, mode);
    assert.equal(latch.kind(), expected[mode], mode);
    latch.reset();
    assert.equal(latch.kind(), null);
  }
});

test("subway: the train hit is latched as 'train' and the loser keeps their health", async () => {
  const fight = await nativeMatch(4), latch = createFinishLatch(fight.memory), m = fight.memory;
  for (let tick = 0; tick < 1200; tick++) {
    if (tick === 960) {   // a throw leaves the fighter over the track bed, the way hazard.test.mjs places them
      m.setFloat32(A[1] + 0x44, 0, true); m.setFloat32(A[1] + 0x4c, -58, true);
      m.setFloat32(A[0] + 0x44, 0, true); m.setFloat32(A[0] + 0x4c, 20, true);
    }
    fight.tick([idle, idle]);
    latch.observe();
    if (fight.outcome().over) break;
  }
  assert.deepEqual([fight.outcome().winner, fight.outcome().method], [0, "hazard"]);
  assert.equal(latch.kind(), "train");
  assert.ok(scalar(fight, A[1] + 0x350) > 0);
});

// Where pads can walk: the arena collision keeps a fighter inside these bounds. 500 ticks of walking in each of eight directions.
async function reach(venueId) {
  const found = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let k = 0; k < 8; k++) {
    const fight = await nativeMatch(venueId), a = k * Math.PI / 4;
    for (let t = 0; t < 500; t++) fight.tick([{ buttons: 0, x: Math.cos(a), z: -Math.sin(a) }, idle]);
    const [x, z] = [scalar(fight, A[0] + 0x44), scalar(fight, A[0] + 0x4c)];
    found.minX = Math.min(found.minX, x); found.maxX = Math.max(found.maxX, x);
    found.minZ = Math.min(found.minZ, z); found.maxZ = Math.max(found.maxZ, z);
  }
  return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, +v.toFixed(1)]));
}

test("cage: the Club Murder cage is a closed 56 x 56 box; the Dragon House ring edge stops pad walking at 38.3", async () => {
  const cage = await reach(16);
  assert.deepEqual(cage, { minX: -28.1, maxX: 27.9, minZ: -28, maxZ: 28 });
  const ring = await reach(5);
  assert.deepEqual(ring, { minX: -38.3, maxX: 38.2, minZ: -38.3, maxZ: 38.2 });
  // The cage's top y is the floor (9) and the ring floor is raised (12.3): the same collision data the retail loader built.
  const fight = await nativeMatch(16);
  assert.equal(+scalar(fight, A[0] + 0x48).toFixed(1), 9);
  assert.equal(+scalar(await nativeMatch(5), A[0] + 0x48).toFixed(1), 12.3);
});

// Retail routines of the Window and Demolition venues, run natively one at a time (their callers are the throw-into-object
// states, which pads cannot yet be scripted into).
test("window (Crow's Office): the retail window-hit routine 0x31a660 ends the round for a fighter who is KO-ready, and only for them", async () => {
  const run = async ready => {
    const fight = await nativeMatch(17), m = fight.memory;
    for (let i = 0; i < 30; i++) fight.tick([idle, idle]);
    const objects = word(fight, 0x4c1ae0);
    let window = null;
    for (let i = 0; i < word(fight, 0x4c1adc) && window === null; i++) {
      const record = objects + i * 0x48;
      if (word(fight, word(fight, record + 0x44)) & 0x4000000) window = record;   // the three window definitions carry this flag
    }
    assert.ok(window, "the venue has window objects");
    if (ready) m.setUint16(A[1] + 0x926, m.getUint16(A[1] + 0x926, true) | 4, true);
    const hit = fight.kernel.call(0x31a660, A[1], window, 0, 0);
    return { hit, flags: A.map(a => m.getUint16(a + 0x932, true)), g1c0: word(fight, G + 0x1c0) };
  };
  assert.deepEqual(await run(false), { hit: 0, flags: [0, 0], g1c0: 0 });
  const ko = await run(true);
  assert.equal(ko.hit, 1);
  assert.deepEqual(ko.flags, [0x100, 0x200], "the other fighter wins, the one hit is out");
  assert.equal(ko.g1c0 & 0x40, 0x40, "window KO mark in the match flags");
});

test("demolition (Gun Hill Garage): a car with two of its five key panels destroyed is totalled (0x308910 marks its owner 0x40)", async () => {
  const fight = await nativeMatch(19), m = fight.memory;
  for (let i = 0; i < 30; i++) fight.tick([idle, idle]);
  const typesOf = base => [0, 1, 2, 3, 4].map(i => word(fight, base + 4 * i)), entry = type => 0x3994e0 + type * 0x38;
  const left = typesOf(0x39c388), right = typesOf(0x39c388 + 0x14);
  assert.deepEqual([left, right], [[81, 83, 97, 96, 98], [101, 99, 100, 91, 93]], "the two cars' panel types");
  for (const type of [...left, ...right]) assert.equal(word(fight, entry(type) + 0x14), 3, "each panel takes three strikes (the A, B, C events)");
  const mark = () => A.map(a => m.getUint16(a + 0x932, true));
  const scan = () => fight.kernel.call(0x308910, 0, 0, 0, 0);
  assert.deepEqual([scan(), mark()], [0, [0, 0]]);
  m.setUint32(entry(left[0]) + 0x14, 0, true);
  assert.deepEqual([scan(), mark()], [0, [0, 0]], "one panel gone is not enough");
  m.setUint32(entry(left[1]) + 0x14, 0, true);
  assert.deepEqual([scan(), mark()], [1, [0x40, 0]], "two panels gone: player one's car is totalled");
  m.setUint16(A[0] + 0x932, 0, true);
  m.setUint32(entry(left[0]) + 0x14, 3, true); m.setUint32(entry(left[1]) + 0x14, 3, true);
  m.setUint32(entry(right[2]) + 0x14, 0, true); m.setUint32(entry(right[4]) + 0x14, 0, true);
  assert.deepEqual([scan(), mark()], [1, [0, 0x40]], "and the other car marks player two (a totalled car costs its owner the round)");
  // The referee's mask table (0x3f1088) lists 0x40: a totalled car loses the round for its owner.
  for (let i = 0; i < 4; i++) fight.tick([idle, idle]);
  assert.deepEqual([fight.outcome().over, fight.outcome().winner, fight.outcome().loser, fight.outcome().method], [true, 0, 1, "ko"]);
  assert.deepEqual([...Array(6)].map((_, i) => m.getUint16(0x3f1088 + 2 * i * 2, true)), [1, 2, 4, 0x10, 0x20, 0x40], "the referee's elimination marks");
  assert.deepEqual([...Array(6)].map((_, i) => m.getUint16(0x3f1088 + 2 * i * 2 + 2, true)), [0x20, 8, 0x80, 0x100, 0x200, 0x400], "and their result types");
});

// Replays a recorded controller trace (verification/special-traces.mjs): pokes and pad frames only, no logic. Returns what happened.
async function replay(name, until) {
  const trace = JSON.parse(readFileSync(new URL("./special-traces.json", import.meta.url), "utf8"))[name];
  const { createEnvironment } = await import("../scenery/environment.mjs");
  const events = JSON.parse(readFileSync(new URL("../scenery/events.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL(`../scenery/${trace.file}/scenery.json`, import.meta.url), "utf8"));
  const env = createEnvironment(manifest, events.names, { weaponModels: events.weaponModels });
  const fight = await nativeMatch(trace.venue), m = fight.memory;
  for (let t = 0; t < trace.base; t++) fight.tick([idle, idle]);
  const held = [0, 0], seen = [];
  let finish = null;
  for (let t = 0; t < (until ?? trace.ticks); t++) {
    for (const [at, slot, x, z] of trace.pokes) {
      if (at !== t) continue;
      if (x === "hp") m.setFloat32(A[slot] + 0x350, z, true);
      else for (const o of [0x44, 0xc4]) { m.setFloat32(A[slot] + o, x, true); m.setFloat32(A[slot] + o + 8, z, true); }
    }
    for (const [at, slot, buttons] of trace.pads) if (at === t) held[slot] = buttons;
    fight.tick(held.map(buttons => ({ buttons, x: 0, z: 0 })));
    for (const ev of env.update(m, 1, fight.states)) seen.push([t, events.names[ev.id]]);
    if (fight.outcome().over) { finish = { tick: t, method: fight.outcome().method, loser: fight.outcome().loser, flags: [0, 1].map(i => m.getUint16(A[i] + 0x932, true)) }; break; }
  }
  return { trace, fight, seen, finish };
}

test("ringout: pad-driven throw and slams break a Dragon House rail in three stages (05A_7A, 7B, 7C) and the round goes on", async () => {
  // Player one grapples (cross), throws with no stick (circle) at the wall, steps up to the slumped fighter and grabs him
  // again: the retail slam pair, states 103 / 104. Each slam takes one point of the rail's health (3 -> 0).
  const { trace, fight, seen, finish } = await replay("ringout-rail-break");
  assert.deepEqual(seen, trace.events, "the recorded events");
  assert.deepEqual(seen.map(e => e[1]), ["05A_7A", "05A_7B", "05A_7C"]);
  const health = type => fight.memory.getUint32(0x3994e0 + type * 0x38 + 0x14, true);
  assert.equal(health(0x9d), 0, "the slammed rail type is broken");
  assert.equal(finish, null, "breaking a rail ends nothing: no ring out follows from the slams alone");
});

test("window (Crow's Office): a pad-driven slam into the wall breaks a pane (15A_12); a KO-ready victim loses the round instead", async () => {
  const slam = await replay("window-slam");
  assert.deepEqual(slam.seen, [[144, "15A_12"]]);
  assert.equal(slam.finish, null);
  const ko = await replay("window-slam-ko-ready");
  assert.deepEqual(ko.seen, []);
  assert.deepEqual(ko.finish, { tick: 235, method: "ko", loser: 1, flags: [0x100, 0x200] }, "the same slam on a KO-ready fighter is a knockout (retail 0x308874)");
});

test("ringout: the referee turns mark 0x80 into the RING OUT result (0x800, G+0x1bc 0x8000) as the retail reference showed", async () => {
  const fight = await nativeMatch(SPECIAL.ringout.venue), m = fight.memory;
  for (let i = 0; i < 40; i++) fight.tick([idle, idle]);
  m.setUint16(A[1] + 0x932, m.getUint16(A[1] + 0x932, true) | 0x80, true);
  const latch = createFinishLatch(m);
  assert.equal(latch.observe(), "ringout");
  fight.tick([idle, idle]);   // the referee frame: it posts the result and the match flags the HUD reads (retail captured 0x8406 / record 0x08010021)
  assert.ok(m.getUint32(G + 0x1bc, true) & 0x8000, "ring out sets the match flag the HUD reads");
  assert.equal(m.getUint32(0x4c1c58 + 0xc, true), 0x08010021, "the result record equals the retail capture's");
  for (let i = 0; i < 3; i++) fight.tick([idle, idle]);
  const o = fight.outcome();
  assert.deepEqual([o.over, o.winner, o.loser], [true, 0, 1]);
  assert.equal(m.getUint16(0x3f1088 + 26, true), 0x800, "table entry 7: mark 0x80 -> result 0x800");
});

test("ringout: a broken rail carries the destroyed flags of the health table, and thrown-out state 19 there is a ring out (mark 0x80); at an intact rail it is not", async () => {
  // The destroyed flags are data: the health entry of the rail type holds them at +0x20 (retail table, identical in the native start).
  const railDef = fight => { const m = fight.memory; for (let i = 0; i < m.getUint32(0x4c1adc, true); i++) { const o = m.getUint32(0x4c1ae0, true) + i * 0x48, d = m.getUint32(o + 0x44, true); if (m.getUint32(d + 0x10, true) === 0x9d) return [o, d]; } };
  const entry = type => 0x3994e0 + type * 0x38;
  const { fight: broken } = await replay("ringout-rail-break", 1436);
  const [obj, def] = railDef(broken), m = broken.memory;
  assert.equal(m.getUint32(entry(0x9d) + 0x20, true), 0x40040008, "the health entry's destroyed flags");
  assert.equal(m.getUint32(def, true), 0x40040008, "the kernel wrote them into the rail's definition when its health reached 0");
  // No definition of the Dragon House carries 0x200000, the flag the thrown-body handler (0x3194xx) needs to enter state 19 by itself,
  // so rails alone never put a fighter into it: the state has to be entered with a broken rail as the object (see below).
  const intact = await nativeMatch(5);
  for (let i = 0; i < intact.memory.getUint32(0x4c1adc, true); i++) assert.equal(intact.memory.getUint32(intact.memory.getUint32(intact.memory.getUint32(0x4c1ae0, true) + i * 0x48 + 0x44, true), true) & 0x200000, 0);
  const thrownOut = async (fight, object) => {
    const mm = fight.memory;
    for (let i = 0; i < 900 && !(mm.getUint32(A[0] + 0x30, true) === 1 && mm.getUint32(A[1] + 0x30, true) === 1); i++) fight.tick([idle, { buttons: i % 8 < 4 ? 0x4000 : 0, x: 0, z: 0 }]);
    for (const [slot, z] of [[0, -30], [1, -39]]) for (const o of [0x44, 0xc4]) { mm.setFloat32(A[slot] + o, 10, true); mm.setFloat32(A[slot] + o + 8, z, true); }
    mm.setUint32(A[1] + 0x30, 19, true); mm.setUint32(A[1] + 0x34, 0, true); mm.setUint32(A[1] + 0xac0, object, true);
    const flags = [];
    for (let i = 0; i < 3; i++) { fight.tick([idle, idle]); flags.push(mm.getUint16(A[1] + 0x932, true)); }
    return { flags, outcome: fight.outcome() };
  };
  const out = await thrownOut(broken, obj);
  assert.ok(out.flags.some(f => f & 0x80), "mark 0x80 on the thrown fighter");
  assert.deepEqual([out.outcome.over, out.outcome.winner, out.outcome.loser, out.outcome.finishFlags & 0x800], [true, 0, 1, 0x800], "the round ends with the RING OUT result bit");
  const fresh = await nativeMatch(5);
  const o2 = fresh.memory.getUint32(0x4c1ae0, true) + 10 * 0x48;
  const calm = await thrownOut(fresh, o2);
  assert.ok(calm.flags.every(f => !(f & 0x80)) && !calm.outcome.over, "an intact rail leaves the thrown fighter alive");
});

test.todo("ringout: the natural pad throw that puts a fighter into state 19 at a broken rail is not found (retail 0x3194xx needs def flag 0x200000 as well; no Dragon House definition has it)");
test.todo("end to end car totalling by pad-driven throws at the Gun Hill cars");
