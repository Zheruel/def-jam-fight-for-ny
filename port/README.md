# Native Battle port

The production URL currently runs the PS2 reference player. This directory contains the browser implementation recovered from the US PS2 release, SLUS-21004.

The first match used for comparison is Blaze versus Doc at The Foundation. The reference harness selects both fighters, loads the venue, sends inputs from two players and captures the resulting fight. [Reference match harness](../verification/README.md)

- [Battle setup](battle/setup.mjs) resolves retail fighter and venue handles and places each slot at its venue-specific starting coordinates. [Retail coordinate export](battle/lineups.json)
- [Fighter data](assets/combat.mjs) exposes the retail statistics, style masks and assigned Blazin’ moves by fighter handle.
- [Combat routines](combat/combat.mjs) advance fighter momentum and apply an already-scaled hit delta. The differential test executes the corresponding instructions from the verified retail executable. [Combat tests](combat/combat.test.mjs)
- [Motion lookup](motion/library.mjs) resolves common and fighter-specific action numbers using all 141 retail move tables. The reference test compares both actors against 298 consecutive VBlanks of Blaze versus Doc, including their strikes and reactions.
- [Venue exporter](geometry/venues.py) follows the retail draw lists and decodes indexed SHPS textures for all 24 Battle base meshes. The [native venue viewer](https://zheruel.github.io/def-jam-fight-for-ny/port/viewer/index.html) loads one selected venue and draws its original triangles, UVs and vertex colors directly in WebGL. Animated props, crowds, environmental reflections and retail post-processing still need implementation.

The native build has no playable match yet. Fighter animation, move dispatch, collision, the remaining combat rules and the complete match loop still need implementation and comparison to retail. Frame rate for native combat can be measured once those systems run together.

## Verify

Run `npm test` for the JavaScript checks. After `npm run setup`, run `npm run test:native-venue` for a headless WebGL render and camera test. The check also verifies that viewing the mesh fetches zero emulator files or disc blocks.

To verify all 24 retail venue entries against a local source disc, run these commands.

```sh
python3 port/motion/extract.py private/ps2/reference.iso --check
python3 port/battle/extract_lineups.py private/ps2/reference.iso --check
python3 port/geometry/venues.py private/ps2/reference.iso --check
```

The lineup exporter checks the SHA-256 of `ASSETS/GAMECORE.XML` before reading its start-position table. The formation names, slot order and coordinate pairs come directly from that table. A missing formation remains unavailable.
