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

Not decoded: the 30 `nearCrowd` characters (full V2CM spectators), weapon/bottle models (`V2WP.VIV`), prop colour morphs (`V2BG_02A_A1.o`…), the per-instance retail animation phase and the character spherical-harmonic lighting (`V2BG02A*.irr`).

## Renderer

`scenery.mjs`: `loadScenery(venue)` then `createSceneryRenderer(gl, scenery)` → `{ render({ viewProjection, props, tick, excited, crowd }), dispose }`. `viewProjection` is `battle/camera.mjs`'s matrix.

## Proof

`compare.mjs` replays the retail camera over a saved match trace and renders the same view as an existing capture. Against `run-BjNMn0/21-fight-ready-host.png` (letterbox viewport `2,16,840,588`), grayscale correlation at zero shift is 0.81 and 0.79 for the two speaker stacks and 0.57 for the work light. Frame 23 (mid-fight) does not match `foundationCamera()`: the retail camera is further back at that moment.
