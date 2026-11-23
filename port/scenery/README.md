# Retail Battle scenery

Original stage props and the instanced background crowd, decoded from the licensed US PS2 disc (`SLUS-21004`). Nothing is authored.

```sh
python3 port/scenery/extract.py [iso] [--check]
python3 -m unittest discover -s port/scenery -p 'test_*.py'
node --test port/scenery/scenery.test.mjs
node port/scenery/compare.mjs      # headless Chrome; no emulator
```

## Foundation (`V2BG_02A`) — `foundation/`

| File | Source | Coverage |
| --- | --- | --- |
| `props.scene.gz` (DJS1) | `V2BG.VIV` `V2BG_02A_{A..F,H,I}.o`, `V2BG_02A_O.xml` | Static meshes. A–D pillars (base + break1–3), E/F work lights, H/I speaker stacks. Break states are discrete meshes; each state's bounds equal a retail bounding record. |
| `crowd.bin.gz` (DJC1) | `ICROWD.VIV` `icrowd01.{o,ssh,xml}`, `icl_02A.o` | **Animated.** 60 instances, 132 vertices, 383 retail 16-bit vertex frames: idle `[0,240)`, excited `[243,383)`, shared rest pose at 0/1/241/242/382. One 256² atlas with four outfits; instance name `G_row_variant` selects the quadrant. |
| `scenery.json` | `V2BG_02A.xml`, `_O.xml`, ICROWD | Prop placements, `nearCrowd` (30 foreground/side spectator positions), weapon positions, environment attacks, crowd ratios. |

## Every venue

