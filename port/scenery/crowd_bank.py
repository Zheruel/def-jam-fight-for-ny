#!/usr/bin/env python3
"""Spectators for every venue with retail near-crowd positions: the shared pose bank and each venue's people manifest.

    crowd_bank.py [--recording crowd-recording.bin.gz] [--fade 60] [--step 2]
                                                   tracks from the retail per-VBlank recording
                                                   (verification/capture-crowd.mjs; default
                                                   private/verification/crowd/crowd-recording.bin.gz)
    crowd_bank.py --snapshots                      provisional tracks from the committed RAM snapshots

Writes people/poses.bin.gz, <venue>/people.json, the class meshes and outfit atlases they use (people.py), and records
the venues in index.json.

poses.bin.gz is "DJPB", u32 header length, a JSON header (`names`, `tracks`: [{frames, rate, offset}], `quant`), then int16
[pose][13 bones][qx qy qz qw tx ty tz], local to the parent bone, quaternions x 32767, translations x 256. A track loops, one
pose per `rate` game ticks, the neighbours blended. The retail animation clips are shared by every spectator type (the poses
the Club Murder, Gun Hill and Dragon House captures hold, stand1 included, are all found in the Foundation recording), so any
spectator can play any track: captured spectators start at the recorded frame that matches their captured pose.

Where each spectator's data comes from:
  * Foundation, Club Murder, Gun Hill Garage, Dragon House: the retail captures (crowd_capture.py): the person's own classes;
    the Foundation spectators play their own recorded track, the others the track and frame that matches their captured pose.
  * Every other venue: the stage's own positions and types, with classes DRAWN from the part sets seen in those captures
    following the stage XML's crowd ratios (sex; class[0] as the heavy share, a guess) and a random track. Seated, dancing and
    gym spectators (sit*, dancer*, gym*), whose clips were never recorded, are left to the instanced far crowd; act3, act4,
    stand2 and stand4 are assumed to share the standing clips (unverified).
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import random
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import people  # noqa: E402

PEOPLE = HERE / "people"


def foundation_fixture() -> dict:
    return json.loads((HERE / "foundation" / "crowd-poses.json").read_text())


def captures() -> dict:
    return json.loads((PEOPLE / "captures.json").read_text())["captures"]


def read_recording(path: Path) -> tuple[dict, list]:
    """Header and frames (frame -> spectator -> 13*7 floats) of a DJCR recording."""
    raw = gzip.open(path).read() if path.suffix == ".gz" else path.read_bytes()
    if raw[:4] != b"DJCR":
        raise ValueError("not a crowd recording")
    size = struct.unpack_from("<I", raw, 4)[0]
    header = json.loads(raw[8:8 + size])
    stride = len(header["names"]) * 13 * 7
    flat = struct.unpack_from(f"<{header['frames'] * stride}f", raw, 8 + size)
    return header, [[list(flat[f * stride + i * 91:f * stride + (i + 1) * 91]) for i in range(len(header["names"]))]
                    for f in range(header["frames"])]


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
    ticks, at = [], 0
    for tick in range(counters[0], counters[-1] + 1):
        while at + 1 < len(counters) and counters[at + 1] <= tick:
            at += 1
        low, high = at, min(at + 1, len(counters) - 1)
        span = counters[high] - counters[low]
        t = 0.0 if span <= 0 else min(1.0, max(0.0, (tick - counters[low]) / span))
        ticks.append([blend(a, b, t) for a, b in zip(frames[low], frames[high])] if t else frames[low])
    if loop:
        ticks = ticks[:loop]
    return ticks[::step], len(ticks)


def flat(pose: list) -> list[float]:
    return [v for entry in pose for v in entry]


def spectator_type(name: str) -> str:
    return name.split("_")[1]


def make_loop(header: dict, frames: list, fade: int, step: int) -> list:
    """One looping track per spectator from the recording: the last `fade` ticks are folded into the first so the end meets
    the start, then every `step`th tick is kept. Returns frame -> spectator -> flat 91 floats."""
    ticks, _ = resample(header, frames, None, 1)
    length = len(ticks) - fade
    looped = [ticks[t] if t >= fade else [blend(a, b, t / fade) for a, b in zip(ticks[length + t], ticks[t])] for t in range(length)]
    return looped[::step]


def build_tracks(recording: tuple | None) -> tuple[dict, str, int]:
    """{track name: {"rate", "poses": [flat 91 floats, ...]}}, a description of where the motion came from, loop ticks."""
    if recording:
        header, looped, step = recording
        tracks = {name: {"rate": step, "poses": [frame[i] for frame in looped]} for i, name in enumerate(header["names"])}
        return tracks, f"Foundation retail recording, {len(looped) * step} ticks looped", len(looped) * step
    fixture = foundation_fixture()
    moving = [fixture["frames"][k] for k in sorted(fixture["frames"]) if k.startswith("four-start/")]
    still = fixture["frames"]["one-on-one/fighter-ram-0"]
    tracks = {}
    for name in sorted(still):
        keys = [flat(frame[name]) for frame in moving] if all(name in frame for frame in moving) else [flat(still[name])]
        tracks[name] = {"rate": 40, "poses": keys + keys[:1] if len(keys) > 1 else keys}
    return tracks, "RAM snapshots (provisional)", 160


def pose_distance(a: list[float], b: list[float]) -> float:
    total = 0.0
    for i in range(0, 91, 7):
        sign = 1.0 if sum(x * y for x, y in zip(a[i:i + 4], b[i:i + 4])) >= 0 else -1.0
        total += sum((x - sign * y) ** 2 for x, y in zip(a[i:i + 4], b[i:i + 4]))
    return total


def best_match(tracks: dict, pose: list[float]) -> tuple[str, int, float]:
    """The (track, tick) whose pose is closest to `pose`."""
    best = (9e9, "", 0)
    for name, track in tracks.items():
        for frame, candidate in enumerate(track["poses"]):
            best = min(best, (pose_distance(pose, candidate), name, frame * track["rate"]))
    return best[1], best[2], best[0]


def write_bank(tracks: dict, source: str) -> list[str]:
    names, table, poses = list(tracks), [], []
    for name in names:
        t = tracks[name]
        table.append({"frames": len(t["poses"]), "rate": t["rate"], "offset": len(poses)})
        poses.extend(t["poses"])
    header = json.dumps({"format": "def-jam-ps2-crowd-bank/3", "source": source, "names": names, "tracks": table,
                         "quant": {"rotation": 32767, "translation": 256}}, separators=(",", ":")).encode()
    header += b" " * ((4 - len(header) % 4) % 4)
    values = []
    for pose in poses:
        for bone in range(13):
            values += [round(v * 32767) for v in pose[bone * 7:bone * 7 + 4]] + [round(v * 256) for v in pose[bone * 7 + 4:bone * 7 + 7]]
    if any(abs(v) > 32767 for v in values):
        raise ValueError("pose value out of int16 range")
    blob = b"DJPB" + struct.pack("<I", len(header)) + header + struct.pack(f"<{len(values)}h", *values)
    (PEOPLE / "poses.bin.gz").write_bytes(gzip.compress(blob, 9, mtime=0))
    return names


# ------------------------------------------------------------------------------------------------ classes

def family(parts: list[str]) -> str:
    return "F" if parts[0][0] == "F" else "B" if parts[0][0] == "B" else "M"


def pool() -> dict[str, list[list[str]]]:
    seen = {}
    fixture = foundation_fixture()
    for parts in fixture["classParts"] + [p for c in captures().values() for p in c["classParts"]]:
        seen[tuple(parts)] = parts
    out = {"M": [], "F": [], "B": []}
    for parts in seen.values():
        out[family(parts)].append(parts)
    return out


def draw_classes(venue: str, ratio: dict, count: int, available: dict) -> list[list[str]]:
    """`count` part sets for a venue whose own classes were not captured, by the stage's sex/class ratios."""
    rng = random.Random(venue)
    female = round(count * ratio["sex"][1] / 100)
    heavy = round((count - female) * ratio["class"][0] / 100)
    wanted = ["F"] * female + ["B"] * heavy + ["M"] * (count - female - heavy)
    return [rng.choice(available[f] or available["M"]) for f in wanted]


