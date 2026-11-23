"""Export Battle starting positions from the verified US PS2 GAMECORE table."""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from disc import catalog

SHA256 = "995336a6bed1f3a989e80972018013456475c9ce171416ecb163b143dbc2f2fa"
PLAYER_COUNTS = {"SINGLE": 2, "2 vs 2 TAG": 4, "FREE FOR ALL 3": 3, "FREE FOR ALL 4": 4}
OUTPUT = Path(__file__).with_name("lineups.json")


def positions(raw, venues):
    if hashlib.sha256(raw).hexdigest() != SHA256:
        raise ValueError("Unexpected SLUS-21004 GAMECORE.XML")
    text = raw.decode("utf-8").split("<start position>", 1)[1].split("</start position>", 1)[0]
    # Retail tag names include spaces and even a slash in '18A 50/50 WAREHOUSE'.
    rooms = {}
    for code, label, body in re.findall(r"<((?:\d\d)[A-Z]) ([^>]+)>(.*?)</\1 \2>", text, re.S):
        if code in rooms:
            raise ValueError(f"Duplicate arena {code}")
        formations = {}
        for mode, count in PLAYER_COUNTS.items():
            pattern = rf"<{mode}>(.*?)</{mode}>"
            section = re.search(pattern, body, re.S)
            if not section:
                continue
            slots = re.findall(r"<(\d)P>\s*(-?\d+)\s*,\s*(-?\d+)\s*</\1P>", section[1])
            if [int(slot[0]) for slot in slots] != list(range(1, count + 1)):
                raise ValueError(f"Unexpected slot order in {label}, {mode}")
            formations[mode] = [[int(x), int(y)] for _, x, y in slots]
        rooms[code] = formations
    return {v["file"]: rooms[v["file"].removeprefix("V2BG_")] for v in venues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("disc", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with args.disc.open("rb") as stream:
        entry = catalog(stream)["files"]["ASSETS/GAMECORE.XML"]
        stream.seek(entry["offset"])
        raw = stream.read(entry["bytes"])
    venues = json.loads((ROOT / "ps2/content/inventory.json").read_text())["venues"]
    data = positions(raw, venues)
    if len(data) != len(venues) or any("SINGLE" not in arena for arena in data.values()):
        raise ValueError("Incomplete Battle venue table")
    # Keep each formation on one line for review.
    rows = []
    for key, formations in sorted(data.items()):
        fields = [f"    {json.dumps(mode)}: {json.dumps(slots)}" for mode, slots in formations.items()]
        rows.append(f"  {json.dumps(key)}: {{\n" + ",\n".join(fields) + "\n  }")
    output = "{\n" + ",\n".join(rows) + "\n}\n"
    if args.check:
        if OUTPUT.read_text() != output:
            raise SystemExit("lineups.json differs from the verified retail table")
    else:
        OUTPUT.write_text(output)


if __name__ == "__main__":
    main()
