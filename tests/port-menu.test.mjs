import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import inventory from "../ps2/content/inventory.json" with { type: "json" };
import lineups from "../port/battle/lineups.json" with { type: "json" };
import { createSelection, selectionQuery } from "../port/menu/state.mjs";
import { menuFiles } from "../port/menu/files.mjs";
import { parseBattleQuery } from "../port/battle/modes.mjs";

const art = name => JSON.parse(readFileSync(new URL("../port/menu/art/" + name, import.meta.url), "utf8"));
const roster = art("roster.json"), venues = art("venues.json");
const options = { roster, venues, picks: ["0x07000030", "0x07000025"], venue: "V2BG_02A" };

test("the roster and venues come from the game's inventory", () => {
  for (const f of roster) assert.ok(inventory.fighters.some(i => i.handle === f.handle && i.fighterXml.ID === f.id));
  assert.equal(venues.length, inventory.venues.length);
  venues.forEach(v => assert.ok(v.pin, `${v.name} has a map pin`));
  menuFiles.forEach(file => assert.ok(existsSync(new URL("../" + file, import.meta.url)), file));
});

test("two players pick, then a pin, and the result is a valid battle query", () => {
  const s = createSelection(options);
  assert.equal(s.state.screen, "fighters");
  s.press(0, "right"); s.press(1, "left");
  s.press(0, "confirm");
  assert.equal(s.state.screen, "fighters", "waits for the second player");
  assert.equal(s.press(0, "right"), false, "a ready seat does not move");
  s.press(1, "confirm");
  assert.equal(s.state.screen, "venue");
  s.press(0, "right");
  s.press(0, "confirm");
  assert.equal(s.state.screen, "done");
  const result = s.result();
  const query = selectionQuery(result);
  const parsed = parseBattleQuery(query, { fighters: inventory.fighters, venues: inventory.venues });
  assert.deepEqual(parsed.handles, result.handles);
  assert.equal(parsed.venue, result.venue);
});

test("back unlocks a fighter and returns from the venue map", () => {
  const s = createSelection(options);
  s.press(0, "confirm"); s.press(1, "confirm");
  assert.equal(s.state.screen, "venue");
  s.press(0, "back");
  assert.equal(s.state.screen, "fighters");
  assert.equal(s.state.seats[0].ready, false);
});

test("Free For All keeps four distinct fighters and offers only venues with the formation", () => {
  const s = createSelection({ roster, venues, seats: 4, mode: "ffa", picks: ["0x07000030", "0x07000030", "0x07000030", "0x07000030"],
    venueOk: v => Object.hasOwn(lineups[v.file], "FREE FOR ALL 4") });
  const ids = s.state.seats.map(x => x.cursor);
  assert.equal(new Set(ids).size, 4);
  for (let i = 0; i < 40; i++) s.press(1, "right");
  assert.equal(new Set(s.state.seats.map(x => x.cursor)).size, 4, "cursors never collide");
  s.state.seats.forEach((_, i) => s.press(i, "confirm"));
  assert.equal(s.state.screen, "venue");
  s.state.spots.forEach(spot => spot.variants.forEach(v => assert.ok(Object.hasOwn(lineups[v.file], "FREE FOR ALL 4"))));
  assert.equal(selectionQuery(s.result()).get("mode"), "ffa");
});

test("a venue's remix shares its pin and cycles with next/previous", () => {
  const s = createSelection({ ...options, venue: "V2BG_09A" });
  const spot = s.state.spots[s.state.venue];
  assert.ok(spot.variants.length > 1);
  s.press(0, "confirm"); s.press(1, "confirm");
  const before = s.result().venue;
  s.press(0, "next");
  assert.notEqual(s.result().venue, before);
});
