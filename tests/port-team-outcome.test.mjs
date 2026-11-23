import assert from "node:assert/strict";
import test from "node:test";
import { createOutcome } from "../port/battle/outcome.mjs";
import { resultLines, winnerText } from "../port/hud/result.mjs";

const G = 0x4bbf90, ACTORS = [0, 1, 2, 3].map(slot => 0x4bc170 + slot * 0x12f8);

// A memory with the referee state the outcome reads: phase, per-actor flags/health and ally pointers.
function memory({ allies, flags, phase = 3 }) {
  const view = new DataView(new ArrayBuffer(0x500000));
  view.setUint32(G + 8, phase, true);
  ACTORS.forEach((a, slot) => {
    view.setUint32(a + 4, allies[slot] === null ? 0 : ACTORS[allies[slot]], true);
    view.setUint16(a + 0x932, flags[slot], true);
    view.setFloat32(a + 0x350, flags[slot] & 0x200 ? 0 : 100, true);
  });
  return { ...createOutcome({ memory: view }, ACTORS).read(), ticksSinceOver: 130 };
}

test("a Team result groups the allies and names the winning team", () => {
  const out = memory({ allies: [1, 0, 3, 2], flags: [0x200, 0x600, 0x100, 0] });
  assert.deepEqual(out.teams, [[0, 1], [2, 3]]);
  assert.equal(out.winner, 2);
  assert.equal(out.loser, 0);
  assert.deepEqual(out.winners, [2, 3]);
  assert.deepEqual(out.losers, [0, 1]);
  assert.equal(out.draw, false);
});

test("one-on-one and Free For All keep single-fighter teams", () => {
  const out = memory({ allies: [null, null, null, null], flags: [0x100, 0x200, 0x200, 0x200] });
  assert.deepEqual(out.teams, [[0], [1], [2], [3]]);
  assert.deepEqual(out.winners, [0]);
  assert.equal(out.winner, 0);
});

test("a one-way ally pointer does not make a team, and a draw has no winning team", () => {
  assert.deepEqual(memory({ allies: [1, null, null, null], flags: [0, 0, 0, 0] }).teams, [[0], [1], [2], [3]]);
  const draw = memory({ allies: [1, 0, 3, 2], flags: [0, 0, 0, 0] });
  assert.equal(draw.draw, true);
  assert.deepEqual(draw.winners, []);
});

test("the result banner names both teammates, a single winner keeps its text", () => {
  const names = ["Blaze", "Doc", "Magic", "N.O.R.E."];
  const out = memory({ allies: [1, 0, 3, 2], flags: [0x200, 0x600, 0x100, 0] });
  assert.equal(winnerText(out, names), "MAGIC & N.O.R.E. WIN");
  assert.ok(resultLines(out, names).some(line => line.text === "MAGIC & N.O.R.E. WIN"));
  const solo = memory({ allies: [null, null, null, null], flags: [0x100, 0x200, 0, 0] });
  assert.equal(winnerText(solo, names), "BLAZE WINS");
});
