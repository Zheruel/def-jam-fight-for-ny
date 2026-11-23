"""Build a native offline harness from PS2Recomp output for retail fighter sampling.

    python3 port/fighters/sampler/build.py [--add 0xADDR ...]

Includes the static call closure of the roots plus every address listed in `functions.txt` (found by runtime misses of
indirect calls). Output: build/sampler (git-ignored scratch under private/).
"""
import argparse, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
GENERATED = ROOT / "private" / "native-kernel" / "generated"
OUT = ROOT / "private" / "fighter-sampler"
ROOTS = (0x132b48, 0x132bb8, 0x1a2f38, 0x1a2fe8, 0x132460, 0x132c38, 0x132c60)
sys.path.insert(0, str(ROOT / "port" / "kernel"))
from build import translated_body  # noqa: E402


RUNTIME = ROOT / "private" / "native-recompiler" / "ps2xRuntime" / "include"
SSE2NEON = ROOT / "private" / "native-recompiler" / "build" / "_deps" / "sse2neon-src"


def write_abi():
    """abi.hpp from the real PS2Recomp runtime pieces (context, MMI/VU0/FPU semantics) plus our memory."""
    runtime = (RUNTIME / "ps2_runtime.h").read_text().splitlines()
    start = next(i for i, l in enumerate(runtime) if l.startswith("struct alignas(16) R5900Context"))
    end = next(i for i, l in enumerate(runtime) if "~R5900Context() = default;" in l) + 2
    macros = (RUNTIME / "ps2_runtime_macros.h").read_text().splitlines()
    first = next(i for i, l in enumerate(macros) if l.startswith("static inline bool Ps2FastRangeIsContiguous"))
    memory_end = next(i for i, l in enumerate(macros) if l.startswith("#define PS2_PCGTW"))
    top = next(i for i, l in enumerate(macros) if l.startswith('#include "ps2_runtime.h"')) + 1
    parts = ["#pragma once", "#define USE_SSE2NEON 1", "#include <cstdint>", "#include <cstddef>", "#include <cstring>", "#include <cmath>",
             "#include <bit>", "#include <iostream>", "#include <iomanip>", "#include <atomic>", '#include "sse2neon.h"',
             *runtime[start:end], '#include "memory.hpp"', *macros[top:first], *macros[memory_end:-1]]
    (OUT / "abi.hpp").write_text("\n".join(parts) + "\n")


_RANGES = []


def range_end(path):
    with open(path) as f:
        for line in f:
            if line.startswith("// Address:"):
                return int(re.findall(r"0x([0-9a-f]+)", line)[1], 16)


def containing(address):
    for lo, hi, a in _RANGES:
        if lo <= address < hi:
            return a
    return None


def index():
    files = {int(p.stem.split("_0x")[-1], 16): p for p in GENERATED.glob("sub_*_0x*.cpp")}
    if not _RANGES:
        for a, p in files.items():
            with open(p) as f:
                for line in f:
                    if line.startswith("// Address:"):
                        lo, hi = re.findall(r"0x([0-9a-f]+)", line)
                        _RANGES.append((int(lo, 16), int(hi, 16), a))
                        break
    return files


def fall_through(files, address):
    """Address of the next function when this one's last instruction is not a jump (PS2Recomp stops the
    function there and the generated code simply ends, skipping the rest of the real function)."""
    text = files[address].read_text()
    end = int(re.search(r"// Address: 0x([0-9a-f]+) - 0x([0-9a-f]+)", text).group(2), 16)
    ins = sorted({(int(a, 16), m) for a, m in re.findall(r"// 0x([0-9a-f]+): 0x[0-9a-f]+\s+(\S+)", text) if int(a, 16) < end})
    tail = [m for _, m in [i for i in ins if i[1] != "nop"][-2:]]
    return end if end in files and not any(m in ("jr", "j", "b", "jalr", "break") for m in tail) else None


def closure(files, extra):
    seen, todo = set(), list(ROOTS) + list(extra)
    while todo:
        a = todo.pop()
        if a in seen or a not in files:
            continue
        seen.add(a)
        text = files[a].read_text()
        following = fall_through(files, a)
        if following:
            todo.append(following)
        todo += [int(x, 16) for x in re.findall(r"dispatchGuestBranch\(rdram, ctx, 0x([0-9a-fA-F]+)u", text)]
        todo += [int(x, 16) for x in re.findall(r"\bsub_[0-9A-F]{8}_0x([0-9a-f]+)\(rdram", text)]
        # branches that leave the function: `ctx->pc = target; return;` (the host loop continues in the owner)
        for x in re.findall(r"ctx->pc = 0x([0-9A-Fa-f]+)u;\s*return;", text):
            owner = containing(int(x, 16))
            if owner is not None and owner != a:
                todo.append(owner)
    return sorted(seen)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--add", nargs="*", default=[])
    parser.add_argument("--clang", default="clang++")
    args = parser.parse_args()
    files = index()
    listed = HERE / "functions.txt"
    extra = [int(x, 16) for x in listed.read_text().split()] if listed.exists() else []
    extra += [int(x, 16) for x in args.add]
    if args.add:
        listed.write_text("\n".join(sorted({f"{a:#x}" for a in extra})) + "\n")
    functions = closure(files, extra)
    OUT.mkdir(parents=True, exist_ok=True)
    write_abi()
    chunks = []
    for i in range(0, len(functions), 30):
        chunk = OUT / f"fn-{i // 30}.cpp"
        bodies = []
        for a in functions[i:i + 30]:
            body = translated_body(files[a])
            for name in sorted(set(re.findall(r"\b(sub_[0-9A-F]{8}_0x[0-9a-f]+)\(rdram", body))):
                body = f"void {name}(uint8_t*,R5900Context*,PS2Runtime*);\n" + body
            bodies.append(body)
        chunk.write_text('#include "abi.hpp"\n' + "\n".join(bodies))
        chunks.append(chunk)
    table = OUT / "table.cpp"
    lines = ['#include "abi.hpp"', 'typedef void (*Fn)(uint8_t*,R5900Context*,PS2Runtime*);']
    lines += [f'void {files[a].stem}(uint8_t*,R5900Context*,PS2Runtime*);' for a in functions]
    lines += ['struct Entry { uint32_t address; uint32_t end; Fn fn; };', 'extern const Entry kTable[] = {']
    lines += [f'  {{{a:#x}, {range_end(files[a]):#x}, {files[a].stem}}},' for a in functions]
    lines += ['  {0, 0, nullptr}};']
    table.write_text("\n".join(lines))
    objects = []
    for source in [*chunks, table, HERE / "harness.cpp"]:
        obj = OUT / (source.stem + ".o")
        if not obj.exists() or obj.stat().st_mtime < source.stat().st_mtime or source.parent == HERE:
            subprocess.run([args.clang, "-std=c++20", "-O1", "-ffp-contract=off", "-fno-strict-aliasing", "-w",
                            "-I" + str(OUT), "-I" + str(HERE), "-I" + str(SSE2NEON), "-c", str(source), "-o", str(obj)], check=True)
        objects.append(str(obj))
    subprocess.run([args.clang, *objects, "-o", str(OUT / "sampler")], check=True)
    print(f"built {len(functions)} functions")


if __name__ == "__main__":
    main()
