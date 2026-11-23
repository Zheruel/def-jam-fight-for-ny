# Retail Battle combat data

`combat.mjs` exposes the extracted US PS2 (`SLUS-21004`) Battle configuration as browser-native ES modules.

- `getFighter(handle)` accepts a numeric uint32 or 0x-prefixed hex SOD fighter handle. It masks the retail handle flag in bit 23 and returns `undefined` for an unknown handle.
- `fighters` contains all 75 Character records in their SOD handle order. Each includes the raw six retail `stats`, the active `styleMask`, the corresponding `styles` in ascending bit order, and the directly assigned `blazin` record or `null`. Style order signals bit position. Primary style selection is a separate game behavior.
- `fightingStyles` maps each style key to its display name, bit, and GAMECORE tuning index.
- `unassignedBlazin` contains the 14 motion records with a retail owner value of `0xFFFFFFFF`. Each record, assigned or unassigned, provides a SOD handle and key plus its motion ID and motion key. The motions and their playback logic require a separate port.
- `combatTuning` contains the numeric gameplay values parsed from `ASSETS/GAMECORE.XML`. `combatTuning.byStyle` groups damage rates, speed rates, guard frames, grapple catch frames, and button-escape rates by style. Values retain source units. Formulas that consume these rates and raw fighter stats belong to the combat implementation.
- `source` lists the retail disc identity and the SHA-256 of each extracted or analyzed file.

## Source layout

The existing `ps2/content/sod.py` reader resolves SODB v2 class and instance handles. The Character class has hash `0x4CE5B1B2` and 26-word records; words 0, 5, and 14 are the STRT keys for the record name, displayed name, and model used by the retail unlock inventory.

`GetCharacterStats` at PS2 ELF virtual address `0x0014B408` loads six query constants and writes six named fields to the frontend. To resolve each schema entry, XOR the query constant with the Character class hash and look up the result in the SOD SKMA table. SKMA v2 stores a count and version, a sorted hash array, then corresponding pairs of zero-based word index and value type.

| Returned field | Query | Record word |
| --- | --- | ---: |
| UPR | `0xE2824A3D` | 17 |
| LOW | `0xCD759ABA` | 16 |
| SPD | `0xD19F0636` | 22 |
| TGH | `0xF8779D25` | 25 |
| HLT | `0x9CD237DB` | 12 |
| CHA | `0xA5D6AECD` | 2 |

`GetFightingStyle` at `0x0014B688` resolves query `0x906455C6` (Character word 9), then passes bits 0 through 4 as KICK, STREET, MARTIAL, WRESTLE, and SUB. The five SOD FightingStyle records share the query hash as their class hash. Their words 5 and 6 hold the bit index and GAMECORE column index. GAMECORE annotates the column order as streetfighter, kickboxing, submission, wrestling, martialarts.

SOD class `0x47D305FD` has 82 six-word Blazin records. Word 0 resolves to the `Blazing_*` key, word 1 is the owner handle, and words 4 and 5 carry a unique ID and matching `blazin_NN` STRT key. The extractor preserves records with missing owners and validates the motion ID against the key.

## Rebuild and check

Run from the repository root with Python 3.10+ and a verified retail ISO. The extractor checks the disc size and SHA-256 of DJV2.SOD, GAMECORE.XML, and SLUS_210.04 before decoding.

```sh
python3 port/assets/extract_combat.py private/ps2/reference.iso
python3 port/assets/extract_combat.py private/ps2/reference.iso --check
python3 -m unittest discover -s port/assets -p 'test_*.py'
node --test port/assets/combat.test.mjs
```
