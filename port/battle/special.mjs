// The six original special Battle formats (SLUS-21004): Demolition, Inferno, Subway, Window, Cage and Ringout.
//
// Recovered from the retail disc and from reference captures of every format (verification/capture-special.mjs):
//  * The match type is the id the front end stores with SetMatchType (0x135ef0 -> 0x10e550): the names table at 0x375ab0 is
//    0 Single, 1 Tag, 2 3Way, 3 4Way, 4 1vs2, 5 1vs3, 6 Demolition, 7 Inferno, 8 Subway, 9 Window, 10 Cage, 11 Ringout, 12 Tutorial.
//    Ids 6..11 all use the SINGLE formation (0x10e550's jump table), so every special match is a one-on-one.
//  * Choosing a special card forces the venue (no map) and skips the rules screen. The retail start of each format differs from
//    a standard one-on-one at the same venue only in the backend setup object's match type (+0xb8): the rules word 0x4bbd2c
//    (0x10007), seats, referee phase and every stage-object table are the same. Nothing but roster and seat sizing reads
//    the id (callers of 0x1102b0), so the formats are the venue plus the venue's own rules.
//  * The venue rules run in the native Battle kernel: the subway train (0x2e75e8), Red Hook's fire clock and burn
//    (0x2dea90, 0x2def80), the knockdown classifier's special marks (0x30b928 -> 0x30bb40) and the arena collision.
//    port/battle/special.test.mjs compares each native start with the retail capture (special-retail.json).
export const SPECIAL = Object.freeze({
  demolition: { id: 6, venue: 19, file: "V2BG_17A", name: "Demolition", rule: "Total your opponent's vehicle." },
  inferno: { id: 7, venue: 7, file: "V2BG_07A", name: "Inferno",
    rule: "The fire ring closes in as time passes. Throw your opponent into the fire and make him burn." },
  subway: { id: 8, venue: 4, file: "V2BG_04A", name: "Subway", rule: "Win the subway match with a subway KO (the train)." },
  window: { id: 9, venue: 17, file: "V2BG_15A", name: "Window",
    rule: "Throw your opponent out of the window to finish off the match with a window KO." },
  cage: { id: 10, venue: 16, file: "V2BG_14A", name: "Cage", rule: "No escape: the match is fought inside the cage at Club Murder." },
  ringout: { id: 11, venue: 5, file: "V2BG_05A", name: "Ringout", rule: "Over the edge: ring out rules are always in effect at the Dragon House." },
});

export const SPECIAL_IDS = Object.freeze(Object.keys(SPECIAL));
export const specialOf = venue => SPECIAL_IDS.find(mode => SPECIAL[mode].venue === venue) ?? null;
export const specialByType = id => SPECIAL_IDS.find(mode => SPECIAL[mode].id === id) ?? null;

// The loser marks retail 0x30bb40 sets in a special venue (actor +0x932): the cinematic and banner each one selects.
const ACTORS = [0x4bc170, 0x4bd468, 0x4be760, 0x4bfa58];
const MARKS = Object.freeze({ 0x4: "inferno", 0x8: "train", 0x10: "subway", 0x20: "window" });

// Latches how a special finish was delivered. The referee rewrites the marks into its result flags a frame later, so call
// observe() after every tick: kind() is "inferno" (burned), "train" (hit by the subway train), "subway", "window", or null.
export function createFinishLatch(memory, count = 2) {
  let kind = null;
  return {
    observe() {
      if (kind) return kind;
      for (const actor of ACTORS.slice(0, count)) {
        const flags = memory.getUint16(actor + 0x932, true);
        for (const [bit, name] of Object.entries(MARKS)) if (flags & bit) return (kind = name);
      }
      return null;
    },
    kind: () => kind,
    reset() { kind = null; },
  };
}
