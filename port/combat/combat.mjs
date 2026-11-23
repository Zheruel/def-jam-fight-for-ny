const round = Math.fround;
const momentumFloor = 20;
const timerExpiryDecay = 0.5625;
const timerReset = 30;
const timerDecayPerTick = round(1 / 24);

/** Apply the signed, already-scaled hit delta to one of the five damage channels. */
export function applyHitChannelDelta(channels, index, delta) {
  const updated = round(round(channels[index]) + round(delta));
  channels[index] = updated < 0 ? 0 : updated;
}

/** Advance the two fighter fields written by the retail momentum tick. */
export function tickFighterMomentum(fighter, tick) {
  const { fighterFlags, hitFlags, blazinFlags } = fighter;
  const { matchFlags, elapsedTicks, expiryRate } = tick;
  let { momentum, blazinTimer } = fighter;
  momentum = round(momentum);
  blazinTimer = round(blazinTimer);

  if (matchFlags & 0x4) return { momentum, blazinTimer };

  let decay = 0;
  if (!(blazinFlags & 0x3)) {
    const elapsed = round(elapsedTicks);
    if (fighterFlags & 0xc000) {
      decay = round(elapsed * timerDecayPerTick);
    } else if (!(hitFlags & 0x20)) {
      blazinTimer = round(blazinTimer - elapsed);
      if (blazinTimer <= 0) {
        blazinTimer = timerReset;
        decay = timerExpiryDecay;
      }
    }
  }

  momentum = round(momentum - round(decay * round(expiryRate)));
  if (momentum < momentumFloor) momentum = momentumFloor;
  return { momentum, blazinTimer };
}
