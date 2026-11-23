# Battle-only boot (PS2, SLUS-21004)

Makes the retail US disc a Battle-only game: **Start** on the title opens *Battle › Choose match type*, and **Back** there returns to the title. The main menu, and so Story, Beatbox, Extras and the other modes, can't be reached. Every offset was checked against the retail disc (ISO SHA-1 `5eda39df…`, `SLUS_210.04` SHA-256 `4e65bf29…`).

## Patches

| id | file | change |
|---|---|---|
| `title-requests-battle` | `SCREENS/SCREENS.VIV` › `intMain/prestart.big` | The title's ActionScript calls `transitionStart("battle/cmtype.swf")` instead of `"intMain/mainMenu.swf"` |
| `feflow-title-to-battle` | `SCREENS/FEFLOW.XML` @867 | `intMain/preStart`'s only transition leads to `battle/cmtype` |
| `match-types-start-battle-mode` | `SLUS_210.04` vaddr `0x138108` | `Game.ResetMatchTypeList` first calls the retail `Game.StartBattleMode` (`0x135A48`), as the main menu's Battle tile does |
| `match-type-back-to-title` | `SCREENS.VIV` › `battle/cmtype.big` | Back requests `intMain/preStart.swf` instead of the main menu |
| `feflow-match-type-back-to-title` | `FEFLOW.XML` @3471 | `battle/cmtype` transition 3 leads to `intMain/preStart` |

Screen transitions are looked up by name in `FEFLOW.XML`, so each redirect changes both the screen's request and the flow entry. `StartBattleMode` sets the game mode (`game+0x350 = 1`) and queues the battle run module (`game+0x398`). Without it, the match-loading card falls back to the title. The ELF change reuses the first of two identical profile lookups in `ResetMatchTypeList` (`0x101EF8(0x3FDAA0, 0x18)`), so no code cave is needed.

The screen edits are same-size re-encodings of RefPack streams (`refpack.py`). Only the commands whose output changes are rewritten, and the archive keeps its exact size. Decompressing the result gives the retail screen with only that string changed. The patched entries' SHA-256 values are pinned, so the re-encoding is deterministic.

The committed manifest contains the replacement bytes and the expected hashes of the corresponding retail ranges. The generator rederives it from the reference copy.

## Commands

```sh
python3 ps2/battle/battle_patch.py verify   [iso]      # retail | patched | mixed (exit 1 for other discs)
python3 ps2/battle/battle_patch.py manifest [iso]      # -> ps2/battle/battle-patch.json
python3 ps2/battle/battle_patch.py build iso out.iso   # derived ISO + out.iso.json
```

The ISO defaults to `private/ps2/reference.iso`. `build` makes an APFS copy-on-write clone (`cp -c`, falling back to a full copy), writes the ranges and re-verifies them. It never opens the retail ISO for writing.

## Integration API

`battle-patch.json` (`format: "def-jam-ps2-battle-patch/1"`) lists ranges sorted by `isoOffset`, each with `id`, `file`, `fileOffset`, `isoOffset`, `originalSha256`, `replacement` (hex) and `description`.

```js
import { withBattlePatch, httpDisc, parseManifest, applyRanges } from '/ps2/battle/overlay.mjs';
const source = await withBattlePatch(disc, manifest, { onPatchedRead(offset, length) {} });
// disc / source: { size, read(offset, length) -> Promise<Uint8Array> }
```

- `withBattlePatch` checks the disc size and hashes each original range before returning. It rejects other discs, and images that are already patched (boot those directly).
- Reads return copies with the patched bytes spliced in. The source's buffers are never mutated.
- Ranges from several manifests may be merged into one `patches` array. They must not overlap.

## Tests

```sh
python3 -m unittest discover -s ps2/battle/tests       # synthetic + retail (skips without the ISO)
BATTLE_BUILD_ISO=1 python3 -m unittest discover -s ps2/battle/tests   # also builds a derived ISO
node --test ps2/battle/tests/*.test.mjs                 # overlay (retail case needs the ISO + manifest)
node ps2/battle/e2e/explore.mjs --out private/ps2-battle/e2e/run "<route>"   # headless Play! route
```

`e2e/explore.mjs` serves `runtime/play-build`, the ISO and the manifest on a loopback port and drives headless Chrome only. It presses pad buttons through `_setPad`, and screenshots go to the output folder. See the file header for the route syntax. To reach Battle from a cold boot with no memory card:

```
wait:1500 cross wait:300 down wait:30 cross wait:300 down wait:30 cross wait:1200 start wait:600 start wait:600 shot:match-type
```
