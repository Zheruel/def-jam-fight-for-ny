import assert from "node:assert/strict";
import { test } from "node:test";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };
import { combatTuning, fighters, fightingStyles, getFighter, unassignedBlazin } from "./combat.mjs";

test("Battle handles resolve to the same retail records as the roster inventory", () => {
  assert.equal(fighters.length, 75);
  assert.deepEqual(
    fighters.map(({ handle, key, name, model }) => ({ handle, key, name, model })),
    inventory.fighters.map(({ handle, key, name, model }) => ({ handle, key, name, model })),
  );
  for (const fighter of fighters) {
    assert.equal(getFighter(fighter.handle), fighter);
    assert.equal(getFighter(Number(fighter.handle) | 0x00800000), fighter);
    assert.equal(fighter.styles.reduce((mask, key) => mask | fightingStyles[key].bit, 0), fighter.styleMask);
  }
  for (const handle of [null, false, NaN, 0x100000000, "7000030", "0x07000030x", "0x070000ff", 0x06000040]) {
    assert.equal(getFighter(handle), undefined);
  }
});

test("Blaze and Doc retain distinct retail stats, styles and Blazin motions", () => {
  const blaze = getFighter(0x07000030);
  const doc = getFighter("0X07000025");
  assert.deepEqual(blaze.stats, { upperPower: 50, lowerPower: 43, speed: 27, toughness: 50, health: 33, charisma: 47 });
  assert.deepEqual(doc.stats, { upperPower: 43, lowerPower: 30, speed: 50, toughness: 27, health: 50, charisma: 50 });
  assert.deepEqual(blaze.styles, ["wrestling"]);
  assert.deepEqual(doc.styles, ["martialArts"]);
  assert.deepEqual(blaze.blazin, { handle: "0x06000040", key: "Blazing_Blaze", motionId: 2, motionKey: "blazin_02" });
  assert.deepEqual(doc.blazin, { handle: "0x0600001D", key: "Blazing_Doc", motionId: 4, motionKey: "blazin_04" });
});

test("assigned and unassigned records cover all 82 distinct Blazin motions", () => {
  const assigned = fighters.flatMap(fighter => fighter.blazin ? [fighter.blazin] : []);
  assert.equal(assigned.length, 68);
  assert.equal(unassignedBlazin.length, 14);
  const motions = [...assigned, ...unassignedBlazin].sort((a, b) => a.motionId - b.motionId);
  assert.equal(new Set(motions.map(move => move.handle)).size, 82);
  assert.deepEqual(motions.map(move => move.motionId), Array.from({ length: 82 }, (_, index) => index));
  assert.equal(fighters.find(fighter => fighter.key === "Blaze 2").blazin, null);
});

test("GAMECORE style-slot order and health-recovery scopes remain distinct", () => {
  assert.deepEqual(Object.keys(combatTuning.byStyle), [
    "streetfighting", "kickboxing", "submissions", "wrestling", "martialArts",
  ]);
  assert.equal(combatTuning.byStyle.streetfighting.damage.punch, 1.2);
  assert.equal(combatTuning.byStyle.kickboxing.damage.kick, 1.2);
  assert.equal(combatTuning.byStyle.submissions.damage.grapple, 1.1);
  assert.equal(combatTuning.byStyle.wrestling.grappleCatchFrames.strong, 15);
  assert.equal(combatTuning.byStyle.martialArts.blockFrames.start, 5);
  assert.equal(combatTuning.healthRecoveryRate, 1.35);
  assert.equal(combatTuning.skillEffects.healthRecoveryRate, 0.5);
  assert.deepEqual(combatTuning.stunDuration.ground, { minSeconds: 0.75, maxSeconds: 2, validStunPercent: 5 });
});
