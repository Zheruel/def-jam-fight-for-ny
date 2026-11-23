"""Spectator class meshes and clothed texture atlases, shared by every venue (`people/classes`, `people/outfits`).

A crowd class is a set of modular V2CM parts on the shared 13-bone rig (see crowd_pose.py), read from the class records the
spectators point at (`u32[instance record + 0x84]`, part ELFs at +0x294; crowd_pose.class_parts): upper body, legs, accessory,
shoes and head, in the male (`M1 M2 M4 M6 M3`), female (`F1 F2 F4 F6 F3`) and heavy (`B1 B2 M4 B6 M3`) families. Which sets
exist in a match is random in the retail game; `people/captures.json` and `foundation/crowd-poses.json` hold the sets seen in
the Foundation, Club Murder, Gun Hill Garage and Dragon House captures.

Parts are decoded unskinned in T-pose (as the fighters are); a class file carries the inverse bind matrices so a renderer skins
with `inverseBind x world` from a pose. Textures are not in the class file: each spectator wears one atlas per part
(`outfits/<slot>-<layer>-<palette>.png`, see `outfit`).
"""
from __future__ import annotations

import gzip
import json
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import extract as scenery  # noqa: E402
import crowd_pose  # noqa: E402
sys.path.insert(0, str(HERE.parent / "geometry"))
import ssh as ssh_module  # noqa: E402

VIV = "/ASSETS/V2CM.VIV"
OUT = HERE / "people"
VERTEX = struct.Struct("<3f3f2f4B4f")


# Every part's UVs address a shared 256x256 skin sheet: torso (digit 1) and head (3) the whole sheet, legs (2) and shoes (6) its
# lower-left quarter, the head accessory (4) the upper-right quarter. A part's atlas is the sheet cropped to what it needs, so
# the UVs are rewritten into that crop.
SHEET = 256
CROP = {"1": (0, 0, 256, 256), "3": (0, 0, 256, 256), "2": (0, 128, 128, 128), "4": (128, 0, 128, 128), "6": (0, 128, 128, 128)}
STOMP = {"1": (0, 0), "2": (43, 128), "4": (128, 0), "6": (0, 128)}   # where a clothing layer lands on the sheet


def remap(part: str, uv) -> tuple[float, float]:
    x, y, w, h = CROP[part[1]]
    return (uv[0] * SHEET - x) / w, (uv[1] * SHEET - y) / h


def layer(ssh: bytes, palette: int) -> bytes:
    """A stomp layer (`0000` 8-bit indices plus `plNN` palette-only shapes) painted with palette `palette` (1-based)."""
    count = struct.unpack_from("<I", ssh, 8)[0]
    shapes = {key.decode(): at for key, at in (struct.unpack_from("<4sI", ssh, 16 + 8 * i) for i in range(count))}
    start = shapes["0000"]
    width, height = struct.unpack_from("<HH", ssh, start + 4)
    clut = shapes[f"pl{palette:02d}"]
    if ssh[start] != 2 or ssh[clut] != 33:
        raise ValueError("unexpected stomp layer format")
    colours = []
    for k in range(256):
        at = (k & ~24) | ((k & 8) << 1) | ((k & 16) >> 1)   # CSM1 CLUT for PSMT8, as ssh.textures
        colours.append(ssh[clut + 16 + 4 * at:clut + 20 + 4 * at])
    return ssh_module.indexed_png(width, height, 8, ssh[start + 16:start + 16 + width * height], colours)


