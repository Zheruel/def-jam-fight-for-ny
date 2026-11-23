"""Run the US retail plane contact query in a MIPS32 instruction harness."""
import hashlib
import json
from pathlib import Path
import struct
import sys

from unicorn import Uc, UC_ARCH_MIPS, UC_MODE_LITTLE_ENDIAN, UC_MODE_MIPS32
from unicorn.mips_const import (UC_MIPS_REG_A0, UC_MIPS_REG_A1, UC_MIPS_REG_A2,
    UC_MIPS_REG_A3, UC_MIPS_REG_T0, UC_MIPS_REG_F12, UC_MIPS_REG_F13,
    UC_MIPS_REG_RA, UC_MIPS_REG_SP, UC_MIPS_REG_PC, UC_MIPS_REG_V0)

ELF_HASH = "4e65bf2947b3838ce372967cac448bfc8034709a6d70a87fd11d13c5f09b23b2"
STOP, DATA = 0x500000, 0x600000


def adapt(word):
    # These routines use 128-/64-bit loads only to save integer registers on
    # the stack. Their live addresses and results fit one 32-bit word.
    op = word >> 26
    if op in (0x1e, 0x1f, 0x37, 0x3f):
        return (word & 0x3ffffff) | ((0x23 if op in (0x1e, 0x37) else 0x2b) << 26)
    if not op and word & 63 == 0x2d:
        return (word & ~63) | 0x21
    # EE sqrt.s reads ft whereas MIPS32 sqrt.s reads fs.
    if word & 0xffe0003f == 0x46000004:
        return (word & ~0x1ff800) | (((word >> 16) & 31) << 11)
    return word


def main():
    elf = Path(sys.argv[1]).read_bytes()
    if hashlib.sha256(elf).hexdigest() != ELF_HASH:
        raise ValueError("Expected the USA SLUS-21004 executable")
    cpu = Uc(UC_ARCH_MIPS, UC_MODE_MIPS32 | UC_MODE_LITTLE_ENDIAN)
    cpu.mem_map(0x2e1000, 0x3000)
    cpu.mem_map(DATA, 0x2000)
    cpu.mem_map(STOP, 0x1000)
    for start, end in [(0x2e1000,0x2e11d8),(0x2e1bb8,0x2e1bf0),(0x2e1c20,0x2e1c78),
                       (0x2e1cc0,0x2e1d34),(0x2e30d8,0x2e3478)]:
        words = struct.iter_unpack("<I", elf[start-0xff000:end-0xff000])
        cpu.mem_write(start, b"".join(struct.pack("<I",adapt(w)) for (w,) in words))
    results = []
    for case in json.load(sys.stdin):
        plane, point, radius, scale = case
        cpu.mem_write(DATA, bytes.fromhex(plane))
        cpu.mem_write(DATA+0x80, struct.pack("<3f",*point))
        for reg, value in [(UC_MIPS_REG_A0,DATA),(UC_MIPS_REG_A1,DATA+0x80),
                           (UC_MIPS_REG_A2,DATA+0x100),(UC_MIPS_REG_A3,DATA+0x104),
                           (UC_MIPS_REG_T0,DATA+0x108),(UC_MIPS_REG_SP,DATA+0x1f00),
                           (UC_MIPS_REG_RA,STOP)]:
            cpu.reg_write(reg,value)
        for reg, value in [(UC_MIPS_REG_F12,radius),(UC_MIPS_REG_F13,scale)]:
            cpu.reg_write(reg,struct.unpack("<I",struct.pack("<f",value))[0])
        cpu.emu_start(0x2e1000,STOP,count=1000)
        if cpu.reg_read(UC_MIPS_REG_PC) != STOP:
            raise ValueError(f"Unexpected end at 0x{cpu.reg_read(UC_MIPS_REG_PC):x}")
        kind = cpu.reg_read(UC_MIPS_REG_V0)
        values = struct.unpack("<5f",cpu.mem_read(DATA+0x100,20))
        result = None
        if kind:
            result = dict(type=kind,depth=values[0])
            if kind in (2,3):
                result.update(overlap=values[1],direction=values[2:])
        results.append(result)
    json.dump(results,sys.stdout)


if __name__ == "__main__":
    main()
