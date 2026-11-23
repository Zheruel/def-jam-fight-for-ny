import library from "./library.json" with { type: "json" };

// SLUS-21004, 0x2e49f8. Several rows can start on the same local clip.
// Only a row with an assigned move can replace another at that boundary.
function globalClip(actor, local) {
  const slots = library.slots[actor.modelIndex];
  if (!slots) throw new RangeError("Unknown fighter motion table");
  let row = 1;
  let start = 0;
  for (let next = 2; next <= 125; next++) {
    const end = next === 125 ? 1000 : slots[next][1];
    if (local < end) {
      const offset = local - start;
      if (offset >= 2 && actor.state === 0x41) {
        if (!Number.isInteger(actor.specialBase) || !Number.isInteger(actor.flags)) {
          throw new TypeError("Missing special move state");
        }
        return actor.specialBase + offset - (actor.flags & 4 ? 3 : 2);
      }
      return slots[row][2] + offset;
    }
    if (end > start || (end === start && slots[next][0] !== 0xffff)) {
      start = end;
      row = next;
    }
  }
  return 0;
}

// 0x2e4808 stores the full actor-qualified number as the fighter-local action.
// The player selects a resource from the owning actor's loaded clip bank.
export function resolveMotion(action, actors) {
  if (!Number.isSafeInteger(action) || action < 0) throw new RangeError("Invalid action");
  if (action >= 10000) {
    const local = action - 10000;
    return { bank: 0, local, motion: local, engineName: library.common[local] ?? null,
      loadedClip: library.baseBank[local] ?? null };
  }
  const owner = Math.floor(action / 1000);
  const actor = actors[owner];
  if (!actor) throw new RangeError("Missing motion owner");
  const localClip = action % 1000;
  const motion = globalClip(actor, localClip);
  const entry = library.fighterBanks[actor.modelIndex][localClip];
  return { bank: 1, local: action, motion, engineName: library.global[motion] ?? null,
    loadedClip: typeof entry === "number" ? library.global[entry] : entry ?? null };
}
