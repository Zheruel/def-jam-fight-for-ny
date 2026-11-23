"""The Foundation's near-crowd people as skinned meshes (`foundation/people/class{0,1,2}.skin.gz`, DJF1 layout).

The venue loads three crowd classes; each is a set of modular V2CM parts on the shared 13-bone rig (see crowd_pose.py). The
sets were read from the three class records the spectators point at (`u32[instance record + 0x84]`; record + 0x290 holds the
part ELFs: M1, M2, M4, M6, -, M3) in the Foundation RAM captures, and each part ELF was named by its strtab:

    class 0 (record 0x158b690): M1_01A  M2_01A  M4_11A  M6_01A  M3_01A
    class 1 (record 0x158bcc0): M1_08A  M2_01A  M4_08A  M6_01A  M3_01A
    class 2 (record 0x158c2f0): M1_01A  M2_03A  M4_06A  M6_01A  M3_01A

Parts are decoded unskinned in T-pose (as the fighters are); the file carries the inverse bind matrices so a renderer skins with
`inverseBind x world` from a pose. Textures are each part's own `V2CM_Mn.ssh` `cm_m` skin atlas: the clothing the engine
stomps over it is not applied here (see README).
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
CLASSES = [
    ("M1_01A", "M2_01A", "M4_11A", "M6_01A", "M3_01A"),
    ("M1_08A", "M2_01A", "M4_08A", "M6_01A", "M3_01A"),
    ("M1_01A", "M2_03A", "M4_06A", "M6_01A", "M3_01A"),
]
VERTEX = struct.Struct("<3f3f2f4B4f")


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


def composite(base, top):
    """`top` laid over `base` at the origin (alpha over). The engine stomps a clothing layer onto the part's skin atlas."""
    bw, bh, pixels = base
    tw, th, over = top
    for y in range(min(bh, th)):
        for x in range(min(bw, tw)):
            i, j = (y * bw + x) * 4, (y * tw + x) * 4
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
                                        *mesh["uvs"][2 * i:2 * i + 2], *joints, *mesh["weights"][4 * i:4 * i + 4]))
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
# Each part is the V2CM_<slot>.ssh skin atlas with a clothing layer stomped over it in one of the layer's palettes
# (M1 shirts: 8 palettes, M2 jeans: 6, M4 belts/hems: 4-5, M6 boots: 3). The layer follows the class's part model
# (M1_01A wears the tank top, layer 02; M1_08A the puffer jacket, layer 08; M2/M4 layers are the model's number).
# WHICH palette each spectator wears is not decoded: the record words +0x154/+0x158/+0x164/+0x1a4 (see
# crowd_pose.export "styles") are used as a stand-in and a record that has not finished spawning falls back to its name.
M1_LAYER = {"M1_01A": 2, "M1_07A": 3, "M1_08A": 8}
PALETTES = {"M1": 8, "M2": 6, "M6": 3}


def outfit(name: str, klass: int, style: list[int]) -> dict[str, str]:
    """Texture keys ("<slot>-<layer>-<palette>", or "<slot>" for the bare skin atlas) a spectator wears, by slot."""
    seed = zlib.crc32(name.encode())
    a, b, c, d = (v if v < 32 else None for v in style)
    parts = {p[:2]: p for p in CLASSES[klass]}
    layers = {"M1": M1_LAYER[parts["M1"]], "M2": int(parts["M2"][3:5]), "M4": int(parts["M4"][3:5]), "M6": int(parts["M6"][3:5])}
    m4 = 4 if layers["M4"] <= 6 else 5
    picks = {"M1": 1 + (b - 1) % 8 if b else 1 + seed % 8,
             "M2": 1 + ((a or 0) + (c or seed)) % PALETTES["M2"],
             "M4": 1 + ((a or 0) + (b or seed >> 3)) % m4,
             "M6": 1 + (d if d is not None else seed >> 5) % PALETTES["M6"]}
    return {slot: f"{slot}-{layers[slot]:02d}-{picks[slot]}" for slot in ("M1", "M2", "M4", "M6")} | {"M3": "M3"}


def outfit_png(disc, key: str) -> bytes:
    slot, *rest = key.split("-")
    skin = None
    # Only the torso's UVs address the skin atlas (head, hands); the other slots' meshes are mapped onto the layer itself.
    if slot in ("M1", "M3"):
        skin = decode_png(scenery.textures(scenery.member(disc, VIV, f"V2CM_{slot}.ssh"))["cm_m"])
    clothes = decode_png(layer(scenery.member(disc, VIV, f"V2CM_{slot}_{rest[0]}.ssh"), int(rest[1]))) if rest else None
    image = composite(skin, clothes) if skin and clothes else skin or clothes
    return rgba_png(*bleed(image))


def outfits() -> dict[str, dict[str, str]]:
    poses = json.loads((HERE / "foundation" / "crowd-poses.json").read_text())
    return {name: outfit(name, poses["classes"][name], poses["styles"][name]) for name in sorted(poses["classes"])}


def build(iso: Path) -> dict[str, bytes]:
    disc = scenery.Disc(str(iso))
    try:
        files = {f"people/class{i}.skin.gz": person(disc, parts) for i, parts in enumerate(CLASSES)}
        for key in sorted({key for worn in outfits().values() for key in worn.values()}):
            files[f"people/outfits/{key}.png"] = outfit_png(disc, key)
        return files
    finally:
        disc.close()


def main() -> int:
    out = HERE / "foundation"
    for name, blob in build(scenery.DEFAULT_ISO).items():
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(blob)
        print(name, len(blob))
    return 0


if __name__ == "__main__":
    sys.exit(main())
