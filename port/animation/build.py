"""Build the retail motion sampler for the browser from the offline sampler's translation units."""
import argparse
import hashlib
from extend import extend
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emxx", default="em++")
    parser.add_argument("--elf", type=Path,required=True)
    parser.add_argument("--out", type=Path, default=ROOT / "private/anim-wasm")
    args = parser.parse_args()
    source = ROOT / "private/fighter-sampler"
    args.out.mkdir(parents=True, exist_ok=True)
    header = (source / "abi.hpp").read_text().replace("#define USE_SSE2NEON 1", "").replace('"sse2neon.h"', "<immintrin.h>")
    (args.out / "abi.hpp").write_text(header)
    memory = (ROOT / "port/fighters/sampler/memory.hpp").read_text()
    memory = memory.replace("PS2_RAM_SIZE = 0x02000000","PS2_RAM_SIZE = 0x02600000")
    before = "    __builtin_memcpy(&value, data + addr, sizeof(T));"
    assert memory.count(before) == 1
    (args.out / "memory.hpp").write_text(memory.replace(before, """
    extern uint8_t readPages[];
    readPages[addr / 4096] = 1;
    readPages[(addr + sizeof(T) - 1) / 4096] = 1;
""" + before))
    files = [*sorted(source.glob("fn-*.cpp")), source / "table.cpp", HERE / "entry.cpp"]
    for path in files:
        shutil.copyfile(path, args.out/path.name)
    units = [args.out/path.name for path in files]
    units += extend(args.out, args.elf.read_bytes())
    objects = []
    for unit in units:
        obj = unit.with_suffix(".o")
        signature = hashlib.sha256((args.out/"abi.hpp").read_bytes()+(args.out/"memory.hpp").read_bytes()+unit.read_bytes()).hexdigest()
        stamp = obj.with_suffix(".sha256")
        if stamp.exists() and stamp.read_text()==signature and obj.exists():
            objects.append(obj)
            continue
        subprocess.run([args.emxx,"-std=c++20","-O2","-ffp-contract=off","-fno-strict-aliasing",
                        "-fno-exceptions","-fno-rtti","-msimd128","-msse4.2","-w","-c",str(unit),"-o",str(obj)],check=True)
        stamp.write_text(signature)
        objects.append(obj)
    subprocess.run([args.emxx,*map(str,objects),"-O0","-msimd128","--no-entry","-sSTANDALONE_WASM=1",
                    "-sINITIAL_MEMORY=50331648","-sSTACK_SIZE=1048576","-sERROR_ON_UNDEFINED_SYMBOLS=0",
                    "-o",str(args.out/"sampler.wasm")],check=True)


if __name__ == "__main__":
    main()
