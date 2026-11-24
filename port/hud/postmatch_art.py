"""Export the retail versus score sheets (the match summary screens shown after a Battle match) from SCREENS.VIV.

    python3 port/hud/postmatch_art.py <reference.iso> [output directory]        (default port/hud/postmatch)

SCREENS.VIV screens/battle/matchSm1..4.big are Apt movies of one to four player panels. The retail flow (SLUS 0x178440, see
port/hud/postmatch.mjs) opens matchSm<N> for N people after a Battle match (N = 1 only when that person won). Each panel is
a paper card with the player's colour label, the "P<n>" sticker, a name field, the player's thumbnail and "NAME as ALIAS"
logo, the SCORE bar, a scrolling list of what earned points, and the TOTAL, CASH and TOTAL EARNINGS bars.

sheet-<N>.json is the settled draw list of the movie (its timeline runs the panels in and counts the numbers up; the final
frame of every clip is used, the label colour and sticker frame of player k are frame k-1), each picture exported once from
its split texture (match_type_art.movie_shapes). Fighter art, per count of panels: screens/portrait/t_MS/t_MS_<id>_<2|3|4>p
(thumbnail) and l_CF/l_CF_<id>_2p (sheet 1) or l_MS_<id>_<2|3|4>p (name logo), placed at the movie's playerPhoto<k> and
logoLoader<k> anchors.
"""
import hashlib
import io
import json
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "menu"), str(HERE), str(HERE.parent / "geometry")]
from extract import Source, apt, fighter_art_id  # noqa: E402
from match_type_art import movie_shapes  # noqa: E402

SHAPE, EDIT_TEXT, SPRITE = 1, 2, 5
ART_COUNT = {1: 2, 2: 2, 3: 3, 4: 4}   # the picture suffix each sheet loads (matchSm1's logos come from l_CF)
# Values the engine fills in at run time, by the clip that holds them.
VALUE_ROLES = {"points": "points", "cash": "cash", "earnings": "earnings", "purse": "purse"}


def save(image, path, lossy=False):
    if lossy:
        image.save(path, "WEBP", quality=88, alpha_quality=100, method=6)
    else:
        image.save(path, "WEBP", lossless=True, method=6)


def panel_of(path):
    for part in path.split("/"):
        if part.startswith("playerContent") and part[13:].isdigit():
            return int(part[13:])
    return None


def settle(path, count, panel):
    """Which frame of a clip to show: the player's colour for its label and sticker, the first for the clips that hold run-time
    values (their text field sits there), otherwise the last."""
    names = path.split("/")
    if "panelColor" in names or "playerSticker" in names:
        return min((panel or 1) - 1, count - 1)
    if any(name in VALUE_ROLES for name in names):
        return 0
    return count - 1


def walk(movie, sprite, frame, parent, path, out, anchors, depth=0):
    frames = movie.frames(sprite)
    frame = min(frame, len(frames) - 1)
    shown = {}
    for items in frames[:frame + 1]:
        for item in items:
            if item.character < 0:
                shown.pop(item.depth, None)
            elif item.character < len(movie.characters):
                shown[item.depth] = item
    for depth_key in sorted(shown):
        item = shown[depth_key]
        matrix = apt.compose(parent, item.matrix)
        kind = movie.kind(item.character)
        label = f"{path}/{item.name or item.character}"
        if kind == SHAPE:
            out.append({"kind": "image", "character": item.character, "path": label,
                        "rect": apt.transform_rect(matrix, movie.bounds(item.character))})
        elif kind == EDIT_TEXT:
            out.append({"kind": "text", "path": label, "rect": apt.transform_rect(matrix, movie.bounds(item.character)),
                        **movie.edit_text(item.character)})
        elif kind == SPRITE and depth < 8:
            if item.name and (item.name.startswith("playerPhoto") or item.name.startswith("logoLoader")):
                anchors[item.name] = [round(matrix[4], 2), round(matrix[5], 2)]
            panel = panel_of(label)
            walk(movie, item.character, settle(label, len(movie.frames(item.character)), panel), matrix, label, out, anchors, depth + 1)


def role_of(element):
    """What a text field is for: its variable or path decides."""
    path = element["path"]
    name = path.rsplit("/", 1)[-1]
    if name == "szFighterNameMov": return "name"
    if name == "scoreText": return "score"
    for key in VALUE_ROLES:
        if f"/{key}/" in path: return "value-" + key
    if element["variable"] in ("playerText1", "playerText2", "playerText3"): return "sticker" + element["variable"][-1]
    if (element["text"] or "").startswith("~"): return "label"
    return None


