"""Decode PS2 fighter models (ASSETS/V2IP.VIV, V2IP_nnnA.o) into browser-ready arrays.

Everything here is recovered from the retail disc:

* The member is a RefPack-wrapped ELF32/MIPS relocatable object.  Its `.data` holds an EAGL
  skeleton, an axis-aligned bounding box and a set of VIF1 display lists.
* A display list is a sequence of "parts".  Each part owns a bone palette (a list of skeleton
  indices uploaded to VU1 as skinning matrices) and one DMA REF packet.
* A packet starts with a table of weight vectors, then repeats batches of at most 60 output
  slots.  Every batch UNPACKs three vertex streams:

  =====  ==========  =======================================================================
  VU     format      content
  =====  ==========  =======================================================================
  +4     V4-16 usn   x, y, z as 16-bit offsets added to ROW=1.0f bits, then flag/index
  +64    V4-16       u, v (12-bit fixed, /4096) and two output slot numbers (x3)
  +124   V4-32       normal scaled by 1/axis-scale (floats), weight-table index * 7 in w
  =====  ==========  =======================================================================
"""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "ps2" / "battle"))

from battle_patch import Disc  # noqa: E402
from refpack import decompress  # noqa: E402

ARCHIVE = "ASSETS/V2IP.VIV"
GAME_ID = "SLUS-21004"
POSITION_ZERO = 0x8001          # u16 offset that decodes to 0.0 on every axis
POSITION_FULL_SCALE = 0x4000    # |offset| that decodes to the axis' largest bounding-box extent
UV_SCALE = 4096.0
WEIGHT_SLOT_MASK = 0x3F         # low mantissa bits of a weight hold (VU matrix offset in qwords)
BONE_RECORD = 0x70
MAX_SLOTS = 64
SKELETON_RECORD_DELTA = 0x40    # first 0x70-byte bone record follows the 0x40-byte skeleton header

# The tool-chain stores bones in depth-first order and records no parent field.  The retail
# skeleton is the same 94-bone EAGL rig in every fighter, so the parent table below follows the
# bone names; it is validated against the first-child vectors stored in the records.
PARENTS = {
    "root": None, "tophip": "root",
    "L_hipbone_root": "tophip", "L_hipbone": "L_hipbone_root", "L_hipbone_eff": "L_hipbone",
    "L_leg_root": "L_hipbone", "L_leg1": "L_leg_root", "L_leg2": "L_leg1", "L_leg_eff": "L_leg2",
    "L_foot_root": "L_leg2", "L_foot": "L_foot_root", "L_foot_eff": "L_foot",
    "hip": "tophip", "waist": "hip", "chest": "waist",
    "L_arm_root": "chest", "L_shoulder": "L_arm_root", "L_arm1": "L_shoulder", "L_arm2": "L_arm1",
    "L_hand": "L_arm2", "L_arm_eff": "L_hand",
    "R_arm_root": "chest", "R_shoulder": "R_arm_root", "R_arm1": "R_shoulder", "R_arm2": "R_arm1",
    "R_hand": "R_arm2", "R_arm_eff": "R_hand",
    "neck": "chest", "head": "neck", "HairParent": "head", "PonyTail1": "HairParent",
    "PonyTail2": "PonyTail1", "HairTop": "HairParent", "HairFront": "HairParent",
    "R_Hair": "HairParent", "L_Hair": "HairParent", "HairBack": "HairParent",
    "HeadBones": "head", "Blink": "HeadBones", "JAW": "HeadBones", "BotLip": "JAW",
    "L_Brow": "HeadBones", "L_Eye": "HeadBones", "placellip": "HeadBones", "L_Lip": "HeadBones",
    "placerlip": "HeadBones", "R_Lip": "HeadBones", "R_Brow": "HeadBones", "R_Eye": "HeadBones",
    "Sneer": "HeadBones", "Squint": "HeadBones", "backbone_eff3": "chest",
    "Pendant1": "chest", "Pendant2": "Pendant1",
    "R_hipbone_root": "tophip", "R_hipbone": "R_hipbone_root", "R_hipbone_eff": "R_hipbone",
    "R_leg_root": "R_hipbone", "R_leg1": "R_leg_root", "R_leg2": "R_leg1", "R_leg_eff": "R_leg2",
    "R_foot_root": "R_leg2", "R_foot": "R_foot_root", "R_foot_eff": "R_foot",
}
for _side in "LR":
    for _finger in ("Thumb", "pointer", "middle", "pinky", "ring"):
        PARENTS[f"{_side}_{_finger}1"] = f"{_side}_hand"
        PARENTS[f"{_side}_{_finger}2"] = f"{_side}_{_finger}1"
        PARENTS[f"{_side}_{_finger}3"] = f"{_side}_{_finger}2"


