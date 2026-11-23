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
