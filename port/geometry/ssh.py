"""Decode the indexed SHPS textures used in the US PS2 Battle venue archives."""

import binascii
import struct
import zlib


def png_chunk(kind, data):
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", binascii.crc32(kind + data))
    )


def indexed_png(width, height, bits, pixels, palette):
    """Store the indices losslessly. PNG packs its first 4-bit index in the high nibble."""
    if bits == 4:
        pixels = pixels.translate(bytes((x >> 4) | ((x & 15) << 4) for x in range(256)))
    stride = (width * bits + 7) // 8
    scanlines = b"".join(
        b"\0" + pixels[y * stride : (y + 1) * stride] for y in range(height)
    )
    rgb = b"".join(p[:3] for p in palette)
    alpha = bytes(min(255, p[3] * 2) for p in palette)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, bits, 3, 0, 0, 0))
        + png_chunk(b"PLTE", rgb)
        + png_chunk(b"tRNS", alpha)
        + png_chunk(b"IDAT", zlib.compress(scanlines, 6))
        + png_chunk(b"IEND", b"")
    )


def textures(ssh):
    magic, length, count = struct.unpack_from("<4sII", ssh)
    if magic != b"SHPS" or length != len(ssh) or count > (length - 16) // 8:
        raise ValueError("Invalid SHPS texture directory")
    result = {}
    for i in range(count):
        key, start = struct.unpack_from("<4sI", ssh, 16 + i * 8)
        kind = ssh[start]
        bits = {1: 4, 2: 8}[kind]
        width, height = struct.unpack_from("<HH", ssh, start + 4)
        clut = start + int.from_bytes(ssh[start + 1 : start + 4], "little")
        entries = 1 << bits
        if not width or not height or (bits == 4 and width % 2):
            raise ValueError("Invalid texture dimensions")
        end = start + 16 + width * height * bits // 8
        if end > clut or ssh[clut] != 0x21 or clut + 16 + 4 * entries > len(ssh):
            raise ValueError("Unexpected texture or CLUT format")
        palette = []
        for k in range(entries):
            # CSM1 CLUT for PSMT8 interchanges bits 3 and 4 within each group of 32.
            at = (k & ~24) | ((k & 8) << 1) | ((k & 16) >> 1) if bits == 8 else k
            palette.append(ssh[clut + 16 + 4 * at : clut + 20 + 4 * at])
        name = key.decode("ascii")
        if name in result:
            raise ValueError("Duplicate shape name")
        result[name] = indexed_png(width, height, bits, ssh[start + 16 : end], palette)
    return result
