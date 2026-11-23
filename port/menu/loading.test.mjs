// The match-loading poster: what it shows for a query, and that the exported art covers every selectable fighter and venue.
//   node --test port/menu/loading.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { loadingSelection } from "./loading.mjs";
import { MODES } from "../battle/modes.mjs";
import { loadingFiles } from "./loading-files.mjs";
import roster from "./art/roster.json" with { type: "json" };
import venues from "./art/venues.json" with { type: "json" };

const art = JSON.parse(readFileSync(new URL("./art/loading/layout.json", import.meta.url)));
const select = query => loadingSelection(new URLSearchParams(query), art);
const BLAZE = "0x07000030", DOC = "0x07000025", MAGIC = "0x0700003B", HAVOC = "0x07000037", NORE = "0x07000009", CRACK = "0x07000034";
const id = handle => roster.find(f => f.handle === handle).id;

test("a one-on-one poster shows the two fighters, the match title and the venue's banner", () => {
  const picked = select(`p1=${BLAZE}&p2=${CRACK}&venue=V2BG_15A`);
  assert.deepEqual(picked, { mode: "1v1", formation: "1v1", title: "1v1", ids: [id(BLAZE), id(CRACK)], venue: 27 });
});

test("Free For All, Team and the special formats choose their own paper and title", () => {
  assert.equal(select(`mode=ffa3&p1=${BLAZE}&p2=${DOC}&p3=${MAGIC}`).formation, "ffa3");
  assert.equal(select(`mode=ffa3&p1=${BLAZE}&p2=${DOC}&p3=${MAGIC}`).title, "ffa");
  const four = select(`mode=ffa&p1=${BLAZE}&p2=${DOC}&p3=${MAGIC}&p4=${HAVOC}`);
  assert.deepEqual([four.formation, four.title, four.ids], ["ffa4", "ffa", [56, 55, 22, 28].map(Number)]);
  const team = select(`mode=team&p1=${BLAZE}&p2=${DOC}&p3=${MAGIC}&p4=${NORE}`);
  assert.deepEqual([team.formation, team.title, team.ids], ["team", "team", [56, 55, 22, 48]]);
  for (const mode of ["window", "subway", "demolition", "inferno", "cage", "ringout"]) {
    const special = select(`mode=${mode}`);
    assert.deepEqual([special.formation, special.title], ["1v1", MODES[mode] ? mode : "1v1"], mode);
  }
});

test("missing, unknown and repeated fighters are replaced the way the viewer does", () => {
  assert.deepEqual(select("").ids, [56, 55]);
  assert.deepEqual(select("p1=nope&p2=0x1").ids, [56, 55]);
  const three = select(`mode=ffa3&p1=${BLAZE}&p2=${BLAZE}&p3=${BLAZE}`).ids;
  assert.equal(new Set(three).size, 3);
  assert.equal(three[0], 56);
});

test("an unknown mode or venue falls back to the defaults", () => {
  const picked = select("mode=nonsense&venue=NOWHERE");
  assert.equal(picked.mode, "1v1");
  assert.equal(picked.venue, 2);
});

test("the files exist for every fighter in every poster size and for every venue and title", () => {
  const missing = loadingFiles.filter(file => !existsSync(new URL("../../" + file, import.meta.url)));
  assert.deepEqual(missing, []);
  for (const venue of venues) assert.ok(art.venues[venue.feID + 1], venue.name);
  for (const mode of ["1v1", "team", "ffa", "window", "subway", "demolition", "inferno", "cage", "ringout"]) assert.ok(art.titles[mode], mode);
  // Anyone who can be picked has a portrait and a logo for the poster with the matching number of fighters.
  for (const count of ["2", "3", "4"]) {
    const lacking = roster.filter(f => !art.portraits[f.id]?.[count] || !art.logos[f.id]?.[count]).map(f => f.name);
    assert.deepEqual(lacking.map(f=>f.name), [], count+"-fighter loading art");
  }
});

test("every formation names a panel for each slot and anchors for its logos", () => {
  for (const [key, formation] of Object.entries(art.formations)) {
    const slots = formation.portraits.length;
    assert.equal(formation.logos.length, slots, key);
    assert.equal(formation.panelOf.length, slots, key);
    assert.ok(formation.panelOf.every(panel => panel < formation.panels.length), key);
    assert.equal(slots, { "1v1": 2, ffa3: 3, ffa4: 4, team: 4 }[key]);
  }
});
