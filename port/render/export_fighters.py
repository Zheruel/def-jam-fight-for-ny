"""Package retail fighter skin attributes, inverse binds and diffuse textures for WebGL."""
import argparse
import gzip
import json
from pathlib import Path
import re
import struct
import sys

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "fighters"), str(HERE.parent / "geometry")]
from retail import Disc, Elf, decode_model, find_parts, read_member
from foundation import elf_links
from ssh import textures

INVENTORY = HERE.parents[1] / "ps2/content/inventory.json"
VERTEX = struct.Struct("<3f3f2f4B4f")


def pack(disc, name):
    obj = read_member(disc, name + ".o")[1]
    shapes = textures(read_member(disc, name + ".ssh")[1])
    mesh = decode_model(obj)
    elf = Elf(obj)
    model_symbol = next(n for n, _, _ in elf.symbols if n.startswith("__Model:::"))
    _, _, external = elf_links(obj, model_symbol)
    tags = {part["tag"] + 4: part["packet"] for part in find_parts(elf)}
    material = {}
    active = None
    for at in sorted(external.keys() | tags.keys()):
        symbol = external.get(at, "")
        if "__EAGLMicroCode" in symbol:
            active = None
        match = re.search(r";SHAPENAME=(\w{4}),1;", symbol)
        if match:
            active = match[1]
        if at in tags:
            material[tags[at]] = active
    count = len(mesh["positions"]) // 3
    payload = bytearray()
    for i in range(count):
        values = []
        for key, n in [("positions",3),("normals",3),("uvs",2),("joints",4),("weights",4)]:
            values.extend(mesh[key][n*i:n*(i+1)])
        payload.extend(VERTEX.pack(*values))
    elements = []
    groups = {}
    for part in mesh["parts"]:
        key = material[part["packet"]]
        if key in shapes:
            start = part["firstIndex"]
            groups.setdefault(key, []).extend(mesh["indices"][start:start+part["indexCount"]])
    if not groups:
        raise ValueError(f"No bound body texture in {name}")
    batches = []
    for shape, indices in groups.items():
        batches.append(dict(shape=shape, first=len(elements), count=len(indices)))
        elements.extend(indices)
    payload.extend(struct.pack(f"<{len(elements)}H", *elements))
    images = {}
    for key in groups:
        img = shapes[key]
        images[key] = [len(payload), len(img)]
        payload.extend(img)
    meta = dict(model=name, vertices=count, indices=len(elements), batches=batches,
                textures=images, bounds=mesh["boundingBox"],
                bones=[dict(name=b["name"],parent=b["parent"],inverseBind=b["inverseBind"],bindWorld=b["bindWorld"]) for b in mesh["bones"]])
    header = json.dumps(meta, separators=(",",":")).encode()
    header += b" " * (-len(header)%4)
    return gzip.compress(b"DJF1"+struct.pack("<I",len(header))+header+payload,compresslevel=6,mtime=0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("models", nargs="*")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    disc = Disc(args.iso)
    try:
        names = args.models or sorted({f["model"] for f in json.loads(INVENTORY.read_text())["fighters"]})
        for name in names:
            path = HERE / "fighters" / (name+".skin.gz")
            data = pack(disc, name)
            if args.check:
                if gzip.decompress(path.read_bytes()) != gzip.decompress(data):
                    raise ValueError(f"Skin data differs for {name}")
            else:
                path.write_bytes(data)
    finally:
        disc.close()


if __name__ == "__main__":
    main()