def c_string(blob: bytes, offset: int) -> str:
    return blob[offset:blob.index(0, offset)].decode("latin-1")


class Elf:
    """Minimal ELF32 reader exposing `.data`, symbols and local R_MIPS_32 relocations."""

    def __init__(self, blob: bytes):
        if len(blob) < 52 or blob[:7] != b"\x7fELF\x01\x01\x01" or blob[16:20] != b"\x01\x00\x08\x00":
            raise ValueError("expected a little-endian ELF32/MIPS relocatable object")
        table, = struct.unpack_from("<I", blob, 32)
        size, count, names_index = struct.unpack_from("<HHH", blob, 46)
        if size != 40 or not 0 < names_index < count:
            raise ValueError("invalid ELF section table")
        sections = list(struct.iter_unpack("<10I", blob[table:table + count * size]))

        def contents(index):
            start, length = sections[index][4:6]
            if start + length > len(blob):
                raise ValueError("ELF section runs outside the file")
            return blob[start:start + length]

        names = contents(names_index)
        by_name = {c_string(names, section[0]): i for i, section in enumerate(sections)}
        self.data = contents(by_name[".data"])
        strings = contents(sections[by_name[".symtab"]][6])
        self.symbols = [(c_string(strings, name), value, kind)
                        for name, value, _, _, _, kind in struct.iter_unpack("<IIIBBH", contents(by_name[".symtab"]))]
        data_index = by_name[".data"]
        self.local = set()
        for at, info in struct.iter_unpack("<II", contents(by_name[".rel.data"])):
            symbol, kind = divmod(info, 256)
            if kind == 2 and self.symbols[symbol][2] == data_index:
                self.local.add(at)

    def u32(self, at: int) -> int:
        return struct.unpack_from("<I", self.data, at)[0]

    def symbol(self, prefix: str) -> int:
        found = [value for name, value, _ in self.symbols if name.startswith(prefix)]
        if len(found) != 1:
            raise ValueError(f"expected one symbol starting {prefix!r}, found {len(found)}")
        return found[0]


def matrix_inverse(m: list[float]) -> list[float]:
    """Invert a general 4x4 (Gauss-Jordan); the bind matrices are not all orthonormal."""
    a = [[float(m[r * 4 + c]) for c in range(4)] + [1.0 if r == c else 0.0 for c in range(4)] for r in range(4)]
    for col in range(4):
        pivot = max(range(col, 4), key=lambda r: abs(a[r][col]))
        if abs(a[pivot][col]) < 1e-12:
            raise ValueError("singular bind matrix")
        a[col], a[pivot] = a[pivot], a[col]
        scale = a[col][col]
        a[col] = [v / scale for v in a[col]]
        for r in range(4):
            if r != col:
                factor = a[r][col]
                a[r] = [v - factor * w for v, w in zip(a[r], a[col])]
    return [a[r][4 + c] for r in range(4) for c in range(4)]


def decode_skeleton(elf: Elf) -> list[dict]:
    """Bones in file order with names, parents and bind matrices."""
    base = None
    bones = {}
    for name, value, _ in elf.symbols:
        if name.startswith("__Bone:::root."):
            bones[value] = name[len("__Bone:::root."):]
    if not bones:
        raise ValueError("no bone symbols")
    base = min(bones)
    skeleton = elf.symbol("__Skeleton:::root")
    count = elf.u32(skeleton + 8)
    if skeleton != base + count * 16 or len(bones) != count:
        raise ValueError("bone array does not end at the skeleton header")
    names = [bones[base + 16 * i] for i in range(count)]
    for i, name in enumerate(names):
        if elf.u32(base + 16 * i) != i:
            raise ValueError("bone header index mismatch")
    records = skeleton + SKELETON_RECORD_DELTA
    result = []
    for i, name in enumerate(names):
        at = records + BONE_RECORD * i
        inverse_bind = list(struct.unpack_from("<16f", elf.data, at))
        if (abs(inverse_bind[15] - 1.0) > 1e-4 or any(abs(inverse_bind[j]) > 1e-4 for j in (3, 7, 11))
                or not all(math.isfinite(v) for v in inverse_bind)):
            raise ValueError(f"invalid inverse bind matrix for bone {i}")
        parent = PARENTS.get(name)
        if name not in PARENTS:
            raise ValueError(f"unknown bone {name!r}")
        result.append({"name": name, "parent": None if parent is None else names.index(parent),
                       "inverseBind": inverse_bind, "bindWorld": matrix_inverse(inverse_bind)})
    return result


