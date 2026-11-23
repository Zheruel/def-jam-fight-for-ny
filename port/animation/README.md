# Native retail animation

The browser runs the statically translated EAGL motion routines from SLUS-21004. BASE00 supplies 709 shared clips. Each fighter streams one WRES bank, including paired moves that the opposing player samples from its owner’s bank. The loader relocates ELF data, initializes the type-25 compressed readers and rebuilds the name-index tables in retail order. A dedicated 6 MiB address range holds the two banks. The common rig data comes from the same reference match used for the Battle seed.

The verification checks mid-clip poses and original durations for all 8,598 WRES entries in either player slot. During seed generation it also compares relocated Blaze and Doc banks against their live-loaded counterparts at three times per clip. The streamed tail of BASE00 holds 82 paired Blazin’ moves. Each fighter’s four directional assignments come from their decoded WPAR profile. The player loads just the distinct moves assigned to the selected pair, including both roles. All 164 clips run through the retail EAGL sampler. During reference verification the 94-bone poses and root motion of Blaze’s and Doc’s four clips match the captured resources at the beginning, middle and end.

From the repo root, use the generated retail sources and the reference match snapshot described in the kernel README. The native preparation step uses the offline sampler’s PS2Recomp checkout and headers.

```sh
python3 port/fighters/sampler/build.py
python3 port/animation/build.py --elf private/ps2-battle/extract/SLUS_210.04 --emxx em++
gzip -n -c private/anim-wasm/sampler.wasm > port/animation/sampler.wasm.gz
python3 port/animation/extract.py private/ps2/reference.iso
node verification/native-animation.mjs --seed CAPTURE/fighter-ram-0.bin
npm run test:native-animation
npm run test:native-battle
```
