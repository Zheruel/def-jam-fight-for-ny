// Stage environment events: pillars that break, speakers that shed their bottles, bottles that smash, hidden
// weapons that drop out of a broken pillar. A native match feeds it; it hands the scenery renderer what to draw.
//
// How retail does it (SLUS-21004, recovered from the disassembly and checked against the native kernel):
//  * Fighter code decides that a hit reached a stage object. Retail 0x307250 picks the event from the move, and
//    0x192068(id, attacker, target, flag) queues it. The queue is two 16-byte records at 0x476e28
//    { id, attacker actor+40, target, flag }; id 0xffffffff is a free record. This part is in the native kernel.
//  * The id indexes a 468-name table at 0x379f70 ("02A_1A" ...). Pillars are three events: 02A_1A break1,
//    02A_1B break2, 02A_1C break3 + hidden weapon. Which of the three a hit queues is decided by the fighter code.
//  * The stage manager (vtable 0x191a00, not in the kernel) starts each queued event in one of two slots at
//    0x472014 (140 bytes each) and 0x192b28 steps it by 60 time units per second. 0x1922b0 runs the stage XML
//    <environmentattack> block of that name: each command carries a start time, -1 meaning "now".
// This adapter replaces the manager: it drains the queue the way the manager does and runs the same XML commands
// from scenery.json. Geometry states are exact. The tumble of a bottle (V2WA_029_11_02A, an EAGL animation bank) and
// the fall of a pillar weapon are not decoded; they are a plain fall and are marked approximate in the state.

import { actorMatrix, boneWorldMatrix } from "../fighters/pose.mjs";
import { placementMatrix } from "./scenery.mjs";
import { createSubwayTrain } from "./train.mjs";
import { infernoFire } from "./particles.mjs";

export const EVENT_QUEUE = 0x476e28;
export const QUEUE_RECORDS = 2;
export const QUEUE_STRIDE = 16;
export const FREE = 0xffffffff;

// Weapon manager (retail 0x133180 returns it for a battle): 16 slots of 208 bytes from +12.
//   +0 active   +4 weapon type (index in the sorted V2WP list; -1 = free slot)   +8 holder
//   +12..+75 world matrix (16 floats, translation in the last row)   +76 grip position  +88 grip rotation (degrees)
//   +144 request bits   +148 state   +176 the weapon number in its name (29 for V2WP_029A)
// holder: -1 resting, 0 / 1 carried by that fighter, -2 in flight. state: 1 being used, 2 resting on the stage,
// 3..5 breaking (0x1c1c28 tests for these; 0x1c33a0 walks 3 -> 4 -> 5 and frees the slot).
// Retail's per-frame weapon update (vtable method 0x1c33a0) is not in the kernel, so a carried weapon's matrix is built
// here the way 0x1c11e8 builds it: grip rotation, then grip position, then the hand bone (retail bone id 19) of the carrier.
export const WEAPON_MANAGER = 0x472144;
export const WEAPON_SLOTS = 16;
export const WEAPON_STRIDE = 208;
export const HAND_BONE = 19;
export const HOLDER = Object.freeze({ resting: -1, flying: -2 });
const BREAKING = 3;

// Plain stand-in for the weapon fall: units per frame squared, and the frames a bottle takes to leave its stand.
const GRAVITY = 0.35;

const short = name => name.replace(/^weapon_/, "");

export function readEventQueue(memory) {
  const out = [];
  for (let slot = 0; slot < QUEUE_RECORDS; slot++) {
    const at = EVENT_QUEUE + slot * QUEUE_STRIDE;
    const id = memory.getUint32(at, true);
    if (id !== FREE) out.push({ slot, id, attacker: memory.getUint32(at + 4, true),
      target: memory.getUint32(at + 8, true), flag: memory.getUint32(at + 12, true) });
  }
  return out;
}

