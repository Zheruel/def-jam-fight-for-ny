# Native Battle library

The browser calls the statically translated SLUS-21004 Battle update at 0x2dbdd0 once per simulation tick. The module contains 785 functions from the Battle region. Their original data addresses are offsets into a WebAssembly buffer. The host provides controller inputs, sampled poses, joint transforms and math services. An unimplemented engine call reports its address. The Foundation starting data holds the pages the verified match needs. Player inputs control both actors from that point onward.

## Rebuild

From the repository root, extract the verified US executable to the input path in game.toml. Run the PS2Recomp executable with that TOML as its argument. The translator revision used was e5636981a1c9de368f6b71e819c3dc188dfedbf4. Use a Clang installation with the wasm32 target and wasm-ld. [PS2Recomp source](https://github.com/ran-j/PS2Recomp/tree/e5636981a1c9de368f6b71e819c3dc188dfedbf4)

```sh
ps2_recomp port/kernel/game.toml
python3 port/kernel/build.py private/native-kernel/generated --out private/native-kernel/release --clang clang++
gzip -n -c private/native-kernel/release/battle.wasm > port/kernel/battle.wasm.gz
node verification/native-combat.mjs
```

To regenerate the starting data, capture both poses and RAM with the reference match harness. Replace CAPTURE below with the directory printed by the harness. Extract the inputs and poses from the same recording as the starting snapshot. The seed builder instruments compiled memory accesses and includes the controller and skeleton tables read by the host.

```sh
DEFJAM_REFERENCE_POSES=1 DEFJAM_REFERENCE_SNAPSHOT=1 node verification/ps2-match.mjs --trace
node verification/export-poses.mjs CAPTURE/combat-trace.json
node verification/native-combat.mjs --extract CAPTURE/combat-trace.json
python3 port/kernel/build.py private/native-kernel/generated --out private/native-kernel/tracked --track --clang clang++
node verification/native-combat.mjs --seed CAPTURE/fighter-ram-0.bin private/native-kernel/tracked/battle.wasm port/kernel/foundation-start.gz
node verification/native-combat.mjs
```

The native player loads the original MAIN_ALL.DAT through the compiled match rules parser. Its WPAR tables supply the 75 roster records in either player slot. The profile test compares the complete 232-byte output for Blaze and Doc against the reference snapshot. Rebuild or check the rules from the disc with the motion extractor.

```sh
python3 port/motion/extract.py private/ps2/reference.iso --check
```
