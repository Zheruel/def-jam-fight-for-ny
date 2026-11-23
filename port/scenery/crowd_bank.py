#!/usr/bin/env python3
"""Foundation spectators: the pose bank and the people manifest the native renderer plays.

    crowd_bank.py                                  bank from the committed RAM snapshots (provisional)
    crowd_bank.py --recording crowd-recording.bin.gz [--loop 600] [--step 2]
                                                   bank from the retail per-VBlank recording
                                                   (verification/capture-crowd.mjs)

Writes foundation/people/{poses.bin.gz,people.json}.

poses.bin.gz is "DJPB", u32 header length, a JSON header, then float32
[frame][spectator][13 bones][qx qy qz qw tx ty tz], local to the parent bone. Playing frame `i` of
`frames` at `rate` game ticks per frame, looping, with the neighbours blended.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import struct
import sys
from pathlib import Path

import people

HERE = Path(__file__).resolve().parent
OUT = HERE / "foundation" / "people"


def read_poses() -> dict:
    return json.loads((HERE / "foundation" / "crowd-poses.json").read_text())


def read_recording(path: Path) -> tuple[dict, list[list[list[float]]]]:
    """Header and frames (frame -> spectator -> 13*7 floats) of a DJCR recording."""
    raw = gzip.open(path).read() if path.suffix == ".gz" else path.read_bytes()
    if raw[:4] != b"DJCR":
        raise ValueError("not a crowd recording")
    size = struct.unpack_from("<I", raw, 4)[0]
    header = json.loads(raw[8:8 + size])
    stride = len(header["names"]) * 13 * 7
    count = header["frames"]
    flat = struct.unpack_from(f"<{count * stride}f", raw, 8 + size)
    frames = [[list(flat[f * stride + i * 91:f * stride + (i + 1) * 91]) for i in range(len(header["names"]))] for f in range(count)]
    return header, frames


def blend(a: list[float], b: list[float], t: float) -> list[float]:
    """Interpolate two 13x7 poses: quaternions by normalised lerp on the short arc, translations linearly."""
    out = []
    for bone in range(13):
        qa, qb = a[bone * 7:bone * 7 + 4], b[bone * 7:bone * 7 + 4]
        sign = 1.0 if sum(x * y for x, y in zip(qa, qb)) >= 0 else -1.0
        q = [x * (1 - t) + sign * y * t for x, y in zip(qa, qb)]
        length = math.sqrt(sum(v * v for v in q)) or 1.0
        out += [v / length for v in q]
        out += [x * (1 - t) + y * t for x, y in zip(a[bone * 7 + 4:bone * 7 + 7], b[bone * 7 + 4:bone * 7 + 7])]
    return out


def resample(header: dict, frames: list, loop: int | None, step: int) -> tuple[list, int]:
    """One sample per game tick from the first sample's counter (VBlank samples can repeat or skip a tick), then every `step`th."""
    counters = header["counters"]
    first, last = counters[0], counters[-1]
    ticks = []
    at = 0
    for tick in range(first, last + 1):
        while at + 1 < len(counters) and counters[at + 1] <= tick:
            at += 1
        low, high = at, min(at + 1, len(counters) - 1)
        span = counters[high] - counters[low]
        t = 0.0 if span <= 0 else min(1.0, max(0.0, (tick - counters[low]) / span))
        ticks.append([blend(a, b, t) for a, b in zip(frames[low], frames[high])] if t else frames[low])
    if loop:
        ticks = ticks[:loop]
    return ticks[::step], len(ticks)


def write_bank(path: Path, names: list[str], frames: list, rate: int, source: str, extra: dict | None = None) -> None:
    header = json.dumps({"format": "def-jam-ps2-crowd-bank/1", "source": source, "names": names, "frames": len(frames),
                         "rate": rate, **(extra or {})}, separators=(",", ":")).encode()
    header += b" " * ((4 - len(header) % 4) % 4)
    flat = [v for frame in frames for person in frame for v in person]
    blob = b"DJPB" + struct.pack("<I", len(header)) + header + struct.pack(f"<{len(flat)}f", *flat)
    path.write_bytes(gzip.compress(blob, 9, mtime=0))


def provisional(poses: dict) -> tuple[list[str], list, int]:
    """The RAM snapshots as a looping animation (until the retail recording replaces it).

    The one-on-one capture holds all 30 spectators; the four-player ones only 26, so the other four hold their
    one-on-one pose."""
    still = poses["frames"]["one-on-one/fighter-ram-0"]
    names = sorted(still)
    moving = [poses["frames"][key] for key in sorted(poses["frames"]) if key.startswith("four-start/")]
    keys = [[[v for entry in frame.get(name, still[name]) for v in entry] for name in names] for frame in moving]
    return names, keys + [keys[0]], 40


def manifest(poses: dict, names: list[str], bank: str, rate: int, source: str) -> dict:
    scenery = json.loads((HERE / "foundation" / "scenery.json").read_text())
    placed = {p["name"]: p for p in scenery["nearCrowd"]}
    worn = people.outfits()
    return {
        "format": "def-jam-ps2-people/1",
        "classes": [f"class{k}.skin.gz" for k in range(3)],
        "bank": {"file": bank, "rate": rate, "source": source},
        "bones": poses["bones"], "parents": poses["parents"],
        "spectators": [{"name": name, "class": poses["classes"][name], "index": i,
                        "translate": placed[name]["translate"], "rotate": placed[name]["rotate"],
                        "scale": poses.get("scales", {}).get(name, 1.0),
                        "outfit": worn[name]} for i, name in enumerate(names)],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recording", type=Path)
    ap.add_argument("--loop", type=int, help="keep the first N game ticks of the recording")
    ap.add_argument("--step", type=int, default=1, help="keep every Nth tick (the player blends the gaps)")
    args = ap.parse_args(argv)
    poses = read_poses()
    if args.recording:
        header, frames = read_recording(args.recording)
        names = header["names"]
        kept, total = resample(header, frames, args.loop, args.step)
        rate, source = args.step, f"retail recording, {total} ticks"
    else:
        names, kept, rate = provisional(poses)
        source = "snapshots"
    OUT.mkdir(parents=True, exist_ok=True)
    write_bank(OUT / "poses.bin.gz", names, kept, rate, source)
    (OUT / "people.json").write_text(json.dumps(manifest(poses, names, "poses.bin.gz", rate, source), indent=1) + "\n")
    print(f"{len(names)} spectators, {len(kept)} frames at {rate} ticks ({source})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