`python3 port/scenery/extract.py` writes `<VENUE>/{scenery.json,props.scene.gz}` for all 24 Battle venues, the shared `crowd/icrowd01.crowd.gz` model and `index.json`. Props are static meshes (a prop with named break states has one mesh per state; the rest are one `base` mesh). The instanced crowd is **animated** and exists in 11 venues (its layout is in the venue's `scenery.json`, `instancedCrowd.placements`). `loadSceneryIndex()` returns the index.

| Venue | Name | Static props | Undecoded props | Instanced crowd | Near-crowd slots |
| --- | --- | --- | --- | --- | --- |
| V2BG_01A | Hunt's Point Scrapyard | 6 (6 meshes) | 1 | - | 23 |
| V2BG_01B | Hunt's Point After Hours | 4 (4 meshes) | 3 | - | - |
| V2BG_02A | The Foundation | 8 (24 meshes) | 0 | 60 | 30 |
| V2BG_03A | Syn Energy Power Plant | 3 (3 meshes) | 1 | - | 30 |
| V2BG_04A | 125th Street Station | 10 (21 meshes) | 5 | - | - |
| V2BG_05A | Dragon House | 24 (72 meshes) | 0 | 100 | 15 |
| V2BG_06A | The Heights | 7 (7 meshes) | 0 | - | 29 |
| V2BG_07A | Red Hook Tire Co. | 3 (15 meshes) | 1 | - | - |
| V2BG_09A | Club 357 | 0 (0 meshes) | 1 | 100 | 30 |
| V2BG_09B | Club 357 High Stakes | 0 (0 meshes) | 1 | 100 | 30 |
| V2BG_10A | The Gauntlet | 6 (6 meshes) | 1 | 120 | 36 |
| V2BG_10B | The Gauntlet Intense | 9 (9 meshes) | 1 | 120 | 30 |
| V2BG_11A | Stapleton Athletics | 0 (0 meshes) | 1 | - | 6 |
| V2BG_12A | The Chopshop | 3 (3 meshes) | 0 | - | 34 |
| V2BG_13A | The Pit | 16 (28 meshes) | 0 | - | 35 |
| V2BG_14A | Club Murder | 10 (10 meshes) | 0 | 120 | 30 |
| V2BG_15A | Crow's Office | 18 (31 meshes) | 2 | - | - |
| V2BG_17A | Gun Hill Garage | 5 (5 meshes) | 51 | - | 30 |
| V2BG_19A | The Terrordome | 8 (8 meshes) | 1 | 60 | 30 |
| V2BG_20A | The Limit | 19 (23 meshes) | 2 | - | 35 |
| V2BG_21A | Babylon | 6 (8 meshes) | 3 | - | 30 |
| V2BG_22A | Club DTP | 5 (5 meshes) | 1 | 100 | 28 |
| V2BG_22B | 7th Heaven | 5 (5 meshes) | 1 | 100 | 28 |
| V2BG_23A | Red Room | 8 (8 meshes) | 2 | 100 | 29 |

Undecoded props are skinned, bone-animated models (`*_Skin` microcode, e.g. the Gun Hill Garage cars) or use a VIF layout `port/geometry/venues.py` does not handle; they are listed by name in `scenery.json` `undecodedProps`.

Not decoded: the `nearCrowd` characters (modular V2CM people with their `animcr` clips; see below), prop colour morphs (`V2BG_02A_A1.o`…), the per-instance retail animation phase, instance variant 5, the rim and shadow light terms in `.irr`, and the engine's ambient mix into the first coefficient.

## Weapons and bottles

`weapons/` holds all 55 `V2WP_nnnX` models from `V2WP.VIV` as DJF1 skinned meshes (the fighter container; one bone, drawn in bind pose) with `weapons/index.json` carrying each weapon's `weapon.xml` data (material `pt`, grips `fp/bp/cp/dp`, hand `hd`). Their packets batch fewer vertices than a fighter's, so the extractor reads the VU addresses from the packet instead of using `retail.decode_packet`'s fixed ones. A venue's `scenery.json` lists `weapons` (placements with `model`) and `hiddenWeaponModels`; `loadScenery` fetches those models and the renderer draws them (`weapons: {name: false}` hides one, `hiddenWeapons: true` shows the pillar weapons that appear when a pillar breaks). The Foundation's two bottles on the speakers match the retail frame (speaker correlation 0.79 to 0.88).

## Irradiance lighting

`<VENUE>/lighting.json` holds every retail `.irr` setting for the venue (88 across the 24 venues; names and order from `ENTITY.XML`, e.g. `V2BG02A0..3` and `_nis`). Each setting has two light sets of probe spheres. `irradiance.mjs` ports the engine's CPU step (SLUS-21004 `0x16ae00`: inverse-distance blend of the probes, times `intensityMultiplier`) and evaluates the ten (r, g, b) coefficients as a symmetric 4x4 irradiance matrix, `[M33, M00, M11, M22, M01, M02, M12, M03, M13, M23]`: `sampleIrradiance(set, position)`, `irradiance(coefficients, normal)`, and `irradianceGLSL`. The VU1 microcode that consumes the coefficients is not disassembled, so the coefficient order and the final scale are inferred. Set 0 of the first setting lights the Foundation fight; the scenery renderer takes `{ lighting: set, lightScale }`.

Check against retail frame 21 (mean grayscale, same camera, fighters posed from the saved trace):

| Region | Retail | Unlit / flat | Irradiance |
| --- | --- | --- | --- |
| Foreground spectator A | 16 | 48 | 18 (scale 1) |
| Foreground spectator B | 21 | 53 | 22 (scale 1) |
| Blaze's jersey | 96 | 132 | 97 (scale 1.2) |
| Doc's jersey | 69 | 109 | 69 (scale 1.2) |

The crowd mesh has no normals, so each figure is shaded once by the irradiance toward where it faces. Fighter shading uses the same sampler with their skinned normals; `compare.mjs` renders both. The scales are fitted to this one frame.

## Environment events (pillars, speakers, bottles)

`environment.mjs` turns retail's stage-environment events into renderer inputs for a native match.

How retail does it (recovered from the SLUS-21004 disassembly):

- Fighter code (recompiled in the native kernel) decides that a move reached a stage object (`0x307250`) and queues the event with `0x192068(id, attacker, target, flag)`. The queue is two 16-byte records at `0x476e28`; `0xffffffff` is a free record.
- `id` indexes the 468-name table at `0x379f70` (`events.json`, extracted from the executable): `02A_1A`..`02A_10C` are 25..44. A pillar is three events (`1A` break1, `1B` break2, `1C` break3 plus its hidden weapon); the fighter code picks which. Bottle smash in hand is `02A_3` (right) and `02A_6` (left); speaker breaks are `02A_2A/2B/5A/5B`.
- The stage manager (vtable `0x191a00`) starts each queued event in one of two slots at `0x472014` and `0x192b28` steps it at 60 units per second; `0x1922b0` runs the `<environmentattack>` commands of that name from the stage XML (`geometry`, `particle`, `venueweapon`, `sound`, `weaponsound`, ...). A command's first field is its start frame, `-1` meaning now. The manager is not in the kernel, so the adapter plays its part.

```js
import { createEnvironment } from "./environment.mjs";
const names = (await (await fetch("port/scenery/events.json")).json()).names;
const env = createEnvironment(scenery.manifest, names);
// each frame, after match.tick(inputs):
env.update(match.memory);             // drain the retail queue (frees the records) and advance one frame
scenery.render({ viewProjection, ...env.state() });   // { props, weapons, hiddenWeapons }
for (const fx of env.effects()) play(fx);              // sounds, particles, light changes with frame and position
```

`env.trigger(nameOrId)` starts an event without the queue, `env.reset()` on rematch. `weapons[name]` is `false` (gone) or `{translate, rotate}` (moved); `hiddenWeapons` lists revealed pillar weapons; `render` accepts both.

Verified: `environment.test.mjs` plays the native match with a fixed pad script. At tick 3389 the retail code queues `02A_3` and the right bottle goes; at tick 7701 it queues `02A_1A` and the pillar shows `break1`, after `02A_6` at tick 5755.

Not recovered: the bottle's tumble (`V2WA_029_11_02A`, an EAGL animation bank) and the pillar weapon's drop are a plain fall (state marks `approximate`); the choice of 1A/1B/1C inside the fighter code is not read, only observed.

### Weapons in play (pickup, carry, break)

Retail keeps weapons in a manager (`0x133180` returns `0x472144` in a battle): 16 slots of 208 bytes from `+12`. A slot has the weapon type at `+4` (index in the sorted V2WP list, `-1` free; 52 is `V2WP_029A`, 22 is `V2WP_011D`), the holder at `+8` (`-1` resting, `0`/`1` carried by that fighter, `-2` in flight), the world matrix at `+12` (translation in the last row), the grip at `+76` (position) and `+88` (rotation, degrees) and the state at `+148` (1 in use, 2 resting, 3..5 breaking). `readWeaponSlots(memory, models)` reads them; `env.weaponSlots` is the live list.

- The Foundation starts with four slots: the two bottles (type 52, resting at the speaker stands) and two pillar weapons (type 22). The XML lists four pillar weapons and `setcount 2`, so only two exist in a match; here pillars A and C. `env.state()` marks the other two `false`.
- A fighter picks a bottle up by creating a new slot (the kernel does this itself): holder = the fighter, grip copied from `weapon.xml` (`fp`/`fr`, exactly `1.4,-0.3,-1.5` / `-180,-10,0` for the bottle), and the fighter's `W[slot]` record at `0x4c21a8 + 164*slot` points at it. The strike queues `02A_3`/`02A_6`, which deletes the bottle on the stand.
- Retail's per-frame weapon update (vtable method `0x1c33a0`, which builds the carried matrix from the hand bone) is not in the kernel. `carriedMatrix` rebuilds it as `0x1c11e8` does: grip rotation, grip position, then the carrier's hand (retail bone id 19, the right hand). The result goes out as `dynamicWeapons: [{model, matrix}]`, which `render` draws. The hand placement is not compared with a retail frame; the formula follows the disassembly.
- Weapons in flight (`holder -2`) and respawns are not drawn: retail computes their path in `0x1c33a0`.
- `scenery.json` now carries `stageWeapon` (the `<stageweapon>` block: drop list, weak/strong catch, durability steps, drop interval seconds, simultaneous limit, pass weights) and `droppedWeaponModels`, which `loadScenery` fetches.

## Venue hazards (subway train, Red Hook, Crow's Office)

`hazard.mjs` documents and drives the retail rules for venues 4 (125th Street Station), 7 (Red Hook) and 17 (Crow's Office); the header lists the recovered flags and routines.

- Knockouts: `0x30bb40` marks the loser with `0x10`/`0x4`/`0x20` and `G+448` with `8`/`4`/`0x10` in those venues only; the referee `0x2e6260` turns the mark into result type `0x100`/`0x80`/`0x200`. In the scripted match Red Hook marks `0x4` (loser in state 114); the other venues, and Red Hook with the other victim, take the generic `0x1`. What selects the branch is not isolated. Calling `0x30bb40` by hand sets the flags but does not end the round, so it is not a trigger.
- Subway train (verified, `hazard.test.mjs`): the train is the retail frame update `0x2e75e8`, so it runs on its own in the native kernel (`0x4c2178`: bit 0 live, 1 coming, 2 hits; first siren ~tick 975, hit at tick 1000). The consumer `0x2e78d0` flags a fighter in a hazard state or whose floor word at actor+932 (the ground height under them, from `0x2e1548`) is below -1: the track pit is -11, the platform 0. The flagged fighter goes to state 19, the referee ends the round with the other fighter winning at full health, and the loser's `+0x932` ends as `0x600` (same as a time-up loser) and the match flags `G+448` get `0x20`. `outcome().method` reports `"hazard"` from that flag (`port/battle/outcome.mjs`). Pad walking stops at the ring edge (|z| ~43), so the test puts the fighter over the pit (z -58) as a throw would. `createTrain(kernel).warn()/strike()` run the consumer directly. `fight.rematch()` resets it.

## Near crowd (not done)

`nearCrowd` slots (`crowd_act1/act2/stand1_*`) are full V2CM spectators. Recovered so far: the models decode with `port/fighters/retail.py` once its parent table knows the 13-bone crowd rig (`root, L_Leg1, L_Leg2, eff5, R_Leg1, R_Leg2, eff4, Chest, Head, R_Arm1, R_Arm2, L_Arm1, L_Arm2`); a person is several parts (`M1` upper body, `M2` legs, `M3`, `M4_nn` hair/hats) textured by one `cm_m`/`cm_f` skin atlas with clothing layers (`V2CM_M1_02..08.ssh`, one 8-bit layer plus eight `plNN` palettes) stomped onto it. The `animcr*.o` banks hold two objects per clip (`_s`, `_t`) and load into the offline sampler with `port/animation/extract.py`'s packer, but the channel-to-bone mapping is unresolved, so sampled poses do not fit the crowd skeleton.

## Subway train (venue 4)

`train.mjs`, `V2BG_04A/trains/`, `train.test.mjs`, `train-browser.mjs`.

- Rules and timing come from the native kernel (`0x2e75e8`; see `hazard.mjs`): phase `0x4c2174` runs -4 to 1.5 at 0.004 a frame; siren at -0.1 (tick 975 of the first cycle), hit at 0 (tick 1000), siren off at 1 (tick 1250), cycle ends at 1.5 (tick 1375). Later trains follow after a random wait.
- Models: `<subwaymatch>` in `V2BG_04A_O.xml` lists the cars `V2BG_04A_H..L` (5 models of one 181 unit car, 1,333 vertices, differing in one side texture), the track span (`width` 180) and four glow lights. They are skinned-microcode stage models (the weight table is sent once, the other five packets reuse it), decoded with the weapon path and shipped as `trains/*.skin.gz`, drawn by the weapon renderer as `dynamicWeapons`.
- The kernel passes the phase each frame to `0x193da0` -> `0x131b30`. That is **not** the game speed: it is the host side of the `TrainAmbience` sound (retail event `Amb_train`, bank `train`). It starts when the phase passes 0, ramps from -2 dB to full over the first quarter, stops at 1.5.
- Not recovered: retail moves the cars with the venue animation `V2BG_04A_H_A1`, which only holds the parked pose (x -500). The path is derived: head at the playfield edge (`width`/2) at the hit, tail out at phase 1. The car per cycle is the cycle count in the XML order. Which of the bank's five subsongs `Amb_train` plays is bank code, so the cycle number picks. The glow lights (`fx_trainF1..R2`, off by default) are emitted as `siren` effects; nothing draws particles yet.
- `createEnvironment(...)` follows the train: `state().dynamicWeapons` has the car; `effects()` has `{kind:"train", action: siren | audio | volume | hit}`. `createTrainAudio(audio, {fighters})` plays the sound and the `Train_Kill_Female/Male` scream (female for fighters whose retail grunt set is a Girl set). The viewer wires both.
- Controller-driven: a closed-loop pad script that walks both fighters to the platform edge and mashes buttons (`hazard.test.mjs`) puts a fighter in a retail hazard state or over the track bed; the first train ends the round at tick 1002 as `hazard`.
- `node port/scenery/train-browser.mjs` runs the real battle page headless (venue 4) and checks the car's path and the sound's start.
