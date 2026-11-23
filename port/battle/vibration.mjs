import tracks from "./vibration.json" with { type: "json" };

// Tag class 58 (0x12d950) sets the actor's two motor levels, including explicit
// zero commands. A clip change stops the previous effect at 0x12cd40.
export function clipVibration(memory, actor) {
  const common = memory.getUint32(actor + 0x84, true) === 0;
  const id = memory.getUint32(actor + (common ? 0x88 : 0x8c), true);
  const keys = (common ? tracks.common : tracks.global)[id];
  if (!keys) return 0;
  const frame = memory.getFloat32(actor + 0x9c, true);
  for (let i = keys.length - 2; i >= 0; i -= 2) if (frame >= keys[i]) return keys[i + 1];
  return 0;
}

// Refresh an active motor every six simulation ticks. Each short hardware
// effect expires by itself if a tab is suspended or a guest loses its connection.
export function matchVibration(actors, send) {
  const levels = actors.map(() => 0), refresh = actors.map(() => 0);
  function update(slot, level) {
    if (level !== levels[slot] || (level && --refresh[slot] <= 0)) {
      send(slot, level);
      refresh[slot] = 6;
    }
    levels[slot] = level;
  }
  return {
    tick(memory) { actors.forEach((actor, slot) => update(slot, clipVibration(memory, actor))); },
    stop() { actors.forEach((_, slot) => update(slot, 0)); },
  };
}
