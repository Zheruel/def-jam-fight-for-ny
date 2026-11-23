"""Export original front-end screens (EA Apt movies in SCREENS.VIV) as a draw list plus their pictures.

    python3 port/hud/screens/extract.py private/ps2/reference.iso [--output port/hud/screens]

Each screen `<name>` becomes `<name>.json` (640x480 draw list, see port/hud/apt.py) and `<name>-<n>.png` pictures.
Each image shape's picture is the SHPS texture tagged with the image character before it (apt.pair_pictures); shapes
without one are exported as `slot` rectangles for the page to fill (portraits, bars).
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

SCREENS = {"rematch": "screens/battle/rematch.big"}


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
            art = {k.strip(): v for k, v in textures(parts[f"{name}.ssh"]).items()}
            pairing = apt.pair_pictures(movie, list(art))
            elements = []
            for e in movie.flatten(0, 0):
                e = {k: v for k, v in e.items() if k != "depth"}
                if e["kind"] == "image":
                    # a shape with no image before it is a plain fill or a picture the script loads at run time
                    e["kind"] = "image" if e["character"] in pairing else "slot"
                    if e["kind"] == "image":
                        e["picture"] = pairing[e["character"]]
                else:
                    e["size"] = round(e["size"], 2)
                e["rect"] = [round(v, 2) for v in e["rect"]]
                del e["character"]
                elements.append(e)
            used = sorted({e["picture"] for e in elements if e["kind"] == "image"}, key=int)
            for tag in used:
                (output / f"{name}-{tag}.png").write_bytes(art[tag])
            for e in elements:
                if e["kind"] == "image":
                    e["picture"] = used.index(e["picture"])
            (output / f"{name}.json").write_text(json.dumps({
                "screen": member, "size": list(movie.size),
                "pictures": [{"file": f"{name}-{tag}.png", "size": list(png_size(art[tag]))} for tag in used],
                "elements": elements}, indent=1) + "\n")
            print(f"{name}: {len(elements)} elements, {len(used)} pictures")
    finally:
        disc.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--output", type=Path, default=HERE)
    args = parser.parse_args()
    export(args.iso, args.output)
