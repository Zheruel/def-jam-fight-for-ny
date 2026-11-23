// The 125th Street Station train (venue 4), read from the native kernel and handed to the scenery renderer and audio.
//
// Retail runs the train in the Battle frame update 0x2e75e8, so the native kernel already does it. Its state lives in
// four words (see hazard.mjs for the match rules):
//   0x4c2174 phase, a float. A cycle starts at -4 and gains 0.004 a frame (1.2 / 300 per frame at the retail game speed):
//            -0.1 the siren starts (bits 1 and 3 of the word), 0 the train arrives and hits (bit 2 for one frame), 1 the
//            siren stops, 1.5 the cycle ends and the live bit clears. The next cycle starts after a random wait.
//   0x4c2178 word: bit 0 live, 1 coming, 2 hits, 3 siren, 4 a knockout asked for the train.
//   0x4c217c cycle count (1 for the first train).
// Every frame the kernel passes the phase to 0x193da0, which calls 0x131b30, the host side of the "TrainAmbience" sound
// (retail event Amb_train, ambient bank "train"). 0x131b30 is not the game speed. It does nothing until the phase is
// above 0 and then plays the sound; the volume is -(0.25 - phase) * 800 hundredths of a dB below full while the phase
// is under 0.25 and full after; the sound is stopped when the phase reaches 1.5.
//
// The cars are the stage models V2BG_04A_H..L (<subwaymatch>): one 181 unit car body each, identical but for one texture.
// Retail moves them with its venue animation V2BG_04A_H_A1, which the kernel does not drive and which holds only the
// parked pose (x -500). The path here is derived: the head of the train reaches the edge of the playfield (<width> 180)
// at phase 0 and the tail leaves the other edge at phase 1. Which car a cycle shows is the cycle count in the order the
// stage XML lists them; the retail pick is not recovered.
export const PHASE = 0x4c2174, WORD = 0x4c2178, CYCLE = 0x4c217c, VENUE = 0x4bbd34, SUBWAY = 4;
export const LIVE = 1, COMING = 2, HIT = 4, SIREN = 8;
export const ACTORS = [0x4bc170, 0x4bd468];
const FLAGS = 2354, TRAIN_HIT = 0x8;
export const START = -4, END = 1.5, ARRIVES = 0, LEAVES = 1, VISIBLE_FROM = -0.7;
export const SIREN_AT = -0.1;

// The retail volume of the train sound for a phase: hundredths of a dB below full, and the linear gain.
export function trainVolume(phase) {
  const cents = phase < 0.25 ? Math.max(-1000, Math.min(1000, Math.trunc((phase - 0.25) * 800))) : 0;
  return { cents, gain: 10 ** (cents / 2000) };
}

// Centre of the cars along x for a phase. `bounds` is the car mesh's own bounding box (x ±90.94).
export function trainX(subway, phase, bounds = { min: [-90.94], max: [90.94] }) {
  const half = (bounds.max[0] - bounds.min[0]) / 2, edge = subway.width / 2;
  return -(edge + half) + (subway.width + 2 * half) * phase;
}

export function createSubwayTrain(subway, { cues = 5 } = {}) {
  let siren, playing, cycle, hit, emitted, now, phase, live;
  function reset() { siren = false; playing = false; cycle = 0; hit = [false, false]; emitted = []; now = 0; phase = START; live = false; }
  reset();
  const lights = (subway.lights ?? []).map(l => l.name);
  const bounds = subway.bounds;
  return {
    reset,
    // Call once per tick after the kernel ran.
    update(memory, at = now++) {
      if (memory.getUint32(VENUE, true) !== SUBWAY) { live = false; return; }
      const word = memory.getUint32(WORD, true);
      phase = memory.getFloat32(PHASE, true);
      cycle = memory.getUint32(CYCLE, true);
      live = (word & LIVE) !== 0;
      const emit = effect => emitted.push({ kind: "train", at, cycle, phase, ...effect });
      const sirenNow = live && (word & SIREN) !== 0;
      if (sirenNow !== siren) { siren = sirenNow; emit({ action: "siren", on: siren, lights }); }
      // The sound starts the first frame the phase is above 0 and stops when the cycle ends.
      if (!playing && live && phase > ARRIVES) {
        playing = true;
        emit({ action: "audio", on: true, bank: "train", subsong: 1 + (cycle - 1) % cues, ...trainVolume(phase) });
      } else if (playing && (!live || phase >= END)) {
        playing = false;
        emit({ action: "audio", on: false, bank: "train" });
      } else if (playing && phase < 0.25) emit({ action: "volume", ...trainVolume(phase) });
      ACTORS.forEach((actor, slot) => {
        const hurt = (memory.getUint16(actor + FLAGS, true) & TRAIN_HIT) !== 0;
        if (hurt && !hit[slot]) emit({ action: "hit", slot });
        hit[slot] = hurt;
      });
    },
    // The car on the track now, as a dynamic weapon entry (model + world matrix), or null when none is in the tunnel.
    car() {
      if (!live || phase < VISIBLE_FROM || phase > END) return null;
      const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, trainX(subway, phase, bounds), 0, 0, 1]);
      return { model: subway.objects[(cycle - 1 + subway.objects.length) % subway.objects.length], matrix, train: true, phase };
    },
    effects() { const out = emitted; emitted = []; return out; },
    get phase() { return phase; },
    get live() { return live; },
    get siren() { return siren; },
  };
}

// Plays the train's sound and the scream of whoever it hit through a venueAudio() instance (audio.cue(bank, subsong, {gain})).
// The "train" bank (SFX0, ambient2 of the venue) has five 5 second subsongs; which one retail's Amb_train picks is code in
// the bank, so the cycle number picks. The hit plays Train_Kill_Female for the fighters whose retail grunt set is a Girl
// set and Train_Kill_Male for the rest. The train bank is prepared on the first audio gesture so its volume can follow the phase immediately.
export function createTrainAudio(audio, { fighters = [], combat = null, load = () => fetch(new URL("../audio/combat.json", import.meta.url)).then(r => r.json()) } = {}) {
  audio.prepareCueBank?.("train");
  let voice = 0, node = null, manifest = combat, gain = 1;
  const play = (bank, subsong, gain = 1) => audio.cue(bank, subsong, { gain });
  const female = slot => /girl/i.test(manifest?.fighters?.[fighters[slot]?.coreID]?.grunts ?? "");
  return {
    reset() { voice++; try { node?.stop(); } catch { /* already ended */ } node = null; },
    async effects(list) {
      for (const effect of list ?? []) {
        if (effect.kind !== "train") continue;
        if (effect.action === "audio" && effect.on) {
          const mine = ++voice;
          gain = effect.gain;
          const started = await play(effect.bank, effect.subsong, effect.gain).catch(() => null);
          if (mine === voice) { node = started ?? null; if (node) audio.setCueGain?.(node, gain); }
          else try { started?.stop(); } catch { /* ended */ }
        } else if (effect.action === "audio") {
          voice++;
          try { node?.stop(); } catch { /* already ended */ }
          node = null;
        } else if (effect.action === "volume") {
          gain = effect.gain;
          if (node) audio.setCueGain?.(node, gain);
        } else if (effect.action === "hit") {
          manifest ??= await load().catch(() => null);
          await play(female(effect.slot) ? "Train_Kill_Female" : "Train_Kill_Male", 1).catch(() => null);
        }
      }
    },
  };
}
