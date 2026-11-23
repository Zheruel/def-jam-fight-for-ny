import assert from "node:assert/strict";
import test from "node:test";
import { resolveMotion } from "./library.mjs";
import reference from "./reference-match.json" with { type: "json" };

const actors = reference.modelIndices.map(modelIndex => ({ modelIndex }));

test("both fighters select the same motion as every captured retail VBlank", () => {
  for (const transitions of reference.transitions) {
    let next = 0;
    let selection;
    for (let tick = 0; tick < reference.samples; tick++) {
      if (transitions[next]?.[0] === tick) selection = transitions[next++];
      const [, action, bank, local, motion] = selection;
      const actual = resolveMotion(action, actors);
      assert.deepEqual([actual.bank, actual.local, actual.motion], [bank, local, motion]);
    }
  }
});

test("the engine and both loaded fighter banks identify the observed strike clips", () => {
  for (const [action, name] of [[10011,"A112"], [10016,"A117"], [67,"N0113AA1"], [1069,"N01C7AA"]]) {
    const actual = resolveMotion(action, actors);
    assert.equal(actual.engineName, name);
    assert.equal(actual.loadedClip, name);
  }
});

test("actor special state keeps the correct two- or three-frame offset", () => {
  const special = { modelIndex: 4, state: 0x41, specialBase: 700 };
  // Local clip 48 is two beyond the start of move 568 in Blaze's table.
  assert.equal(resolveMotion(48, [{...special, flags: 0}]).motion, 700);
  assert.equal(resolveMotion(48, [{...special, flags: 4}]).motion, 699);
});

import { readFileSync } from "node:fs";
import settings from "./reference-settings.json" with { type: "json" };
import { motionSettings } from "./settings.mjs";

test("expanded motion settings match all 34 live actor words for each observed clip", () => {
  const bytes = readFileSync(new URL("./motion-settings.bin", import.meta.url));
  for (const [key, {end,tick,words}] of Object.entries(settings.observed)) {
    const [bank,motion] = key.split("/").map(Number);
    assert.deepEqual([...motionSettings(bytes,bank,motion,end,tick)],words,key);
  }
});

import { advanceClip, takeBlend } from "./clock.mjs";

test("retail startup, movement and reaction frames advance at their distinct clip rates", () => {
  for (const [key, frame,expected] of [["0/11",16,17],["0/66",0,Math.fround(1.3)],["0/328",0,Math.fround(1.1)]]) {
    const {words, end} = settings.observed[key];
    const actor = {frame, end, rate: 1, stopLoop: 0};
    advanceClip(actor, Uint32Array.from(words), 1, () => {});
    assert.equal(actor.frame, expected);
    assert.equal(actor.remaining, Math.fround(end-expected));
  }
});

test("end crossings, timed events and blend counters follow retail execution order", () => {
  const actor = { frame: 9, end: 10, rate: 2, stopLoop: 0, blendRemaining: 3, blendTotal: 4 };
  const words = Uint32Array.from(settings.observed["0/11"].words);
  words[33] = 1;
  words.set([8,9,3,9,10,5,9,10,25,11,12,22]);
  const events = [];
  advanceClip(actor, words, 1, n => events.push(n));
  assert.deepEqual(events,[3,5]);
  assert.deepEqual([actor.frame, actor.remaining, actor.crossedEnd],[1,9,true]);
  actor.stopLoop = 1;
  actor.frame = 9;
  advanceClip(actor,words,1,()=>{});
  assert.equal(actor.frame,10);
  assert.deepEqual(Array.from({length:4}, () => takeBlend(actor)),[0.25,0.5,0.75,1]);
});
