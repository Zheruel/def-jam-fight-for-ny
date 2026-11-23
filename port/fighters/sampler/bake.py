"""Python wrapper around the offline retail sampler (recompiled 0x132b48 / 0x132c38 / 0x132c60 run on a RAM snapshot).

    python3 port/fighters/sampler/build.py          # once: build private/fighter-sampler/sampler
    bank.py turns these samples into the keyframe banks consumed by port/fighters/motion.mjs.
"""
from __future__ import annotations

import struct
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SAMPLER = ROOT / "private" / "fighter-sampler" / "sampler"
BONES = 94
ENTRY = 12                       # floats per bone in the engine array: scale xyz1, quat xyzw, trans xyz1
POSE_POINTER = 0x17C
CHARACTERS = 0x471230

# Bones the body clips never drive (verified against the recorded poses of 7 clips: the sampler output for them is
# not what the game shows): both hands' fingers and the lip/brow bones. The game poses them from another source (a
# hand/face layer that is not recovered), so they are held at the live pose.
HELD = tuple(list(range(21, 36)) + list(range(42, 57)) + [70, 71, 74, 76, 77, 79, 80])

def sample(ram: Path, queries):
    """Run the sampler on `queries` = [(slot, time, bank, clip)]; returns one tuple of 1128 floats per query."""
    text = "".join(f"{slot} {time} {bank} {clip}\n" for slot, time, bank, clip in queries)
    done = subprocess.run([str(SAMPLER), str(ram), "-"], input=text.encode(), capture_output=True)
    if done.returncode:
        raise RuntimeError(done.stderr.decode().strip())
    size = BONES * ENTRY * 4 + 16
    return [struct.unpack_from(f"<{BONES * ENTRY}f", done.stdout, n * size) for n in range(len(queries))]


def sample_with_root(ram: Path, queries):
    """Like `sample`, also returning (x, y, z, yaw): the root translation the engine hands to the actor update and the
    root yaw in degrees from 0x132c38."""
    text = "".join(f"{slot} {time} {bank} {clip}\n" for slot, time, bank, clip in queries)
    done = subprocess.run([str(SAMPLER), str(ram), "-"], input=text.encode(), capture_output=True)
    if done.returncode:
        raise RuntimeError(done.stderr.decode().strip())
    size = BONES * ENTRY * 4 + 16
    return [(struct.unpack_from(f"<{BONES * ENTRY}f", done.stdout, n * size),
             struct.unpack_from("<4f", done.stdout, n * size + BONES * ENTRY * 4)) for n in range(len(queries))]


def live_pose(ram_bytes: bytes, slot: int):
    character = struct.unpack_from("<I", ram_bytes, CHARACTERS + 4 * slot)[0]
    array = struct.unpack_from("<I", ram_bytes, character + POSE_POINTER)[0]
    return struct.unpack_from(f"<{BONES * ENTRY}f", ram_bytes, array)
