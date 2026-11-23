#!/usr/bin/env python3
"""Stage particle definitions (`V2BG_<venue>.jdi`): <venue>/particles.json and <venue>/particles.png.

    particles.py [iso] [--venue V2BG_xx|all] [--check]

A JDI is a table of 16-byte rows {tag, flags | size << 8, count, offset}; the tags are 4 characters stored reversed in the
file. Verified structure (every one of the 24 stage files parses to the same shape):

    row 0     TIME, count = effects + 1
    rows 1..n TRAP, one per effect; `offset` is the row distance to that effect's first row
    row n+1   TEXR: an SHPS image (one 256x256 8-bit sheet, "0000") with the effects' sprite tiles
    rows ..   ME, one name per effect ("fx_V2BG_04A.fx_trainF1")
    effect    LY, Name (128 bytes), MESH (a float count, then that many xyz points), GLOB (1), DA (280 bytes)

DA is the emitter's parameters. Which fields mean what was read off the 992 records of all stages, the native event
scripts and the retail memory image (the runtime copies the record and rescales it), not from the particle code, so the
meaning of each field below is INFERRED unless noted:

    +0x00  flags (0x22 0x26 0x82 0x86 0xa6 0x06 0x8a ...)             +0x04  size (0.07 .. 1.0)
    +0x08  burst count                                                +0x0c  lifetime, milliseconds (0: until stopped)
    +0x14 +0x18  vertical velocity x 1000 (`rise`)                    +0x1c +0x20  speed range (`speed`)
    +0x24 +0x28  spread (often +-)                                    +0x34 +0x38  mode, blend (1 additive, others alpha)
    +0x44  start colour R G B A bytes (VERIFIED against the train lights: white head lights, red tail lights)
    +0x4c  end colour, same layout                                    +0xb4  opacity
    +0xc8  frame count, then +0xcc, three floats per frame: sprite tile u, v and size in the sheet (VERIFIED: the flame
           column, the smoke column and the glow tiles land on the right sprites)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import extract as scenery  # noqa: E402
sys.path.insert(0, str(HERE.parent / "geometry"))
import ssh as ssh_module  # noqa: E402

STAGE = "/ASSETS/V2BG.VIV"


class Jdi:
    def __init__(self, blob: bytes):
        self.blob = blob
        self.tag0, self.flags0, self.count, self.offset0 = struct.unpack_from("<IIII", blob, 0)
        if blob[:4] != b"TIME":
            raise ValueError("not a JDI")
        self.effects = self.count - 1

    def row(self, i: int) -> tuple[bytes, int, int, int]:
        tag, flags, count, offset = struct.unpack_from("<IIII", self.blob, i * 16)
        return tag.to_bytes(4, "little"), flags, count, offset

    def data(self, i: int) -> bytes:
        _, flags, _, offset = self.row(i)
        return self.blob[i * 16 + offset:i * 16 + offset + (flags >> 8)]

    def texture(self) -> bytes:
        return self.data(self.effects + 1)

    def effect(self, i: int) -> dict:
        name = self.data(self.effects + 2 + i).split(b"\0")[0].decode().split(".")[-1]
        first = 1 + i + self.row(1 + i)[3]
        # The effect's rows: LY, Name, MESH, GLOB, DA; the LY row's offset is the row distance to DA.
        da = self.data(first + self.row(first)[3])
        mesh = self.data(first + 2)
        return {"name": name, "da": da, "mesh": mesh}


def rgba(word: int) -> list[int]:
    return list(word.to_bytes(4, "little"))


def decode(effect: dict) -> dict:
    da = effect["da"]
    if len(da) != 280:
        raise ValueError(f"{effect['name']}: DA is {len(da)} bytes")
    w = struct.unpack("<70I", da)
    f = struct.unpack("<70f", da)
    points = int(struct.unpack_from("<f", effect["mesh"], 0)[0]) if len(effect["mesh"]) >= 4 else 0
    mesh = [[round(v, 3) for v in struct.unpack_from("<3f", effect["mesh"], 4 + 12 * k)] for k in range(points)
            if 4 + 12 * (k + 1) <= len(effect["mesh"])]
    frames = w[0xC8 // 4]
    tiles = [[round(f[(0xCC + 12 * k) // 4 + j], 6) for j in range(3)] for k in range(frames)]
    out = {"flags": w[0], "size": round(f[1], 6), "count": round(f[2], 3), "life": round(f[3]),
           "rise": [round(f[5]), round(f[6])], "speed": [round(f[7], 3), round(f[8], 3)],
           "spread": [round(f[9], 3), round(f[10], 3), round(f[11], 3), round(f[12], 3)],
           "mode": w[0x34 // 4], "blend": w[0x38 // 4], "start": rgba(w[0x44 // 4]), "end": rgba(w[0x4C // 4]),
           "opacity": round(f[0xB4 // 4], 4), "tiles": tiles, "points": mesh}
    return out


def build(disc, venue: str) -> dict[str, bytes]:
    blob = scenery.member(disc, STAGE, venue + ".jdi")
    jdi = Jdi(blob)
    effects = {}
    for i in range(jdi.effects):
        effect = jdi.effect(i)
        effects[effect["name"]] = decode(effect)
    sheets = ssh_module.textures(jdi.texture())
    manifest = {"format": "def-jam-ps2-particles/1", "venue": venue, "source": {"file": venue + ".jdi", "sha256": hashlib.sha256(blob).hexdigest()},
                "atlas": "particles.png", "effects": effects}
    return {"particles.json": (json.dumps(manifest, separators=(",", ":")) + "\n").encode(), "particles.png": sheets["0000"]}


def venues(disc) -> list[str]:
    inventory = json.loads((HERE.parents[1] / "ps2" / "content" / "inventory.json").read_text())
    names = sorted(v["file"] for v in inventory["venues"])
    return [v for v in names if _has(disc, v)]


def _has(disc, venue: str) -> bool:
    try:
        scenery.member(disc, STAGE, venue + ".jdi")
        return True
    except (FileNotFoundError, KeyError):
        return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("iso", type=Path, nargs="?", default=scenery.DEFAULT_ISO)
    ap.add_argument("--venue", default="all")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    disc = scenery.Disc(str(args.iso))
    bad = []
    try:
        for venue in (venues(disc) if args.venue == "all" else [args.venue]):
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