def vif_codes(data: bytes, start: int, qwc: int):
    """Yield VIF1 commands in a REF packet.  UNPACKs carry the data offset and byte size."""
    at, end = start, start + qwc * 16
    widths = {0x0: (32, 1), 0x4: (32, 2), 0x8: (32, 3), 0xC: (32, 4),
              0x1: (16, 1), 0x5: (16, 2), 0x9: (16, 3), 0xD: (16, 4),
              0x2: (8, 1), 0x6: (8, 2), 0xA: (8, 3), 0xE: (8, 4), 0xF: (16, 1)}
    while at < end:
        word, = struct.unpack_from("<I", data, at)
        command, count, immediate = word >> 24 & 0x7F, word >> 16 & 0xFF, word & 0xFFFF
        if command & 0x60 == 0x60:
            bits, lanes = widths[command & 0xF]
            count = count or 256
            size = (bits * lanes * count + 31) // 32 * 4
            yield {"at": at, "unpack": command & 0xF, "count": count, "address": immediate & 0x3FF,
                   "unsigned": bool(immediate & 0x4000), "tops": bool(immediate & 0x8000),
                   "data": at + 4, "size": size}
            at += 4 + size
        else:
            yield {"at": at, "command": command, "count": count, "immediate": immediate}
            at += 20 if command == 0x30 else 4   # STROW is followed by four data words


def find_parts(elf: Elf) -> list[dict]:
    """Pair each REF packet with the bone palette announced before it."""
    data = elf.data
    palette = None
    parts = []
    for at in range(0, len(data) - 16, 4):
        if (at + 4) not in elf.local:
            continue
        head, pointer, first, second = struct.unpack_from("<IIII", data, at)
        if head >> 28 == 0 and first == 0x10000000 and (second & 0xFFFF == 0x4022 or second == 0x20000000) and head < MAX_SLOTS:
            palette = list(struct.unpack_from(f"<{head}I", data, pointer))
        elif head >> 28 == 3 and head & 0xFFFF > 1 and pointer + (head & 0xFFFF) * 16 <= len(data):
            parts.append({"tag": at, "packet": pointer, "qwc": head & 0xFFFF, "palette": palette})
    return parts


def decode_packet(data: bytes, part: dict):
    """Return (weight table, batches) for a skinned VIF packet, or None for other packets."""
    table = None
    batches = []
    batch = None
    for code in vif_codes(data, part["packet"], part["qwc"]):
        if "unpack" not in code:
            continue
        kind, address, at, count = code["unpack"], code["address"], code["data"], code["count"]
        if kind == 0xC and not code["tops"] and address == 4:
            table = [struct.unpack_from("<4I", data, at + 16 * i) for i in range(count)]
        elif kind == 0xC and address == 0:
            batch = {"header": struct.unpack_from("<4I", data, at), "bounds": b""}
        elif kind == 0xE and address in (1, 2, 3):
            batch["bounds"] += data[at:at + 4]
        elif kind == 0xD and address == 4:
            batch["a"] = struct.unpack_from(f"<{4 * count}H", data, at)
        elif kind == 0xD and address == 64:
            batch["b"] = struct.unpack_from(f"<{4 * count}h", data, at)
        elif kind == 0xC and address == 124:
            batch["c"] = struct.unpack_from(f"<{4 * count}I", data, at)
            batch["count"] = count
            batches.append(batch)
    if table is None or not batches:
        return None
    return table, batches


def bounding_box(elf: Elf) -> tuple[list[float], list[float]]:
    at = elf.symbol("__BBOX:::")
    values = struct.unpack_from("<6f", elf.data, at)
    return list(values[:3]), list(values[3:])


