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

Not decoded: the `nearCrowd` characters (modular V2CM people with their `animcr` clips; see below), weapon/bottle models (`V2WP.VIV`), prop colour morphs (`V2BG_02A_A1.o`…), the per-instance retail animation phase, instance variant 5, and the character spherical-harmonic lighting (`V2BG02A*.irr`) that makes the retail crowd darker toward the camera.

## Near crowd (not done)

`nearCrowd` slots (`crowd_act1/act2/stand1_*`) are full V2CM spectators. Recovered so far: the models decode with `port/fighters/retail.py` once its parent table knows the 13-bone crowd rig (`root, L_Leg1, L_Leg2, eff5, R_Leg1, R_Leg2, eff4, Chest, Head, R_Arm1, R_Arm2, L_Arm1, L_Arm2`); a person is several parts (`M1` upper body, `M2` legs, `M3`, `M4_nn` hair/hats) textured by one `cm_m`/`cm_f` skin atlas with clothing layers (`V2CM_M1_02..08.ssh`, one 8-bit layer plus eight `plNN` palettes) stomped onto it. The `animcr*.o` banks hold two objects per clip (`_s`, `_t`) and load into the offline sampler with `port/animation/extract.py`'s packer, but the channel-to-bone mapping is unresolved, so sampled poses do not fit the crowd skeleton.