// Take the pending requests and free their records, as the retail manager does when it starts them.
export function drainEventQueue(memory) {
  const events = readEventQueue(memory);
  for (const { slot } of events) memory.setUint32(EVENT_QUEUE + slot * QUEUE_STRIDE, FREE, true);
  return events;
}

export function readWeaponSlots(memory, models = [], base = WEAPON_MANAGER) {
  const out = [];
  for (let slot = 0; slot < WEAPON_SLOTS; slot++) {
    const at = base + 12 + slot * WEAPON_STRIDE;
    const type = memory.getInt32(at + 4, true);
    if (type === -1) continue;
    const matrix = new Float32Array(16);
    for (let i = 0; i < 16; i++) matrix[i] = memory.getFloat32(at + 12 + i * 4, true);
    const vec = offset => [0, 4, 8].map(k => memory.getFloat32(at + offset + k, true));
    out.push({ slot, type, model: models[type] ?? null, holder: memory.getInt32(at + 8, true),
      state: memory.getUint32(at + 148, true), requests: memory.getUint32(at + 144, true),
      number: memory.getUint32(at + 176, true), matrix, position: [matrix[12], matrix[13], matrix[14]],
      grip: { translate: vec(76), rotate: vec(88) } });
  }
  return out;
}

// Column-major 4x4 product a * b.
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = sum;
  }
  return out;
}

// Where a carried weapon is: the carrier's hand with the weapon's grip applied.
export function carriedMatrix(slot, fighter) {
  if (!fighter?.world || !fighter.entries) return null;
  const hand = boneWorldMatrix(fighter, fighter.entries, actorMatrix(fighter.position, fighter.yaw), HAND_BONE, fighter.world);
  return multiply(Float32Array.from(hand), placementMatrix(slot.grip));
}

