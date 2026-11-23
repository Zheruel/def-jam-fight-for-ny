"""Export the retail Battle match-loading poster from SCREENS.VIV (the picture shown while a match loads).

    python3 port/menu/loading_art.py <reference.iso> [output directory]

The poster is built from:
  screens/match/0_bg/paper_<1v1|ffa3|ffa4|team>.big   the poster paper (one per formation)
  screens/match/3_fighters/p_ML_<fighter ID+1>_<2|3|4>p.big   the fighter portraits (right-hand slots mirror them)
  screens/battle/oldMLoad.big   the front chevron that covers the portraits' feet and the vignette tile
  screens/match/2_type/mTypeLogo_<mode>_e.big   the match-type title
  screens/match/1_venue/vn_ML_<venue feID+1>.big   the venue name banner
  screens/match/3_fighters/l_ML_<fighter ID>_<2|3|4>p.big   the "NAME as ALIAS" logos

Every picture is a split-texture Apt movie, recovered whole with match_type_art.movie_shapes(). Each exported file is the
shape's pixels; layout.json carries the art's rect (left, top, right, relative to the slot's anchor) and the anchors.

LAYOUTS below are measured against the retail captures (private/verification/special/*/*-menu.png and the three-fight,
four-start and team-start captures): each element was located by masked zero-mean normalised cross-correlation against the
frame (title, venue and logos at 0.9-0.97; portraits 0.4-0.9 where neighbours cover them), and the remaining differences of
the whole composite were fitted (each portrait stays inside its panel of the paper; the vignette multiplies the picture by
1 - 0.43 * alpha). verification/native-loading-browser.mjs measures the browser's render against those captures again.
"""
import io
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract import Source
from match_type_art import movie_shapes

TITLES = {"1v1": "oneOnOne", "team": "team", "ffa": "ffa", "window": "window", "subway": "subway", "demolition": "demolition",
          "inferno": "inferno", "cage": "cage", "ringout": "ringOut"}
# formation key -> (paper, fighters per poster, art count). Free For All with 3 fighters and with 4 have their own paper.
FORMATIONS = {"1v1": ("1v1", 2, 2), "ffa3": ("ffa3", 3, 3), "ffa4": ("ffa4", 4, 4), "team": ("team", 4, 4)}
# Anchors in the 640x480 frame, slot by slot (left to right): the logo's origin, and the portrait's origin (bottom centre)
# with whether the slot mirrors the portrait. Z order is left to right.
LAYOUTS = {
    "1v1": {"venue": [319.75, 407.75],
            "logos": [[185, 316.5], [458, 317.5]],
            "portraits": [[184, 405, 0], [460, 405, 1]]},
    "ffa3": {"venue": [319.75, 407.75],
             "logos": [[164.5, 325.5], [461.5, 341.5], [515.5, 274.5]],
             "portraits": [[141, 384, 0], [321, 403, 0], [501, 384, 1]]},
    "ffa4": {"venue": [319.75, 407.75],
             "logos": [[125, 258.5], [194, 332.5], [445, 332.5], [502, 258.5]],
             "portraits": [[118, 386, 0], [253, 403, 0], [388, 403, 1], [525, 387, 1]]},
    "team": {"venue": [319.75, 407.75],
             "logos": [[131, 254.5], [198, 327.5], [443, 326.5], [507, 253.5]],
             "portraits": [[121, 371, 0], [228, 421, 0], [414, 420, 1], [520, 371, 1]]},
}
# The titles' art starts at the frame's left; the poster draws it at (53, 47) (one row lower for the two flame-edged ones).
TITLE_ANCHOR = {"default": [53, 47], "demolition": [53, 48], "inferno": [53, 48]}
FRONT = [45, 237]           # the chevron overlay's position (its own rect in oldMLoad.big)
VIGNETTE_ALPHA = 0.43      # how strongly the 256x256 vignette tile darkens the frame
# Each portrait is clipped to its panel of the paper (between the paper's dark dividers, x ranges [from, to)); in Team the
# two fighters of a side share one panel. "panels" lists them, each portrait slot names its panel.
PANELS = {"1v1": ([[54, 316], [323, 588]], [0, 1]),
          "ffa3": ([[54, 227], [234, 406], [413, 588]], [0, 1, 2]),
          "ffa4": ([[54, 182], [189, 316], [323, 452], [459, 588]], [0, 1, 2, 3]),
          "team": ([[54, 316], [323, 588]], [0, 0, 1, 1])}


