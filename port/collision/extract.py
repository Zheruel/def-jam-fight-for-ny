"""Extract each Battle venue's uncompressed CLLI contact surface table."""
import argparse
import json
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "geometry"))
from venues import Disc, INVENTORY, member


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    disc = Disc(args.iso)
    try:
        for venue in json.loads(INVENTORY.read_text())["venues"]:
            name = venue["file"] + ".cli"
            data = member(disc, name)
            magic, groups = struct.unpack_from("<4sI", data)
            start = 8 + groups * 48
            planes, = struct.unpack_from("<I", data, start)
            if magic != b"CLLI" or len(data) != start + 4 + planes * 72:
                raise ValueError(f"Invalid collision table in {name}")
            target = HERE / "venues" / name
            if args.check:
                if target.read_bytes() != data:
                    raise ValueError(f"Retail collision data differs for {name}")
            else:
                target.write_bytes(data)
    finally:
        disc.close()


if __name__ == "__main__":
    main()
