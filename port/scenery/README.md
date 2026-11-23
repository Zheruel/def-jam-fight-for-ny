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
| V2BG_17A | Gun Hill Garage | 5 (5 meshes) + 2 cars | 3 (car shadows, a flat light sprite) | - | 30 |
| V2BG_19A | The Terrordome | 8 (8 meshes) | 1 | 60 | 30 |
| V2BG_20A | The Limit | 19 (23 meshes) | 2 | - | 35 |
| V2BG_21A | Babylon | 6 (8 meshes) | 3 | - | 30 |
| V2BG_22A | Club DTP | 5 (5 meshes) | 1 | 100 | 28 |
| V2BG_22B | 7th Heaven | 5 (5 meshes) | 1 | 100 | 28 |
| V2BG_23A | Red Room | 8 (8 meshes) | 2 | 100 | 29 |

Undecoded props are skinned, bone-animated models (`*_Skin` microcode, e.g. the Gun Hill Garage car shadows `V2SD_17A_*`, planar-shadow skins) or use a VIF layout `port/geometry/venues.py` does not handle; they are listed by name in `scenery.json` `undecodedProps`.

Not rendered: the `nearCrowd` characters (modular V2CM people; the rig and live poses are recovered, see below), prop colour morphs (`V2BG_02A_A1.o`…), the per-instance retail animation phase, instance variant 5, the rim and shadow light terms in `.irr`, and the engine's ambient mix into the first coefficient.

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

## Near crowd (rig, retail poses, skinned render in 20 venues)

`nearCrowd` slots (`crowd_act1/act2_*`, 24 spectators plus two more; `stand1_*` are not posed) are full V2CM people, built from modular parts (`M1` torso and arms, `M2` legs, `M3`, `M4_nn` head and hair, `M6` shoes; clothing layers `V2CM_M1_02..08.ssh`, one 8-bit layer plus eight `plNN` palettes, stomped onto the `cm_m`/`cm_f` atlas). `crowd_pose.py` and `test_crowd_pose.py` hold what is proven:

- **One rig for every part.** All 38 decodable V2CM models have the same 13 bones in the same order (`root, L_Leg1, L_Leg2, eff5, R_Leg1, R_Leg2, eff4, Chest, Head, R_Arm1, R_Arm2, L_Arm1, L_Arm2`) and identical bind matrices.
- **Hierarchy** (not stored in the models): `root` is the parent of `L_Leg1`, `R_Leg1`, `eff4`, `eff5` and `Chest`; `L_Leg2`<`L_Leg1`, `R_Leg2`<`R_Leg1`; `Head`, `R_Arm1`, `L_Arm1`<`Chest`; `R_Arm2`<`R_Arm1`, `L_Arm2`<`L_Arm1`. Composing the engine's bind buffer under it reproduces every model's bind matrices with zero error.
- **Live matrix palette.** In the Foundation RAM captures each spectator keeps three 13 x 48 byte buffers (current, previous, bind reference; `scale xyz 1, quat xyzw, trans xyz 1`, local to the parent, the layout of `port/fighters/pose.mjs`) 0x280 apart: record `crowd_*` at 0x571100 (stride 0x1c0) -> `u32[record+0x8c]` object -> `u32[object+0x14c]`. 30 instances (the record scan runs 0x571000-0x575000: the one-on-one image holds all 30, the four-player ones 26), all off the bind pose and changing from frame to frame (`foundation/crowd-poses.json`: the one-on-one image and three `four-start` frames).
- **Not a T-pose.** `python3 port/scenery/crowd_pose.py RAM.bin --png out.png` skins the modular parts (M1 + M2 + M4) with the live buffers: arms by the sides, a lean, one spectator cheering with both arms up, another waving, against the bind T-pose.
- **Still open.** The poses are snapshots, not clips. The animation bank `animcr0.o` (64 clips, `_s`/`_t` objects per clip) is resident in the Foundation image (its `.data` matches at `0x19b46f4`), and the engine writes each spectator's local pose from animation objects of vtable `0x3a7fa0` (blend/sample nodes `0x1f59a8`, `0x1f52b0`) that also own the pose pointers; the entry the fighters use (`0x132b48` -> `0x1a2f38`) takes a character with the fighter layout (`+0xae54` flags, `+0x30`/`+0x9f0` skeleton), which these objects do not have (their pose pointers sit at `+0x14c`). Which clip each spectator plays and its time, the spectator's part and skin choice and the texture layering are not decoded; the `_s`/`_t` objects' channel list does not name bones (their ids run to 0x7e, more than 13 bones x 4).