def single_image(source, path):
    movie, shape, _ = movie_shapes(source, path)
    elements = [e for e in movie.flatten() if e["kind"] == "image"]
    assert len(elements) == 1, (path, len(elements))
    return shape(elements[0]["character"]), elements[0]["rect"]


def save(image, path, lossy=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if lossy:
        image.save(path, "WEBP", quality=88, alpha_quality=100, method=6)
    else:
        image.save(path, "WEBP", lossless=True, method=6)


def export(source, output, roster, venues):
    output = Path(output)
    layout = {"size": [640, 480], "front": FRONT, "title": TITLE_ANCHOR, "vignette": VIGNETTE_ALPHA,
              "fighters": {f["handle"]: f["id"] for f in roster}, "venueFiles": {v["file"]: v["feID"] + 1 for v in venues},
              "formations": {}, "titles": {}, "venues": {}, "logos": {}, "portraits": {}}
    for key, (paper, fighters, count) in FORMATIONS.items():
        image, _ = single_image(source, f"screens/match/0_bg/paper_{paper}.big")
        save(image.convert("RGB"), output / f"paper-{paper}.webp", lossy=True)
        layout["formations"][key] = {"paper": paper, "count": count, "panels": PANELS[key][0], "panelOf": PANELS[key][1], **LAYOUTS[key]}
    # the front chevron and the vignette tile (the tile is stretched over the frame)
    movie, shape, _ = movie_shapes(source, "screens/battle/oldMLoad.big")
    chevron = [e for e in movie.flatten() if e["kind"] == "image" and e["character"] == 58][0]
    assert [round(v) for v in chevron["rect"][:2]] == FRONT
    save(shape(58), output / "front.webp", lossy=True)
    tile = Image.open(io.BytesIO(source.pictures("screens/battle/oldMLoad.big")["60"])).convert("RGBA")
    assert tile.size == (256, 256)
    alpha = tile.getchannel("A").resize((64, 64), Image.Resampling.LANCZOS)
    vignette = Image.new("RGBA", alpha.size, (0, 0, 0, 0)); vignette.putalpha(alpha)
    save(vignette, output / "vignette.webp")
    for mode, name in TITLES.items():
        image, rect = single_image(source, f"screens/match/2_type/mTypeLogo_{name}_e.big")
        save(image, output / f"title-{mode}.webp")
        layout["titles"][mode] = [rect[0], rect[1], rect[2]]
    for venue in venues:
        number = venue["feID"] + 1
        image, rect = single_image(source, f"screens/match/1_venue/vn_ML_{number}.big")
        save(image, output / f"venue-{number}.webp")
        layout["venues"][str(number)] = [rect[0], rect[1], rect[2]]
    for fighter in roster:
        for count in (2, 3, 4):
            for kind, number, folder in (("logos", fighter["id"], "l"), ("portraits", fighter["id"] + 1, "p")):
                path = f"screens/match/3_fighters/{folder}_ML_{number}_{count}p.big"
                if not source.has(path):
                    continue
                image, rect = single_image(source, path)
                name = f"{'logo' if kind == 'logos' else 'portrait'}-{fighter['id']}-{count}p"
                save(image, output / (name + ".webp"), lossy=kind == "portraits")
                layout[kind].setdefault(str(fighter["id"]), {})[str(count)] = [rect[0], rect[1], rect[2]]
    (output / "layout.json").write_text(json.dumps(layout, separators=(",", ":")) + "\n")
    return layout


if __name__ == "__main__":
    iso = sys.argv[1]
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent / "art" / "loading"
    art = Path(__file__).resolve().parent / "art"
    layout = export(Source(iso), output, json.loads((art / "roster.json").read_text()), json.loads((art / "venues.json").read_text()))
    print(f"{output}: {len(layout['logos'])} logos, {len(layout['portraits'])} portraits, {len(layout['venues'])} venues")
