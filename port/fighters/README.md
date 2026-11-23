# Retail fighter models

`models/V2IP_113A.json` (Blaze) and `models/V2IP_109A.json` (Doc) are skinned meshes decoded from `ASSETS/V2IP.VIV` on the US PS2 disc (`SLUS-21004`). `retail.py` decodes any `V2IP_nnnA.o`: all 78 roster members share one 94-bone rig and decode with 4,500–7,400 vertices each.

```sh
python3 port/fighters/extract.py extract private/ps2/reference.iso                       # Blaze and Doc
python3 port/fighters/extract.py extract private/ps2/reference.iso --all --output build/fighters
python3 port/fighters/extract.py verify  private/ps2/reference.iso                       # byte-compare checked-in JSON
python3 -m unittest discover -s port/fighters -p 'test_*.py'
```

Tests run without the ISO against the checked-in JSON. With the ISO they also re-extract Blaze and Doc byte for byte, decode the whole roster, and read the animation bank structure.

## JSON schema `def-jam-fny-fighter-model/1`

| field | content |
| --- | --- |
| `positions` | flat xyz, bind pose, retail units, Y-up, about 22 units tall, T-pose (arms along ±X, face toward +Z) |
| `normals` | flat unit normals, same space |
| `uvs` | flat `u,v` as stored (`value / 4096`); PS2 origin is top-left |
| `joints`, `weights` | four per vertex; index into `bones`; at most three non-zero weights, sum 1 |
| `indices` | triangle list, outward-facing |
| `parts` | draw ranges (`firstVertex`, `vertexCount`, `firstIndex`, `indexCount`) and the part's bone `palette` |
| `bones` | 94 entries: `name`, `parent`, `inverseBind`, `bindWorld` (row-major 4x4, row-vector convention `p' = p * M`) |
| `source` | archive member offset, sizes and SHA-256 of the compressed member and decompressed ELF |

Skinning: `skinned = Σ weight * (p * inverseBind[joint] * poseWorld[joint])`, with `poseWorld` the animated bone-to-model matrix. In the bind pose this reproduces `positions`.

## What is verified against the retail data

* **Container.** The member is a RefPack ELF32/MIPS object. `.data` holds VIF1 display lists, an `__BBOX` symbol, a 94-entry bone header array, the `__Skeleton` header and 0x70-byte bone records.
* **Positions.** Each vertex has three `u16` offsets added to the bit pattern of `1.0f` (VIF offset mode). The value is `(u16 − 0x8001) × max(|bbox.min|, |bbox.max|) / 0x4000` per axis. Evidence: the largest offsets saturate exactly at ±0x4000 on every model, the zero point sits on the center plane (x=0, feet at y=0), the T-pose silhouette matches the skeleton, and regression of finger-bone positions against the offsets reproduces the scales to within 8%. The z scale is the least constrained axis; face-normal agreement peaks at the derived value.
* **Normals.** The `V4-32` stream stores `normal / axisScale`; `normalize(c * axisScale)` agrees with computed face normals (mean cosine 0.95). Strip winding is not consistent between strips, so triangles are oriented per strip to face the stored normals (verified: strips are all-or-nothing).
* **Strips.** A batch fills up to 60 output slots. Two `s16` fields per vertex (`/3`) give the slot or slots a vertex fills (a vertex can fill two); the three `V4-8` boundary words split the slot range into strips.
* **Skinning.** The packet's first `V4-32` table holds three weights per row; the low six mantissa bits of each weight hold the VU matrix offset in quadwords, which selects an entry of the part's bone palette (the palette size is always max slot + 1). Rows sum to 1 within 2e-5.
* **Skeleton.** Bind matrices are inverse bind transforms; their inverses give the T-pose joint positions (hands at x=±8.6, feet at ground). Parents are not stored; `PARENTS` in `retail.py` follows the bone names and was validated by composing the live default local TRS array against `bindWorld` for 77 of 94 bones (finger roots hang off `*_arm_eff`, `backbone_eff3` off `head`). Unresolved: `PonyTail2`, `placellip`, `L_Lip`, `placerlip`, `R_Lip` (no body geometry; <0.5 unit error).

## Live poses (`pose.mjs`)

Read from a 32MB EE RAM image (`DataView`), verified on two instants of a real Blaze vs Doc match:

* character = `u32[0x471230 + slot*4]`; CSkeleton at `char+0x170`, pointer at `char+0x174`.
* **current final local pose = `u32[char+0x17c]`**: 94 entries x 48 bytes in model `bones` order (no remap): `scale xyz1, quat xyzw, trans xyz1`, local to the parent. The pointers at `+0x180/+0x184` are the previous/reference buffers and rotate; the reference one skins the mesh back to the bind pose.
* world = local x parentWorld (row vectors, transposed quaternion); skin = `inverseBind x world`. Bone 0 translation is actor-relative; place with actor position and yaw.

```js
import { readPose, skinPositions } from "./pose.mjs";
const { skin, world, entries } = readPose(new DataView(eeRam), model, slot);   // skin: Float32Array(94*16)
```

`poses/*.json` (`def-jam-fny-fighter-pose/1`) are examples exported by `export-poses.mjs`: Blaze idle A112 frame 16, Doc idle A117 frame 18, both actors in the second snapshot, and the bind reference. `node --test port/fighters/pose.test.mjs`.

## Not recovered

* **Animations.** `animbank.py` resolves the bank structure: `BASE00.VIV` and each `WRES_ALL.VIV` member are an ELF split into `.ord` + `.orl`, with five objects (`_d/_f/_h/_s/_t`) per clip and the list of channels (skeleton indices) it drives. Idle clips A112 (Blaze) and A117 (Doc) drive 50 and 58 of 67 and 65 skeleton channels; other clips use shorter prefixes (29–49 channels), so they run on a smaller skeleton whose bone mapping onto the 94-bone rig is not stored in the bank. The key streams are compressed (16-bit values centered on 0x8000, float tables, byte indices, a clip length such as `8.5` as a float) and the sampling rules were not recovered, so no clip is exported; arbitrary-frame sampling needs the sampler (EE 0x1a2f38/0x1a2fe8, scratchpad animation buffer). Strike poses need live captures mid-attack.
* **Textures.** Parts are not yet matched to the `.ssh` textures.
* **Eyes and effects.** Sprite packets (eyes, sparkle) are skipped; `skippedPackets` is not exported.
