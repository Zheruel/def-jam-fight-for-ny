"""Run only the two combat routines from a local retail ELF in Unicorn."""

import hashlib
import json
from pathlib import Path
import struct
import sys

from unicorn import Uc, UC_ARCH_MIPS, UC_MODE_LITTLE_ENDIAN, UC_MODE_MIPS32
from unicorn.mips_const import (
    UC_MIPS_REG_A0,
    UC_MIPS_REG_A1,
    UC_MIPS_REG_F12,
    UC_MIPS_REG_FCSR,
    UC_MIPS_REG_PC,
    UC_MIPS_REG_RA,
)

ELF_SHA256 = "4e65bf2947b3838ce372967cac448bfc8034709a6d70a87fd11d13c5f09b23b2"
LOAD_DELTA = 0xFF000
MOMENTUM_PC, MOMENTUM_END = 0x2DE648, 0x2DE720
HIT_PC, HIT_END = 0x2DDF38, 0x2DDF6C
FIGHTER = 0x600000
STOP = 0x500000


def store(cpu, address, fmt, *values):
    cpu.mem_write(address, struct.pack("<" + fmt, *values))


def run(cpu, address):
    cpu.reg_write(UC_MIPS_REG_A0, FIGHTER)
    cpu.reg_write(UC_MIPS_REG_RA, STOP)
    cpu.reg_write(UC_MIPS_REG_FCSR, 0)
    cpu.emu_start(address, STOP, count=96)
    if cpu.reg_read(UC_MIPS_REG_PC) != STOP:
        raise RuntimeError(f"Retail routine {address:#x} did not return")


def hit(cpu, case):
    store(cpu, FIGHTER + 0x820, "5f", *case["channels"])
    cpu.reg_write(UC_MIPS_REG_A1, case["index"])
    (delta_bits,) = struct.unpack("<I", struct.pack("<f", case["delta"]))
    cpu.reg_write(UC_MIPS_REG_F12, delta_bits)
    run(cpu, HIT_PC)
    return struct.unpack("<5I", cpu.mem_read(FIGHTER + 0x820, 20))


def momentum(cpu, case):
    fighter = case["fighter"]
    tick = case["tick"]
    store(cpu, FIGHTER + 0x364, "2f", fighter["momentum"], fighter["blazinTimer"])
    store(cpu, FIGHTER + 0x924, "2H", fighter["fighterFlags"], fighter["hitFlags"])
    store(cpu, FIGHTER + 0x93E, "B", fighter["blazinFlags"])
    store(cpu, 0x4BC14C, "I", tick["matchFlags"])
    store(cpu, 0x4BBF94, "f", tick["elapsedTicks"])
    store(cpu, 0x394AB8, "f", tick["expiryRate"])
    run(cpu, MOMENTUM_PC)
    return struct.unpack("<2I", cpu.mem_read(FIGHTER + 0x364, 8))


def main():
    elf = Path(sys.argv[1]).read_bytes()
    if hashlib.sha256(elf).hexdigest() != ELF_SHA256:
        raise ValueError("Expected the verified retail USA SLUS-21004 ELF")

    cpu = Uc(UC_ARCH_MIPS, UC_MODE_MIPS32 | UC_MODE_LITTLE_ENDIAN)
    for address, size in (
        (0x2DD000, 0x2000),
        (0x394000, 0x1000),
        (0x4BB000, 0x2000),
        (STOP, 0x1000),
        (FIGHTER, 0x1000),
    ):
        cpu.mem_map(address, size)
    for start, end in ((MOMENTUM_PC, MOMENTUM_END), (HIT_PC, HIT_END)):
        cpu.mem_write(start, elf[start - LOAD_DELTA : end - LOAD_DELTA])

    cases = json.load(sys.stdin)
    json.dump(
        {
            "hit": [hit(cpu, case) for case in cases["hit"]],
            "momentum": [momentum(cpu, case) for case in cases["momentum"]],
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
