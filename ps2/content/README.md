# Battle unlocks: US PS2 (SLUS-21004)

Every fighter and venue in Battle mode is unlocked deterministically, with no save file. The game's own unlock sets are filled whenever a screen asks about unlocks. All data comes from the retail disc (Redump SHA-1 `5eda39dfd703804c8734b91bd23039f642317837`; `SLUS_210.04` SHA-256 `4e65bf29…b23b2`).

| File | What it is |
| --- | --- |
| `inventory.json` | Every unlockable fighter (75) and venue (24), with its live handle, cost and its FIGHTER.XML or VENUE.XML entry |
| `unlock-disc-patch.json` | The patch as ISO byte ranges inside `SLUS_210.04` (`def-jam-ps2-battle-patch/1`). The web launcher already merges this with the Battle overlay. |
| `overlay.mjs` | Standalone read-time overlay for those ranges. It checks each range's retail SHA-256 first. |
| `unlock-patch.json` / `GameConfig.xml` | The same 121 EE words, as a manifest and as a Play! `GameConfig.xml` entry (alternative integration) |
| `unlock-verification.json` | What the live runtime showed (see below) |
| `unlocks.py`, `sod.py` | Rebuild everything from the ISO; `verify` fails if a checked-in file is stale |
| `e2e/` | Headless checks: `check-unlocks.mjs` (production launcher), `harness.mjs`/`explore.mjs` (bare Play! page with EE RAM reads) |

```sh
python3 ps2/content/unlocks.py verify private/ps2/reference.iso   # or: patch, to regenerate
python3 -m unittest discover -s ps2/content/tests
node --test ps2/content/tests/overlay.test.mjs
node ps2/content/e2e/check-unlocks.mjs all --record              # needs `npm start`; headless
```

## Where the inventory comes from

`ASSETS/DJV2.SOD` is EA's SODB object database. Its DATA chunk lists 28 classes. Class 7 (`0x4CE5B1B2`) has 75 fighter records and class 23 (`0xD7DCA628`) has 24 venue records. Strings resolve through the STRT chunk. A live handle is `(class << 24) | index`, where the index is the record's position in the class's primary index. The resolver at `0x001C6444` indexes that table's record column, which is built by `0x001C5BB8`. Bit 23 is a flag that every compare masks off with `0xFF7FFFFF`.

- **Fighters:** matched to FIGHTER.XML by model name; all 75 match uniquely. Word 13 (`listed`) is 0 for Blaze 2, Blaze 3, D-Mob 2, D-Mob 3, Sticky 2 and the E3 Hero placeholder.
- **Venues:** matched to VENUE.XML by `coreID` + BG file; all 24 match. The five arenas VENUE.XML has but the SOD does not (cut 08A/18A/20B, cinema-only 16A, 12B, viewer) are listed in `venueXmlArenasNotInSod`.

## How the game gates them, and the patch

The profile object is registry slot `0x18` of the table at `0x003FDAA0`, so `R = [[0x003FDB00] + 4]`. On the live runtime it sits at `0x008EAB00`. The profile constructor at `0x001031B8` lays out two sorted handle sets:

| Set | Capacity | Count | Count mirror | Data |
| --- | --- | --- | --- | --- |
| Venues | `R+0x0C` (30) | `R+0x10` | `R+0x14` → | `R+0x18` → inline at body+`0x1268` |
| Fighters | `R+0x20` (80) | `R+0x24` | `R+0x28` → | `R+0x2C` → inline at body+`0x12E0` |

`BuyCharacter` (`0x0014BFB0`) and `BuyVenue` (`0x0014C970`) are the only retail writers. Each subtracts the cost at `R+0x50` and inserts one handle.

The patch repoints 11 script-binding pointers in `.rodata` (the pointer-to-member's code word):

- the shop screen's `GetGlobalCharUnlockInfo`, `GetCharCostInfo`, `GetCharacterList`, `BuyCharacter`, `GetGlobalVenueUnlockInfo`, `GetVenueCostInfo`, `GetVenueList` and `BuyVenue`;
- the Battle setup screen's `ResetFighterList` (`0x003B3DB8`) and `ResetVenueList` (`0x003B3E20`);
- the story `ResetVenueList` (`0x003BB618`).

Each points at a 3-word wrapper that puts the real handler in `$t9` and jumps to one fill routine. The routine has 75 words and lives in the old `BuyCharacter` body; the wrappers live in the `BuyVenue` body. The routine:

1. Reads `R` from the registry.
2. Checks capacity and count against the retail layout, and does nothing if they don't fit.
3. Merges every class 7 and class 23 handle into the sets, keeping existing entries and their flag bit.
4. Writes the count and its mirror.
5. Tail-jumps to `$t9` with `$a0`–`$a3` untouched.

`Buy*` become "fill, return 0". Every target word is checked first: the binding slots must hold the retail handlers, and 20 signature words cover the constructor, binder and handlers.

Integration options (the root agent owns the runtime):

- **Disc overlay** (current): `web/runtime.mjs` concatenates `unlock-disc-patch.json` into the Battle overlay, and `tools/serve.mjs` serves it. This works with any emulator.
- **Play! GameConfig:** before `initVm`, write `GameConfig.xml` to `/usr/local/share/GameConfig.xml` in MEMFS (`FORCE_FILESYSTEM`). Play! applies `<Patch>` words when the executable loads (`PS2OS.cpp` `OnExecutableChange`). If upstream entries are ever bundled, merge the `<GameConfig>` node into them.

## Verified on the live runtime (`unlock-verification.json`)

- **Retail starting set:** 12 fighters and 4 venues. Fighters: Meca, NORE, Nyne, Doc, Rollins, Xzibit, Blaze, Havoc, Magic, Banner, Baxter, Santos. Venues: Foundation, Terrordome, The Pit, Power Plant.
- **At CHOOSE FIGHTER:** fighters 75/80 and venues 24/30, with both count mirrors updated and no handle missing.
- **Battle fighter list:** the buffer at `0x004E2D28` holds 74 fighters. Every SOD fighter is there except the E3 Hero placeholder.
- **UI grid:** 69 fighters, no padlocks: 12 rows × 6, with Suspect, Starks and Stingray in the last row. The five story variants with `listed`=0 are in the list but not in the grid. This is the "UI selectable" count.
- **Venue list:** the list CHOOSE VENUE is built from holds all 24 venues. The map pins were not walked one by one.
- **Paid picks:** Erick Sermon (cost 50) and Hunt's Point Scrapyard (cost 75) were selected and the match ran at the Scrapyard. A Crow (cost 250) vs Blaze match also ran. None of these are in the retail starting set. Screens are in `private/ps2-content/unlock-check/proof/`.

The grid count comes from walking the cursor, which is timing-sensitive: dropped pad presses make it undercount. The 69 figure is backed by the list-order alignment above.

Out of scope: locked Battle match types (padlocks on the match-type screen) and story, shop or bling rewards.

The CodeBreaker v7 codes on almarsguides.com ("Unlock All Fighters" and "Unlock All Venues", NTSC-U) decrypt with cb2util's `cb7_decrypt_code` to the same layout. They write count `0x4B` at `0x008EAB24` and `0x18` at `0x008EAB10`, then `0x07000000+i` / `0x17000000+i` at body+`0x12E0` / body+`0x1268`. The codes write fixed heap addresses every frame and skip the count mirrors; this patch does neither.
