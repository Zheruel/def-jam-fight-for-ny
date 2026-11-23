"""The Foundation's near-crowd people as skinned meshes (`foundation/people/class{0,1,2}.skin.gz`, DJF1 layout).

The venue loads three crowd classes; each is a set of modular V2CM parts on the shared 13-bone rig (see crowd_pose.py). The
sets were read from the three class records the spectators point at (`u32[instance record + 0x84]`; record + 0x290 holds the
part ELFs: M1, M2, M4, M6, -, M3) in the Foundation RAM captures, and each part ELF was named by its strtab:

    class 0 (record 0x158b690): M1_01A  M2_01A  M4_11A  M6_01A  M3_01A
    class 1 (record 0x158bcc0): M1_08A  M2_01A  M4_08A  M6_01A  M3_01A
    class 2 (record 0x158c2f0): M1_01A  M2_03A  M4_06A  M6_01A  M3_01A

Parts are decoded unskinned in T-pose (as the fighters are); the file carries the inverse bind matrices so a renderer skins with
`inverseBind x world` from a pose. Textures are each part's own `V2CM_Mn.ssh` `cm_m` skin atlas: the clothing the engine
stomps over it is not applied here (see README).
"""
from __future__ import annotations

import gzip
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import extract as scenery  # noqa: E402
import crowd_pose  # noqa: E402
sys.path.insert(0, str(HERE.parent / "geometry"))
import ssh as ssh_module  # noqa: E402

VIV = "/ASSETS/V2CM.VIV"
CLASSES = [
    ("M1_01A", "M2_01A", "M4_11A", "M6_01A", "M3_01A"),
    ("M1_08A", "M2_01A", "M4_08A", "M6_01A", "M3_01A"),
    ("M1_01A", "M2_03A", "M4_06A", "M6_01A", "M3_01A"),
]
VERTEX = struct.Struct("<3f3f2f4B4f")


def layer(ssh: bytes, palette: int) -> bytes:
    """A stomp layer (`0000` 8-bit indices plus `plNN` palette-only shapes) painted with palette `palette` (1-based)."""
    count = struct.unpack_from("<I", ssh, 8)[0]
    shapes = {key.decode(): at for key, at in (struct.unpack_from("<4sI", ssh, 16 + 8 * i) for i in range(count))}
    start = shapes["0000"]
    width, height = struct.unpack_from("<HH", ssh, start + 4)
    clut = shapes[f"pl{palette:02d}"]
    if ssh[start] != 2 or ssh[clut] != 33:
        raise ValueError("unexpected stomp layer format")
    colours = []
    for k in range(256):
        at = (k & ~24) | ((k & 8) << 1) | ((k & 16) >> 1)   # CSM1 CLUT for PSMT8, as ssh.textures
        colours.append(ssh[clut + 16 + 4 * at:clut + 20 + 4 * at])
    return ssh_module.indexed_png(width, height, 8, ssh[start + 16:start + 16 + width * height], colours)


def texture(disc, part: str, palette: int) -> bytes:
    """Part variant NN draws with the layer V2CM_<slot>_<NN>.ssh when the archive has one, else the slot's skin atlas."""
    slot, number = part[:2], part[3:5]
    try:
        return layer(scenery.member(disc, VIV, f"V2CM_{slot}_{number}.ssh"), palette)
    except FileNotFoundError:
        return scenery.textures(scenery.member(disc, VIV, f"V2CM_{slot}.ssh"))["cm_m"]


def person(disc, parts: tuple[str, ...], palettes: tuple[int, ...] = (1, 1, 1, 1, 1)) -> bytes:
    retail = scenery.retail
    vertices, elements, batches, images = bytearray(), [], [], {}
    inverse = None
    for part, palette in zip(parts, palettes):
        blob = scenery.member(disc, VIV, f"V2CM_{part}.o")
        elf = retail.Elf(blob)
        bones = {v: n[len("__Bone:::root."):] for n, v, _ in elf.symbols if n.startswith("__Bone:::root.")}
        base = min(bones)
        skeleton = elf.symbol("__Skeleton:::root")
        names = [bones[base + 16 * i] for i in range(elf.u32(skeleton + 8))]
        if names != crowd_pose.BONES:
            raise ValueError(f"{part}: unexpected skeleton {names}")
        records = skeleton + retail.SKELETON_RECORD_DELTA
        these = [list(struct.unpack_from("<16f", elf.data, records + retail.BONE_RECORD * i)) for i in range(13)]
        if inverse is not None and these != inverse:
            raise ValueError(f"{part}: bind differs from the other parts")
        inverse = these
        mesh = retail.build_mesh(elf, [{} for _ in names])
        first = len(vertices) // VERTEX.size
        for i in range(len(mesh["positions"]) // 3):
            joints = [int(j) for j in mesh["joints"][4 * i:4 * i + 4]]
            vertices.extend(VERTEX.pack(*mesh["positions"][3 * i:3 * i + 3], *mesh["normals"][3 * i:3 * i + 3],
                                        *mesh["uvs"][2 * i:2 * i + 2], *joints, *mesh["weights"][4 * i:4 * i + 4]))
        slot = part[:2]
        batches.append({"shape": slot, "first": len(elements), "count": len(mesh["indices"]), "part": part})
        elements.extend(first + i for i in mesh["indices"])
        images[slot] = texture(disc, part, palette)
    payload = bytearray(vertices)
    payload.extend(struct.pack(f"<{len(elements)}H", *elements))
    textures = {}
    for slot, image in sorted(images.items()):
        textures[slot] = [len(payload), len(image)]
        payload.extend(image)
    meta = {"model": "+".join(parts), "vertices": len(vertices) // VERTEX.size, "indices": len(elements), "batches": batches,
            "textures": textures, "parts": list(parts), "bones": [{"name": n, "parent": p, "inverseBind": m}
                                                                    for n, p, m in zip(crowd_pose.BONES, crowd_pose.PARENTS, inverse)]}
    header = json.dumps(meta, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    return gzip.compress(b"DJF1" + struct.pack("<I", len(header)) + header + bytes(payload), compresslevel=9, mtime=0)


def build(iso: Path) -> dict[str, bytes]:
    disc = scenery.Disc(str(iso))
    try:
        return {f"people/class{i}.skin.gz": person(disc, parts) for i, parts in enumerate(CLASSES)}
    finally:
        disc.close()


def main() -> int:
    out = HERE / "foundation"
    for name, blob in build(scenery.DEFAULT_ISO).items():
        (out / name).parent.mkdir(exist_ok=True)
        (out / name).write_bytes(blob)
        print(name, len(blob))
    return 0


if __name__ == "__main__":
    sys.exit(main())
