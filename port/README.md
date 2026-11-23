# Native Battle port

The production URL opens the native one-on-one match. This directory contains the browser implementation recovered from the US PS2 release, SLUS-21004.

The first match used for comparison is Blaze versus Doc at The Foundation. The reference harness selects both fighters, loads the venue, sends inputs from two players and captures the resulting fight. [Reference match harness](../verification/README.md)

- [Battle setup](battle/setup.mjs) resolves retail fighter and venue handles and places each slot at its venue-specific starting coordinates. [Retail coordinate export](battle/lineups.json)
- [Fighter data](assets/combat.mjs) exposes the retail statistics, style masks and assigned Blazin’ moves by fighter handle.
- [Combat routines](combat/combat.mjs) advance fighter momentum and apply an already-scaled hit delta. The differential test executes the corresponding instructions from the verified retail executable. [Combat tests](combat/combat.test.mjs)
- [Fighter renderer](render/export_fighters.py) packages 75 textured fighter bodies and their skeleton weights for direct GPU skinning. Select two fighters in the viewer to inspect them at their retail starting positions. Blaze and Doc also have captured idle animations.
- [Venue collision](collision/contact.mjs) reads each arena’s original CLLI planes and computes face and corner contacts. The differential test checks depth, direction and result type against the PS2 instructions.
- [Motion lookup](motion/library.mjs) resolves common and fighter-specific action numbers using all 141 retail move tables. The reference test compares both actors against 298 consecutive VBlanks of Blaze versus Doc, including their strikes and reactions.
- [Venue exporter](geometry/venues.py) follows the retail draw lists and decodes indexed SHPS textures for all 24 Battle base meshes. The [native venue viewer](https://zheruel.github.io/def-jam-fight-for-ny/port/viewer/index.html) loads one selected venue and draws its original triangles, UVs and vertex colors directly in WebGL. The match renderer draws recovered props in 21 venues and animated background spectators in 11. [Scenery coverage by venue](scenery/README.md)

Select any two of the 75 fighters and any of the 24 venues. The chosen pair loads its original move banks, fighter profiles and textures. The game uses the original Battle update and EAGL motion sampler compiled to WebAssembly. The controls panel lists the local keyboard and gamepad mappings. Choose Host match and share Room invite for online play. The guest receives video and audio. [Play Battle](https://zheruel.github.io/def-jam-fight-for-ny/)

The verification suite compares 460 ticks of a Blaze–Doc fight to PS2 reference data. With live sampling, both actors match every retail state and action, each scores 250 and the largest position difference is 0.646 game units. A separate run drove all 75 fighters in both slots with the same inputs. Every match recorded a scoring hit. A headless Chrome run at 941 × 705 averaged 60.0 rendered FPS with an 18.0 ms 95th-percentile frame interval. All 24 venues initialize their collision and starting positions. All 24 venues play their original ambient audio. The host loads the selected venue’s loop after interaction and sends the mix to the guest. The retail bruise tiles update the face atlas for the 67 fighter records that supply them. A 24,000-tick endurance test reached both damage stages and 129 distinct actions with the retail referee running. Blaze and Doc can each win a full-health match by KO. The referee also resolves time limits by score or draw according to the match rules. A rematch restores the starting match memory. The guest hears the same mix of venue ambience and frame-timed attack, impact and movement cues as the host. The tag timing and cue banks come from the PS2 game. The choice of sample within a bank uses a seeded generator. Blaze and Doc both earn and land their distinct Blazin’ moves from full health, with synchronized attacker and defender motion and the retail score award. All 164 signature animation resources are checked separately. Stage events break Foundation bottles and change a pillar mesh on actual fighter contact. Venue-specific wins, additional environmental interactions, foreground spectators, music and additional game modes still require parity checks.

The camera runs the retail Battle framing routine and uses each stage’s field of view, pitch, offset and height. Replaying captured fighter coordinates across 436 PS2 frames produced a mean eye and target error of 0.55 game units and a maximum of 5.32. The renderer uses the original 640 × 448 picture area and caps the drawing buffer at twice the original dimensions. On 120 and 144 Hz displays, it submits one scene for each new 60 Hz simulation tick.

Fighters cast shadows from each venue’s original shadow lights. The light blend and horizontal projection follow retail routines 0x16a4a8 and 0x116ac8. Both flattened model matrices agree with the Foundation capture within 0.001. The flat receiver height and blended colour have been checked visually at Foundation. The crowd and fighters use the venue’s irradiance probes. The probe weights follow the retail routine. The shader coefficient order, the first light set and fighter brightness are calibrated against one Foundation frame. [Scene coverage and image comparisons](scenery/README.md)

## Verify

Run `npm test` for the JavaScript checks and `npm run test:native-outcome` for referee decisions and rematches. Run `npm run test:native-battle` for the PS2 input comparison, native browser frame timing and a two-browser video and input test. Run `npm run test:native-animation` to sample the 709 common clips and 17,196 fighter clip and slot combinations. Run `node verification/native-roster.mjs --endurance` for the longer fight and `npm run test:native-damage` to compare both damage tiles for Blaze against their WebGL output. After `npm run setup`, run `npm run test:native-venue` for a headless WebGL render and camera test. The check also verifies that viewing the mesh fetches zero emulator files or disc blocks.

To verify all 24 retail venue entries against a local source disc, run these commands.

```sh
python3 port/render/export_fighters.py private/ps2/reference.iso --check
python3 port/collision/extract.py private/ps2/reference.iso --check
python3 port/motion/extract.py private/ps2/reference.iso --check
python3 port/battle/extract_lineups.py private/ps2/reference.iso --check
python3 port/battle/extract_camera.py private/ps2/reference.iso --check
python3 port/geometry/venues.py private/ps2/reference.iso --check
```

The lineup exporter checks the SHA-256 of `ASSETS/GAMECORE.XML` before reading its start-position table. The formation names, slot order and coordinate pairs come directly from that table. A missing formation remains unavailable.
