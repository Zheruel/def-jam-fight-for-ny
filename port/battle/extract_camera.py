"""Export the stage camera values consumed by SLUS-21004 routine 0x1ae398."""
import argparse
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "ps2/battle"))
from battle_patch import Disc
from refpack import decompress


def configuration(disc, venue):
    archive = "/ASSETS/V2BG.VIV"
    offset, length = disc.viv_entry(archive, venue + ".xml")
    data = disc.read(archive, offset, length)
    if data.startswith(b"\x10\xfb"):
        data = decompress(data)
    # The retail parser seeks /camera, reads its children and exits at the closing tag.
    section = re.search(rb"<camera>(.*?)</camera>", data, re.S)
    if section is None:
        raise ValueError(f"Missing camera in {venue}")
    tags = {name.decode(): float(value) for name, value in
            re.findall(rb"<(\w+)>\s*(-?[\d.]+)\s*</\1>", section[1])}
    return [tags.get("changepos", 0), tags.get("lowfov", tags.get("fov", 35)),
            tags.get("highfov", tags.get("fov", 35)), -abs(tags.get("lowangle", 25)),
            -abs(tags.get("highangle", 25)), tags.get("highoffset", tags.get("offset", 0)),
            tags.get("lowoffset", tags.get("offset", 0)), tags.get("upcamera", 6)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("disc")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    disc = Disc(args.disc)
    try:
        venues = json.loads((ROOT / "ps2/content/inventory.json").read_text())["venues"]
        settings = {v["file"]: configuration(disc, v["file"]) for v in venues}
    finally:
        disc.close()
    output = HERE / "cameras.json"
    data = "{\n" + ",\n".join(f'  "{key}": {json.dumps(values)}' for key, values in sorted(settings.items())) + "\n}\n"
    if args.check:
        if output.read_text() != data:
            raise SystemExit("Stage camera settings differ from the disc")
    else:
        output.write_text(data)


if __name__ == "__main__":
    main()
