// Round result, read from the retail Battle referee instead of being re-derived.
//
// Each frame retail (0x18ae00) runs the match state machine 0x2dbbd8 with a delta of 1.0 before the actor update
// 0x2dbdd0. It advances the match phase at G+8:
//   0 intro, 1 fight, 2 finishing, 3 result.
// A fighter is knocked out when a knockdown lands (actor state 31, handler 0x30a190 -> classifier 0x30b550/0x30b928)
// while their health ratio (+0x35c) is below 0.1. 0x30bb40 then zeroes their health, flags them (+0x932 bit 0x20) and
// the referee 0x2e6260 posts the result event through 0x2e67c8. 0x2dbbd8 turns that into phase 2 and 3 and stores the
// winning slot at G+0x14 / G+0x18. Flags 0x100 (winner) and 0x200 (loser) are left in each actor's +0x932.
const G = 0x4bbf90;
const PHASE = Object.freeze({ intro: 0, fight: 1, ending: 2, result: 3 });
const WINNER = 0x100, LOSER = 0x200;

export function createOutcome(kernel, actors) {
  const { memory } = kernel;
  const word = address => memory.getUint32(address, true);
  const half = address => memory.getUint16(address, true);
  const scalar = address => memory.getFloat32(address, true);
  let overFor = 0, effects = [], speed = 1;

  // One retail frame of the referee. Returns the state after it ran.
  function advance() {
    kernel.callWithDelta(0x2dbbd8, 0, 1);
    const phase = word(G + 8);
    overFor = phase >= PHASE.ending ? overFor + 1 : 0;
    return read();
  }

  function read() {
    const phase = word(G + 8), over = phase >= PHASE.ending;
    const marks = actors.map(a => half(a + 0x932));
    let winner = null, loser = null;
    if (over) {
      winner = marks.findIndex(m => m & WINNER);
      loser = marks.findIndex(m => m & LOSER);
      if (winner < 0) winner = word(G + 0x14);
      if (loser < 0) loser = actors.findIndex((_, slot) => slot !== winner);
    }
    return {
      phase, over, result: phase >= PHASE.result, winner, loser,
      method: !over ? null : scalar(actors[loser] + 0x350) <= 0 ? "ko" : "time",
      // Retail match clock (G+0x1a8 minutes, G+0x1ac seconds); it advances while the referee runs.
      clock: { minutes: word(G + 0x1a8), seconds: word(G + 0x1ac) },
      ticksSinceOver: overFor,
      speed, effects,
    };
  }

  return {
    advance, read,
    // Host side of retail 0x1325b8(kind, frames): the slow-motion/time-scale request the referee raises at the finish.
    timeScale(kind, frames) { effects = [...effects, { kind, frames }]; },
    // Host side of retail 0x131b30(scale), which 0x2e75e8 sets every frame through 0x193da0: the global game speed.
    gameSpeed(scale) { speed = scale; },
    reset() { overFor = 0; effects = []; speed = 1; },
  };
}

export { PHASE };
