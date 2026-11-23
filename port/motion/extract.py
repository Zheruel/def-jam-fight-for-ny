"""Extract the retail motion-name tables, per-fighter move slots and loaded clip lists."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "ps2/battle"))
from battle_patch import Disc
from refpack import decompress

ELF_HASH = "4e65bf2947b3838ce372967cac448bfc8034709a6d70a87fd11d13c5f09b23b2"
OUTPUT = HERE / "library.json"


def bank(disc, path, member):
    offset, length = disc.viv_entry(path, member)
    data = disc.read(path, offset, length)
    if data[:2] == b"\x10\xfb":
        data = decompress(data)
    count, zero = struct.unpack_from("<II", data)
    if not data.endswith(b".") or zero:
        raise ValueError(f"Unexpected motion list header for {member}")
    clips = data[8:-1].decode("ascii").split(".")
    if len(clips) != count or not all(clips):
        raise ValueError(f"Invalid clip count for {member}")
    return clips


def game_tables(elf, address, count):
    # SLUS-21004 has one loadable segment, at 0x100000 with file offset 0x1000.
    pointers = struct.unpack_from(f"<{count}I", elf, address - 0xff000)
    result = []
    for pointer in pointers:
        start = pointer - 0xff000
        if not 0 <= start < len(elf):
            raise ValueError("Invalid name pointer")
        result.append(elf[start:elf.index(0, start)].decode("ascii"))
    return result


def build(disc):
    def full(path):
        return disc.read(path, 0, disc.iso.entry(path).size)
    elf = full("/SLUS_210.04")
    if hashlib.sha256(elf).hexdigest() != ELF_HASH:
        raise ValueError("Unexpected PS2 executable")
    data = full("/MOTION/MAIN_ALL.DAT")
    slots = []
    names = []
    pos = 0
    while pos < len(data):
        tag, size = struct.unpack_from("<4sI", data, pos)
        body = data[pos + 8:pos + 8 + size]
        if len(body) != size:
            raise ValueError("Truncated motion chunk")
        if tag == b"WWAZ":
            if size != 130 * 6:
                raise ValueError("Unexpected fighter move slots")
            slots.append(list(struct.iter_unpack("<3H",body)))
        elif tag == b"NAME":
            count = struct.unpack_from("<I",body)[0]
            starts = struct.unpack_from(f"<{count}H",body,4)
            strings = body[4+count*2:]
            names.append([strings[at:strings.index(0,at)].decode("cp932") for at in starts])
        pos += size + 8
    if len(slots) != 141 or len(names) != 2:
        raise ValueError("Incomplete retail motion library")
    ids = game_tables(elf, 0x390730, 2088)
    common = game_tables(elf, 0x38f988, 873)
    index = {name: i for i, name in enumerate(ids)}
    banks = []
    for i in range(len(slots)):
        loaded = bank(disc, "/MOTION/WRES_ALL.VIV", f"wres{i+1:03}.mnl")
        # Compact references to names, preserving alternate labels used only in a bank.
        banks.append([index.get(clip, clip) for clip in loaded])
    return {"sourceSha256":hashlib.sha256(data).hexdigest(),"common":common,
            "global":ids,"baseBank":bank(disc,"/MOTION/BASE00.VIV","base00.mnl"),
            "fighterBanks":banks,"moveNames":names,"slots":slots}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    disc = Disc(args.iso)
    try:
        encoded = json.dumps(build(disc),separators=(",",":"))+"\n"
    finally:
        disc.close()
    if args.check:
        if OUTPUT.read_text() != encoded:
            raise SystemExit("Motion library differs from retail")
    else:
        OUTPUT.write_text(encoded)


if __name__ == "__main__":
    main()
