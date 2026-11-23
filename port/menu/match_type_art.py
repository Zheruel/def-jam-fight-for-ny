"""Compose the PS2 match-type wall and English details from cmtype.big."""
import io
import json
import re
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from extract import Source, apt, decompress, loc_strings

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fighters"))
from retail import Elf


MODES = ("1v1", "team", "ffa", "window", "subway", "demolition", "inferno", "cage", "ringout")
DETAIL_FRAMES = (0, 1, 2, 4, 5, 6, 7, 9, 10)
ICON_FRAMES = (0, 1, 4, 6, 7, 8, 11, 12, 13)


def movie_shapes(source, archive):
    stem = Path(archive).stem
    parts = source.read(archive)
    movie = apt.Apt.parse(parts[stem + ".apt"])
    geometry = Elf(parts[stem + ".o"])
    models = {int(name.split(":::")[1]): address for name, address, _ in geometry.symbols if name.startswith("__Model:::")}
    pictures = {tag: Image.open(io.BytesIO(png)).convert("RGBA") for tag, png in source.pictures(archive).items()}

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

    return movie, shape, draw


def export_rules(source, output):
    movie, shape, draw = movie_shapes(source, "screens/battle/rules.big")
    text = loc_strings(source)
    elements = movie.flatten()
    fields = {entry["path"]: entry for entry in elements if entry["kind"] == "text"}
    icons = {"standard": 15, "votes": 7, "no-submissions": 11}
    faces = {}
    for field in fields.values():
        face = movie.cstring(movie.u32(movie.characters[field["font"]] + 8))
        member = {"Arial": "AachenStd-Bold.ttf", "TradeBld": "TradeBld.ttf", "TradeCon": "TradeCon.ttf"}[face]
        archive = "/FONTS/FONTS.VIV"
        data = source.disc.read(archive, *source.disc.viv_entry(archive, member))
        if data.startswith(bytes.fromhex("10fb")):
            data = decompress(data)
        faces[field["character"]] = ImageFont.truetype(io.BytesIO(data), round(field["size"]))

    def label(image, field, words):
        x, y, right, bottom = field["rect"]
        centered = field["align"] == 2
        font = faces[field["character"]]
        color = "#%06x" % (field["color"] & 0xffffff)
        lines = [""]
        for word in words.split():
            line = (lines[-1] + " " + word).strip()
            if lines[-1] and font.getlength(line) > right-x:
                lines.append(word)
            else:
                lines[-1] = line
        pen = ImageDraw.Draw(image)
        for n, line in enumerate(lines):
            pen.text(((x+right)/2 if centered else x, y+2+n*font.size), line, font=font,
                     fill=color, anchor="ma" if centered else "la")

    for rule, title, description in (("standard", 189, 190), ("votes", 184, 185), ("no-submissions", 186, 187)):
        art = Image.new("RGBA", (294, 292))
        for item in elements:
            if item["kind"] != "image":
                continue
            character = item["character"]
            if character not in icons.values() or character == icons[rule]:
                draw(art, item)
                continue
            # The icon sprites' first placement multiplies by (0,0,0,204) and adds (50,50,50,0).
            # The selected frame restores the unmodified texture.
            x, y, right, bottom = map(round, item["rect"])
            silhouette = Image.new("RGBA", (right-x, bottom-y), (50,50,50))
            alpha = shape(character).getchannel("A").resize(silhouette.size, Image.Resampling.LANCZOS)
            silhouette.putalpha(alpha.point(lambda a: round(a*204/255)))
            art.alpha_composite(silhouette, (x, y))
        label(art, fields["/19"], "SELECT")
        label(art, fields["/30"], text[188])
        label(art, fields["/31"], text[title])
        label(art, fields["/32"], text[description])
        art.save(output / f"rules-{rule}.png", optimize=True)
    for mode, index in (("1v1", 2016), ("team", 2073), ("ffa", 2037)):
        title = Image.new("RGBA", (294, 55))
        label(title, fields["/matchType"], text[index])
        title.save(output / f"rules-title-{mode}.png", optimize=True)


def export(source, output):
    movie, shape, draw = movie_shapes(source, "screens/battle/cmtype.big")
    output.mkdir(parents=True, exist_ok=True)
    export_rules(source, output)
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
