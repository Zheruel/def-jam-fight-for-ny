# Retail combat routines

`combat.mjs` ports two leaf routines from the USA PS2 release `SLUS-21004`. It takes fighter state and timing as plain JavaScript values. The caller supplies the move delta or game tick and applies the resulting state in its own fight update.

Retail `SLUS_210.04` SHA-256 is `4e65bf2947b3838ce372967cac448bfc8034709a6d70a87fd11d13c5f09b23b2`. The ELF loads .text at `0x00100000` from file offset `0x1000`. Slices include each return delay slot.

| Routine | Virtual address | ELF offset | Bytes | Slice SHA-256 |
| --- | --- | --- | --- | --- |
| `applyHitChannelDelta` | `0x002ddf38` | `0x001def38` | `0x34` | `aa8bff1fbc3f4a76df722b529e92fb0d3614ef3c80270e418232735daf7d5866` |
| `tickFighterMomentum` | `0x002de648` | `0x001df648` | `0xd8` | `e9a8e42064a2282f97e177a186f56ff8f8217741cddffb29f37563d09e1bb5f0` |

## Hit channel update

The function containing the `DamageCalc` diagnostic starts at `0x002dacf0`. At `0x002db26c` it calls this leaf five times for the defender, passing index 0 through 4 and the negated, scaled move delta in F12. The leaf adds the delta to the indexed float at `fighter + 0x820 + 4 * index` and floors it at zero. The JavaScript function changes the selected entry in the caller's five-element array. The five channel identities and upstream move scaling are outside this port.

## Momentum tick

The active-fighter update loop calls this leaf at `0x002dbf1c`. The routine writes momentum at fighter offset `0x364` and the timer at `0x368`. The `MpAdd` path corroborates these roles by setting the Blazin flag and loading the same timer to 1800 when momentum fills. The `DamageCalc` path subtracts 120 from that timer while either low Blazin flag is set.

| JavaScript input | Retail field |
| --- | --- |
| `fighterFlags` | Fighter halfword `+0x924` |
| `hitFlags` | Fighter halfword `+0x926` |
| `blazinFlags` | Fighter byte `+0x93e` |
| `matchFlags` | 32-bit match flags at `0x004bc14c` |
| `elapsedTicks` | Float at `0x004bbf94`, in the game's timing units |
| `expiryRate` | Float at `0x00394ab8`. The parser stores the `momentum expiry rate` value here at `0x002efd54`. The USA disc config sets it to 0.9. |

Match flag `0x4` leaves both fields alone. With either low Blazin bit set, the tick suppresses the decay and timer update. Otherwise fighter flags `0xc000` select elapsed-time decay. With those flags clear, hit flag `0x20` holds the timer. A timer reaching zero resets to 30 and charges one fixed decay amount. An enabled tick floors momentum at 20.

## Verification

`node --test port/combat/combat.test.mjs` runs the deterministic JavaScript cases. Set the variables below to run the same suite with direct execution of the hash-checked retail slices.

```sh
uv venv --python 3.13 private/combat-oracle
uv pip install --python private/combat-oracle/bin/python unicorn==2.1.4
DEFJAM_RETAIL_ELF=private/ps2-battle/extract/SLUS_210.04 \
DEFJAM_UNICORN_PYTHON=private/combat-oracle/bin/python \
  node --test port/combat/combat.test.mjs
```

The differential checks compare exact float bits across 281 hit cases and 616 momentum cases. Cases cover all five indices, signed deltas, the momentum floor, the timer expiry boundary and the flag combinations. Unicorn runs the original MIPS instructions, including branch delay slots, using the FCSR value zero written at retail startup at `0x00100118`. The check uses ordinary finite combat values and does not establish real hardware behavior for exceptional floating-point inputs. No retail executable bytes are committed.
