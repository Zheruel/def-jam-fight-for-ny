"""Bake every Blaze/Doc motion the retail engine can play into compact keyframe banks.

    python3 port/fighters/sampler/build.py                                   # once
    python3 port/fighters/sampler/bank.py <ram.bin> <out-dir> [--iso reference.iso] [--only base00]

The recompiled retail sampler (0x132b48) is run on a fine time grid of every clip of
    BASE00 (bank 0, shared; engine clip = BASE00 name index, 709 clips),
    Blaze WRES005 (bank 1, slot 0, engine clip = index) and Doc WRES010 (bank 1, slot 1, engine clip = 1000 + index).
Duration (`end`) is the game's own: the float returned by 0x132c60(slot, bank, clip). Sampling covers t = 0..end.
The engine's curves are piecewise linear with breaks (often jumps) at half frames, so the grid is every half frame plus a
1/64 frame either side of it, and each bone's track is reduced to the keys needed to reproduce the grid within the
tolerances below (`TOL_*`). Root translation/yaw (the engine's 0x132b48 `out` and 0x132c38) get the same treatment.

Output per bank: `<bank>.json` (index) and `<bank>.bin` (little-endian blob). Per clip, in the blob:
    translation class   94 bytes   0 = rig default, 1 = constant (3 x f32), 2 = keyed (u16 n, n x u16 times, n x 3 x f32)
    for each bone not in HELD, in order:
        quaternion track  u16 n; n x u16 times (1/64 frame); then four planes (x, y, z, w) of n x int16 = round(v * quant).
                          The keys are the engine's raw quaternions, NOT unit length (clip data and blends leave |q| down to ~0.85);
                          retail composes bones from them as they are, so a consumer must not normalise.
        translation       none (class 0) / 3 x f32 (class 1) / keyed as above (class 2)
    root track          u16 n; n x u16 times; n x (x, y, z, yaw degrees) f32   (x, y, z: absolute offset from the motion start)
A track with n = 1 is constant; between keys everything is lerp'd (quaternions along the shortest arc, never renormalised, as the engine does); before the first and
after the last key the value is held. HELD bones (fingers, lips/brows) are not stored: see rig files.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import bake  # noqa: E402

FORMAT = "def-jam-fny-motion-bank/3"
BONES = 94
ENTRY = 12
HELD = set(bake.HELD)
QUANT = 4095.0
UNIT = 64                       # time units per frame
TOL_QUAT = 3e-4                 # per component of the raw quaternion
TOL_TRANS = 5e-4
TOL_ROOT = 1e-3
SAMPLER = bake.SAMPLER

BANKS = {
    # name: (slot used for sampling, engine bank, name source)
    "base00": (0, 0, ("/MOTION/BASE00.VIV", "base00"), 709, lambda i: i),
    "wres005-blaze": (0, 1, ("/MOTION/WRES_ALL.VIV", "wres005"), 117, lambda i: i),
    "wres010-doc": (1, 1, ("/MOTION/WRES_ALL.VIV", "wres010"), 120, lambda i: 1000 + i),
}


def durations(ram: Path, queries):
    """Retail 0x132c60(slot, bank, clip) for each (slot, bank, clip): the motion length in frames."""
    import subprocess
    text = "".join(f"{s} {b} {c}\n" for s, b, c in queries)
    done = subprocess.run([str(SAMPLER), str(ram), "dur"], input=text.encode(), capture_output=True)
    if done.returncode:
        raise RuntimeError(done.stderr.decode().strip())
    return [float(line.split()[1]) for line in done.stdout.decode().splitlines()]


def align(q, ref):
    return [-v for v in q] if sum(a * b for a, b in zip(q, ref)) < 0 else q


def lerp_q(a, b, w):
    b = align(b, a)
    return [x * (1 - w) + y * w for x, y in zip(a, b)]


def reduce_track(times, values, tolerance, quaternion):
    """Indices of the keys needed so that interpolating between them reproduces every grid sample."""
    keep = {0, len(times) - 1}
    stack = [(0, len(times) - 1)]
    while stack:
        lo, hi = stack.pop()
        worst, at = 0.0, None
        span = times[hi] - times[lo]
        for i in range(lo + 1, hi):
            w = (times[i] - times[lo]) / span
            if quaternion:
                p = lerp_q(values[lo], values[hi], w)
                e = max(abs(x - y) for x, y in zip(p, align(values[i], p)))
            else:
                e = max(abs(x * (1 - w) + y * w - z) for x, y, z in zip(values[lo], values[hi], values[i]))
            if e > worst:
                worst, at = e, i
        if worst > tolerance:
            keep.add(at)
            stack += [(lo, at), (at, hi)]
    return sorted(keep)


def pack_times(times, keys):
    return b"".join(struct.pack("<H", round(times[i] * UNIT)) for i in keys)


def grid_for(end: float):
    steps = int(round(end * 2))
    times = {m * 0.5 for m in range(0, steps + 1)}
    times |= {m * 0.5 + 1 / UNIT for m in range(0, steps)}
    times |= {m * 0.5 - 1 / UNIT for m in range(1, steps + 1)}
    return sorted(t for t in times if 0 <= t <= end)


def encode_clip(grid, poses, defaults):
    """poses: [(pose, root)] on `grid`; returns (blob, stats, translation classes)."""
    tclass = [0] * BONES
    tracks = []
    keys = 0
    for k in range(BONES):
        if k in HELD:
            continue
        quats = [list(pose[k * ENTRY + 4:k * ENTRY + 8]) for pose, _ in poses]
        kept = reduce_track(grid, quats, TOL_QUAT, True)
        trans = [tuple(pose[k * ENTRY + 8:k * ENTRY + 11]) for pose, _ in poses]
        tkeys = reduce_track(grid, trans, TOL_TRANS, False)
        if all(max(abs(a - b) for a, b in zip(t, trans[0])) <= TOL_TRANS for t in trans):
            tkeys = tkeys[:1]
            tclass[k] = 0 if max(abs(a - b) for a, b in zip(trans[0], defaults[k])) <= TOL_TRANS else 1
        else:
            tclass[k] = 2
        tracks.append((k, kept, quats, tkeys, trans))
        keys += len(kept) + (len(tkeys) if tclass[k] == 2 else 0)
    blob = bytearray(bytes(tclass))
    for k, kept, quats, tkeys, trans in tracks:
        blob += struct.pack("<H", len(kept)) + pack_times(grid, kept)
        for c in range(4):
            blob += struct.pack(f"<{len(kept)}h", *[round(quats[i][c] * QUANT) for i in kept])
        if tclass[k] == 1:
            blob += struct.pack("<3f", *trans[0])
        elif tclass[k] == 2:
            blob += struct.pack("<H", len(tkeys)) + pack_times(grid, tkeys)
            blob += b"".join(struct.pack("<3f", *trans[i]) for i in tkeys)
    roots = [root for _, root in poses]
    rkeys = reduce_track(grid, roots, TOL_ROOT, False)
    blob += struct.pack("<H", len(rkeys)) + pack_times(grid, rkeys)
    blob += b"".join(struct.pack("<4f", *roots[i]) for i in rkeys)
    keys += len(rkeys)
    while len(blob) % 4:
        blob += b"\0"
    return bytes(blob), {"keys": keys, "keyedTranslations": tclass.count(2), "constantTranslations": tclass.count(1)}, tclass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ram", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--iso", type=Path)
    parser.add_argument("--only")
    parser.add_argument("--locals", help="bank=n,n,...;bank=n,... engine clip numbers to keep (fixtures)")
    parser.add_argument("--prefix", default="", help="output file name prefix")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    ram_bytes = args.ram.read_bytes()
    live = {slot: bake.live_pose(ram_bytes, slot) for slot in (0, 1)}
    rigs = {}
    for slot, fighter, model in ((0, "blaze", "V2IP_113A"), (1, "doc", "V2IP_109A")):
        defaults = [tuple(live[slot][k * ENTRY + 8:k * ENTRY + 11]) for k in range(BONES)]
        rigs[slot] = defaults
        rig = {"format": "def-jam-fny-fighter-rig/1", "fighter": fighter, "model": model, "slot": slot, "bones": BONES,
               "held": {str(k): [round(v, 6) for v in live[slot][k * ENTRY + 4:k * ENTRY + 11]] for k in sorted(HELD)},
               "defaultTranslations": [[round(v, 6) for v in d] for d in defaults],
               "note": "held = fingers and lips/brows, which no body clip drives (live pose); defaultTranslations = the rest translations the engine leaves in the pose array"}
        (args.output / f"{args.prefix}rig-{fighter}.json").write_text(json.dumps(rig, separators=(",", ":")) + "\n")
    names_by_bank = {}
    if args.iso:
        from animbank import read_bank
        from retail import Disc
        disc = Disc(str(args.iso))
        for name, (_, _, (archive, stem), _, _) in BANKS.items():
            names_by_bank[name] = read_bank(disc, archive, stem).names
        disc.close()
    keeps = {}
    for part in (args.locals or "").split(";"):
        if part:
            bank_name, numbers = part.split("=")
            keeps[bank_name] = {int(x) for x in numbers.split(",")}
    for name, (slot, bank, _, count, to_local) in BANKS.items():
        if args.only and args.only != name:
            continue
        if keeps and name not in keeps:
            continue
        names = names_by_bank.get(name) or [f"clip{i}" for i in range(count)]
        wanted = [(i, to_local(i)) for i in range(count) if not keeps or to_local(i) in keeps[name]]
        ends = durations(args.ram, [(slot, bank, local) for _, local in wanted])
        blob, clips, crossed = bytearray(), [], 0
        for (i, local), end in zip(wanted, ends):
            grid = grid_for(end)
            poses = bake.sample_with_root(args.ram, [(slot, t, bank, local) for t in grid])
            data, info, tclass = encode_clip(grid, poses, rigs[slot])
            if bank == 0:   # a shared clip must pose the other fighter too: class 0 bones take that fighter's own rest translations
                (twin, _), = bake.sample_with_root(args.ram, [(1 - slot, 0.0, bank, local)])
                crossed += sum(1 for k in range(BONES) if k not in HELD and tclass[k] == 0
                               and max(abs(a - b) for a, b in zip(twin[k * ENTRY + 8:k * ENTRY + 11], rigs[1 - slot][k])) > 1e-3)
            clips.append({"name": names[i], "local": local, "end": end, "offset": len(blob), "length": len(data), **info})
            blob += data
        (args.output / f"{args.prefix}{name}.bin").write_bytes(bytes(blob))
        index = {"format": FORMAT, "name": name, "bank": bank, "slot": slot, "bones": BONES, "quant": QUANT, "timeUnit": UNIT,
                 "rig": f"{args.prefix}rig-" + ["blaze", "doc"][slot] + ".json", "clips": clips}
        (args.output / f"{args.prefix}{name}.json").write_text(json.dumps(index, separators=(",", ":")) + "\n")
        print(f"{name}: {len(clips)} clips, {sum(c['keys'] for c in clips)} keys, {len(blob)} bytes; other-fighter rest translation mismatches: {crossed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