def scaled_shape(source, archive, movie, character):
    """A single-batch shape whose texture matrix scales (the colour bars' grunge overlay): crop what the matrix maps the shape's
    bounds to, and fit it to the bounds."""
    import re
    import struct
    from retail import Elf
    stem = Path(archive).stem
    parts = source.read(archive)
    geometry = Elf(parts[stem + ".o"])
    models = {int(n.split(":::")[1]): a for n, a, _ in geometry.symbols if n.startswith("__Model:::")}
    model = models[character]
    table = geometry.u32(model)
    assert geometry.u32(model + 4) == 2
    attr = table + 16
    name = geometry.u32(attr)
    tag = re.match(rb"ScaleMatrix::(\d+)::TextureMatrix", geometry.data[name:]).group(1).decode()
    m = struct.unpack_from("<16f", geometry.data, geometry.u32(attr + 12))
    left, top, right, bottom = movie.bounds(character)
    crop = tuple(round(v) for v in (left * m[0] + m[12], top * m[5] + m[13], right * m[0] + m[12], bottom * m[5] + m[13]))
    tile = Image.open(io.BytesIO(source.pictures(archive)[tag])).convert("RGBA")
    return tile.crop(crop).resize((round(right - left), round(bottom - top)), Image.Resampling.LANCZOS)


MASK = (0x00, 0xCC, 0x33, 0xFF)   # the green clip mask the movie's script uses for the list window; never drawn


def solid_colours(parts, name):
    """Fill colour (RGBA) of the movie's flat shapes (no texture batch): the colour bars and shadows. The colour is the word
    after the VIF UNPACK 0x92 in the shape's packet, which precedes the model record."""
    from retail import Elf
    geometry = Elf(parts[name + ".o"])
    colours = {}
    for symbol, address, _ in geometry.symbols:
        if not symbol.startswith("__Model:::"):
            continue
        model = address
        if geometry.u32(model + 4) > 1:
            continue
        blob = geometry.data[max(0, model - 0x300):model]
        at = blob.rfind(b"\x92\xc0\x01\x6e")
        if at >= 0:
            colours[int(symbol.split(":::")[1])] = tuple(blob[at + 4:at + 8])
    return colours


def export_sheet(source, output, number, pictures):
    name = f"matchSm{number}"
    parts = source.read(f"screens/battle/{name}.big")
    movie = apt.Apt.parse(parts[name + ".apt"])
    _, shape, _ = movie_shapes(source, f"screens/battle/{name}.big")
    solid = solid_colours(parts, name)
    out, anchors = [], {}
    walk(movie, 0, 0, (1, 0, 0, 1, 0, 0), "", out, anchors)
    elements = []
    for element in out:
        rect = [round(v, 2) for v in element["rect"]]
        panel = panel_of(element["path"])
        if element["kind"] == "image":
            try:
                image = shape(element["character"])
            except KeyError:
                continue   # a run-time picture slot (the player photo)
            except AssertionError:
                try:
                    image = scaled_shape(source, f"screens/battle/{name}.big", movie, element["character"])
                except (KeyError, AssertionError):
                    continue
            if image.getchannel("A").getextrema()[1] == 0:
                colour = solid.get(element["character"])
                if colour == MASK and panel is not None:
                    elements.append({"kind": "list", "panel": panel, "rect": rect})   # the list window
                    continue
                if colour is None or "/scroller/" in element["path"]:
                    continue
                image = Image.new("RGBA", (4, 4), colour)   # a flat fill, stretched to its rect
            digest = hashlib.sha1(image.tobytes() + str(image.size).encode()).hexdigest()[:10]
            file = f"picture-{digest}.webp"
            if digest not in pictures:
                pictures[digest] = file
                save(image, output / file, lossy=image.width * image.height > 20000)
            elements.append({"kind": "image", "file": file, "rect": rect, "panel": panel, "path": element["path"]})
            continue
        role = role_of(element)
        if role is None:
            continue
        face = movie.cstring(movie.u32(movie.characters[element["font"]] + 8))
        elements.append({"kind": "text", "role": role, "panel": panel, "rect": rect, "align": element["align"], "face": face,
                         "size": round(element["size"], 2), "color": element["color"], "text": element["text"], "path": element["path"]})
    sheet = {"movie": f"screens/battle/{name}.big", "size": list(movie.size), "panels": number, "anchors": anchors, "elements": elements}
    (output / f"sheet-{number}.json").write_text(json.dumps(sheet, indent=1) + "\n")
    return sheet




