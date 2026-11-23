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

## Near crowd (not done)

`nearCrowd` slots (`crowd_act1/act2/stand1_*`) are full V2CM spectators. Recovered so far: the models decode with `port/fighters/retail.py` once its parent table knows the 13-bone crowd rig (`root, L_Leg1, L_Leg2, eff5, R_Leg1, R_Leg2, eff4, Chest, Head, R_Arm1, R_Arm2, L_Arm1, L_Arm2`); a person is several parts (`M1` upper body, `M2` legs, `M3`, `M4_nn` hair/hats) textured by one `cm_m`/`cm_f` skin atlas with clothing layers (`V2CM_M1_02..08.ssh`, one 8-bit layer plus eight `plNN` palettes) stomped onto it. The `animcr*.o` banks hold two objects per clip (`_s`, `_t`) and load into the offline sampler with `port/animation/extract.py`'s packer, but the channel-to-bone mapping is unresolved, so sampled poses do not fit the crowd skeleton.
