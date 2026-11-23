"""Verify the retail US GameCube disc and index its filesystem and PowerPC DOL."""
import argparse
import hashlib
import json
import struct
from pathlib import Path, PurePosixPath

SIZE = 1459978240
SHA1 = "eab72bb2d1b08aa6807b5c86a2ac4f67ebbbaff4"


def index_disc(stream, size):
    def read(offset, length):
        if offset < 0 or offset + length > size:
            raise ValueError("Disc extent exceeds image")
        stream.seek(offset)
        data = stream.read(length)
        if len(data) != length:
            raise ValueError("Truncated image")
        return data

    head = read(0, 0x430)
    if head[:8] != b"GNWE69\0\0" or head[0x1c:0x20] != bytes.fromhex("c2339f3d"):
        raise ValueError("Expected Def Jam USA GameCube disc GNWE69 revision 0")
    dol, fst, fst_size = struct.unpack_from(">3I", head, 0x420)
    table = read(fst, fst_size)
    kind, _, count = struct.unpack_from(">3I", table)
    if kind != 1 << 24 or not 0 < count <= len(table) // 12:
        raise ValueError("Invalid root entry")
    names = table[count * 12:]
    stack = [(0, count, PurePosixPath())]
    files = []
    for i in range(1, count):
        while i == stack[-1][1]:
            stack.pop()
        name, offset, length = struct.unpack_from(">3I", table, i * 12)
        start = name & 0xffffff
        end = names.index(0, start)
        part = names[start:end].decode("ascii")
        if part in ("", ".", "..") or "/" in part or "\\" in part:
            raise ValueError("Invalid filename")
        path = stack[-1][2] / part
        if name >> 24 == 1 and offset == stack[-1][0] and i < length <= stack[-1][1]:
            stack.append((i, length, path))
        elif name >> 24 == 0 and offset + length <= size:
            files.append(dict(path=str(path), offset=offset, bytes=length))
        else:
            raise ValueError(f"Invalid filesystem extent at entry {i}")
    header = read(dol, 0x100)
    sections = []
    for n in range(18):
        offset, = struct.unpack_from(">I", header, n * 4)
        address, = struct.unpack_from(">I", header, 0x48 + n * 4)
        length, = struct.unpack_from(">I", header, 0x90 + n * 4)
        if length:
            if dol + offset + length > size:
                raise ValueError("Invalid DOL section")
            sections.append(dict(kind="text" if n < 7 else "data", offset=dol + offset,
                                 address=address, bytes=length))
    entry, = struct.unpack_from(">I", header, 0xe0)
    return dict(game_id="GNWE69", dol_offset=dol, entry=entry, sections=sections, files=files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with args.iso.open("rb") as stream:
        size = args.iso.stat().st_size
        if size != SIZE or hashlib.file_digest(stream, "sha1").hexdigest() != SHA1:
            parser.exit(1, "Image does not match the Redump USA reference.\n")
        catalog = index_disc(stream, size)
    catalog.update(sha1=SHA1, bytes=size)
    if args.output:
        args.output.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"Verified GNWE69 | {len(catalog['files'])} files | PowerPC entry 0x{catalog['entry']:08x}")


if __name__ == "__main__":
    main()
