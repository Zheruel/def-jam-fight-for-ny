// Per-tick combat audio for a native match. The retail engine walks ANIMTAGS.DAT every frame (0x12c9f0):
// each fighter's playing clip is looked up by its engine name, tags whose frame has been reached fire in
// order, and the class word of a tag selects the named audio event posted to the SND service.
// SLUS-21004's walker and queue are not compiled into the native kernel, so this does the same walk host
// side from the actor's live clip (+0x84 bank, +0x88 local, +0x8c motion) and frame (+0x9c).
//
//   const audio = venueAudio(arena.file);
//   const match = createMatchAudio({ combat, tags, mix, cues, venue, fighters: [{coreID}, {coreID}], clips: library,
//                                    play: (bank, subsong, options) => audio.cue(bank, subsong, options) });
//   match.tick(fight);   // once per simulated tick, after fight.tick()
//
// Which sample a bank event plays is decided by compiled bank code (ABKC); that choice is a seeded,
// deterministic pick inside the retail player's cue set, so a host and its guests agree.

import { combatManifest, loadAnimTags, mixLevels, venueManifest } from "./venue.mjs";

export const ACTORS = [0x4bc170, 0x4bd468];
const FRAME = 0x9c, BANK = 0x84, LOCAL = 0x88, MOTION = 0x8c;

// Events whose module lives in the common banks (WCommon1/2, Chops, Spec_*), by event name.
const COMMON = {
  Whooshes: "WCommon1", Fight_Bell: "WCommon1", Blood_Gush: "WCommon1", Bling_Chain: "WCommon1", PauseMenu_SFX: "WCommon1",
  Body_Contacts: "WCommon2", Face_Hits: "WCommon2", Bone_Crunch: "WCommon2", Groin_Punch: "WCommon2", Muscle: "WCommon2",
  Foley_Fx: "WCommon2", Land: "WCommon2", Omni_Event: "WCommon2", Blazin_sfx: "WCommon2", Blaze_Alarm: "WCommon2",
  Chops: "Chops", Special_Ass: "Spec_Ass", Special_Boob: "Spec_Boob", Special_Chest: "Spec_Chest", Special_Cork: "Spec_Cork",
  Special_Kick: "Spec_Kick", Special_Punch: "Spec_Punch",
};

export function engineName(memory, actor, clips) {
  const bank = memory.getUint32(actor + BANK, true);
  const local = memory.getUint32(actor + LOCAL, true);
  const motion = memory.getUint32(actor + MOTION, true);
  return (bank === 0 ? clips.common[local] : clips.global[motion]) ?? null;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 0x6d2b79f5 >>> 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Walker state per actor: clip key and last frame; tags fire while their frame has been reached.
export function createWalker(tags) {
  const index = new Map(tags.anims.map(([name, list]) => [name, list]));
  const state = { key: null, last: -1, next: 0, first: true };
  return {
    state,
    step(key, frameFloat) {
      const frame = Math.trunc(frameFloat);
      const list = index.get(key);
      if (key !== state.key || frame < state.last) {
        state.key = key; state.next = 0;
        // The first sample of a match joins a clip already under way: its earlier tags have passed.
        if (state.first) while (list && state.next < list.length && list[state.next][0] < frame) state.next++;
      }
      state.first = false;
      state.last = frame;
      const fired = [];
      while (list && state.next < list.length && list[state.next][0] <= frame) fired.push(list[state.next++]);
      return fired;
    },
  };
}

export function createMatchAudio({ combat, tags, mix, venue, fighters, clips, play, actors = ACTORS, seed = 1, record = true }) {
  let random = mulberry32(seed);
  const walkers = actors.map(() => createWalker(tags));
  const eventModules = new Map(); // `${bank}\0${event}` -> modules
  for (const [bank, info] of Object.entries(combat.banks)) {
    info.modules.forEach((module, index) => {
      if (!module.event) return;
      const key = bank + "\0" + module.event;
      if (!eventModules.has(key)) eventModules.set(key, []);
      eventModules.get(key).push({ ...module, index });
    });
  }
  const out = Object.prototype.hasOwnProperty.call(venue ?? {}, "out") ? venue.out : combat.venueOut.includes(venue?.coreID);
  const log = [];
  let ticks = 0;

  const level = key => key && mix.gain[key] !== undefined ? mix.gain[key] : 1;
  const pick = list => list[Math.floor(random() * list.length)];

  // class payload -> {bank, module, player, cue, gain} or null when the event has no bank in this venue.
  function route(slot, event, words) {
    const info = combat.fighters[fighters[slot]?.coreID] ?? {};
    let bank = COMMON[event];
    if (event === "Punch_Kick") bank = `Fighter_${info.hit ?? "Med"}_Hits_${out ? "Out" : "Ring"}`;
    else if (event === "Grunts" || event === "Grunts_cycle") bank = info.grunts ? "Grunts_" + info.grunts : null;
    else if (!bank) bank = venue?.sounds;
    const modules = bank && eventModules.get(bank + "\0" + event);
    if (!modules) return null;
    // A venue bank repeats an event per floor/weapon module; which one applies is compiled, so the first stands in.
    const module = modules[0];
    const w1 = words[0] ?? 0;
    const player = Math.min(Math.max(w1, 1), module.players.length) - 1;
    const cues = module.players[player];
    if (!cues?.length) return null;
    const variable = module.mix[Math.min(player, module.mix.length - 1)] ?? module.mix.find(Boolean);
    return { bank, module: module.index, player, cue: pick(cues), gain: level(variable), mix: variable };
  }

  function fire(slot, name, tag) {
    const [frame, , cls, ...words] = tag;
    const spec = combat.classes[cls];
    if (!spec?.events.length) return;
    for (const event of spec.events) {
      const target = route(slot, event, words);
      const entry = { tick: ticks, slot, clip: name, frame, class: cls, event, ...(target ?? { bank: null }) };
      if (record) log.push(entry);
      if (target) play?.(target.bank, target.cue, { gain: target.gain });
    }
  }

  return {
    log, walkers,
    reset() {
      for (const walker of walkers) Object.assign(walker.state,{key:null,last:-1,next:0,first:true});
      random = mulberry32(seed);
      ticks = 0;
      log.length = 0;
    },
    tick(fight) {
      const memory = fight.memory;
      actors.forEach((actor, slot) => {
        const name = engineName(memory, actor, clips);
        const frame = memory.getFloat32(actor + FRAME, true);
        if (!name || !Number.isFinite(frame)) return;
        for (const tag of walkers[slot].step(name, frame)) fire(slot, name, tag);
      });
      ticks++;
    },
    // Drain the events since the last call (for tests and diagnostics).
    drain() { return log.splice(0); },
  };
}

// Loads the manifests on first use and binds the adapter to a venueAudio() instance.
//   const match = await loadMatchAudio(audio, { file: arena.file, fighters: [{coreID}, {coreID}], clips: library });
export async function loadMatchAudio(audio, { file, fighters, clips, seed, fetcher = globalThis.fetch }) {
  const [combat, tags, mix, venues] = await Promise.all([combatManifest(fetcher), loadAnimTags(fetcher), mixLevels(fetcher), venueManifest(fetcher)]);
  const venue = venues.venues.find(entry => entry.file === file);
  if (!venue) throw new RangeError("Unknown venue " + file);
  return createMatchAudio({ combat, tags, mix, venue, fighters, clips, seed, record:false,
    play: (bank, subsong, options) => audio.cue(bank, subsong, options).catch(() => {}) });
}
