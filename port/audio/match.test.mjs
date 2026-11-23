import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { decodePoseBank } from "../motion/pose-bank.mjs";
import library from "../motion/library.json" with { type: "json" };
import { createFoundationFight } from "../battle/fight.mjs";
import { ACTORS, createMatchAudio, createWalker, engineName } from "./match.mjs";

const here = new URL("./", import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, here)));
const combat = json("combat.json"), cues = json("cues.json"), mix = json("mix.json"), venues = json("venues.json");
const tags = JSON.parse(gunzipSync(readFileSync(new URL("animtags.json.gz", here))));
const root = new URL("../../", import.meta.url);
const packed = path => Uint8Array.from(gunzipSync(readFileSync(new URL(path, root)))).buffer;
const venue = venues.venues.find(entry => entry.file === "V2BG_02A");

test("tag names are the engine clip names", () => {
  const names = new Set(tags.anims.map(([name]) => name));
  for (const clip of ["N0113AA1", "N01C7AA", "Q101", "Q107", "B201"]) assert.ok(names.has(clip), clip);
  assert.ok(![...names].some(name => name.includes("\0")));
});

test("the walker resets on a clip change or a frame decrease and fires reached tags in order", () => {
  const walker = createWalker({ anims: [["X", [[2, 2, 10, 1, 1], [2, 2, 25, 1, 1], [9, 2, 27, 1, 1]]], ["Y", [[0, 2, 17, 1, 1]]]] });
  const classes = fired => fired.map(tag => tag[2]);
  assert.deepEqual(classes(walker.step("X", 0)), []);
  assert.deepEqual(classes(walker.step("X", 2.9)), [10, 25]);
  assert.deepEqual(classes(walker.step("X", 3.5)), []);
  assert.deepEqual(classes(walker.step("X", 9)), [27]);
  assert.deepEqual(classes(walker.step("X", 1)), [], "frame decrease restarts the clip");
  assert.deepEqual(classes(walker.step("X", 9)), [10, 25, 27]);
  assert.deepEqual(classes(walker.step("Y", 0)), [17]);
  // A match that starts mid-clip does not replay what already passed.
  const late = createWalker({ anims: [["X", [[2, 2, 10, 1, 1], [9, 2, 27, 1, 1]]]] });
  assert.deepEqual(classes(late.step("X", 5)), []);
  assert.deepEqual(classes(late.step("X", 9)), [27]);
});

test("every routed cue exists in the retail bank it names", () => {
  for (const [name, bank] of Object.entries(combat.banks)) {
    const subsongs = new Set(cues.banks[name].cues.map(cue => cue.i));
    for (const module of bank.modules) for (const player of module.players) for (const cue of player) assert.ok(subsongs.has(cue), `${name} #${cue}`);
  }
  for (const [cls, spec] of Object.entries(combat.classes)) for (const event of spec.events) {
    const found = Object.values(combat.banks).some(bank => bank.modules.some(module => module.event === event));
    if (spec.count) assert.ok(found || ["Rope", "Rail_Hit", "Burn_Yell", "Falling_Wood", "Foot_Pillar"].includes(event), `class ${cls} ${event} has a module`);
  }
});

test("hit size, grunt set and indoor/outdoor banks come from the retail tables", () => {
  assert.deepEqual([combat.fighters[5].hit, combat.fighters[5].grunts, combat.fighters[10].hit], ["Med", "WGuy", "Med"]);
  assert.deepEqual(combat.venueOut, [0, 1, 3, 6, 15]);
  const played = [];
  const out = venues.venues.find(entry => entry.flag);
  const adapter = createMatchAudio({ combat, tags, mix, venue: out, fighters: [{ coreID: 5 }, { coreID: 10 }], clips: library,
    play: (bank, subsong) => played.push([bank, subsong]) });
  // Put actor 0 on Doc-style reaction clip Q101 at frame 0: bank 0, local = its common clip number.
  const memory = new DataView(new ArrayBuffer(0x5000000));
  const local = library.common.indexOf("Q101");
  assert.ok(local > 0);
  memory.setUint32(ACTORS[0] + 0x84, 0, true);
  memory.setUint32(ACTORS[0] + 0x88, local, true);
  assert.equal(engineName(memory, ACTORS[0], library), "Q101");
  adapter.tick({ memory });
  assert.deepEqual(adapter.log.filter(entry => entry.slot === 0).map(entry => [entry.event, entry.bank]),
    [["Grunts", "Grunts_WGuy"], ["Punch_Kick", "Fighter_Med_Hits_Out"]]);
  assert.equal(played.length, 2);
});