def decode_png(data: bytes) -> tuple[int, int, bytearray]:
    """Width, height and RGBA bytes of a non-interlaced 8-bit PNG (palette, RGB or RGBA), as `ssh` writes them."""
    chunks, at = {}, 8
    while at < len(data):
        size, kind = struct.unpack_from(">I4s", data, at)
        chunks.setdefault(kind, []).append(data[at + 8:at + 8 + size])
        at += 12 + size
    width, height, depth, colour = struct.unpack(">IIBB", chunks[b"IHDR"][0][:10])
    if depth != 8 or colour not in (2, 3, 6):
        raise ValueError("unsupported PNG")
    channels = {2: 3, 3: 1, 6: 4}[colour]
    raw, stride = zlib.decompress(b"".join(chunks[b"IDAT"])), width * channels
    rows, previous = [], bytearray(stride)
    for y in range(height):
        kind, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            left = line[x - channels] if x >= channels else 0
            up = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if kind == 1: line[x] = (line[x] + left) & 255
            elif kind == 2: line[x] = (line[x] + up) & 255
            elif kind == 3: line[x] = (line[x] + (left + up) // 2) & 255
            elif kind == 4:
                p = left + up - corner
                best = min((abs(p - left), left), (abs(p - up), up), (abs(p - corner), corner), key=lambda t: t[0])[1]
                line[x] = (line[x] + best) & 255
        rows.append(line)
        previous = line
    out = bytearray()
    if colour == 3:
        palette, alpha = chunks[b"PLTE"][0], chunks.get(b"tRNS", [b""])[0]
        for line in rows:
            for index in line:
                out += palette[3 * index:3 * index + 3] + bytes([alpha[index] if index < len(alpha) else 255])
    else:
        for line in rows:
            for x in range(0, stride, channels):
                out += line[x:x + 3] + (line[x + 3:x + 4] if channels == 4 else b"\xff")
    return width, height, out


def rgba_png(width: int, height: int, pixels: bytearray) -> bytes:
    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))
    raw = b"".join(b"\0" + bytes(pixels[y * width * 4:(y + 1) * width * 4]) for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def composite(base, top, at_x=0, at_y=0):
    """`top` laid over `base` at (at_x, at_y) (alpha over). The engine stomps a clothing layer onto the part's skin sheet."""
    bw, bh, pixels = base
    tw, th, over = top
    for y in range(max(0, min(th, bh - at_y))):
        for x in range(max(0, min(tw, bw - at_x))):
            i, j = ((y + at_y) * bw + x + at_x) * 4, (y * tw + x) * 4
            if over[j + 3] >= 128:
                pixels[i:i + 4] = over[j:j + 4]
    return bw, bh, pixels


def bleed(image):
    """Give transparent texels the colour of their opaque neighbours so filtering never fetches the colour key (magenta)."""
    width, height, pixels = image
    done = [pixels[i * 4 + 3] >= 128 for i in range(width * height)]
    for _ in range(4):
        grow = []
        for y in range(height):
            for x in range(width):
                if done[y * width + x]:
                    continue
                near = [(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if 0 <= x + dx < width and 0 <= y + dy < height
                        and done[(y + dy) * width + x + dx]]
                if near:
                    grow.append((y * width + x, near))
        for at, near in grow:
            for c in range(3):
                pixels[at * 4 + c] = sum(pixels[(ny * width + nx) * 4 + c] for nx, ny in near) // len(near)
        for at, _ in grow:
            done[at] = True
    for i in range(width * height):
        if pixels[i * 4 + 3] < 128 and not done[i]:
            pixels[i * 4:i * 4 + 3] = b"\0\0\0"
    return width, height, pixels


def person(disc, parts: tuple[str, ...]) -> bytes:
    retail = scenery.retail
    vertices, elements, batches = bytearray(), [], []
    inverse = None
    for part in parts:
        blob = scenery.member(disc, VIV, f"V2CM_{part}.o")
        elf = retail.Elf(blob)
        bones = {v: n[len("__Bone:::root."):] for n, v, _ in elf.symbols if n.startswith("__Bone:::root.")}
        base = min(bones)
        skeleton = elf.symbol("__Skeleton:::root")
        names = [bones[base + 16 * i] for i in range(elf.u32(skeleton + 8))]
        if names != crowd_pose.BONES:
            raise ValueError(f"{part}: unexpected skeleton {names}")
        records = skeleton + retail.SKELETON_RECORD_DELTA
        these = [list(struct.unpack_from("<16f", elf.data, records + retail.BONE_RECORD * i)) for i in range(13)]
        if inverse is not None and these != inverse:
            raise ValueError(f"{part}: bind differs from the other parts")
        inverse = these
        mesh = retail.build_mesh(elf, [{} for _ in names])
        first = len(vertices) // VERTEX.size
        for i in range(len(mesh["positions"]) // 3):
            joints = [int(j) for j in mesh["joints"][4 * i:4 * i + 4]]
            vertices.extend(VERTEX.pack(*mesh["positions"][3 * i:3 * i + 3], *mesh["normals"][3 * i:3 * i + 3],
                                        *remap(part, mesh["uvs"][2 * i:2 * i + 2]), *joints, *mesh["weights"][4 * i:4 * i + 4]))
        slot = part[:2]
        batches.append({"shape": slot, "first": len(elements), "count": len(mesh["indices"]), "part": part})
        elements.extend(first + i for i in mesh["indices"])
    payload = bytearray(vertices)
    payload.extend(struct.pack(f"<{len(elements)}H", *elements))
    meta = {"model": "+".join(parts), "vertices": len(vertices) // VERTEX.size, "indices": len(elements), "batches": batches,
            "textures": {}, "parts": list(parts), "bones": [{"name": n, "parent": p, "inverseBind": m}
                                                                    for n, p, m in zip(crowd_pose.BONES, crowd_pose.PARENTS, inverse)]}
    header = json.dumps(meta, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    return gzip.compress(b"DJF1" + struct.pack("<I", len(header)) + header + bytes(payload), compresslevel=9, mtime=0)


# --- outfits -----------------------------------------------------------------------------------------------
# A part's atlas is the skin sheet of its slot (`V2CM_<slot>.ssh`, `bases`; absent for the M6/B6 shoes) with a clothing layer
# (`V2CM_<slot>_<NN>.ssh`: one 8-bit layer plus palette-only shapes) stomped on at STOMP, cropped to CROP. The layer follows the
# part model (M2_03A wears layer 03; M1_01A, which has no layer 01, the first one above it); the heavy family (B1, B6) has no
# layers of its own and wears the male ones. WHICH palette a spectator wears is not decoded: the record words
# +0x154/+0x158/+0x164/+0x1a4 (crowd_pose "styles") stand in, and a record that has not finished spawning falls back to its name.
# An atlas key is "<base slot or X>[~<layer slot>-<layer>-<palette>]".
SLOTS = range(1, 13)


def layers_table(disc) -> dict:
    """{ "layers": {slot: {"02": palettes}}, "bases": [slots with a skin atlas] } from the archive."""
    layers, bases = {}, []
    for family in "MFB":
        for digit in "123456":
            slot = f"{family}{digit}"
            try:
                scenery.member(disc, VIV, f"V2CM_{slot}.ssh")
                bases.append(slot)
            except (FileNotFoundError, KeyError):
                pass
            for number in SLOTS:
                try:
                    ssh = scenery.member(disc, VIV, f"V2CM_{slot}_{number:02d}.ssh")
                except (FileNotFoundError, KeyError):
                    continue
                layers.setdefault(slot, {})[f"{number:02d}"] = struct.unpack_from("<I", ssh, 8)[0] - 1
    return {"layers": layers, "bases": bases}


def table() -> dict:
    return json.loads((OUT / "layers.json").read_text())


def outfit(name: str, parts: list[str], style: list[int], known: dict) -> dict[str, str]:
    """Atlas keys ("<slot>-<layer>-<palette>", or "<slot>" for a bare skin atlas) a spectator wears, by part slot."""
    seed = zlib.crc32(name.encode())
    a, b, c, d = (v if v < 32 else None for v in style)
    picks = {"1": lambda n: 1 + (b - 1) % n if b else 1 + seed % n, "2": lambda n: 1 + ((a or 0) + (c or seed)) % n,
             "4": lambda n: 1 + ((a or 0) + (b or seed >> 3)) % n, "6": lambda n: 1 + (d if d is not None else seed >> 5) % n}
    worn = {}
    for part in parts:
        slot, number = part[:2], int(part[3:5])
        base = slot if slot in known["bases"] else "X"
        source = slot if slot in known["layers"] else "M" + slot[1] if slot[0] == "B" and "M" + slot[1] in known["layers"] else None
        layers = known["layers"].get(source, {})
        above = sorted(int(k) for k in layers if int(k) >= number)
        chosen = number if f"{number:02d}" in layers else (above[0] if above and slot[1] in "13" else None)
        if chosen is None:
            worn[slot] = base
        else:
            count = layers[f"{chosen:02d}"]
            worn[slot] = f"{base}~{source}-{chosen:02d}-{picks.get(slot[1], lambda n: 1 + seed % n)(count)}"
    return worn


def outfit_png(disc, key: str, known: dict) -> bytes:
    """The part's skin sheet with its clothing layer stomped on, cropped to the region its UVs use."""
    base, _, rest = key.partition("~")
    digit = (rest or base)[1]
    if base != "X":
        sheet = decode_png(scenery.textures(scenery.member(disc, VIV, f"V2CM_{base}.ssh")).popitem()[1])
    else:
        sheet = (SHEET, SHEET, bytearray(SHEET * SHEET * 4))
    if rest:
        source, number, palette = rest.split("-")
        sheet = composite(sheet, decode_png(layer(scenery.member(disc, VIV, f"V2CM_{source}_{number}.ssh"), int(palette))), *STOMP[digit])
    x0, y0, w, h = CROP[digit]
    pixels = bytearray()
    for y in range(y0, y0 + h):
        pixels += sheet[2][(y * SHEET + x0) * 4:(y * SHEET + x0 + w) * 4]
    return rgba_png(*bleed((w, h, pixels)))


def class_id(parts: list[str]) -> str:
    return "-".join(parts)


def build(iso: Path, classes: list[list[str]], outfits: set[str]) -> dict[str, bytes]:
    """`people/layers.json`, the class meshes and the atlases asked for."""
    disc = scenery.Disc(str(iso))
    try:
        known = layers_table(disc)
        files = {"people/layers.json": (json.dumps(known, separators=(",", ":")) + "\n").encode()}
        for parts in classes:
            files[f"people/classes/{class_id(parts)}.skin.gz"] = person(disc, tuple(parts))
        for key in sorted(outfits):
            files[f"people/outfits/{key}.png"] = outfit_png(disc, key, known)
        return files
    finally:
        disc.close()


def write(files: dict[str, bytes]) -> None:
    for name, blob in files.items():
        path = HERE / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
