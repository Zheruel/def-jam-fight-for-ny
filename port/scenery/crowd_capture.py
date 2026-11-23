#!/usr/bin/env python3
"""Spectator data read from the retail RAM captures: classes (part sets), who is in which, and live poses.

    crowd_capture.py            rewrite foundation/crowd-poses.json and people/captures.json

The Foundation keeps its own fixture (foundation/crowd-poses.json: the one-on-one image plus three four-player frames).
The three arena captures (private/verification/special: Club Murder, Gun Hill Garage, Dragon House) go to
people/captures.json, which is all `crowd_bank.py` needs from RAM.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
import crowd_pose  # noqa: E402

FOUNDATION = {
    "one-on-one/fighter-ram-0": "private/verification/ps2-match/run-BjNMn0/fighter-ram-0.bin",
    "four-start/start-0": "private/ps2-battle/four-start/start-0.bin",
    "four-start/start-40": "private/ps2-battle/four-start/start-40.bin",
    "four-start/start-70": "private/ps2-battle/four-start/start-70.bin",
}
ARENAS = {   # id -> (venue file, [captured frames])
    "clubmurder": ("V2BG_14A", ["private/verification/special/cage/fight-start.bin", "private/verification/special/cage/fight-later.bin"]),
    "gunhill": ("V2BG_17A", ["private/verification/special/demolition/fight-start.bin", "private/verification/special/demolition/fight-later.bin"]),
    "dragonhouse": ("V2BG_05A", ["private/verification/special/ringout/fight-start.bin", "private/verification/special/ringout/fight-later.bin"]),
}


def describe(ram: bytes) -> dict:
    """Classes (part lists, ordered by class address), each instance's class index, style words and pose."""
    found = crowd_pose.instances(ram)
    groups = sorted({each["group"] for each in found})
    exported = crowd_pose.export(ram)
    return {"classes": [crowd_pose.class_parts(ram, group) for group in groups],
            "byName": {each["name"]: groups.index(each["group"]) for each in found},
            "styles": exported["styles"], "instances": exported["instances"], "bind": exported["bind"]}


def foundation() -> dict:
    frames, first = {}, None
    for key, path in FOUNDATION.items():
        seen = describe((REPO / path).read_bytes())
        frames[key] = seen["instances"]
        first = first or seen
    return {"format": "def-jam-ps2-crowd-poses/1", "venue": "V2BG_02A", "bones": crowd_pose.BONES, "parents": crowd_pose.PARENTS,
            "entry": "qx qy qz qw tx ty tz (local to the parent; scale is 1)", "bind": first["bind"],
            "classes": first["byName"], "classParts": first["classes"], "styles": first["styles"], "frames": frames}


def arenas(bind: list) -> dict:
    out = {}
    for key, (venue, paths) in ARENAS.items():
        seen = [describe((REPO / path).read_bytes()) for path in paths]
        if any(each["bind"] != bind for each in seen):
            raise ValueError(f"{key}: the bind pose differs from the Foundation's")
        first = seen[0]
        out[key] = {"venue": venue, "classParts": first["classes"],
                    "spectators": {name: {"class": klass, "style": first["styles"][name],
                                          "poses": [each["instances"][name] for each in seen if name in each["instances"]]}
                                   for name, klass in sorted(first["byName"].items()) if all(name in each["instances"] for each in seen)}}
    return out


def main() -> int:
    fixture = foundation()
    (HERE / "foundation" / "crowd-poses.json").write_text(json.dumps(fixture, separators=(",", ":")) + "\n")
    out = HERE / "people"
    out.mkdir(exist_ok=True)
    (out / "captures.json").write_text(json.dumps({"format": "def-jam-ps2-crowd-captures/1", "captures": arenas(fixture["bind"])},
                                                  separators=(",", ":")) + "\n")
    print("Foundation classes", fixture["classParts"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
