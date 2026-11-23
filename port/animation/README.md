# Native retail animation

The browser runs the statically translated EAGL motion routines from SLUS-21004. BASE00 supplies 709 shared clips. Each fighter streams one WRES bank, including paired moves that the opposing player samples from its owner’s bank. The loader relocates ELF data, initializes the type-25 compressed readers and rebuilds the name-index tables in retail order. A dedicated 6 MiB address range holds the two banks. The common rig data comes from the same reference match used for the Battle seed.

The verification checks mid-clip poses and original durations for all 8,598 WRES entries in either player slot. During seed generation it also compares relocated Blaze and Doc banks against their live-loaded counterparts at three times per clip. Procedural aim, face, finger and secondary-motion layers require separate comparisons.

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
