"""Same-size edits inside EA RefPack (QFS) streams.

The front-end screens live RefPack-compressed in SCREENS/SCREENS.VIV. To change a string
in one without moving any other byte of the disc, `patch_same_size` re-encodes only the
commands whose output changes, choosing an encoding of exactly the original byte count;
every other command, and so the rest of the archive, stays bit-for-bit identical.

    blob2 = patch_same_size(blob, b"intMain/mainMenu.swf", b"battle/cmtype.swf\\0\\0\\0")
    assert decompress(blob2) == decompress(blob).replace(old, new)
"""

from __future__ import annotations

import bisect
import sys
from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache

MAGIC = 0xFB


@dataclass(frozen=True)
class Command:
    start: int  # first byte of the command in the stream
    end: int  # one past its literal bytes
    out: int  # first output byte it produces
    out_end: int
    literal: bytes
    distance: int  # back-reference distance (0: literals only)


def _header(blob: bytes) -> tuple[int, int]:
    if len(blob) < 5 or blob[1] != MAGIC or (blob[0] & 0x3E) != 0x10:
        raise ValueError("not a RefPack stream")
    width = 4 if blob[0] & 0x80 else 3
    pos = 2 + (width if blob[0] & 0x01 else 0)
    return int.from_bytes(blob[pos:pos + width], "big"), pos + width


def commands(blob: bytes) -> list[Command]:
    size, i = _header(blob)
    out = 0
    result = []
    while i < len(blob):
        start, c = i, blob[i]
        distance = length = 0
        if c < 0x80:
            a = blob[i + 1]
            literal, length, distance = c & 3, ((c >> 2) & 7) + 3, ((c & 0x60) << 3) + a + 1
            i += 2
        elif c < 0xC0:
            a, b = blob[i + 1], blob[i + 2]
            literal, length, distance = a >> 6, (c & 0x3F) + 4, ((a & 0x3F) << 8) + b + 1
            i += 3
        elif c < 0xE0:
            a, b, e = blob[i + 1], blob[i + 2], blob[i + 3]
            literal = c & 3
            length = ((c & 0x0C) << 6) + e + 5
            distance = ((c & 0x10) << 12) + (a << 8) + b + 1
            i += 4
        elif c < 0xFC:
            literal = ((c & 0x1F) + 1) * 4
            i += 1
        else:
            literal = c & 3
            i += 1
        result.append(Command(start, i + literal, out, out + literal + length, blob[i:i + literal], distance))
        i += literal
        out += literal + length
        if c >= 0xFC:
            break
    if out != size:
        raise ValueError(f"RefPack stream decodes to {out} bytes, header says {size}")
    return result


def decompress(blob: bytes) -> bytes:
    out = bytearray()
    for cmd in commands(blob):
        out += cmd.literal
        for _ in range(cmd.out_end - cmd.out - len(cmd.literal)):
            out.append(out[-cmd.distance])
    return bytes(out)


def _encode_copy(distance: int, length: int, literal: int) -> bytes | None:
    d = distance - 1
    if 3 <= length <= 10 and distance <= 1024:
        return bytes([((d >> 8) << 5) | ((length - 3) << 2) | literal, d & 0xFF])
    if 4 <= length <= 67 and distance <= 16384:
        return bytes([0x80 + length - 4, (literal << 6) | (d >> 8), d & 0xFF])
    if 5 <= length <= 1028 and distance <= 131072:
        return bytes([0xC0 | ((d >> 16) << 4) | (((length - 5) >> 8) << 2) | literal,
                      (d >> 8) & 0xFF, d & 0xFF, (length - 5) & 0xFF])
    return None


def _encode_exact(dest: bytes, begin: int, end: int, budget: int, index) -> bytes | None:
    """Commands producing dest[begin:end] in exactly `budget` bytes (deterministic search)."""

    @lru_cache(maxsize=None)
    def visit(pos: int, left: int) -> bytes | None:
        if pos == end:
            return b"" if left == 0 else None
        if left < 2 or left > (end - pos) * 2 + 2:
            return None
        for n in range(min((end - pos) // 4, 28), 0, -1):  # literal runs of 4n bytes
            size = 4 * n
            if left >= size + 1:
                tail = visit(pos + size, left - size - 1)
                if tail is not None:
                    return bytes([0xDF + n]) + dest[pos:pos + size] + tail
        for literal in range(4):  # 0-3 literals followed by a copy
            at = pos + literal
            if at + 3 > end:
                break
            candidates = index[dest[at:at + 3]]
            stop = bisect.bisect_left(candidates, at)
            for prev in reversed(candidates[max(0, stop - 32):stop]):
                distance = at - prev
                if distance > 131072:
                    break
                longest = 3
                while at + longest < end and longest < 1028 and dest[prev + longest] == dest[at + longest]:
                    longest += 1
                for length in range(longest, 2, -1):
                    code = _encode_copy(distance, length, literal)
                    if code is None or left < len(code) + literal:
                        continue
                    tail = visit(at + length, left - len(code) - literal)
                    if tail is not None:
                        return code + dest[pos:at] + tail
        return None

    sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))
    return visit(begin, budget)


def patch_same_size(blob: bytes, old: bytes, new: bytes) -> bytes:
    """`blob` with the single occurrence of `old` in its output replaced by `new`."""
    if len(old) != len(new):
        raise ValueError("old and new must have the same length")
    cmds = commands(blob)
    original = decompress(blob)
    if original.count(old) != 1:
        raise ValueError(f"{old!r} occurs {original.count(old)} times in the stream")
    dest = original.replace(old, new)

    def broken(cmd: Command) -> bool:
        mid = cmd.out + len(cmd.literal)
        if cmd.literal != dest[cmd.out:mid]:
            return True
        # A copy still works if every byte it copies (from the patched output) matches.
        return any(dest[i] != dest[i - cmd.distance] for i in range(mid, cmd.out_end))

    bad = [k for k, cmd in enumerate(cmds) if broken(cmd)]
    index: defaultdict[bytes, list[int]] = defaultdict(list)
    limit = min(len(dest), cmds[bad[-1]].out_end + 4096) if bad else 0
    for i in range(limit):
        index[dest[i:i + 3]].append(i)
    out = bytearray(blob)
    while bad:
        k = bad[0]
        for extend in range(1, 32):
            lo, hi = max(0, k - extend), min(k + extend, len(cmds) - 2)  # never touch the end marker
            first, last = cmds[lo], cmds[hi]
            code = _encode_exact(dest, first.out, last.out_end, last.end - first.start, index)
            if code is not None:
                out[first.start:last.end] = code
                bad = [i for i in bad if i > hi]
                break
        else:
            raise ValueError(f"no same-size encoding around command {k}")
    if decompress(bytes(out)) != dest:
        raise AssertionError("re-encoded stream does not decode to the intended bytes")
    return bytes(out)
