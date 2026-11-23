"""Build the AKI Battle functions as a standalone WebAssembly library."""
import argparse
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent


def translated_body(path):
    source = path.read_text()
    body = source[source.index("void sub_"):]
    # PS2 SQRT.S takes ft; the standard MIPS encoding takes fs. The upstream
    # decoder prints the source word even where its standard disassembler fails.
    pattern = r"(// 0x[\da-f]+: 0x([\da-f]+) [^\n]*\n\s*ctx->pc = [^;]+;\n\s*ctx->f\[\d+\] = FPU_SQRT_S\()ctx->f\[\d+\]"
    def sqrt_source(match):
        word = int(match[2],16)
        if word & 0xffe0003f != 0x46000004:
            raise ValueError("Unexpected COP1 SQRT encoding")
        return match[1] + f"ctx->f[{word >> 16 & 31}]"
    return re.sub(pattern,sqrt_source,body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("generated",type=Path)
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--clang",default="clang++")
    parser.add_argument("--track",action="store_true",help="Record memory page usage for extracting match data")
    args = parser.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    definitions = []
    for item in sorted(args.generated.glob("sub_*_0x*.cpp")):
        address = int(item.stem.split("_0x")[-1],16)
        if 0x2da000 <= address < 0x323000:
            definitions.append((address,item))
    if not definitions:
        raise ValueError("No Battle functions")
    entry = ['#include "abi.hpp"']
    for base, path in definitions:
        entry += [f'void {path.stem}(uint8_t*,R5900Context*,PS2Runtime*);']
    entry += ['#include "entry.inc"', 'void callBattle(uint32_t target,uint32_t site) {',
              '  switch (target) {']
    for base,path in definitions:
        landings = {base}
        for address in re.findall(r"case 0x([0-9a-f]+)u: goto label_",path.read_text()):
            landings.add(int(address,16))
        entry.extend(f'    case {pc:#x}:' for pc in sorted(landings))
        entry.append(f'      {path.stem}(data,&registers,&runtime); break;')
    entry += ['    default: battle_service(site,target); registers.pc = GPR_U32((&registers),31); break;','  }','}']
    chunks = []
    for i in range(0,len(definitions),40):
        file = args.out / f"battle-{i//40}.cpp"
        file.write_text('#include "abi.hpp"\n' + '\n'.join(translated_body(p) for _,p in definitions[i:i+40]))
        chunks.append(file)
    main_file = args.out / "entry.cpp"
    main_file.write_text("\n".join(entry))
    subprocess.run([args.clang,"--target=wasm32-unknown-unknown","-std=c++20","-O1","-ffreestanding",
                    "-fno-exceptions","-fno-rtti","-ffp-contract=off","-mbulk-memory","-nostdlib",
                    *(["-DBATTLE_TRACK_PAGES"] if args.track else []), "-Wl,--no-entry","-Wl,--export-dynamic","-Wl,--allow-undefined","-Wl,--strip-all",
                    "-I"+str(HERE),str(main_file),*map(str,chunks),"-o",str(args.out/"battle.wasm")],check=True)
    print(f"Compiled {len(definitions)} Battle functions")


if __name__ == "__main__":
    main()
