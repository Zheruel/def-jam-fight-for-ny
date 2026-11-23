"""Read the structure of retail EAGL animation banks (MOTION/BASE00.VIV and MOTION/WRES_ALL.VIV).

A bank is `<name>.ord` + `<name>.orl` (concatenated, they form one ELF32/MIPS object) and `<name>.mnl`
(engine clip names, in object order).  The ELF `.data` ends with an `AnimationBank` record whose pointers give, for every clip, five
objects named `<authoring name>_d/_f/_h/_s/_t`; the authoring name differs from the engine name after the first 66 clips.  This module resolves those objects and the per-clip bone channel list.
It does not decode the compressed key streams: see README.md for what is and is not understood.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ps2" / "battle"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from battle_patch import Disc  # noqa: E402
from refpack import decompress  # noqa: E402
from retail import Elf  # noqa: E402

OBJECTS = "dfhst"


def clip_names(mnl: bytes) -> list[str]:
    count, zero = struct.unpack_from("<II", mnl)
    if zero or not mnl.endswith(b"."):
        raise ValueError("unexpected motion name list")
    names = mnl[8:-1].decode("ascii").split(".")
    if len(names) != count:
        raise ValueError("motion name count mismatch")
    return names


class Bank:
    def __init__(self, ord_bytes: bytes, orl_bytes: bytes, names: list[str]):
        self.elf = Elf(ord_bytes + orl_bytes)
        self.names = names
        data = self.elf.data
        record = self.elf.symbol("__AnimationBank:::")
        words = struct.unpack_from("<6I", data, record)
        self.object_count = words[1]
        self.entries_at, self.names_at = words[4], words[5]
        if self.object_count != 5 * len(names):
            raise ValueError("bank object count does not match the clip list")
        self.entries = struct.unpack_from(f"<{self.object_count}I", data, self.entries_at)
        pointers = struct.unpack_from(f"<{self.object_count}I", data, self.names_at)
        self.labels = [data[p:data.index(0, p)].decode("ascii") for p in pointers]
        for index, label in enumerate(self.labels):
            if not label.endswith("_" + OBJECTS[index % 5]):
                raise ValueError("object label is not in d/f/h/s/t order")

    def clip(self, name: str) -> dict:
        slot = self.names.index(name)
        offsets = dict(zip(OBJECTS, self.entries[5 * slot:5 * slot + 5]))
        data = self.elf.data
        constants = offsets["d"]
        # `d` -> sub-object [type, defaults, bone list, (kind << 16 | count)]
        sub = struct.unpack_from("<I", data, constants + 12)[0]
        _, _, bones_at, packed = struct.unpack_from("<4I", data, sub)
        count = packed & 0xFFFF
        bones = list(struct.unpack_from(f"<{count}H", data, bones_at))
        return {"name": name, "slot": slot, "source": self.labels[5 * slot][:-2], "objects": offsets,
                "skeletonChannels": struct.unpack_from("<I", data, constants + 8)[0] >> 16,
                "bones": bones}


def read_bank(disc: Disc, archive: str, stem: str) -> Bank:
    def member(name):
        offset, length = disc.viv_entry(archive, name)
        data = disc.read(archive, offset, length)
        return decompress(data) if data[:2] == b"\x10\xfb" else data
    return Bank(member(f"{stem}.ord"), member(f"{stem}.orl"), clip_names(member(f"{stem}.mnl")))
