"""Live poses of the Foundation's near-crowd spectators, read from a retail EE RAM image.

Every V2CM person (`crowd_act1/act2_*` in the stage's `<crowdposition>`) is built from modular parts (`M1` torso and arms,
`M2` legs, `M3`, `M4_nn` head and hair, `M6` shoes ...) that share one 13-bone rig: `root, L_Leg1, L_Leg2, eff5, R_Leg1,
R_Leg2, eff4, Chest, Head, R_Arm1, R_Arm2, L_Arm1, L_Arm2` (the bone order of all 38 decoded V2CM models, whose bind
matrices are identical). The engine keeps a skeleton's pose in three buffers of 13 entries x 48 bytes
(`scale xyz 1, quaternion xyzw, translation xyz 1`, local to the parent, the layout `port/fighters/pose.mjs` reads for the
94-bone fighters), 0x280 bytes apart: the current pose, the previous pose and the bind reference. Layout in the Foundation RAM
captures (verified on five frames of the four-player start):

    record  = crowd_* name at 0x571100.. (stride 0x1c0, the first 0x20 bytes are the NUL-padded name)
    object  = u32[record + 0x8c]               (a character object, 0xd00 apart)
    current = u32[object + 0x14c]              (previous = +0x150, reference = +0x154)

Parents are not stored; PARENTS is the hierarchy under which the reference buffer composes (row vectors, transposed
quaternion, local x parentWorld) exactly onto the models' bind matrices (max error 0).

    python3 port/scenery/crowd_pose.py RAM.bin [--json out.json] [--png out.png] [--models private/scenery/v2cm]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import struct
import sys
import zlib
from pathlib import Path

BONES = ["root", "L_Leg1", "L_Leg2", "eff5", "R_Leg1", "R_Leg2", "eff4", "Chest", "Head", "R_Arm1", "R_Arm2", "L_Arm1", "L_Arm2"]
PARENTS = [None, 0, 1, 0, 0, 4, 0, 0, 7, 7, 9, 7, 11]
RECORDS = (0x570000, 0x578000)   # where the crowd_* instance records sit in the venue images (0x571100.. in the Foundation)
ENTRY = 48


def read_pose(ram: bytes, address: int) -> list[list[float]]:
    """13 entries of 12 floats: scale xyz 1, quaternion xyzw, translation xyz 1."""
    return [list(struct.unpack_from("<12f", ram, address + ENTRY * i)) for i in range(13)]


def instances(ram: bytes) -> list[dict]:
    """The named crowd instances with the addresses of their three pose buffers."""
    found = []
    low, high = RECORDS
    for match in re.finditer(rb"crowd_[a-z0-9]+_[A-Za-z0-9_]*\x00", ram[low:high]):
        record = low + match.start()
        obj = struct.unpack_from("<I", ram, record + 0x8C)[0]
        if not 0 < obj < len(ram) - 0x160:
            continue
        current, previous, reference = struct.unpack_from("<3I", ram, obj + 0x14C)
        if reference - current != 2 * (previous - current) or not 0 < current < len(ram) - 13 * ENTRY * 3:
            continue
        found.append({"name": match.group()[:-1].decode(), "record": record, "object": obj,
                      "current": current, "previous": previous, "reference": reference,
                      "group": struct.unpack_from("<I", ram, record + 0x84)[0],
                      "scale": struct.unpack_from("<f", ram, record + 0x1B8)[0],
                      "style": list(struct.unpack_from("<I", ram, record + 0x154)[:1] + struct.unpack_from("<I", ram, record + 0x158)[:1]
                                    + struct.unpack_from("<I", ram, record + 0x164)[:1] + struct.unpack_from("<I", ram, record + 0x1A4)[:1])})
    # The three crowd classes (modular part sets) are told apart by address; their order is the class number.
    order = {group: k for k, group in enumerate(sorted({f["group"] for f in found}))}
    for each in found:
        each["class"] = order[each["group"]]
    return found


# The class record (`u32[record + 0x84]`) lists the part ELFs at +0x294: upper body, legs, accessory, shoes, extra, head.
CLASS_SLOTS = (0, 1, 2, 3, 5)   # of those, the ones that are drawn (index 4, an M5/F5 extra, has no texture)


def class_parts(ram: bytes, group: int) -> list[str]:
    """Names of a class's drawn parts (`M1_01A`, ...), read from each part ELF's own strtab (bounded by the next ELF)."""
    ptrs = struct.unpack_from("<7I", ram, group + 0x294)
    starts = sorted(p for p in ptrs if 0x100000 < p < len(ram))
    names = []
    for index in CLASS_SLOTS:
        at = ptrs[index]
        end = min([q for q in starts if q > at] + [at + 0x20000])
        found = re.search(rb"V2CM_([A-Z]\d_\d\d[A-Z])\x00", ram[at:end])
        if not found:
            raise ValueError(f"class {group:#x}: no part name at {at:#x}")
        names.append(found.group(1).decode())
    return names


def matrix(entry: list[float]) -> list[float]:
    """Row-vector 4x4 of a pose entry (what the engine builds from the raw, unnormalised quaternion)."""
    sx, sy, sz, _, x, y, z, w, tx, ty, tz, _ = entry
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
         [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
         [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]]
    return [r[0][0] * sx, r[0][1] * sx, r[0][2] * sx, 0, r[1][0] * sy, r[1][1] * sy, r[1][2] * sy, 0,
            r[2][0] * sz, r[2][1] * sz, r[2][2] * sz, 0, tx, ty, tz, 1]


def multiply(a: list[float], b: list[float]) -> list[float]:
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]


def world(pose: list[list[float]]) -> list[list[float]]:
    out: list[list[float]] = []
    for i, entry in enumerate(pose):
        local = matrix(entry)
        out.append(local if PARENTS[i] is None else multiply(local, out[PARENTS[i]]))
    return out


def inverse_bind(models: Path, name: str = "V2CM_B1_01A.o") -> tuple[list[str], list[list[float]]]:
    """Bone names and inverse bind matrices of one V2CM model (all 38 share them)."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fighters"))
    from retail import BONE_RECORD, SKELETON_RECORD_DELTA, Elf
    elf = Elf((models / name).read_bytes())
    bones = {value: sym[len("__Bone:::root."):] for sym, value, _ in elf.symbols if sym.startswith("__Bone:::root.")}
    base = min(bones)
    skeleton = elf.symbol("__Skeleton:::root")
    names = [bones[base + 16 * i] for i in range(elf.u32(skeleton + 8))]
    records = skeleton + SKELETON_RECORD_DELTA
    return names, [list(struct.unpack_from("<16f", elf.data, records + BONE_RECORD * i)) for i in range(len(names))]