def build_mesh(elf: Elf, bones: list[dict]) -> dict:
    low, high = bounding_box(elf)
    scale = [max(abs(a), abs(b)) / POSITION_FULL_SCALE for a, b in zip(low, high)]
    positions: list[float] = []
    normals: list[float] = []
    uvs: list[float] = []
    joints: list[int] = []
    weights: list[float] = []
    indices: list[int] = []
    parts = []
    skipped = []
    for number, part in enumerate(find_parts(elf)):
        decoded = decode_packet(elf.data, part) if part["palette"] else None
        if decoded is None:
            skipped.append(part["packet"])
            continue
        table, batches = decoded
        palette = part["palette"]
        if any(bone >= len(bones) for bone in palette):
            raise ValueError("bone palette references a missing bone")
        first_vertex, first_index = len(positions) // 3, len(indices)
        for batch in batches:
            vertices = batch["count"]
            slots = batch["header"][0]
            if batch["header"][1] != vertices or not 3 <= slots <= MAX_SLOTS:
                raise ValueError("unexpected batch header")
            origin = len(positions) // 3
            local_position = []
            for i in range(vertices):
                a, b, c = batch["a"][4 * i:4 * i + 4], batch["b"][4 * i:4 * i + 4], batch["c"][4 * i:4 * i + 4]
                point = [(a[k] - POSITION_ZERO) * scale[k] for k in range(3)]
                local_position.append(point)
                positions.extend(point)
                normal = [struct.unpack("<f", struct.pack("<I", c[k]))[0] * scale[k] for k in range(3)]
                length = math.sqrt(sum(v * v for v in normal)) or 1.0
                normals.extend(v / length for v in normal)
                uvs.extend((b[0] / UV_SCALE, b[1] / UV_SCALE))
                row = table[c[3] // 7]
                pairs = []
                for word in row[:3]:
                    weight = struct.unpack("<f", struct.pack("<I", word & ~WEIGHT_SLOT_MASK))[0]
                    slot = (word & WEIGHT_SLOT_MASK) >> 2
                    pairs.append((weight, palette[slot]))
                total = sum(w for w, _ in pairs)
                pairs = [(w / total, bone) for w, bone in pairs] + [(0.0, pairs[0][1])]
                joints.extend(bone for _, bone in pairs)
                weights.extend(w for w, _ in pairs)
            slot_vertex = [None] * slots
            for i in range(vertices):
                for slot in {batch["b"][4 * i + 2] // 3, batch["b"][4 * i + 3] // 3}:
                    slot_vertex[slot] = i
            if None in slot_vertex:
                raise ValueError("batch leaves an output slot unfilled")
            cuts = [value // 3 for value in batch["bounds"] if value]
            edges = [0, *cuts, slots]
            for start, end in zip(edges, edges[1:]):
                triangles = []
                for at in range(start + 2, end):
                    triple = (slot_vertex[at - 2], slot_vertex[at - 1], slot_vertex[at])
                    if at - start & 1:
                        triple = (triple[1], triple[0], triple[2])
                    if len(set(triple)) == 3:
                        triangles.append(triple)
                # Strip winding is not consistent between strips; face every strip along its stored normals.
                vote = 0
                for tri in triangles:
                    p = [local_position[i] for i in tri]
                    u = [p[1][k] - p[0][k] for k in range(3)]
                    v = [p[2][k] - p[0][k] for k in range(3)]
                    face = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                    n = [sum(normals[3 * (origin + i) + k] for i in tri) for k in range(3)]
                    vote += 1 if sum(face[k] * n[k] for k in range(3)) > 0 else -1
                for tri in triangles:
                    ordered = tri if vote >= 0 else (tri[0], tri[2], tri[1])
                    indices.extend(origin + i for i in ordered)
        parts.append({"palette": palette, "firstVertex": first_vertex,
                      "vertexCount": len(positions) // 3 - first_vertex, "firstIndex": first_index,
                      "indexCount": len(indices) - first_index, "packet": part["packet"]})
    return {"positions": positions, "normals": normals, "uvs": uvs, "joints": joints, "weights": weights,
            "indices": indices, "parts": parts, "boundingBox": {"min": low, "max": high},
            "positionScale": scale, "skippedPackets": skipped}


def decode_model(blob: bytes) -> dict:
    elf = Elf(blob)
    bones = decode_skeleton(elf)
    mesh = build_mesh(elf, bones)
    mesh["bones"] = bones
    return mesh


def read_member(disc: Disc, member: str) -> tuple[bytes, bytes, tuple[int, int]]:
    offset, length = disc.viv_entry("/" + ARCHIVE, member)
    packed = disc.read("/" + ARCHIVE, offset, length)
    return packed, decompress(packed), (offset, length)


def model_from_disc(disc: Disc, name: str) -> dict:
    packed, blob, (offset, length) = read_member(disc, f"{name}.o")
    model = decode_model(blob)
    model["source"] = {"gameId": GAME_ID, "archive": ARCHIVE, "member": f"{name}.o", "memberOffset": offset,
                       "memberBytes": length, "memberSha256": hashlib.sha256(packed).hexdigest(),
                       "elfSha256": hashlib.sha256(blob).hexdigest()}
    return model


def roster(disc: Disc) -> list[str]:
    """Every V2IP model member in archive order."""
    import re
    head = disc.read("/" + ARCHIVE, 0, 16)
    count, header_size = struct.unpack_from(">II", head, 8)
    table = disc.read("/" + ARCHIVE, 0, header_size)
    names, at = [], 16
    for _ in range(count):
        end = table.index(b"\0", at + 8)
        name = table[at + 8:end].decode("latin-1")
        if re.fullmatch(r"V2IP_\d{3}[A-Z]\.o", name):
            names.append(name[:-2])
        at = end + 1
    return names