### Spectators in every venue with retail positions

`crowd_bank.py` (reads `crowd-poses.json`, `people/captures.json`, the retail recording) writes the shared `people/poses.bin.gz` and `<venue>/people.json` for the 20 venues that place near-crowd people (`scenery.json` has `"people": true`; `index.json` counts them). `people.py` writes `people/classes/<parts>.skin.gz` (DJF1: the five V2CM parts of a crowd class on the shared rig with inverse bind matrices; the part sets come from the class records `u32[record+0x84]`, part ELFs at +0x294, `crowd_pose.class_parts`), `people/outfits/<base>~<layer>-<NN>-<palette>.png` (a part's skin sheet with its clothing layer stomped on, cropped) and `people/layers.json`. `crowd_capture.py` reads the RAM captures (Foundation; Club Murder, Gun Hill, Dragon House from `private/verification/special`). `people.mjs` blends track frames (nlerp), builds each skin palette (`inverseBind x world`, row-vector convention, uploaded as is) and `scenery.mjs` draws it with a 13-bone skin shader and the irradiance lighting. Tests: `people.test.mjs`, `people-browser.mjs` (real page, files fetched, frame changes, frame rate with and without spectators).

- **One skin sheet per part.** Every part's UVs address a shared 256x256 sheet: torso (digit 1) and head (3) the whole sheet, legs (2) and shoes (6) its lower-left quarter, the head accessory/hair (4) the upper-right quarter. The clothing layers (`V2CM_<slot>_<NN>.ssh`) land at (0,0) for the torso, (43,128) legs, (128,0) accessory, (0,128) shoes (read off the parts' UV bounds and the layers' sizes); the atlas is the slot's `V2CM_<slot>.ssh` sheet (M6/B6 have none) with the layer stomped on, cropped to what the part's UVs use, and the UVs are rewritten into the crop.
- **Orientation.** `nearCrowd` yaw is the model's own (spectators face the ring: compare `private/verification/special/demolition/051-fight-start.png`, where the foreground spectators show their backs and caps).
- **Families.** Male `M1 M2 M4 M6 M3`, female `F1 F2 F4 F6 F3`, heavy `B1 B2 M4 B6 M3` (the heavy B1/B6 wear the male layers; B6's shoes use M6's). An `M5/F5` extra in some classes has no texture and is not drawn.
- **Motion** is the retail recording (`verification/capture-crowd.mjs`): 30 Foundation spectators, 1800 distinct frames, no gaps, looped (the last 60 ticks folded into the first), every second tick kept, int16-quantised (2 MB). The retail clips are shared by every spectator type: each pose in the Club Murder, Gun Hill and Dragon House captures (stand1 included) matches a recorded frame to within 0.002-0.2 squared quaternion distance, so every spectator can play any track and the captured spectators start at their matching recorded frame (`phase`, in game ticks). Which clip a given spectator plays in retail is random, so tracks are assigned per name.
- **Classes**: the Foundation, Club Murder, Gun Hill and Dragon House use the part sets seen in their captures (and the instance-to-class assignment); the other venues draw the stage's `crowdGroup.normal` sets from the sets seen, by the stage's sex ratio and `class[0]` as the heavy share (a guess). Class and outfit are random per match in the retail game, so any draw is authentic in kind.
- **Palettes** are not decoded: record words `+0x154/+0x158/+0x164/+0x1a4` (or the name for the venues without a capture) pick them as a stand-in (`people.outfit`).
- **Left to the far crowd**: seated, dancing and gym spectators (`sit*`, `dancer*`, `gym*`), whose clips were never recorded. `act3`, `act4`, `stand2`, `stand4` are assumed to share the standing clips.
- Coverage: 20 venues, 14 to 35 spectators each (the Foundation and Club Murder, Gun Hill, The Pit and Club 357 draw all their positions; the Gauntlet, Club DTP and 7th Heaven lose their seated rows).

## Stage particles (JDI, all 24 venues) and crowd occlusion

`particles.py` reads each stage's `V2BG_<id>.jdi` and writes `<venue>/particles.json` (every effect's decoded parameters, `index.json` counts them) and `particles.png` (the stage's 256 x 256 sprite sheet). `particles.mjs` simulates and draws them as camera-facing sprites (additive for blend 1 and flames, alpha otherwise, depth-tested, no depth writes); `scenery.mjs` loads and draws them last in `render()`. Wiring: `environment.state()` returns `particleEvents` (the stage XML `<particle>` events since the last frame: name, position, rotation), `fire` (Red Hook only, from the retail fire clock) and `sight` (fighter positions); the subway lights come from the train car. No change to the viewer.

| | |
|---|---|
| **Verified** | the JDI layout (every file parses the same way); the sprite sheet; the colours of each effect (start/end RGBA at +0x44/+0x4c: the train's white head lights `247 255 251` and red tail lights `229 0 1`, the fobj flames' orange `216 153 63`); each effect's tile list (u, v, size at +0xc8/+0xcc); the Inferno's fire clock and radius/intensity formulas (retail 0x2dea90: the clock gains 1.2 a frame, full until 7200, then dying over 4500; radius `37 + 20 x intensity`); the lights' car-local attachment points (world = car matrix x point). |
| **Inferred (tuned by eye)** | everything that moves a sprite: speeds, sizes, counts, gravity, lifetimes' pacing, blend modes beyond additive/alpha; the glass shard look (no retail frame of the sprites); the Inferno flame placement and brightness (Red Hook's own flame effect `fx_fireG2` is not in the stage's JDI, so the flame look uses `fx_plfire`/`fx_fobj` sprites; the ring of flames at the fire radius is placed against `private/verification/special/inferno/050-fight-start.png`); the light sprite size. |

The Inferno fire is drawn whenever Red Hook is loaded, because the native page does not set the backend match type 7 (the kernel's fire clock runs on the venue alone).

**Crowd occlusion** (`occlusion.mjs`): retail has no rule for it (every crowd record has alpha 1.0, even a spectator 1.6 units from the Gun Hill camera; the crowd update at 0x17dfa0 only turns heads toward the nearest fighter within 25 units), and its picture shows front-row backs at the fight start. So the port only fades what covers a fighter: a spectator (or an instanced crowd figure) whose body passes within 3.5..7 units of the camera's sight line to a fighter (stopping 8 short of him), or that is within 9..14 of the eye, is dithered out over a few frames. No retail Foundation, Cage, Gun Hill or Dragon House start or later frame hides anyone.

## Subway train (venue 4)

`train.mjs`, `V2BG_04A/trains/`, `train.test.mjs`, `train-browser.mjs`.

- Rules and timing come from the native kernel (`0x2e75e8`; see `hazard.mjs`): phase `0x4c2174` runs -4 to 1.5 at 0.004 a frame; siren at -0.1 (tick 975 of the first cycle), hit at 0 (tick 1000), siren off at 1 (tick 1250), cycle ends at 1.5 (tick 1375). Later trains follow after a random wait.
- Models: `<subwaymatch>` in `V2BG_04A_O.xml` lists the cars `V2BG_04A_H..L` (5 models of one 181 unit car, 1,333 vertices, differing in one side texture), the track span (`width` 180) and four glow lights. They are skinned-microcode stage models (the weight table is sent once, the other five packets reuse it), decoded with the weapon path and shipped as `trains/*.skin.gz`, drawn by the weapon renderer as `dynamicWeapons`.
- The kernel passes the phase each frame to `0x193da0` -> `0x131b30`. That is **not** the game speed: it is the host side of the `TrainAmbience` sound (retail event `Amb_train`, bank `train`). It starts when the phase passes 0, ramps from -2 dB to full over the first quarter, stops at 1.5.
- Not recovered: retail moves the cars with the venue animation `V2BG_04A_H_A1`, which only holds the parked pose (x -500). The path is derived: head at the playfield edge (`width`/2) at the hit, tail out at phase 1. The car per cycle is the cycle count in the XML order. Which of the bank's five subsongs `Amb_train` plays is bank code, so the cycle number picks. The glow lights (`fx_trainF1..R2`, off by default) are emitted as `siren` effects; nothing draws particles yet.
- `createEnvironment(...)` follows the train: `state().dynamicWeapons` has the car; `effects()` has `{kind:"train", action: siren | audio | volume | hit}`. `createTrainAudio(audio, {fighters})` plays the sound and the `Train_Kill_Female/Male` scream (female for fighters whose retail grunt set is a Girl set). The viewer wires both.
- Controller-driven: a closed-loop pad script that walks both fighters to the platform edge and mashes buttons (`hazard.test.mjs`) puts a fighter in a retail hazard state or over the track bed; the first train ends the round at tick 1002 as `hazard`.
- `node port/scenery/train-browser.mjs` runs the real battle page headless (venue 4) and checks the car's path and the sound's start.

## Gun Hill Garage cars (`V2BG_17A/cars/`)

`<demolitionmatch>` in `V2BG_17A_O.xml` lists two car containers: the left car `V2BG_17A_B` (24 panels `B_A`..`B_X`, `17A_1`..`13`, `27`) and the right car `V2BG_17A_A` (22 panels, `14`..`26`, `28`). Each ships as one DJF1 mesh, `cars/<container>.skin.gz`, drawn unskinned in car space with the weapon shader (irradiance-lit):

- The container model is the body without its breakable panels. Its batches carry no `object`.
- A panel's model stores its damage states as consecutive display-list blocks that each open with the skin microcode relocation: `base`, `break1`..`break3`, in the order of its `<geometry>` names. A panel drawn with two skin microcodes lists the blocks of each microcode in turn; state *k* is the *k*-th block of every group. A block draws one or more packets, each with a `SHAPENAME` material. That mapping (block → part → shape) is the display map, and it is stored as batches `{object, state, shape, first, count}`.
- `A_V` and `B_X` (the inner windscreen pieces) have one block only. Environment attacks hide them with state `null`. The window attacks `17A_5D`, `6C` and `21D` ask for `break4`, which has no mesh; both are valid states that draw nothing (the fourth stage is the glass gone: inferred, no retail frame yet).
- `manifest.cars[].objects[]` has `name`, `states` (the `<geometry>` names), `modelled` (those with a mesh) and `hidden` (`null`, `break4`). `environment.mjs` takes these panels as props, so `17A_3A..C` drive `V2BG_17A_B_P` through `break1`..`break3`. `render({props})` picks the state per panel.
- **Placement is approximate.** The stage XML places no car. The glass and headlight particle emitters in the environment attacks have world positions, and the panels they break have known centres in car space. A yaw and translation fitted to those anchors puts the left car at `(-51, 0, -44.6)` with rotate Y -30 and the right at `(47.9, 0, -43.4)` with rotate Y -150. The residual is at most 1.7 units, the precision of the hand-placed emitters. `test_extract.py` checks the anchors. A retail frame of Gun Hill is needed to tighten it.
- Not decoded: the car shadows `V2SD_17A_A/B` (planar-shadow skins) and `V2BG_17A_C` (a 9.6 x 8 flat animated sprite).

`node --test port/scenery/cars.test.mjs` checks the mesh batches, every attack's panel and state, the event-driven states and the floor contact.
