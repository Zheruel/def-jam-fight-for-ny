"""Add retail motion channel dispatch targets found in the SLUS vtables."""
from pathlib import Path
import re
import struct
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0,str(ROOT / 'port/kernel'))
from build import translated_body


def extend(out, elf):
    source = ROOT / 'private/native-kernel/generated'
    table = (out/'table.cpp').read_text()
    old = {int(n,16) for n in re.findall(r'\{0x([0-9a-f]+), 0x',table)}
    files = {int(p.stem.split('_0x')[-1],16):p for p in source.glob('sub_*_0x*.cpp')}
    # Every vtable of the retail channel readers between the first BASE00 reader and type 25.
    candidates = set(struct.unpack_from('<'+'I'*((0x3a9460-0x3a8300)//4),elf,0x3a8300-0xff000))
    todo = [a for a in candidates if a in files and (0x1f6000<=a<=0x20a900 or 0x367000<=a<=0x369000)]
    # The recompiler dispatches calls it could not bind directly (0x2042a8 from the channel readers) through
    # dispatchGuestBranch with a constant target: follow those from the shipped table too.
    def branch_targets(text):
        return {int(n,16) for n in re.findall(r'dispatchGuestBranch\(rdram, ctx, 0x([0-9A-Fa-f]+)u',text)}
    for a in old | set(todo):
        if a in files:
            todo += [t for t in branch_targets(files[a].read_text()) if t not in old]
    bodies = {}
    while todo:
        a = todo.pop()
        if a in old or a in bodies or a not in files:
            continue
        p = files[a]
        body = translated_body(p).replace("runtime->SignalException(ctx, EXCEPTION_INTEGER_OVERFLOW)",
                                          "battle_fault(ctx->pc, 0xfffffff3u)")
        calls = set(re.findall(r'\b(sub_[0-9A-F]{8}_0x[0-9a-f]+)\(rdram',body))
        for name in calls:
            todo.append(int(name.split('_0x')[-1],16))
        todo += branch_targets(body)
        decl = ''.join(f'void {name}(uint8_t*,R5900Context*,PS2Runtime*);\n' for name in sorted(calls))
        bodies[a] = decl + body
    ordered = sorted(bodies)
    extra = []
    for n in range(0,len(ordered),35):
        path = out/f'extra-{n//35}.cpp'
        path.write_text('#include "abi.hpp"\n'+'\n'.join(bodies[a] for a in ordered[n:n+35]))
        extra.append(path)
    entries = []
    for a in ordered:
        p = files[a]
        end = int(re.search(r'// Address: 0x[0-9a-f]+ - 0x([0-9a-f]+)',p.read_text())[1],16)
        entries.append(f'  {{{a:#x}, {end:#x}, {p.stem}}},')
    decls = ''.join(f'void {files[a].stem}(uint8_t*,R5900Context*,PS2Runtime*);\n' for a in ordered)
    (out/'table.cpp').write_text(table.replace('struct Entry',decls+'struct Entry').replace('  {0, 0, nullptr}', '\n'.join(entries)+'\n  {0, 0, nullptr}'))
    return extra
