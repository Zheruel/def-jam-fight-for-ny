// Battle page modes and their query schema (shared by the viewer, the controls and tests).
//
//   ?mode=1v1|ffa3|ffa|team  one-on-one (default), Free For All or two versus two
//   ?p1=&p2=&p3=&p4=  fighter handles from ps2/content/inventory.json; p3/p4 only in ffa
//   ?venue=V2BG_xx    venue file; ffa needs a venue with a "FREE FOR ALL 4" formation
//   ?room=CODE        join a hosted match as a guest (the host's shared match view)
//   ?seat=2..4        optional guest seat to take (1-based player number; default: the next open one)
//   ?rules=votes|no-submissions    optional rules for one-on-one, Team and Free For All
//   ?teams=1324       in Team Match, player seats in team placement order (default 1234)
//   ?cpu=N            the last N seats are retail CPU opponents (default 0: a seat nobody holds is never filled in on
//                     its own). N is 0..fighters-1, so one seat always belongs to a person; the people sit in seats
//                     1..fighters-N, which is also the range guests join (a CPU seat is never offered to a guest).
//
// In ffa every fighter is distinct by FIGHTER.XML coreID (the kernel profiles a fighter by it) and by name (so
// the HUD labels differ); any pN that is missing, unknown or repeats an earlier fighter is replaced by the
// next unused one.

import lineups from "./lineups.json" with { type: "json" };

export const MODES = Object.freeze({
  "1v1": Object.freeze({ formation: "SINGLE", fighters: 2, start: "foundation-start.gz", label: "One on one" }),
  ffa3: Object.freeze({ formation: "FREE FOR ALL 3", fighters: 3, start: "three-start.gz", label: "Free For All · 3 fighters" }),
  ffa: Object.freeze({ formation: "FREE FOR ALL 4", fighters: 4, start: "four-start.gz", label: "Free For All · 4 fighters" }),
  subway: Object.freeze({ formation: "SINGLE", fighters: 2, start: "foundation-start.gz", label: "Subway Match", venues: ["V2BG_04A"] }),
  team: Object.freeze({ formation: "2 vs 2 TAG", fighters: 4, start: "team-start.gz", label: "Team Match" }),
});
export const DEFAULT_FIGHTERS = ["0x07000030", "0x07000025", "0x0700000A", "0x07000011"];
export const DEFAULT_VENUE = "V2BG_02A";

// Both the Pages build and local server serve the verified four-actor start.
export const FREE_FOR_ALL_PUBLIC = true;
export function freeForAllAvailable(location = globalThis.location) {
  if (FREE_FOR_ALL_PUBLIC) return true;
  return ["localhost", "127.0.0.1", "[::1]"].includes(location?.hostname);
}

export function venueSupports(file, mode) {
  const { formation, venues } = MODES[mode];
  return (!venues || venues.includes(file)) && Object.hasOwn(lineups[file] ?? {}, formation);
}

export function parseBattleQuery(params, { fighters, venues, ffa = false }) {
  const byHandle = new Map(fighters.map(f => [f.handle, f]));
  const requested=params.get("mode");
  const mode = ffa && Object.hasOwn(MODES, requested) ? requested : "1v1";
  const count = MODES[mode].fighters;
  const sorted = [...fighters].sort((a, b) => a.name.localeCompare(b.name) || a.handle.localeCompare(b.handle));
  const used = new Set();
  const taken = f => used.has(f.fighterXml.coreID) || used.has(f.name);
  const handles = [];
  for (let i = 0; i < count; i++) {
    let pick = byHandle.get(params.get("p" + (i + 1)));
    if (count === 2) pick ??= byHandle.get(DEFAULT_FIGHTERS[i]);
    if (count > 2) {
      if (!pick || taken(pick)) pick = [...DEFAULT_FIGHTERS.map(h => byHandle.get(h)), ...sorted].find(f => f && !taken(f));
      used.add(pick.fighterXml.coreID).add(pick.name);
    }
    handles.push(pick.handle);
  }
  let venue = venues.find(v => v.file === params.get("venue"));
  if (!venue || !venueSupports(venue.file, mode)) venue = venues.find(v => v.file === (MODES[mode].venues?.[0] ?? DEFAULT_VENUE));
  const cpu = Number(params.get("cpu") ?? 0);
  const cpuCount = Number.isInteger(cpu) && cpu >= 0 && cpu < count ? cpu : 0;
  const seat = Number(params.get("seat"));
  const rule = params.get("rules");
  const customRule = !MODES[mode].venues && ["votes", "no-submissions"].includes(rule);
  const order = params.get("teams") ?? "";
  const hasOrder = mode === "team" && /^[1-4]{4}$/.test(order) && new Set(order).size === 4;
  return {
    ...(customRule && {rule}),
    ...(hasOrder && {teamOrder: [...order].map(n => Number(n) - 1)}),
    mode, handles, venue: venue.file, room: params.get("room") || null, cpu: cpuCount,
    seat: Number.isInteger(seat) && seat >= 2 && seat <= count - cpuCount ? seat : null,
  };
}
