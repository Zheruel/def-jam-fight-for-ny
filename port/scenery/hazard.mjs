// Venue hazards that end a round: the 125th Street Station train (venue 4), Red Hook's inferno (7) and Crow's Office (17).
//
// Retail (SLUS-21004), recovered from the disassembly and executed in the native kernel:
//  * Venue id is the word at 0x4bbd34 (coreID). Only 4, 7 and 17 have hazard rules.
//  * 0x30bb40(winner) is the knockout routine. It zeroes the health of actor+0 (the loser), and in those venues marks the
//    loser's flags (+0x932 half, decimal 2354) with 0x10 (subway), 0x4 (Red Hook) or 0x20 (Crow's Office) and the match
//    flags at G+448 with 8, 4 or 0x10. The referee 0x2e6260 maps that flag to the result type 0x100 / 0x80 / 0x200 and
//    ends the round at once. Everywhere else it does nothing.
//  * The subway's train is a stage object outside the kernel. It talks to the match through the word 0x4c2178:
//      bit 0 the train hazard is live (set at venue setup), bit 1 the train is coming, bit 2 the train hits.
//    0x2e78d0 (called every frame from 0x2dbdd0) reads them. While bits 0 and 1 are set it marks each fighter that is in a
//    hazard state (action state 12, 13, 19, 86, 90, 91) or has the word at actor+932 below -1 with 0x1000 in +2344. When
//    bit 2 arrives it clears bits 1 and 2, puts every marked fighter into state 19 and sets 8 in their +2354 flags. The
//    referee 0x2e6260 then ends the round: the marked fighter loses and the unmarked one wins, health untouched.
//  * 0x30b928, the under-10% knockdown rule, defers the KO in the subway while the train scalar (0x4c2174) is inside
//    [-0.3, 1.1] and no fighter is in the pit, and asks for the train instead by setting bit 4 (0x10) of 0x4c2178.
//    Red Hook and Crow's Office let the KO through only while the opponent is above 10% health.
export const VENUE_ID = 0x4bbd34;
export const TRAIN_WORD = 0x4c2178;
export const TRAIN_SCALAR = 0x4c2174;
export const ACTORS = [0x4bc170, 0x4bd468];
export const COMING = 2, HIT = 4, REQUESTED = 0x10;
export const HAZARD_VENUES = Object.freeze({ 4: "subway", 7: "inferno", 17: "garage" });
const FLAGS = 2354, ZONE = 2344, ZONE_BIT = 0x1000, HIT_FLAG = 0x8;

export const hazardKind = memory => HAZARD_VENUES[memory.getUint32(VENUE_ID, true)] ?? null;

export function createTrain(kernel) {
  const { memory } = kernel;
  const word = () => memory.getUint32(TRAIN_WORD, true);
  const set = value => memory.setUint32(TRAIN_WORD, value >>> 0, true);
  let hit = false;
  return {
    // The train is coming. The retail consumer marks fighters in a hazard state on the next frame, and a fighter in the
    // pit (the word at +932 below -1) at once: call() runs the consumer now so both are marked before the hit.
    warn() { set(word() | COMING); kernel.call(0x2e78d0, 0, 0, 0, 0); },
    // The train arrives: marked fighters are hit.
    strike() { set(word() | HIT); kernel.call(0x2e78d0, 0, 0, 0, 0); hit = true; },
    // What the next frame will see.
    marked: () => ACTORS.map(a => (memory.getUint16(a + ZONE, true) & ZONE_BIT) !== 0),
    hitBy: () => ACTORS.map(a => (memory.getUint16(a + FLAGS, true) & HIT_FLAG) !== 0),
    requested: () => (word() & REQUESTED) !== 0,
    get struck() { return hit; },
    reset() { hit = false; },
  };
}

// The way a finished round ended: 'hazard' when the train ended it, otherwise the referee's own method.
export function finishKind(outcome, actors, train) {
  if (!outcome.over || outcome.loser === null) return outcome.method;
  return train?.struck && actors[outcome.loser].health > 0 ? "hazard" : outcome.method;
}