async function exchange() {
  const fighters = ["V2IP_113A", "V2IP_109A"].map(model => {
    const bytes = packed(`port/render/fighters/${model}.skin.gz`);
    const length = new DataView(bytes).getUint32(4, true);
    return { model, body: JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 8, length))), bank: decodePoseBank(model, packed(`port/motion/poses/${model}.poses.gz`)) };
  });
  const fight = await createFoundationFight(fighters, packed("port/kernel/battle.wasm.gz"), packed("port/kernel/foundation-start.gz"),
    null, packed("port/kernel/match-rules.gz"));
  const played = [];
  const match = createMatchAudio({ combat, tags, mix, venue, fighters: [{ coreID: 5 }, { coreID: 10 }], clips: library,
    play: (bank, subsong, options) => played.push({ bank, subsong, ...options }) });
  const inputs = JSON.parse(readFileSync(new URL("verification/native-fight-inputs.json", root)));
  inputs.forEach(actors => {
    fight.tick(actors.map(([pad], slot) => ({ buttons: pad & 0xfff0, x: pad & 0x10000 ? (slot ? -1 : 1) : 0, z: 0 })));
    match.tick(fight);
  });
  return { log: match.log, played, ticks: inputs.length };
}

test("the native Blaze/Doc exchange triggers retail whooshes, impacts and grunts for both players", async () => {
  const { log, played, ticks } = await exchange();
  assert.equal(ticks, 460);
  const at = (slot, event) => log.filter(entry => entry.slot === slot && entry.event === event);
  for (const slot of [0, 1]) for (const event of ["Whooshes", "Punch_Kick", "Grunts", "Feet", "Foley_Fx"]) assert.ok(at(slot, event).length, `slot ${slot} ${event}`);
  // The jab's swing (frame 9 of Blaze's N0113AA1) and Doc's strike (frame 7 of N01C7AA) whoosh;
  // each fighter's reaction clip (Q101, Q107) opens with the grunt and the Punch_Kick impact.
  const where = (slot, event, clip) => log.find(entry => entry.slot === slot && entry.event === event && entry.clip === clip);
  assert.equal(where(0, "Whooshes", "N0113AA1").tick, 259);
  assert.equal(where(1, "Whooshes", "N01C7AA").tick, 297);
  assert.deepEqual([where(1, "Punch_Kick", "Q101").tick, where(1, "Grunts", "Q101").tick], [267, 267]);
  assert.deepEqual([where(0, "Punch_Kick", "Q107").tick, where(0, "Grunts", "Q107").tick], [303, 303]);
  // Both fighters are medium weights with the WGuy voice set, in an indoor venue.
  for (const entry of log.filter(entry => entry.event === "Punch_Kick")) assert.equal(entry.bank, "Fighter_Med_Hits_Ring");
  for (const entry of log.filter(entry => entry.event === "Grunts")) assert.equal(entry.bank, "Grunts_WGuy");
  for (const entry of log.filter(entry => entry.event === "Whooshes")) assert.equal(entry.bank, "WCommon1");
  // The jab uses Punch_Kick player 0 (punch), the kick player 1; whoosh and grunt levels are the retail mix.
  assert.equal(where(1, "Punch_Kick", "Q101").player, 0);
  assert.equal(where(0, "Punch_Kick", "Q107").player, 1);
  assert.equal(where(1, "Whooshes", "N01C7AA").gain, mix.gain.Whoosh_Vol);
  assert.equal(where(1, "Grunts", "Q101").gain, mix.gain.Grunts_Vol);
  // Every cue that plays is a real subsong of the named retail bank.
  assert.equal(played.length, log.filter(entry => entry.bank).length);
  for (const cue of played) assert.ok(cues.banks[cue.bank].cues.some(entry => entry.i === cue.subsong), `${cue.bank} #${cue.subsong}`);
  assert.ok(existsSync(new URL(cues.banks.WCommon1.file, here)));
});

test("a second run picks the same cues", async () => {
  const [a, b] = [await exchange(), await exchange()];
  assert.deepEqual(a.played, b.played);
});
