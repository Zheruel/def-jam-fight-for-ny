"""Build the AKI Battle functions as a standalone WebAssembly library."""
import argparse
import hashlib
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


def join_split_delay_slot(bodies):
    # The retail routine spans two translation units. The tool put the boundary
    # between JAL and its SQ delay slot. The store must see the caller's t3,
    # then the return address must resume at the instruction following the SQ.
    caller, tail = 0x313330, 0x313430
    if caller not in bodies:
        return
    slot = '    WRITE128(ADD32(GPR_U32(ctx, 29), 288), GPR_VEC(ctx, 11));'
    target = '    ctx->pc = 0x2E2C80u;'
    branch = '    switch (ctx->pc) {'
    resume = '    // 0x313434:'
    if (bodies[caller].count(target) != 1 or bodies[tail].count(slot) != 1
            or bodies[tail].count(branch) != 1 or bodies[tail].count(resume) != 1):
        raise ValueError('Unrecognized retail translation around 0x31342c')
    bodies[caller] = bodies[caller].replace(target, slot + '\n' + target)
    bodies[tail] = bodies[tail].replace(branch, branch +
        '\n        case 0x313434u: goto label_313434;').replace(resume, 'label_313434:\n' + resume)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("generated",type=Path)
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--clang",default="clang++")
    parser.add_argument("--track",action="store_true",help="Record memory page usage for extracting match data")
    args = parser.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    presentation = {int(line,16) for line in (HERE/"presentation.txt").read_text().split()}
    definitions = []
    for item in sorted(args.generated.glob("sub_*_0x*.cpp")):
        address = int(item.stem.split("_0x")[-1],16)
        if 0x2da000 <= address < 0x323000 or address in presentation:
            definitions.append((address,item))
    if not definitions:
        raise ValueError("No Battle functions")
    bodies = {base: translated_body(path) for base, path in definitions}
    join_split_delay_slot(bodies)
    entry = ['#include "abi.hpp"']
    for base, path in definitions:
        entry += [f'void {path.stem}(uint8_t*,R5900Context*,PS2Runtime*);']
    entry += ['#include "entry.inc"', 'void callBattle(uint32_t target,uint32_t site) {',
              '  switch (target) {']
    for base,path in definitions:
        landings = {base}
        for address in re.findall(r"case 0x([0-9a-f]+)u: goto label_",bodies[base]):
            landings.add(int(address,16))
        entry.extend(f'    case {pc:#x}:' for pc in sorted(landings))
        entry.append(f'      {path.stem}(data,&registers,&runtime); break;')
    entry += ['    default: battle_service(site,target); registers.pc = GPR_U32((&registers),31); break;','  }','}']
    chunks = []
    for group, members in (("battle",[(a,p) for a,p in definitions if a not in presentation]),
                           ("presentation",[(a,p) for a,p in definitions if a in presentation])):
        for i in range(0,len(members),40):
            file = args.out / f"{group}-{i//40}.cpp"
            file.write_text('#include "abi.hpp"\n' + '\n'.join(bodies[a] for a,_ in members[i:i+40]))
            chunks.append(file)
    main_file = args.out / "entry.cpp"
    main_file.write_text("\n".join(entry))
    flags = ["--target=wasm32-unknown-unknown","-std=c++20","-O1","-ffreestanding",
             "-fno-exceptions","-fno-rtti","-ffp-contract=off","-mbulk-memory","-nostdlib",
             *(["-DBATTLE_TRACK_PAGES"] if args.track else []),"-I"+str(HERE)]
    compiler = subprocess.check_output([args.clang,"--version"])
    common = (HERE/"abi.hpp").read_bytes() + (HERE/"entry.inc").read_bytes() + compiler + repr(flags).encode()
    objects = []
    for unit in [main_file,*chunks]:
        obj=unit.with_suffix(".o")
        tag=unit.with_suffix(".sha256")
        digest=hashlib.sha256(common+unit.read_bytes()).hexdigest()
        if not (obj.exists() and tag.exists() and tag.read_text()==digest):
            subprocess.run([args.clang,*flags,"-c",str(unit),"-o",str(obj)],check=True)
            tag.write_text(digest)
        objects.append(obj)
    subprocess.run([args.clang,"--target=wasm32-unknown-unknown","-nostdlib","-Wl,--no-entry",
                    "-Wl,--export-dynamic","-Wl,--allow-undefined","-Wl,--strip-all",*map(str,objects),
                    "-o",str(args.out/"battle.wasm")],check=True)
    print(f"Compiled {len(definitions)} Battle functions")


if __name__ == "__main__":
    main()
