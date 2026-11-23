"""Export original front-end screens (EA Apt movies in SCREENS.VIV) as a draw list plus their pictures.

    python3 port/hud/screens/extract.py private/ps2/reference.iso [--output port/hud/screens]

Each screen `<name>` becomes `<name>.json` (640x480 draw list, see port/hud/apt.py) and `<name>-<n>.png` pictures.
Picture <-> image-shape pairing is by size (apt.pair_pictures); the JSON records which picture each image uses.
"""
import argparse
import json
import re
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path[:0] = [str(ROOT / "ps2/battle"), str(ROOT / "port/geometry"), str(HERE.parent)]
from battle_patch import Disc  # noqa: E402
from refpack import decompress  # noqa: E402
from ssh import textures  # noqa: E402
import apt  # noqa: E402

SCREENS = {"rematch": "screens/battle/rematch.big", "matchSm2": "screens/battle/matchSm2.big"}


def members(big: bytes):
    count, _ = struct.unpack_from(">II", big, 8)
    pos, out = 16, {}
    for _ in range(count):
        offset, size = struct.unpack_from(">II", big, pos)
        end = big.index(b"\0", pos + 8)
        out[big[pos + 8:end].decode()] = big[offset:offset + size]
        pos = end + 1
    return out


def png_size(png: bytes):
    return struct.unpack(">II", png[16:24])


def export(iso: str, output: Path):
    disc = Disc(iso)
    output.mkdir(parents=True, exist_ok=True)
    try:
        archive = "/SCREENS/SCREENS.VIV"
        for name, member in SCREENS.items():
            raw = disc.read(archive, *disc.viv_entry(archive, member))
            parts = members(decompress(raw) if raw[:2] == bytes.fromhex("10fb") else raw)
            movie = apt.Apt.parse(parts[f"{name}.apt"])
            ssh = parts[f"{name}.ssh"]
            count = struct.unpack_from("<I", ssh, 8)[0]
            directory = bytearray(ssh)
            for i in range(count):
                directory[16 + i * 8:20 + i * 8] = f"{i:04x}".encode()
            art = textures(directory)
            keys = sorted(art)
            sizes = [png_size(art[k]) for k in keys]
            pairing = apt.pair_pictures(movie, sizes)
            for i, k in enumerate(keys):
                (output / f"{name}-{i}.png").write_bytes(art[k])
            elements = []
            for e in movie.flatten(0, 0):
                e = {k: v for k, v in e.items() if k not in ("depth",)}
                if e["kind"] == "image":
                    if e["character"] not in pairing:
                        continue
                    e["picture"] = pairing[e["character"]]
                else:
                    e["rect"] = [round(v, 2) for v in e["rect"]]
                    e["size"] = round(e["size"], 2)
                e["rect"] = [round(v, 2) for v in e["rect"]]
                del e["character"]
                elements.append(e)
            (output / f"{name}.json").write_text(json.dumps({
                "screen": member, "size": list(movie.size),
                "pictures": [{"file": f"{name}-{i}.png", "size": list(sizes[i])} for i in range(len(keys))],
                "elements": elements}, indent=1) + "\n")
            print(f"{name}: {len(elements)} elements, {len(keys)} pictures")
    finally:
        disc.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--output", type=Path, default=HERE)
    args = parser.parse_args()
    export(args.iso, args.output)
