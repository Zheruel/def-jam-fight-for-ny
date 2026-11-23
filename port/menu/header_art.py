"""Rasterize the PS2 page header using its font mask, outline face and paper texture."""
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

from extract import apt, decompress


def export(source, output):
    output.mkdir(parents=True, exist_ok=True)
    parts = source.read("screens/pageHead.big")
    art = source.pictures("screens/pageHead.big")
    movie = apt.Apt.parse(parts["pageHead.apt"])
    elements = {entry["path"]: entry for entry in movie.flatten(0, 1)}
    fill = elements["/phTitle/maskText/phTitle1"]
    title_scale = movie.frames(0)[1][1].matrix[0]
    size = round(fill["size"] * title_scale)

    def font(member, px):
        archive = "/FONTS/FONTS.VIV"
        data = source.disc.read(archive, *source.disc.viv_entry(archive, member))
        if data.startswith(b"\x10\xfb"):
            data = decompress(data)
        return ImageFont.truetype(BytesIO(data), px)

    face = font("FERRO___.TTF", size)
    outline = font("Ferro Outline.ttf", size)
    paper = Image.open(BytesIO(art["7"])).convert("RGBA").convert("RGB")
    left, top, right, bottom = map(round, elements["/phTitle/scum/8"]["rect"])
    texture = Image.new("RGB", (640, 72))
    texture.paste(paper.resize((right-left, bottom-top), Image.Resampling.LANCZOS), (left, top))
    origin = tuple(round(v) for v in fill["rect"][:2])
    for label in ("CHOOSE MATCH TYPE", "CHOOSE FIGHTER", "CHOOSE VENUE", "CHOOSE TEAMS"):
        image = Image.new("RGBA", texture.size)
        ImageDraw.Draw(image).text(origin, label, font=outline, fill="black")
        mask = Image.new("L", image.size)
        ImageDraw.Draw(mask).text(origin, label, font=face, fill=255)
        image.paste(texture, mask=mask)
        image.crop((0, 0, image.getbbox()[2], image.getbbox()[3])).save(
            output / (label.lower().replace(" ", "-") + ".png"), optimize=True)
    hint_font = font("TradeBld.ttf", 16)
    for tag, name in (("16", "back"), ("18", "select")):
        image = Image.open(BytesIO(art[tag])).convert("RGBA")
        hint = Image.new("RGBA", (92, 22))
        hint.alpha_composite(image.crop((0, 0, 20, 20)))
        ImageDraw.Draw(hint).text((28, 3), name.upper(), font=hint_font, fill="white", stroke_width=1, stroke_fill="black")
        hint.save(output / (name + ".png"))
