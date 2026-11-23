"""Compose the PS2 match-type wall and English details from cmtype.big."""
import io
import json
import re
import struct
import sys
from pathlib import Path

from PIL import Image

from extract import Source, apt

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fighters"))
from retail import Elf


MODES = ("1v1", "team", "ffa", "window", "subway", "demolition", "inferno", "cage", "ringout")
DETAIL_FRAMES = (0, 1, 2, 4, 5, 6, 7, 9, 10)
ICON_FRAMES = (0, 1, 4, 6, 7, 8, 11, 12, 13)


def export(source, output):
    archive = "screens/battle/cmtype.big"
    parts = source.read(archive)
    movie = apt.Apt.parse(parts["cmtype.apt"])
    geometry = Elf(parts["cmtype.o"])
    models = {int(name.split(":::")[1]): address for name, address, _ in geometry.symbols if name.startswith("__Model:::")}
    pictures = {tag: Image.open(io.BytesIO(png)).convert("RGBA") for tag, png in source.pictures(archive).items()}
    output.mkdir(parents=True, exist_ok=True)

    def shape(character):
        left, top, right, bottom = map(round, movie.bounds(character))
        result = Image.new("RGBA", (right-left, bottom-top))
        model = models[character]
        table = geometry.u32(model)
        for slot in range(1, geometry.u32(model+4)):
            attr = table + slot*16
            name = geometry.u32(attr)
            tag = re.match(rb"ScaleMatrix::(\d+)::TextureMatrix", geometry.data[name:]).group(1).decode()
            matrix = struct.unpack_from("<16f", geometry.data, geometry.u32(attr+12))
            assert matrix[:12] == (1,0,0,0, 0,1,0,0, 0,0,1,0)
            # Bounds for each texture batch precede the model in reverse attribute order.
            x, y, _, _, r, b, _, _ = struct.unpack_from("<8f", geometry.data, model-48*slot)
            crop = tuple(round(v) for v in (x+matrix[12], y+matrix[13], r+matrix[12], b+matrix[13]))
            tile = pictures[tag]
            assert 0 <= crop[0] < crop[2] <= tile.width and 0 <= crop[1] < crop[3] <= tile.height
            result.paste(tile.crop(crop), (round(x)-left, round(y)-top))
        return result

    def draw(image, element):
        x, y, right, bottom = map(round, element["rect"])
        art = shape(element["character"]).resize((right-x, bottom-y), Image.Resampling.LANCZOS)
        image.alpha_composite(art, (x,y))
        return [x,y,right-x,bottom-y]

    root = movie.frames(0)[0]
    elements = movie.flatten()
    wall = Image.new("RGBA", movie.size)
    draw(wall, elements[0])
    cards = [item for item in elements if "_poster/" in item["path"]]
    assert len(cards) == len(MODES)
    layout = {"cards": {mode: draw(wall, item) for mode, item in zip(MODES,cards)}, "locks": {}, "details": {}}
    wall.convert("RGB").save(output / "wall.webp", lossless=True, method=6)
    locks = [item for item in elements if item["character"] == 51]
    for mode, item in zip(MODES[3:], locks):
        x,y,r,b = map(round,item["rect"])
        layout["locks"][mode] = [x,y,r-x,b-y]
    shape(51).save(output / "lock.png")
    shape(11).save(output / "highlight.png")
    shape(298).save(output / "size-paper.png")
    shape(300).save(output / "size-highlight.png")

    panel = next(item for item in root if item.name == "mtd")
    layers = movie.frames(panel.character)[0]
    for mode, icon, frame in zip(MODES, ICON_FRAMES, DETAIL_FRAMES):
        image = Image.new("RGBA", movie.size)
        for layer in layers:
            transform = apt.compose(panel.matrix, layer.matrix)
            for element in movie.flatten(layer.character, icon if layer.name=="cmtIcons" else frame, transform):
                draw(image, element)
        bounds = image.getbbox()
        layout["details"][mode] = list(bounds[:2])
        image.crop(bounds).save(output / f"{mode}.png", optimize=True)
    (output / "layout.json").write_text(json.dumps(layout, indent=2)+"\n")


if __name__ == "__main__":
    source = Source(sys.argv[1])
    try:
        export(source, Path(__file__).resolve().parent / "art" / "match-type")
    finally:
        source.disc.close()
