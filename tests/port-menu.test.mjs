import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import inventory from "../ps2/content/inventory.json" with { type: "json" };
import lineups from "../port/battle/lineups.json" with { type: "json" };
import { createSelection, selectionQuery } from "../port/menu/state.mjs";
import { menuFiles } from "../port/menu/files.mjs";
import { MODES, parseBattleQuery } from "../port/battle/modes.mjs";
import { matchTypes } from "../port/menu/launch.mjs";

const art = name => JSON.parse(readFileSync(new URL("../port/menu/art/" + name, import.meta.url), "utf8"));
const roster = art("roster.json"), venues = art("venues.json");
const options = { roster, venues, picks: ["0x07000030", "0x07000025"], venue: "V2BG_02A" };

test("the roster and venues come from the game's inventory", () => {
  assert.equal(new Set(roster.map(f => f.handle)).size, inventory.fighters.length);
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

test("match types follow what MODES advertises, in retail order", () => {
  assert.deepEqual(matchTypes(MODES, true), ["1v1", "team", "ffa3", "ffa"].filter(mode => Object.hasOwn(MODES, mode)), "exactly the advertised modes");
  assert.ok(matchTypes(MODES, true).includes("1v1"));
  const all = { "1v1": {}, ffa: {}, team: {}, ffa3: {} };
  assert.deepEqual(matchTypes(all, true), ["1v1", "team", "ffa3", "ffa"]);
  assert.deepEqual(matchTypes(all, false), ["1v1", "team"], "Free For All variants follow their availability switch");
  assert.deepEqual(matchTypes({ "1v1": {} }, true), ["1v1"]);
});

test("a three fighter and a tag team selection keep distinct seats and their own formation", () => {
  for (const [mode, seats, formation] of [["ffa3", 3, "FREE FOR ALL 3"], ["team", 4, "2 vs 2 TAG"]]) {
    const s = createSelection({ roster, venues, seats, mode, picks: [], venueOk: v => Object.hasOwn(lineups[v.file], formation) });
    assert.equal(s.state.seats.length, seats);
    assert.equal(s.state.columns, seats === 3 ? 4 : 3);
    assert.equal(new Set(s.state.seats.map(x => x.cursor)).size, seats);
    s.state.seats.forEach((_, i) => s.press(i, "confirm"));
    if (mode === "team") {
      assert.equal(s.state.screen, "teams");
      s.pickTeammate(0); s.press(0, "right"); s.press(0, "confirm");
      s.press(0, "back"); assert.deepEqual(s.state.teamOrder, [0]);
      assert.equal(s.state.teamCursor, 2);
      s.press(0, "confirm"); s.press(0, "confirm"); s.press(0, "confirm");
      assert.equal(s.state.screen, "venue");
      s.press(0,"back"); s.press(0,"confirm");
      const parsed = parseBattleQuery(selectionQuery(s.result()), {fighters:inventory.fighters,venues:inventory.venues,ffa:true});
      assert.deepEqual(parsed.teamOrder, [0,2,1,3]);
    }
    s.press(0, "confirm");
    const q = selectionQuery(s.result());
    assert.equal(q.get("mode"), mode);
    assert.equal(q.get("p" + seats) !== null, true);
    assert.ok(Object.hasOwn(lineups[q.get("venue")], formation));
  }
});

test("CPU seats are the last ones, always leave a person, and travel as ?cpu=N", () => {
  const s = createSelection({ ...options, seats: 4, mode: "ffa", picks: [] });
  assert.equal(s.state.cpu, 0);
  assert.equal(selectionQuery(s.result()).has("cpu"), false);
  s.press(0, "cpu");
  assert.equal(selectionQuery(s.result()).get("cpu"), "1");
  s.press(0, "cpu"); s.press(0, "cpu");
  assert.equal(s.state.cpu, 3);
  s.press(0, "cpu");
  assert.equal(s.state.cpu, 0, "never all seats");
  s.toggleCpuFrom(2);
  assert.equal(s.state.cpu, 2, "seat 3 and 4");
  s.toggleCpuFrom(2);
  assert.equal(s.state.cpu, 1, "seat 3 handed back, seat 4 stays");
  assert.equal(s.toggleCpuFrom(0), false, "the first seat is never a CPU");
  const query = selectionQuery(s.result());
  const parsed = parseBattleQuery(query, { fighters: inventory.fighters, venues: inventory.venues, ffa: true });
  assert.equal(parsed.cpu, 1);
});

test("the multiplayer selector keeps the displayed fighter when other seats occupy adjacent cells or name variants", () => {
  const s = createSelection({ ...options, mode: "ffa", seats: 4, picks: roster.slice(0, 4).map(f => f.handle) });
  s.press(0, "right");
  assert.equal(s.state.seats[0].cursor, 4);
  const blaze = roster.map((f, i) => [f, i]).filter(([f]) => f.name === "Blaze");
  assert.ok(s.pickFighter(1, blaze[0][1]));
  assert.equal(s.pickFighter(0, blaze[1][1]), false);
  const result = s.result();
  const query = parseBattleQuery(selectionQuery(result), { fighters: inventory.fighters, venues: inventory.venues, ffa: true });
  assert.deepEqual(query.handles, result.handles);
});
