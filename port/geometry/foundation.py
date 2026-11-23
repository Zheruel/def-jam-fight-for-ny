"""Extract the original PS2 Foundation base render mesh from a local retail ISO."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "ps2" / "battle"))

from battle_patch import Disc
from refpack import decompress


ARCHIVE = "ASSETS/V2BG.VIV"
MEMBER = "V2BG_02A.o"
MODEL = "__Model:::V2BG_02A_branch"
OUTPUT = HERE / "foundation.json"
GAME_ID = "SLUS-21004"
DISC_SHA1 = "5eda39dfd703804c8734b91bd23039f642317837"
MEMBER_SHA256 = "92a7ea6dc84b1e791633419d66367c43f44295ff7799177095525fb1b93c26ae"
ELF_SHA256 = "2cf25cfb9d8baac0df2a2461b57551eda253bdc75a2d4a7bb8cda5d1f7889da8"


def section_bytes(blob: bytes, start: int, length: int) -> bytes:
    if start < 0 or length < 0 or start + length > len(blob):
        raise ValueError("data runs outside its containing section")
    return blob[start:start + length]


def c_string(blob: bytes, offset: int) -> str:
    return blob[offset:blob.index(0, offset)].decode("ascii")


def elf_links(blob: bytes, model: str) -> tuple[bytes, dict[int, int], dict[int, str]]:
    """Return ELF .data and its local R_MIPS_32 relocation targets."""
    if len(blob) < 52 or blob[:7] != b"\x7fELF\x01\x01\x01" or blob[16:20] != b"\x01\x00\x08\x00":
        raise ValueError("expected a little-endian ELF32/MIPS relocatable object")
    section_table, = struct.unpack_from("<I", blob, 32)
    entry_size, count, names_index = struct.unpack_from("<HHH", blob, 46)
    if entry_size != 40 or not 0 < names_index < count:
        raise ValueError("invalid ELF section table")
    sections = tuple(struct.iter_unpack("<10I", section_bytes(blob, section_table, count * entry_size)))

    def contents(section):
        return section_bytes(blob, section[4], section[5])

    names = contents(sections[names_index])
    named_sections = {c_string(names, section[0]): index for index, section in enumerate(sections)}
    data_index = named_sections[".data"]
    data_section = sections[data_index]
    relocs = sections[named_sections[".rel.data"]]
    symbol_index = named_sections[".symtab"]
    symbols_section = sections[symbol_index]
    if data_section[1] != 1 or relocs[1] != 9 or symbols_section[1] != 2:
        raise ValueError("unexpected ELF model section types")
    if relocs[6:8] != (symbol_index, data_index) or relocs[9] != 8 or symbols_section[9] != 16:
        raise ValueError("unsupported ELF relocation or symbol layout")
    data = contents(data_section)
    symbols = tuple(struct.iter_unpack("<IIIBBH", contents(symbols_section)))
    symbol_names = contents(sections[symbols_section[6]])
    if not any(c_string(symbol_names, name) == model and index == data_index
               for name, _, _, _, _, index in symbols):
        raise ValueError(f"Missing model symbol {model}")

    local = {}
    external = {}
    for at, info in struct.iter_unpack("<II", contents(relocs)):
        symbol, kind = divmod(info, 256)
        if kind != 2 or symbol >= len(symbols) or at % 4 or at + 4 > len(data):
            raise ValueError("invalid R_MIPS_32 model relocation")
        name, value, _, _, _, index = symbols[symbol]
        if index == data_index:
            local[at] = value + struct.unpack_from("<I", data, at)[0]
        elif index == 0:
            external[at] = c_string(symbol_names, name)
    return data, local, external


def elf_model(blob: bytes) -> tuple[bytes, dict[int, int]]:
    data, local, _ = elf_links(blob, MODEL)
    return data, local


def dma_ref(data: bytes, reference: int, target: int, payload_size: int) -> None:
    """Validate a VIF1 DMA REF tag and the packet size declared by the tag."""
    if target % 16 or reference % 16 != 4 or reference < 4:
        raise ValueError("unaligned Foundation VIF packet reference")
    tag, = struct.unpack_from("<I", data, reference - 4)
    qwc = (payload_size + 15) // 16
    if tag != ((3 << 28) | qwc) or target + qwc * 16 > len(data):
        raise ValueError("Foundation VIF packet disagrees with DMA tag length")


def vif_tag(command: int, count: int, address: int) -> bytes:
    return struct.pack("<I", command << 24 | count << 16 | 0xC000 | address)


def triangle_indices(base: int, strips: list[int]) -> list[int]:
    """Expand strips, alternating winding after each new vertex."""
    indices = []
    for start, end in zip(strips, strips[1:]):
        for at in range(start + 2, end):
            a, b, c = (base + at - 2, base + at - 1, base + at)
            indices.extend((b, a, c) if (at - start) % 2 else (a, b, c))
    return indices


def decode(blob: bytes) -> dict:
    data, local = elf_model(blob)
    positions: list[float] = []
    texcoords: list[float] = []
    colors: list[int] = []
    indices: list[int] = []
    packets = set()
    strip_count = 0
    for reference, packet in sorted(local.items()):
        if data[packet:packet + 4] != vif_tag(0x6C, 1, 0):
            continue
        header = section_bytes(data, packet, 48)
        count, = struct.unpack_from("<I", header, 4)
        if header[8:20] != bytes(12) or not 3 <= count <= 72:
            continue
        if any(header[offset:offset + 4] != vif_tag(0x6E, 1, address)
               for offset, address in ((20, 0x14), (28, 0x15), (36, 0x16))):
            continue
        if header[44:] != vif_tag(0x6C, count, 0x17):
            raise ValueError("Foundation position UNPACK tag is invalid")

        payload_size = 56 + count * 32
        dma_ref(data, reference, packet, payload_size)
        if packet in packets:
            raise ValueError("Foundation position packet has more than one DMA reference")
        packets.add(packet)

        packed_boundaries = header[24:28] + header[32:36] + header[40:44]
        boundaries = packed_boundaries.rstrip(b"\0")
        if any(value % 3 for value in boundaries):
            raise ValueError("Foundation strip boundary is not a multiple of 3")
        strips = [0, *(value // 3 for value in boundaries), count]
        if any(b - a < 3 for a, b in zip(strips, strips[1:])):
            raise ValueError("Foundation strips are out of order or too short")
        strip_count += len(strips) - 1
        indices.extend(triangle_indices(len(positions) // 3, strips))

        pos_at = packet + 48
        uv_at = pos_at + count * 16
        if data[uv_at:uv_at + 4] != vif_tag(0x6C, count, 0x5F):
            raise ValueError("Foundation texture-coordinate UNPACK tag is invalid")
        terminator = uv_at + 4 + count * 16
        if data[terminator:terminator + 4] != b"\0\0\0\x17":
            raise ValueError("Foundation VIF packet must end in MSCNT")
        for x, y, z, w in struct.iter_unpack("<4f", data[pos_at:uv_at]):
            if w != 1 or not all(math.isfinite(value) for value in (x, y, z)):
                raise ValueError("invalid Foundation position")
            positions.extend((x, y, z))
        for u, v, q, w in struct.iter_unpack("<4f", data[uv_at + 4:terminator]):
            if q != 1 or w != 0 or not math.isfinite(u) or not math.isfinite(v):
                raise ValueError("invalid Foundation texture coordinate")
            texcoords.extend((u, v))

        color_at = local.get(reference - 16)
        if color_at is None:
            raise ValueError("Foundation position packet has no color DMA reference")
        dma_ref(data, reference - 16, color_at, 4 + count * 4)
        if data[color_at:color_at + 4] != vif_tag(0x6E, count, 0xA7):
            raise ValueError("Foundation color UNPACK tag is invalid")
        colors.extend(data[color_at + 4:color_at + 4 + count * 4])

    if not packets:
        raise ValueError("no Foundation position packets found")
    limits = {name: [fn(positions[i::3]) for i in range(3)]
              for name, fn in (("min", min), ("max", max))}
    return {
        "positions": positions,
        "indices": indices,
        "texcoords": texcoords,
        "colors": colors,
        "bounds": limits,
        "counts": {
            "packets": len(packets),
            "strips": strip_count,
            "vertices": len(positions) // 3,
            "triangles": len(indices) // 3,
        },
    }


def from_disc(path: Path) -> dict:
    disc = Disc(str(path))
    try:
        iso_path = "/" + ARCHIVE
        member_offset, member_length = disc.viv_entry(iso_path, MEMBER)
        packed = disc.read(iso_path, member_offset, member_length)
    finally:
        disc.close()
    if hashlib.sha256(packed).hexdigest() != MEMBER_SHA256:
        raise ValueError("Foundation VIV member differs from the US retail reference")
    blob = decompress(packed)
    if hashlib.sha256(blob).hexdigest() != ELF_SHA256:
        raise ValueError("RefPack did not produce the expected Foundation ELF object")
    mesh = decode(blob)
    mesh["source"] = {
        "gameId": GAME_ID,
        "referenceDiscSha1": DISC_SHA1,
        "archive": ARCHIVE,
        "member": MEMBER,
        "memberOffset": member_offset,
        "memberBytes": member_length,
        "memberSha256": MEMBER_SHA256,
        "elfSha256": ELF_SHA256,
        "model": MODEL,
    }
    return mesh


def encode(mesh: dict) -> str:
    """Compact decimal floats that round-trip to the original float32 values."""
    compact = mesh.copy()
    for key in ("positions", "texcoords"):
        compact[key] = [float(format(value, ".9g")) for value in mesh[key]]
    compact["bounds"] = {
        key: [float(format(value, ".9g")) for value in pair]
        for key, pair in mesh["bounds"].items()
    }
    return json.dumps(compact, separators=(",", ":"), allow_nan=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("extract", "verify"))
    parser.add_argument("iso", type=Path)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()

    mesh = from_disc(args.iso)
    encoded = encode(mesh)
    if args.command == "extract":
        args.output.write_text(encoded, encoding="utf-8")
    elif args.output.read_text(encoding="utf-8") != encoded:
        parser.error(f"{args.output} differs from freshly decoded retail geometry")
    print(json.dumps(mesh["counts"], separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