export function createEnvironment(manifest, eventNames, { gravity = GRAVITY, weaponModels = [] } = {}) {
  const attacks = new Map((manifest.environmentAttacks ?? []).map(a => [a.name, a]));
  // A car's panels take events like props do; `null` and `break4` are valid and draw nothing (no mesh of their own).
  const propStates = new Map([...(manifest.props ?? []), ...(manifest.cars ?? []).flatMap(c => c.objects)]
    .map(p => [p.name, new Set([...p.states, ...(p.hidden ?? [])])]));
  const placed = new Map((manifest.weapons ?? []).map(w => [short(w.name), w]));
  const hidden = new Set(manifest.hiddenWeapons ?? []);
  const redHook = manifest.venue === "V2BG_07A";
  const train = manifest.subway ? createSubwayTrain(manifest.subway) : null;
  let props, weapons, running, emitted, ignored, clock, live = null;
  // What the particle renderer needs: stage particles started since the last draw, and the Inferno's fire.
  let visual = [], fire = null;

  function reset() {
    props = {};
    weapons = new Map();   // short name -> {gone, translate, rotate, motion}
    running = [];
    emitted = [];
    visual = [];
    fire = null;
    ignored = [];
    clock = 0;
    live = null;
    train?.reset();
  }
  reset();

  const weaponState = name => {
    let state = weapons.get(name);
    if (!state) {
      const base = placed.get(name);
      state = { gone: false, shown: !hidden.has(name), translate: base ? [...base.translate] : [0, 0, 0],
        rotate: base ? [...base.rotate] : [0, 0, 0], motion: null, approximate: false };
      weapons.set(name, state);
    }
    return state;
  };

  // The commands of one event as [time, kind, args...] ordered by time.
  function commands(attack) {
    const list = [];
    const add = (rows, kind) => { for (const [time, ...args] of rows ?? []) list.push({ time: +time, kind, args }); };
    add(attack.geometry, "geometry");
    add(attack.weapons, "weapon");
    add(attack.particles, "particle");
    add(attack.movingParticles, "movingParticle");
    add(attack.deleteParticles, "deleteParticle");
    add(attack.sounds, "sound");
    add(attack.weaponSounds, "weaponSound");
    add(attack.animations, "animation");
    add(attack.spawnWeapons, "spawnWeapon");
    add(attack.light, "light");
    return list.sort((a, b) => a.time - b.time);
  }

  function execute(event, command) {
    const { kind, args } = command;
    const at = clock;
    const emit = extra => {
      const effect = { at, event: event.name, kind, ...extra };
      emitted.push(effect);
      if (effect.particle && kind === "particle") visual.push(effect);
    };
    switch (kind) {
      case "geometry": {
        const [object, state] = args;
        if (!propStates.get(object)?.has(state)) { ignored.push(`${event.name}: ${object} has no state ${state}`); return; }
        props[object] = state;
        return emit({ object, state });
      }
      case "weapon": {
        const [name, action, ...rest] = args;
        const weapon = weaponState(name);
        if (action === "delete") {
          const animation = rest[0] ?? null;
          // With an animation the bottle leaves its stand first and is removed at its "break" sound; without one it
          // vanishes now (bottle smash in hand).
          const breakAt = (event.attack.weaponSounds ?? []).find(([, n]) => n === name)?.[0];
          if (!animation) { weapon.gone = true; weapon.motion = null; return emit({ weapon: name, action }); }
          const landing = (event.attack.particles ?? []).find(([t]) => +t === +breakAt);
          const to = landing ? [+landing[2], +landing[3], +landing[4]] : [weapon.translate[0], 0, weapon.translate[2]];
          weapon.motion = { from: [...weapon.translate], to, start: clock, removeAt: event.start + (+breakAt || 60), animation };
          weapon.approximate = true;
          return emit({ weapon: name, action, animation });
        }
        if (action === "position") {
          const [x, y, z] = rest.map(Number);
          weapon.gone = false;
          weapon.shown = true;
          weapon.translate = [x, y, z];
          const floor = placed.get(name)?.translate[1] ?? 0;
          weapon.motion = { from: [x, y, z], to: [x, floor, z], start: clock, removeAt: null, animation: null };
          weapon.approximate = true;
          return emit({ weapon: name, action, position: [x, y, z] });
        }
        if (action === "call") return emit({ weapon: name, action, animation: rest[0] ?? null });
        ignored.push(`${event.name}: unknown venueweapon action ${action}`);
        return;
      }
      case "weaponSound": return emit({ weapon: args[0], sound: args[1] });
      case "sound": return emit({ sound: args[0] });
      case "particle": return emit({ particle: args[0], position: args.slice(1, 4).map(Number), rotation: args.slice(4).map(Number) });
      case "movingParticle": return emit({ particle: args[0], position: args.slice(1).map(Number) });
      case "deleteParticle": return emit({ particle: args[0] });
      default: return emit({ args });
    }
  }

  function step(frames) {
    for (let i = 0; i < frames; i++) {
      for (const event of running) {
        while (event.queue.length && event.queue[0].time <= clock - event.start) execute(event, event.queue.shift());
      }
      running = running.filter(event => event.queue.length);
      for (const [name, weapon] of weapons) {
        const move = weapon.motion;
        if (!move) continue;
        const t = clock - move.start;
        // Straight fall onto the target in the shortest time gravity allows, then rest there.
        const drop = Math.max(move.from[1] - move.to[1], 0);
        const fall = Math.ceil(Math.sqrt(2 * drop / gravity)) || 1;
        const k = Math.min(t / fall, 1);
        weapon.translate = [move.from[0] + (move.to[0] - move.from[0]) * k,
          Math.max(move.from[1] - 0.5 * gravity * Math.min(t, fall) ** 2, move.to[1]),
          move.from[2] + (move.to[2] - move.from[2]) * k];
        if (move.removeAt !== null && clock >= move.removeAt) {
          weapon.gone = true;
          weapon.motion = null;
          emitted.push({ at: clock, kind: "weaponGone", weapon: name });
        } else if (t >= fall && move.removeAt === null) weapon.motion = null;
      }
      clock++;
    }
  }

  // Start an event by retail id or name. Returns false for ids that this venue has no script for.
  function trigger(event, request = {}) {
    const name = typeof event === "number" ? eventNames[event] : event;
    const attack = attacks.get(name);
    if (!attack) { ignored.push(`${name ?? event}: no script in this venue`); return false; }
    const started = { name, attack, start: clock, request, queue: commands(attack) };
    running.push(started);
    // Time -1 commands run when the event starts, on the same frame.
    while (started.queue.length && started.queue[0].time < 0) execute(started, started.queue.shift());
    running = running.filter(e => e.queue.length);
    return true;
  }

  return {
    trigger,
    advance: step,
    reset,
    // Drain the retail queue from the native match, then run one frame. Call once per fight.tick.
    // fighters (fight.states) lets carried weapons follow the hand.
    update(memory, frames = 1, fighters = null) {
      const events = drainEventQueue(memory);
      for (const e of events) trigger(e.id, e);
      step(frames);
      train?.update(memory, clock);
      // Red Hook's venue clock (0x4c1930) runs the Inferno's fire (0x2dea90) in the native kernel whenever the venue is loaded (the
      // page does not set the backend match type 7, so the venue is the only switch), so the fire is drawn whenever it burns.
      fire = redHook ? infernoFire(memory.getFloat32(0x4c1930, true)) : null;
      live = { slots: readWeaponSlots(memory, weaponModels), fighters };
      return events;
    },
    // What createSceneryRenderer's render() takes.
    state() {
      const out = {};
      const revealed = [];
      for (const [name, weapon] of weapons) {
        if (weapon.gone) out["weapon_" + name] = false;
        else if (weapon.motion || weapon.translate.some((v, i) => v !== placed.get(name)?.translate[i])) {
          out["weapon_" + name] = { translate: [...weapon.translate], rotate: [...weapon.rotate] };
        } else if (weapon.shown && hidden.has(name)) revealed.push("weapon_" + name);
      }
      const dynamicWeapons = [];
      if (live) {
        const matched = new Set();
        for (const [name, base] of placed) {
          const slot = live.slots.find(w => !matched.has(w.slot) && w.model === base.model && w.holder === HOLDER.resting
            && Math.hypot(...w.position.map((v, i) => v - base.translate[i])) < 0.1);
          // A placed weapon the match did not put in play (a pillar weapon of a pillar that holds none) is not there.
          if (slot) matched.add(slot.slot);
          else if (out["weapon_" + name] === undefined) out["weapon_" + name] = false;
        }
        for (const w of live.slots) {
          if (matched.has(w.slot) || w.state >= BREAKING || !w.model) continue;
          const matrix = w.holder >= 0 && w.holder < 4 ? carriedMatrix(w, live.fighters?.[w.holder])
            : w.holder === HOLDER.resting && w.matrix[15] === 1 ? w.matrix : null;
          if (matrix) dynamicWeapons.push({ slot: w.slot, model: w.model, holder: w.holder, matrix });
        }
      }
      const car = train?.car();
      if (car) dynamicWeapons.push(car);
      const particleEvents = visual;
      visual = [];
      // sight: where the fighters stand, for the renderer's crowd occlusion fade (occlusion.mjs).
      const sight = (live?.fighters ?? []).map(f => f.position);
      return { props: { ...props }, weapons: out, hiddenWeapons: revealed, dynamicWeapons, particleEvents, fire, sight };
    },
    // Every weapon slot the match has live right now: what is held, resting or flying.
    get weaponSlots() { return live ? live.slots : []; },
    // Sounds, particles and light changes the events asked for since the last call.
    effects() { const out = [...emitted, ...(train?.effects() ?? [])]; emitted = []; return out; },
    get train() { return train; },
    get running() { return running.map(e => e.name); },
    get ignored() { return ignored; },
    get clock() { return clock; },
  };
}