def skinned(mesh: dict, inverse: list[list[float]], posed: list[list[float]]) -> list[list[float]]:
    """Vertices of a `retail.build_mesh` model skinned by a world pose: position x inverseBind x world."""
    palette = [multiply(inverse[i], posed[i]) for i in range(13)]
    out = []
    for v in range(len(mesh["positions"]) // 3):
        x, y, z = mesh["positions"][3 * v:3 * v + 3]
        o = [0.0, 0.0, 0.0]
        for k in range(4):
            weight = mesh["weights"][4 * v + k]
            if weight:
                m = palette[int(mesh["joints"][4 * v + k])]
                for axis in range(3):
                    o[axis] += weight * (x * m[axis] + y * m[4 + axis] + z * m[8 + axis] + m[12 + axis])
        out.append(o)
    return out


def write_png(path: Path, image: list[list[tuple[int, int, int]]]) -> None:
    raw = b"".join(b"\0" + bytes(c for px in row for c in px) for row in image)
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", len(image[0]), len(image), 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def render(models: Path, parts: list[str], poses: list[list[list[float]]], inverse: list[list[float]]) -> list[list[tuple[int, int, int]]]:
    """Flat-shaded front view of one person (modular parts) in each pose, side by side. A proof, not the game's renderer."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fighters"))
    import retail
    meshes = []
    for name in parts:
        elf = retail.Elf((models / name).read_bytes())
        meshes.append(retail.build_mesh(elf, [{} for s, _, _ in elf.symbols if s.startswith("__Bone:::root.")]))
    width, height, scale = 220, 300, 12
    colours = [(200, 80, 70), (70, 110, 200), (80, 170, 90), (220, 190, 60)]
    panels = []
    for posed in poses:
        image = [[(235, 235, 240)] * width for _ in range(height)]
        depth = [[-1e9] * width for _ in range(height)]
        for part, mesh in enumerate(meshes):
            vertices, indices = skinned(mesh, inverse, posed), mesh["indices"]
            for t in range(0, len(indices), 3):
                a, b, c = (vertices[indices[t + i]] for i in range(3))
                u = [b[i] - a[i] for i in range(3)]
                w = [c[i] - a[i] for i in range(3)]
                n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
                shade = 0.55 + 0.45 * abs(n[2] / (math.sqrt(sum(v * v for v in n)) or 1))
                colour = tuple(int(v * shade) for v in colours[part % 4])
                pts = [(width / 2 + p[0] * scale, height - 15 - p[1] * scale, p[2]) for p in (a, b, c)]
                den = (pts[1][1] - pts[2][1]) * (pts[0][0] - pts[2][0]) + (pts[2][0] - pts[1][0]) * (pts[0][1] - pts[2][1])
                if abs(den) < 1e-9:
                    continue
                for y in range(max(0, int(min(p[1] for p in pts))), min(height - 1, int(max(p[1] for p in pts)) + 1) + 1):
                    for x in range(max(0, int(min(p[0] for p in pts))), min(width - 1, int(max(p[0] for p in pts)) + 1) + 1):
                        l1 = ((pts[1][1] - pts[2][1]) * (x - pts[2][0]) + (pts[2][0] - pts[1][0]) * (y - pts[2][1])) / den
                        l2 = ((pts[2][1] - pts[0][1]) * (x - pts[2][0]) + (pts[0][0] - pts[2][0]) * (y - pts[2][1])) / den
                        l3 = 1 - l1 - l2
                        if min(l1, l2, l3) < 0:
                            continue
                        z = l1 * pts[0][2] + l2 * pts[1][2] + l3 * pts[2][2]
                        if z > depth[y][x]:
                            depth[y][x], image[y][x] = z, colour
        panels.append(image)
    return [sum((panel[y] for panel in panels), []) for y in range(height)]


def export(ram: bytes) -> dict:
    """The instances with their current poses and the shared bind reference, as the committed fixture stores them."""
    found = instances(ram)
    reference = read_pose(ram, found[0]["reference"])
    for each in found:
        if read_pose(ram, each["reference"]) != reference:
            raise ValueError(each["name"] + ": reference pose differs")
    trim = lambda pose: [[round(v, 6) for v in (*e[4:8], *e[8:11])] for e in pose]
    return {"bones": BONES, "parents": PARENTS, "bind": trim(reference),
            "classes": {each["name"]: each["class"] for each in found},
            # Record words +0x154, +0x158, +0x164, +0x1a4 (clothing/palette picks; meanings unverified).
            "styles": {each["name"]: each["style"] for each in found},
            # Per-person height factor (record +0x1b8); a record that is not a person reads as garbage and is left out.
            "scales": {each["name"]: round(each["scale"], 4) for each in found if 0.5 <= each["scale"] <= 1.5},
            "instances": {each["name"]: trim(read_pose(ram, each["current"])) for each in found}}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ram", type=Path)
    ap.add_argument("--json", type=Path)
    ap.add_argument("--png", type=Path)
    ap.add_argument("--models", type=Path, default=Path("private/scenery/v2cm"))
    args = ap.parse_args(argv)
    ram = args.ram.read_bytes()
    found = instances(ram)
    print(f"{len(found)} instances; bones {BONES}")
    if args.json:
        args.json.write_text(json.dumps(export(ram), separators=(",", ":")) + "\n")
    if args.png:
        names, inverse = inverse_bind(args.models)
        if names != BONES:
            raise ValueError("model skeleton differs from BONES")
        poses = [world(read_pose(ram, found[0]["reference"]))] + [world(read_pose(ram, f["current"])) for f in (found[0], found[2], found[11])]
        write_png(args.png, render(args.models, ["V2CM_M1_01A.o", "V2CM_M2_01A.o", "V2CM_M4_01A.o"], poses, inverse))
    return 0


if __name__ == "__main__":
    sys.exit(main())
