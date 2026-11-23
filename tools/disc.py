"""Verify and index the SLUS-21004 retail PS2 DVD for port and fidelity work."""
import argparse
import hashlib
import json
import struct
from pathlib import Path

SIZE = 4694573056
SHA1 = "5eda39dfd703804c8734b91bd23039f642317837"
SECTOR = 2048


def directory(stream, offset, size):
    stream.seek(offset)
    data = stream.read(size)
    pos = 0
    while pos < len(data):
        length = data[pos]
        if not length:
            pos += SECTOR - pos % SECTOR
            continue
        entry = data[pos:pos + length]
        if len(entry) < 34:
            raise ValueError("Invalid ISO9660 directory record")
        pos += length
        raw = entry[33:33 + entry[32]]
        if raw in (b"\0", b"\1"):
            continue
        name = raw.decode("ascii").split(";")[0]
        if name in (".", "..") or any(c in name for c in "/\\"):
            raise ValueError("Invalid file name")
        yield name, int.from_bytes(entry[2:6], "little") * SECTOR, int.from_bytes(entry[10:14], "little"), bool(entry[25] & 2)


def catalog(stream):
    stream.seek(16 * SECTOR)
    pvd = stream.read(SECTOR)
    if pvd[:7] != b"\1CD001\1":
        raise ValueError("Expected an ISO9660 DVD")
    stack = [("", int.from_bytes(pvd[158:162], "little") * SECTOR, int.from_bytes(pvd[166:170], "little"))]
    seen = set()
    files = {}
    while stack:
        prefix, offset, length = stack.pop()
        if offset in seen:
            raise ValueError("Repeated directory extent")
        seen.add(offset)
        for name, start, size, folder in directory(stream, offset, length):
            path = prefix + name
            if folder:
                stack.append((path + "/", start, size))
            else:
                files[path] = dict(offset=start, bytes=size)
    entry = files["SLUS_210.04"]
    stream.seek(entry["offset"])
    elf = stream.read(entry["bytes"])
    if elf[:6] != b"\x7fELF\x01\x01" or struct.unpack_from("<H", elf, 18)[0] != 8:
        raise ValueError("Expected a little-endian MIPS ELF executable")
    return dict(serial="SLUS-21004", sha1=SHA1, files=files,
                elf_entry=hex(struct.unpack_from("<I", elf, 24)[0]),
                elf_sha256=hashlib.sha256(elf).hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with args.iso.open("rb") as stream:
        if args.iso.stat().st_size != SIZE or hashlib.file_digest(stream, "sha1").hexdigest() != SHA1:
            parser.exit(1, "Image does not match the Redump USA PS2 reference.\n")
        result = catalog(stream)
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Verified SLUS-21004 | {len(result['files'])} files | EE entry {result['elf_entry']}")


if __name__ == "__main__":
    main()
