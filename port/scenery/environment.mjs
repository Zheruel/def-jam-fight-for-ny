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

export const EVENT_QUEUE = 0x476e28;
export const QUEUE_RECORDS = 2;
export const QUEUE_STRIDE = 16;
export const FREE = 0xffffffff;

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

export function createEnvironment(manifest, eventNames, { gravity = GRAVITY } = {}) {
  const attacks = new Map((manifest.environmentAttacks ?? []).map(a => [a.name, a]));
  const propStates = new Map((manifest.props ?? []).map(p => [p.name, new Set(p.states)]));
  const placed = new Map((manifest.weapons ?? []).map(w => [short(w.name), w]));
  const hidden = new Set(manifest.hiddenWeapons ?? []);
  let props, weapons, running, emitted, ignored, clock;

  function reset() {
    props = {};
    weapons = new Map();   // short name -> {gone, translate, rotate, motion}
    running = [];
    emitted = [];
    ignored = [];
    clock = 0;
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
    const emit = extra => emitted.push({ at, event: event.name, kind, ...extra });
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
    update(memory, frames = 1) {
      const events = drainEventQueue(memory);
      for (const e of events) trigger(e.id, e);
      step(frames);
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
      return { props: { ...props }, weapons: out, hiddenWeapons: revealed };
    },
    // Sounds, particles and light changes the events asked for since the last call.
    effects() { const out = emitted; emitted = []; return out; },
    get running() { return running.map(e => e.name); },
    get ignored() { return ignored; },
    get clock() { return clock; },
  };
}
