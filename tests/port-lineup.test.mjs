import assert from "node:assert/strict";
import test from "node:test";
import inventory from "../ps2/content/inventory.json" with { type: "json" };
import { createBattleLineup } from "../port/battle/setup.mjs";

const blaze = "0x07000030";
const doc = "0x07000025";
const venue = file => inventory.venues.find(row => row.file === file).handle;

test("retail Blaze and Doc occupy the two Foundation slots", () => {
  const battle = createBattleLineup(venue("V2BG_02A"), "SINGLE", [blaze, doc]);
  assert.deepEqual(battle.participants, [
    { slot: 1, fighter: blaze, model: "V2IP_113A", position: [-25, 0] },
    { slot: 2, fighter: doc, model: "V2IP_109A", position: [25, 0] },
  ]);
});

test("each Battle venue has its own retail single-match entry", () => {
  assert.equal(inventory.venues.length, 24);
  for (const venue of inventory.venues) {
    assert.equal(createBattleLineup(venue.handle, "SINGLE", [doc, blaze]).background, venue.file);
  }
  const club = venue("V2BG_09A");
  const slots = () => createBattleLineup(club, "SINGLE", [doc, blaze]).participants;
  slots()[0].position[0] = 0;
  assert.deepEqual(slots().map(p => p.position), [[-25, 25], [25, -25]]);
});

test("slot count and available formations follow the venue entry", () => {
  const gym = venue("V2BG_02A");
  const team = [doc, blaze, blaze, doc];
  assert.deepEqual(createBattleLineup(gym, "2 vs 2 TAG", team).participants.map(p => p.position),
    [[-27, -6], [-17, 6], [17, -6], [27, 6]]);
  assert.throws(() => createBattleLineup(gym, "SINGLE", team), /requires 2/);
  assert.throws(() => createBattleLineup(venue("V2BG_07A"), "2 vs 2 TAG", team), /formation/);
  assert.throws(() => createBattleLineup(gym, "SINGLE", [doc, "invalid"]), /slot 2/);
});
