// Battle page modes and their query schema (shared by the viewer, the controls and tests).
//
//   ?mode=1v1|ffa     one-on-one (default) or four-fighter Free For All
//   ?p1=&p2=&p3=&p4=  fighter handles from ps2/content/inventory.json; p3/p4 only in ffa
//   ?venue=V2BG_xx    venue file; ffa needs a venue with a "FREE FOR ALL 4" formation
//   ?room=CODE        join a hosted match as a guest (the host's shared match view)
//   ?seat=2..4        optional guest seat to take (1-based player number; default: the next open one)
//
// In ffa every fighter is distinct by FIGHTER.XML coreID (the kernel profiles a fighter by it) and by name (so
// the HUD labels differ); any pN that is missing, unknown or repeats an earlier fighter is replaced by the
// next unused one.

import lineups from "./lineups.json" with { type: "json" };

export const MODES = Object.freeze({
  "1v1": Object.freeze({ formation: "SINGLE", fighters: 2 }),
  ffa: Object.freeze({ formation: "FREE FOR ALL 4", fighters: 4 }),
});
export const DEFAULT_FIGHTERS = ["0x07000030", "0x07000025", "0x0700000A", "0x07000011"];
export const DEFAULT_VENUE = "V2BG_02A";

// Both the Pages build and local server serve the verified four-actor start.
export const FREE_FOR_ALL_PUBLIC = true;
export function freeForAllAvailable(location = globalThis.location) {
  if (FREE_FOR_ALL_PUBLIC) return true;
  return ["localhost", "127.0.0.1", "[::1]"].includes(location?.hostname);
}

export const venueSupports = (file, mode) => Object.hasOwn(lineups[file] ?? {}, MODES[mode].formation);

export function parseBattleQuery(params, { fighters, venues, ffa = false }) {
  const byHandle = new Map(fighters.map(f => [f.handle, f]));
  const mode = ffa && params.get("mode") === "ffa" ? "ffa" : "1v1";
  const count = MODES[mode].fighters;
  const sorted = [...fighters].sort((a, b) => a.name.localeCompare(b.name) || a.handle.localeCompare(b.handle));
  const used = new Set();
  const taken = f => used.has(f.fighterXml.coreID) || used.has(f.name);
  const handles = [];
  for (let i = 0; i < count; i++) {
    let pick = byHandle.get(params.get("p" + (i + 1)));
    if (mode === "1v1") pick ??= byHandle.get(DEFAULT_FIGHTERS[i]);
    if (mode === "ffa") {
      if (!pick || taken(pick)) pick = [...DEFAULT_FIGHTERS.map(h => byHandle.get(h)), ...sorted].find(f => f && !taken(f));
      used.add(pick.fighterXml.coreID).add(pick.name);
    }
    handles.push(pick.handle);
  }
  let venue = venues.find(v => v.file === params.get("venue"));
  if (!venue || !venueSupports(venue.file, mode)) venue = venues.find(v => v.file === DEFAULT_VENUE);
  const seat = Number(params.get("seat"));
  return {
    mode, handles, venue: venue.file, room: params.get("room") || null,
    seat: Number.isInteger(seat) && seat >= 2 && seat <= count ? seat : null,
  };
}
