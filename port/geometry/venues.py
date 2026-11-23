"""Build textured native Battle venue buffers from retail EAGL mesh and SHPS data."""

import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import struct

from foundation import ARCHIVE, Disc, decompress, elf_links, triangle_indices, vif_tag
from ssh import textures

HERE = Path(__file__).resolve().parent
INVENTORY = HERE.parents[1] / "ps2/content/inventory.json"
OUTPUT = HERE / "venues"
U32 = struct.Struct("<I")
VERTEX = struct.Struct("<5f4B")


def geometry(model, blob):
    data, local, external = elf_links(blob, f"__Model:::{model}_branch")
    word = lambda at: U32.unpack_from(data, at)[0]
    draws = []
    shape = None
    for at in sorted(local.keys() | external.keys()):
        name = external.get(at)
        if name is not None:
            if "__EAGLMicroCode" in name:
                shape = None
            match = re.search(r";SHAPENAME=(\w{4}),1;", name)
            if match:
                shape = match[1]
            continue
        target = local[at]
        if word(at - 4) == 0x04000002 and word(target) == 0x50000000:
            # Display-list call -> DMA CALL -> REF pairs -> RET.
            tag = local[target + 4]
            while word(tag) >> 28 == 3:
                payload = local[tag + 4]
                if data[payload : payload + 4] == vif_tag(0x6C, 1, 0):
                    draws.append((shape, tag + 4))
                tag += 16
            if word(tag) >> 28 != 6:
                raise ValueError(f"{model}: unterminated DMA subroutine")
        elif at >= 8 and word(at - 8) == 0x14000004 and word(at - 4) >> 28 == 3:
            draws.append((shape, at))

    vertices, indices, batches = bytearray(), [], []
    mins = [math.inf] * 3
    maxs = [-math.inf] * 3
    used = Counter()
    for shape, ref in draws:
        p = local[ref]
        used[p] += 1
        end = p + (word(ref - 4) & 0xFFFF) * 16
        if p % 16 or end > len(data):
            raise ValueError("Unaligned or out-of-bounds position REF")
        while p < end and end - p > 15:
            if data[p : p + 4] != vif_tag(0x6C, 1, 0):
                raise ValueError(f"{model}: unexpected position payload")
            count = word(p + 4)
            shift = data[p + 20] - 0x14
            if (
                not 3 <= count <= 72
                or shift not in (-7, 0, 1, 4)
                or data[p + 8 : p + 20] != bytes(12)
            ):
                raise ValueError(f"{model}: invalid vertex packet header")
            for offset, address in ((20, 0x14), (28, 0x15), (36, 0x16)):
                if data[p + offset : p + offset + 4] != vif_tag(
                    0x6E, 1, address + shift
                ):
                    raise ValueError("Invalid strip list")
            boundary = (
                data[p + 24 : p + 28] + data[p + 32 : p + 36] + data[p + 40 : p + 44]
            ).rstrip(b"\0")
            textured = shift != -7
            if textured != (shape is not None):
                raise ValueError("Shader material disagrees with VIF format")
            stride = 3 if textured else 2
            cuts = [0, *(value // stride for value in boundary), count]
            if any(value % stride for value in boundary) or any(
                b - a < 3 for a, b in zip(cuts, cuts[1:])
            ):
                raise ValueError("Invalid strip boundary")
            uv = p + 48 + count * 16
            if shift == 4:
                if data[uv : uv + 4] != vif_tag(0x6C, count, 0x57):
                    raise ValueError("Missing environment-mapped normal stream")
                uv += 4 + count * 16
            uv_address = 0x93 if shift == 4 else 0x5F + shift
            color_address = {-7: 0x80, 0: 0xA7, 1: 0xA8, 4: 0xCF}[shift]
            tail = uv + 4 + count * 16 if textured else uv
            if data[p + 44 : p + 48] != vif_tag(0x6C, count, 0x17 + shift) or (
                textured and data[uv : uv + 4] != vif_tag(0x6C, count, uv_address)
            ):
                raise ValueError("Unsupported VIF attribute layout")
            if word(tail) == 0x17000000:
                color = local[ref - 16]
                if word(ref - 20) != 0x30000000 | ((4 + count * 4 + 15) // 16):
                    raise ValueError("Invalid separate color REF")
            else:
                color = tail
                tail += 4 + 4 * count
            if word(tail) != 0x17000000 or data[color : color + 4] != vif_tag(
                0x6E, count, color_address
            ):
                raise ValueError("Invalid color or MSCNT")
            if tail + 4 > end:
                raise ValueError(
                    "Position DMA size or alignment disagrees with VIF data"
                )

            packet_indices = triangle_indices(len(vertices) // VERTEX.size, cuts)
            if not batches or batches[-1]["shape"] != shape:
                batches.append({"shape": shape, "first": len(indices), "count": 0})
            batches[-1]["count"] += len(packet_indices)
            indices.extend(packet_indices)
            for i in range(count):
                x, y, z, w = struct.unpack_from("<4f", data, p + 48 + i * 16)
                u, v, q, pad = (
                    struct.unpack_from("<4f", data, uv + 4 + i * 16)
                    if textured
                    else (0, 0, 1, 0)
                )
                if (w, q, pad) != (1, 1, 0) or not all(
                    map(math.isfinite, (x, y, z, u, v))
                ):
                    raise ValueError("Invalid position or UV")
                rgba = data[color + 4 + i * 4 : color + 8 + i * 4]
                vertices.extend(VERTEX.pack(x, y, z, u, v, *rgba))
                for axis, value in enumerate((x, y, z)):
                    mins[axis] = min(mins[axis], value)
                    maxs[axis] = max(maxs[axis], value)
            p = tail + 4
        if any(data[p:end]):
            raise ValueError("Nonzero VIF padding")
    # All relocated position packets must be reached through a material-bearing draw list.
    expected = {
        p
        for at, p in local.items()
        if at >= 4
        and word(at - 4) >> 28 == 3
        and data[p : p + 4] == vif_tag(0x6C, 1, 0)
    }
    if not expected or expected != used.keys():
        raise ValueError(
            f"{model}: {len(expected - used.keys())} unreached packets, materials {set(b['shape'] for b in batches)}"
        )
    return (
        vertices,
        indices,
        {
            "bounds": {"min": mins, "max": maxs},
            "batches": batches,
            "packets": len(draws),
        },
    )


def member(disc, name):
    path = "/" + ARCHIVE
    at, size = disc.viv_entry(path, name)
    raw = disc.read(path, at, size)
    return decompress(raw) if raw[:2] == b"\x10\xfb" else raw


def pack(disc, model):
    obj, ssh = (member(disc, model + ext) for ext in (".o", ".ssh"))
    vertices, indices, meta = geometry(model, obj)
    meta.update(
        model=model,
        vertices=len(vertices) // VERTEX.size,
        indices=len(indices),
        objectSha256=hashlib.sha256(obj).hexdigest(),
        texturesSha256=hashlib.sha256(ssh).hexdigest(),
    )
    buf = bytearray(vertices)
    meta["indexBytes"] = 2 if max(indices) <= 65535 else 4
    buf.extend(
        struct.pack(
            f"<{len(indices)}" + ("H" if meta["indexBytes"] == 2 else "I"), *indices
        )
    )
    images = textures(ssh)
    meta["textures"] = {}
    for shape in sorted(
        {b["shape"] for b in meta["batches"] if b["shape"] is not None}
    ):
        png = images[shape]
        meta["textures"][shape] = [len(buf), len(png)]
        buf.extend(png)
    header = json.dumps(meta, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    return gzip.compress(
        b"DJS1" + U32.pack(len(header)) + header + buf, compresslevel=6, mtime=0
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("iso", type=Path)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    disc = Disc(str(args.iso))
    try:
        OUTPUT.mkdir(exist_ok=True)
        for arena in json.loads(INVENTORY.read_text())["venues"]:
            model = arena["file"]
            packed = pack(disc, model)
            path = OUTPUT / (model + ".scene.gz")
            if args.check:
                if gzip.decompress(path.read_bytes()) != gzip.decompress(packed):
                    raise ValueError(f"Mismatch for {model}")
            else:
                path.write_bytes(packed)
    finally:
        disc.close()


if __name__ == "__main__":
    main()
