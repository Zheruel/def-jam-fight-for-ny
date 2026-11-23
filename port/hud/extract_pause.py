"""Pack the pause atlas and six menu-row rectangles from the US PS2 release."""
from io import BytesIO
import json
from pathlib import Path
import re
import struct
import sys
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parents[1] / "ps2/battle"), str(HERE.parent / "geometry")]
from battle_patch import Disc
from refpack import decompress
from ssh import textures


def export(iso, output):
    disc = Disc(iso)
    try:
        path = "/ASSETS/MISC.VIV"
        data = disc.read(path, *disc.viv_entry(path, "pause.ssh"))
        rows = disc.read("/SLUS_210.04", 0x37b248 - 0xff000, 6 * 16)
    finally:
        disc.close()
    source = bytearray(decompress(data) if data.startswith(b"\x10\xfb") else data)
    count = struct.unpack_from("<I", source, 8)[0]
    names = []
    for i in range(count):
        at = 16 + i * 8
        begin = struct.unpack_from("<I", source, at + 4)[0]
        end = struct.unpack_from("<I", source, at + 12)[0] if i + 1 < count else len(source)
        label = re.findall(rb"p\0\0\0([A-Za-z0-9_]+)\0", source[begin:end])
        names.append(label[-1].decode() if label else bytes(source[at:at+4]).decode())
        source[at:at+4] = f"{i:04x}".encode()
    atlas = Image.new("RGBA", (512, 1024))
    x = y = row_height = 0
    sprites = {}
    for tag, png in textures(source).items():
        pic = Image.open(BytesIO(png)).convert("RGBA")
        w, h = pic.size
        if x + w > atlas.width:
            x, y, row_height = 0, y + row_height, 0
        if y + h > atlas.height:
            raise ValueError("Pause atlas exceeded its bounds")
        atlas.paste(pic, (x, y))
        sprites[names[int(tag, 16)]] = [x, y, w, h]
        x += w
        row_height = max(row_height, h)
    atlas.crop((0, 0, 512, y + row_height)).save(output / "pause.png")
    layout = {"rows": [list(map(int, row)) for row in struct.iter_unpack("<4f", rows)], "sprites": sprites}
    (output / "pause.json").write_text(json.dumps(layout, indent=2) + "\n")


if __name__ == "__main__":
    export(sys.argv[1], HERE)
