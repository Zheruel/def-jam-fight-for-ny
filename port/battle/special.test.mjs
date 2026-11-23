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

test("every format ends in a retail knockout driven by pads; the finish latch names Red Hook's fire and nothing else here", async () => {
  const expected = { demolition: null, inferno: "inferno", window: null, cage: null, ringout: null };
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

test.todo("ringout: the edge finish needs retail evidence (a fighter standing outside the ring is not finished natively)");
test.todo("demolition: vehicle damage and the vehicle-total finish need retail evidence");
test.todo("window: the window KO throw needs retail evidence");
