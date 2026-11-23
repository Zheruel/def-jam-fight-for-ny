// Native equivalent of the per-actor clip clock at 0x2e3bc8..0x2e3cb0.
// The four optional timed events use the pre-advance frame.
export function advanceClip(actor, words, tick, emit) {
  const frame = actor.frame;
  for (let i = 0; i < 12; i += 3) {
    const kind = words[i + 2];
    if (kind < 25 && words[i] <= frame && frame <= words[i+1]) emit(kind);
  }
  const speed = new Float32Array(words.buffer, words.byteOffset, 34)[30];
  const step = Math.fround(Math.fround(tick * speed) * actor.rate);
  let next = Math.fround(frame + step);
  actor.crossedEnd = actor.end < next;
  if (actor.crossedEnd) {
    next = (words[33] & 1) && !(actor.stopLoop & 1) ? Math.fround(next - actor.end) : actor.end;
  }
  actor.frame = next;
  actor.remaining = Math.fround(actor.end - next);
}

// Both blend counters are integers. PS2 samples the new clip with the current
// fraction, then decrements the remaining counter (0x2e3d28..0x2e3d78).
export function takeBlend(actor) {
  if (actor.blendRemaining <= 0) return 1;
  const weight = Math.fround((actor.blendTotal - actor.blendRemaining) / actor.blendTotal);
  actor.blendRemaining--;
  return weight;
}
