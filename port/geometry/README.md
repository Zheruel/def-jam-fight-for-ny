# PS2 Foundation base geometry

`foundation.json` contains the retail Foundation static base mesh from US PS2 serial `SLUS-21004`. The geometry comes from `ASSETS/V2BG.VIV` → `V2BG_02A.o` → `__Model:::V2BG_02A_branch`. It includes 179 VIF packets, 1,954 triangle strips, 8,538 packet vertices, and 4,630 triangles.

- `positions` contains flat XYZ float32 values in the retail object's Y-up space. The bounds are approximately `[-88.62, -1.45, -77.94]` to `[87.43, 91.96, 278.64]`. The decoder applies no axis or scale conversion.
- `indices` contains flat zero-based triangle indices. Each strip starts with its three original vertices, then alternate triangles swap their first two indices. The arrays retain the original vertices, including repetitions at strip joins. A first render can use double-sided materials while EAGL culling state is translated.
- `texcoords` contains flat UV pairs as stored in the mesh. Texture addressing and material selection still need decoding.
- `colors` contains flat RGBA8 values from the retail color packets. This mesh uses 0–128 for RGB and exactly 128 for alpha. Divide by 128 to express these GS color multipliers as normalized shader inputs.
- `source` identifies the retail archive member and records SHA-256 hashes of both the compressed member and its decompressed ELF. The mesh excludes separate models referenced by the stage-object XML, including the breakable stage props and their morphs.

## Reproduce

```sh
python3 port/geometry/foundation.py verify private/ps2/reference.iso
python3 -m unittest discover -s port/geometry -p 'test_*.py'
```

Use `extract` instead of `verify` to regenerate the JSON. The extractor reads the VIV table and compressed member directly from the ISO, checks both published hashes, and emits decimals that reproduce the original float32 bit patterns. Tests can run without the ISO. With the ISO present they additionally compare the checked-in asset byte for byte with a fresh extraction.

## Packet layout

The VIV member is RefPack-compressed. The decompressed object is an ELF32/MIPS ET_REL file whose `.data` contains VIF1 DMA payloads. Every position packet has a local `R_MIPS_32` relocation from a DMA REF tag. The previous DMA REF tag points to matching color data.

A position packet starts with a V4-32 UNPACK to VU address `0x00`. Its first word is the vertex count. Three V4-8 UNPACKs to `0x14`, `0x15`, and `0x16` contain strip boundaries. The nonzero bytes are cumulative vertex counts multiplied by three, followed by zero padding. The first strip starts at zero and the last ends at the declared vertex count. The first retail packet supplies 72 vertices. Its boundaries at bytes 24, 42, and 72 start new strips at vertices 8, 14, and 24.

Two V4-32 UNPACKs then hold `(x, y, z, 1)` at `0x17` and `(u, v, 1, 0)` at `0x5f`. MSCNT terminates the packet. The accompanying color payload uses V4-8 UNPACK to `0xa7` with the same count. The extractor validates the tags, DMA QWC, termination, component layout and strip boundaries.

## Fighter assets

The same disc's `ASSETS/V2IP.VIV` holds RefPack-wrapped `V2IP_109A.o` for Doc and `V2IP_113A.o` for Blaze. The ELF symbol tables identify EAGL skeletons and skin microcode. Their separate `.ssh` members hold PS2 SHPS textures. Fighter skinning, mesh packet formats and animation remain unverified by this decoder.
