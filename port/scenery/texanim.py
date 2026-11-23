#!/usr/bin/env python3
"""Animated texture planes (`TEXANIM.VIV`): <venue>/texanim.json and <venue>/texanim.png.

    texanim.py [iso] [--check]

Red Hook's fire is not a particle effect (its `<roundfire>` names `fx_fireG2`, which only The Heights' JDI defines). It is the
68 flame planes of `ta_V2BG_07a.big`, a BIGF inside TEXANIM.VIV:

    ta_V2BG_07a.ssh   33 SHPS textures of 128 x 128, 8-bit: 16 "torc" frames, 16 "flam" frames and one "ta_c" (coal) frame
    ta_V2BG_07a.tax   the sequence table: 10 records {name hash, 0, 0, 0, frame count, list offset, 28 x index} then the
                      u32 frame index lists. Hashes are h * 33 + c; torch0..3 are f056b635 + 33 k (frames 0..15 rotated by
                      k), flame0..3 are b279b83a + 33 k (frames 16..31, rotated), the coal is one frame (32)
    texobj0..67.o     one plane each, a PS2 VIF packet: 4 (the floor wedges: more) xyzw vertices in world space, the ST
                      coordinates, the ColourScaleFactor (0.849) and the render state, which the object's own string table
                      names: additive blend, alpha, no Z writes, `TXANM::<sequence>` (torch0..3, flame0..3, ta_coal).

VERIFIED: the planes' world positions, sizes and orientations (a ring of flame planes around radius 48-58, torches on the
walls, coal wedges on the floor), their sequence names, the textures, the additive blend. INFERRED: the playback rate (the
page plays one frame per `RATE` game ticks) and the fire-radius gating the renderer applies.
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import extract as scenery  # noqa: E402

ARCHIVE = "/ASSETS/TEXANIM.VIV"
MEMBERS = {"V2BG_07A": "assets/ta_V2BG_07a.big"}
GRID = 6          # the atlas holds the 33 frames in a 6 x 6 grid of 128 x 128 tiles
TILE = 128
TORCH, FLAME = 0xF056B635, 0xB279B83A
COAL = 0x9930DB58
COMMON_SCALE = 0.849


def big(blob: bytes) -> dict[str, bytes]:
    count, header = struct.unpack_from(">II", blob, 8)
    out, pos = {}, 16
    for _ in range(count):
        offset, size = struct.unpack_from(">II", blob, pos)
        end = blob.index(b"\0", pos + 8)
        out[blob[pos + 8:end].decode("latin-1").split("/")[-1]] = blob[offset:offset + size]
        pos = end + 1
    return out


def shps(ssh: bytes) -> list[bytes]:
    """RGBA 128 x 128 images of every texture of an SHPS file, in order (the shape names repeat, the index is the key)."""
    magic, length, count = struct.unpack_from("<4sII", ssh)
    if magic != b"SHPS" or length != len(ssh):
        raise ValueError("not an SHPS file")
    frames = []
    for i in range(count):
        _, start = struct.unpack_from("<4sI", ssh, 16 + i * 8)
        kind = ssh[start]
        width, height = struct.unpack_from("<HH", ssh, start + 4)
        if kind != 2 or (width, height) != (TILE, TILE):
            raise ValueError("unexpected texture format")
        clut = start + int.from_bytes(ssh[start + 1:start + 4], "little")
        palette = []
        for k in range(256):
            at = (k & ~24) | ((k & 8) << 1) | ((k & 16) >> 1)   # CSM1 CLUT swizzle (ssh.py)
            r, g, b, a = ssh[clut + 16 + 4 * at:clut + 20 + 4 * at]
            palette.append(bytes((r, g, b, min(255, a * 2))))
        pixels = ssh[start + 16:start + 16 + width * height]
        frames.append(b"".join(palette[p] for p in pixels))
    return frames


def png(width: int, height: int, rgba: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def atlas(frames: list[bytes]) -> bytes:
    side = GRID * TILE
    canvas = bytearray(side * side * 4)
    for i, frame in enumerate(frames):
        x0, y0 = (i % GRID) * TILE, (i // GRID) * TILE
        for y in range(TILE):
            start = ((y0 + y) * side + x0) * 4
            canvas[start:start + TILE * 4] = frame[y * TILE * 4:(y + 1) * TILE * 4]
    return png(side, side, bytes(canvas))


def sequences(tax: bytes) -> dict[str, list[int]]:
    count, _, lists = struct.unpack_from("<3I", tax)
    out = {}
    for i in range(count):
        h, _, _, _, frames, offset, _ = struct.unpack_from("<7I", tax, 12 + 28 * i)
        out[h] = list(struct.unpack_from(f"<{frames}I", tax, lists + offset))
    named = {}
    for k in range(4):
        named[f"torch{k}"] = out[(TORCH + 33 * k) & 0xFFFFFFFF]
        named[f"flame{k}"] = out[(FLAME + 33 * k) & 0xFFFFFFFF]
    named["ta_coal"] = out[COAL]
    return named


def data_section(obj: bytes) -> bytes:
    shoff = struct.unpack_from("<I", obj, 0x20)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", obj, 0x2E)
    strings = struct.unpack_from("<10I", obj, shoff + shstrndx * shentsize)[4]
    for i in range(shnum):
        s = struct.unpack_from("<10I", obj, shoff + i * shentsize)
        if obj[strings + s[0]:obj.index(b"\0", strings + s[0])] == b".data":
            return obj[s[4]:s[4] + s[5]]
    raise ValueError("no .data")


def plane(obj: bytes) -> dict:
    """World vertices (a triangle strip), ST coordinates, colour scale and sequence name of one flame plane."""
    data = data_section(obj)
    name = re.search(rb"TXANM::(\w+)", obj).group(1).decode()
    # VIF UNPACK V4-32 commands: the first holds the xyz1 vertices, the next the ST triples of the same count.
    unpacks = [(i, (w >> 16) & 0xFF) for i in range(0, len(data) - 4, 4)
               for (w,) in [struct.unpack_from("<I", data, i)] if w >> 24 == 0x6C and (w >> 16) & 0xFF >= 3]
    start, count = unpacks[0]
    vertices = [struct.unpack_from("<3f", data, start + 4 + 16 * k) for k in range(count)]
    if any(struct.unpack_from("<f", data, start + 4 + 16 * k + 12)[0] != 1.0 for k in range(count)):
        raise ValueError(f"{name}: vertices are not xyz1")
    st_at = next(i for i, n in unpacks[1:] if n == count)
    st = [struct.unpack_from("<2f", data, st_at + 4 + 16 * k) for k in range(count)]
    scale = None
    for i in range(st_at, len(data) - 16, 4):
        quad = struct.unpack_from("<4f", data, i)
        if quad[0] == quad[1] == quad[2] == quad[3] and 0.1 < quad[0] <= 2:
            scale = quad[0]
            break
    if scale is None:   # the flame2 planes store 5.18e-05 here: the runtime sets their scale; use the common one
        scale = COMMON_SCALE
    return {"sequence": name, "scale": round(scale, 4), "vertices": [[round(v, 3) for v in p] for p in vertices],
            "st": [[round(v, 4) for v in p] for p in st]}


def build(disc, venue: str) -> dict[str, bytes]:
    parts = big(scenery.member(disc, ARCHIVE, MEMBERS[venue]))
    key = next(k for k in parts if k.endswith(".tax"))
    frames = shps(parts[next(k for k in parts if k.endswith(".ssh"))])
    planes = [plane(parts[k]) for k in sorted((k for k in parts if "texobj" in k), key=lambda k: int(re.search(r"texobj(\d+)", k).group(1)))]
    manifest = {"format": "def-jam-ps2-texanim/1", "venue": venue, "atlas": {"file": "texanim.png", "tile": TILE, "grid": GRID, "frames": len(frames)},
                "sequences": sequences(parts[key]), "planes": planes}
    return {"texanim.json": (json.dumps(manifest, separators=(",", ":")) + "\n").encode(), "texanim.png": atlas(frames)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("iso", type=Path, nargs="?", default=scenery.DEFAULT_ISO)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    disc = scenery.Disc(str(args.iso))
    bad = []
    try:
        for venue in MEMBERS:
            for name, blob in build(disc, venue).items():
                path = HERE / scenery.directory(venue) / name
                if args.check:
                    if not path.exists() or path.read_bytes() != blob:
                        bad.append(str(path.relative_to(HERE)))
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(blob)
    finally:
        disc.close()
    if bad:
        print("differs:", *bad)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