SEATED = ("sit", "dancer", "gym")   # clips never recorded


def venue_manifest(venue: str, scenery: dict, tracks: dict, loop: int, available: dict) -> dict | None:
    placed = scenery["nearCrowd"]
    fixture, caps = foundation_fixture(), captures()
    own = next(((k, c) for k, c in caps.items() if c["venue"] == venue), None)
    poses = {}   # captured pose per spectator, to start from the matching recorded frame
    if venue == "V2BG_02A":
        parts, assigned, styles, retail = fixture["classParts"], fixture["classes"], fixture["styles"], True
    elif own:
        parts, retail = own[1]["classParts"], True
        assigned = {n: s["class"] for n, s in own[1]["spectators"].items()}
        styles = {n: s["style"] for n, s in own[1]["spectators"].items()}
        poses = {n: flat(s["poses"][0]) for n, s in own[1]["spectators"].items()}
    else:
        assigned, styles, retail = {}, {}, False
        ratio = scenery.get("crowdModelRatio")
        if not ratio:
            return None
        parts = draw_classes(venue, ratio, max(1, scenery["crowdGroup"]["normal"]), available)
    parts = [list(p) for p in parts]
    names, spectators, skipped, known, matched = list(tracks), [], {}, people.table(), []
    for spot in placed:
        name, kind = spot["name"], spectator_type(spot["name"])
        if kind.startswith(SEATED):
            skipped[kind] = skipped.get(kind, 0) + 1
            continue
        rng = random.Random(f"{venue}:{name}")
        if venue == "V2BG_02A" and name in tracks:
            track, phase = name, 0
        elif name in poses:
            track, phase, miss = best_match(tracks, poses[name])
            matched.append(miss)
        else:
            track, phase = rng.choice(names), rng.randrange(loop)
        klass = assigned[name] if name in assigned else rng.randrange(len(parts))
        spectators.append({"name": name, "class": klass, "track": track, "phase": phase,
                           "translate": spot["translate"], "rotate": spot["rotate"],
                           "outfit": people.outfit(name, parts[klass], styles.get(name, [32, 32, 32, 32]), known)})
    if not spectators:
        return None
    return {"format": "def-jam-ps2-people/1", "venue": venue,
            "classes": [people.class_id(p) for p in parts], "classParts": parts,
            "classSource": "retail capture" if retail else "drawn from the captured part sets by the stage's crowd ratios",
            "spectators": spectators, "skipped": skipped, "placed": len(placed),
            "startMatch": {"spectators": len(matched), "worst": round(max(matched), 4)} if matched else None}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recording", type=Path, default=HERE.parents[1] / "private" / "verification" / "crowd" / "crowd-recording.bin.gz")
    ap.add_argument("--snapshots", action="store_true", help="provisional tracks from the RAM snapshots instead of a recording")
    ap.add_argument("--fade", type=int, default=60, help="ticks of the recording's end folded into its start to close the loop")
    ap.add_argument("--step", type=int, default=2, help="keep every Nth tick (the player blends the gaps)")
    ap.add_argument("--no-assets", action="store_true", help="skip the disc: manifests and bank only")
    args = ap.parse_args(argv)
    recording = None
    if not args.snapshots:
        header, frames = read_recording(args.recording)
        recording = (header, make_loop(header, frames, args.fade, args.step), args.step)
    tracks, source, loop = build_tracks(recording)
    PEOPLE.mkdir(exist_ok=True)
    write_bank(tracks, source)
    available = pool()
    sys.path.insert(0, str(HERE))
    import extract
    index = json.loads((HERE / "index.json").read_text())
    manifests, wanted_classes, wanted_outfits = {}, {}, set()
    # layers.json comes from the disc; build it first when absent so outfits can pick palettes
    if not (PEOPLE / "layers.json").exists():
        people.write(people.build(extract.DEFAULT_ISO, [], set()))
    for venue, entry in sorted(index.items()):
        scenery = json.loads((HERE / entry["dir"] / "scenery.json").read_text())
        manifest = venue_manifest(venue, scenery, tracks, loop, available)
        people_json = HERE / entry["dir"] / "people.json"
        if manifest is None:
            people_json.unlink(missing_ok=True)
            entry.pop("people", None)
            continue
        manifests[venue] = manifest
        people_json.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
        entry["people"] = len(manifest["spectators"])
        for parts in manifest["classParts"]:
            wanted_classes[people.class_id(parts)] = parts
        wanted_outfits |= {key for s in manifest["spectators"] for key in s["outfit"].values()}
        print(f"{venue}: {len(manifest['spectators'])}/{manifest['placed']} spectators, {len(manifest['classes'])} classes "
              f"({manifest['classSource'][:14]}), skipped {manifest['skipped']}, start match {manifest['startMatch']}")
    if not args.no_assets:
        people.write(people.build(extract.DEFAULT_ISO, list(wanted_classes.values()), wanted_outfits))
    (HERE / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    print(f"{len(tracks)} tracks ({source}); {len(wanted_classes)} classes, {len(wanted_outfits)} atlases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