def export_fighters(source, output, roster):
    """Thumbnails and name logos for every selectable fighter and sheet size; returns what exists: {id: {file: [w, h]}}."""
    have = {}
    for fighter in roster:
        ident = fighter["id"]
        art = fighter_art_id(fighter, ident)
        for count in (2, 3, 4):
            for kind, path in (("thumb", f"screens/portrait/t_MS/t_MS_{art}_{count}p.big"),
                               ("name", f"screens/portrait/l_MS_{art}_{count}p.big"),
                               ("name-cf", f"screens/portrait/l_CF/l_CF_{art}_{count}p.big")):
                if not source.has(path):
                    continue
                movie, shape, _ = movie_shapes(source, path)
                images = [e for e in movie.flatten() if e["kind"] == "image"]
                if len(images) != 1:
                    continue
                file = f"{kind}-{ident}-{count}p.webp"
                image = shape(images[0]["character"])
                save(image, output / file)
                have.setdefault(str(ident), {})[f"{kind}-{count}"] = [image.width, image.height]
    return have


def export_header(source, output):
    """The "MATCH SUMMARY" page heading and the "CONTINUE" button hint, drawn like the selector's pageHead art (port/menu/header_art.py)."""
    from io import BytesIO
    from PIL import ImageDraw, ImageFont
    from extract import decompress
    parts = source.read("screens/pageHead.big")
    art = source.pictures("screens/pageHead.big")
    movie = apt.Apt.parse(parts["pageHead.apt"])
    elements = {entry["path"]: entry for entry in movie.flatten(0, 1)}
    fill = elements["/phTitle/maskText/phTitle1"]
    size = round(fill["size"] * movie.frames(0)[1][1].matrix[0])

    def font(member, px):
        archive = "/FONTS/FONTS.VIV"
        data = source.disc.read(archive, *source.disc.viv_entry(archive, member))
        return ImageFont.truetype(BytesIO(decompress(data) if data.startswith(b"\x10\xfb") else data), px)

    face, outline = font("FERRO___.TTF", size), font("Ferro Outline.ttf", size)
    paper = Image.open(BytesIO(art["7"])).convert("RGBA").convert("RGB")
    left, top, right, bottom = map(round, elements["/phTitle/scum/8"]["rect"])
    texture = Image.new("RGB", (640, 72))
    texture.paste(paper.resize((right - left, bottom - top), Image.Resampling.LANCZOS), (left, top))
    origin = tuple(round(v) for v in fill["rect"][:2])
    image = Image.new("RGBA", texture.size)
    ImageDraw.Draw(image).text(origin, "MATCH SUMMARY", font=outline, fill="black")
    mask = Image.new("L", image.size)
    ImageDraw.Draw(mask).text(origin, "MATCH SUMMARY", font=face, fill=255)
    image.paste(texture, mask=mask)
    box = image.getbbox()
    image.crop((0, 0, box[2], box[3])).save(output / "heading.png", optimize=True)
    icon = Image.open(BytesIO(art["18"])).convert("RGBA")
    hint = Image.new("RGBA", (120, 22))
    hint.alpha_composite(icon.crop((0, 0, 20, 20)))
    ImageDraw.Draw(hint).text((28, 3), "CONTINUE", font=font("TradeBld.ttf", 16), fill="white", stroke_width=1, stroke_fill="black")
    hint.save(output / "continue.png")


FONTS = {"TradeCon": "TradeCon.ttf", "Schwartz_Hand_Bold2": "SchwartzHand_Bold2.ttf"}


def export_fonts(source, output):
    """The two faces the sheets use (their text fields name them): the condensed label face and the hand-written sticker face."""
    from extract import decompress
    archive = "/FONTS/FONTS.VIV"
    for face, member in FONTS.items():
        data = source.disc.read(archive, *source.disc.viv_entry(archive, member))
        if data.startswith(bytes.fromhex("10fb")):
            data = decompress(data)
        (output / f"{face}.ttf").write_bytes(data)


def export(source, output, roster):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    export_fonts(source, output)
    export_header(source, output)
    pictures = {}
    sheets = {number: export_sheet(source, output, number, pictures) for number in (1, 2, 3, 4)}
    fighters = export_fighters(source, output, roster)
    handles = {fighter["handle"]: fighter["id"] for fighter in roster}
    (output / "fighters.json").write_text(json.dumps({"art": ART_COUNT, "handles": handles, "fighters": fighters}, separators=(",", ":")) + "\n")
    return sheets, fighters


if __name__ == "__main__":
    iso = sys.argv[1]
    destination = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "postmatch"
    roster = json.loads((HERE.parent / "menu" / "art" / "roster.json").read_text())
    sheets, fighters = export(Source(iso), destination, roster)
    print(f"{destination}: {len(sheets)} sheets, art for {len(fighters)} fighters")
