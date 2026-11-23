import assert from "node:assert/strict";
import test from "node:test";
import inventory from "../ps2/content/inventory.json" with { type: "json" };
import { FREE_FOR_ALL_PUBLIC, freeForAllAvailable, parseBattleQuery, venueSupports } from "../port/battle/modes.mjs";
import { createBattleLineup } from "../port/battle/setup.mjs";

const parse = (query, ffa = true) => parseBattleQuery(new URLSearchParams(query), { fighters: inventory.fighters, venues: inventory.venues, ffa });
const byHandle = handle => inventory.fighters.find(f => f.handle === handle);

test("one-on-one keeps its defaults, mirror matches and venue", () => {
  assert.deepEqual(parse(""), { mode: "1v1", handles: ["0x07000030", "0x07000025"], venue: "V2BG_02A", room: null, seat: null });
  assert.deepEqual(parse("p1=0x07000025&p2=0x07000025&venue=V2BG_09A&room=ABCD2345").handles, ["0x07000025", "0x07000025"]);
  assert.equal(parse("venue=V2BG_07A").venue, "V2BG_07A");
});

test("Free For All seats four distinct fighters, filling gaps and repeats", () => {
  const { mode, handles } = parse("mode=ffa");
  assert.equal(mode, "ffa");
  assert.equal(handles.length, 4);
  const repeated = parse("mode=ffa&p1=0x07000030&p2=0x07000040&p3=0x07000030&p4=bogus").handles.map(byHandle);
  assert.equal(new Set(repeated.map(f => f.fighterXml.coreID)).size, 4);
  assert.equal(new Set(repeated.map(f => f.name)).size, 4, "namesakes are not drafted twice");
  assert.equal(repeated[0].handle, "0x07000030");
  const chosen = parse("mode=ffa&p1=0x07000011&p2=0x0700000A&p3=0x07000025&p4=0x07000030").handles;
  assert.deepEqual(chosen, ["0x07000011", "0x0700000A", "0x07000025", "0x07000030"]);
});

test("Free For All needs a venue with the formation and is off unless allowed", () => {
  assert.equal(venueSupports("V2BG_07A", "ffa"), false);
  assert.equal(venueSupports("V2BG_07A", "1v1"), true);
  assert.equal(parse("mode=ffa&venue=V2BG_07A").venue, "V2BG_02A");
  assert.equal(parse("mode=ffa&venue=V2BG_09A").venue, "V2BG_09A");
  assert.equal(parse("mode=ffa", false).mode, "1v1");
  assert.equal(parse("mode=ffa", false).handles.length, 2);
  assert.equal(FREE_FOR_ALL_PUBLIC, false);
  assert.equal(freeForAllAvailable({ hostname: "someone.github.io" }), false);
  assert.equal(freeForAllAvailable({ hostname: "127.0.0.1" }), true);
});

test("seat requests are guests' seats 2 to the seat count", () => {
  assert.equal(parse("mode=ffa&seat=4").seat, 4);
  assert.equal(parse("mode=ffa&seat=1").seat, null);
  assert.equal(parse("seat=3").seat, null);
  assert.equal(parse("seat=2").seat, 2);
});

test("the parsed Free For All draft builds the retail four-fighter lineup", () => {
  const { handles, venue } = parse("mode=ffa&venue=V2BG_09A");
  const handle = inventory.venues.find(v => v.file === venue).handle;
  const lineup = createBattleLineup(handle, "FREE FOR ALL 4", handles);
  assert.equal(lineup.participants.length, 4);
  assert.deepEqual(lineup.participants.map(p => p.slot), [1, 2, 3, 4]);
});
