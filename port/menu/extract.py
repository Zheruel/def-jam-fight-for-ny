"""Export the original fighter/venue selector art from SCREENS.VIV into port/menu/art (+ roster.json, venues.json).

    python3 port/menu/extract.py private/ps2/reference.iso [--output port/menu/art]

Pictures are the game's own indexed PNGs (see port/geometry/ssh.py); only the 40x40 face thumbnails are re-sampled
(ImageMagick `magick`) into one atlas. Layout numbers come from the front-end movies (port/hud/screens/extract.py).
"""
import argparse
import json
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(ROOT / "ps2/battle"), str(ROOT / "port/geometry"), str(ROOT / "port/hud")]
from battle_patch import Disc  # noqa: E402
from refpack import decompress  # noqa: E402
from ssh import textures  # noqa: E402
import apt  # noqa: E402

ARCHIVE = "/SCREENS/SCREENS.VIV"
inventory = json.loads((ROOT / "ps2/content/inventory.json").read_text())
combat = json.loads(subprocess.run(
    ["node", "-e", "import('./port/assets/combat.mjs').then(m=>console.log(JSON.stringify(m.fighters)))"],
    cwd=ROOT, capture_output=True, text=True, check=True).stdout)

# The retail venue picture and name for each playable venue: chooseVenueArt.big holds 27 names (tag 102 + 3 * n, with
# a few other tags between) and 27 photographs (tag 206 + 3 * n) in the same order; venue keys pick the entry.
VENUE_ART = {"Carribean Club": 12, "Junkyard (After Hours)": 15, "Subway": 11, "Club DTP (Intense)": 16, "Fight Club": 0,
             "Warehouse Inferno": 24, "Lefrak (Remix)": 18, "Club DTP": 16, "Blaze's Gym": 1, "Old School Club": 6,
             "Crow's Office": 26, "Crow's Cage": 10, "Crow's Club": 9, "Construction Site": 19, "DMob Club": 4,
             "Parkade": 17, "The Limit CLub": 2, "DMob Club (Intense)": 5, "Junkyard": 14, "Chopshop": 13,
             "Power Plant": 7, "Gauntlet (Another Lighting)": 21, "Dragon House (Remix)": 8, "Gauntlet": 22}
# cmusen.loc string numbers of the venue descriptions (3066..3091 are consecutive; 3067 is a title and 3071/3081 describe
# story-only spots). Venues are matched to them by what each text says.
VENUE_TEXT = {"Carribean Club": 3080, "Junkyard (After Hours)": 3084, "Subway": 3079, "Club DTP (Intense)": 3086,
              "Fight Club": 3070, "Warehouse Inferno": 3089, "Lefrak (Remix)": 3075, "Club DTP": 3085, "Blaze's Gym": 3091,
              "Old School Club": 3078, "Crow's Office": 3090, "Crow's Cage": 3072, "Crow's Club": 3073, "Construction Site": 3076,
              "DMob Club": 3066, "Parkade": 3077, "The Limit CLub": 3069, "DMob Club (Intense)": 3068, "Junkyard": 3083,
              "Chopshop": 3082, "Power Plant": 3087, "Gauntlet (Another Lighting)": 3088, "Dragon House (Remix)": 3074, "Gauntlet": 3088}
STYLES = {"kickboxing": 0x88, "streetfighting": 0x8a, "martialArts": 0x8c, "wrestling": 0x8e, "submissions": 0x90}
STICKERS = [0x7d, 0x7e, 0x80, 0x81]   # blue, red, green, purple player stickers (chooseF2 texture order)
THUMB = 40


def members(big: bytes):
    count, _ = struct.unpack_from(">II", big, 8)
    pos, out = 16, {}
    for _ in range(count):
        offset, size = struct.unpack_from(">II", big, pos)
        end = big.index(b"\0", pos + 8)
        out[big[pos + 8:end].decode()] = big[offset:offset + size]
        pos = end + 1
    return out


def size(png):
    return struct.unpack(">II", png[16:24])


class Source:
    def __init__(self, iso):
        self.disc = Disc(iso)
        self.names = None

    def read(self, member):
        raw = self.disc.read(ARCHIVE, *self.disc.viv_entry(ARCHIVE, member))
        return members(decompress(raw) if raw[:2] == bytes.fromhex("10fb") else raw)

    def has(self, member):
        try:
            self.disc.viv_entry(ARCHIVE, member)
            return True
        except FileNotFoundError:
            return False

    def pictures(self, member):
        """{tag: png} in directory order; the tag is the number of the image character that uses the picture."""
        parts = self.read(member)
        ssh = next(v for k, v in parts.items() if k.endswith(".ssh"))
        return {k.strip(): v for k, v in textures(ssh).items()}


def loc_strings(source) -> list:
    """The US English front-end text (MISC.VIV cmusen.loc): LOCH, LOCT (hash table), then LOCL = size, 0, count, offsets from
    the LOCL start, UTF-16 strings. Keys are hashed (not needed: the strings keep their order)."""
    archive = "/ASSETS/MISC.VIV"
    raw = source.disc.read(archive, *source.disc.viv_entry(archive, "cmusen.loc"))
    data = decompress(raw) if raw[:2] == bytes.fromhex("10fb") else raw
    base = data.index(b"LOCL")
    count = struct.unpack_from("<I", data, base + 12)[0]
    out = []
    for offset in struct.unpack_from(f"<{count}I", data, base + 16):
        end = base + offset
        while data[end:end + 2] != b"\0\0":
            end += 2
        out.append(data[base + offset:end].decode("utf-16-le"))
    return out


def write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def export_team(source, output):
    pictures = source.pictures("screens/battle/chsTeam4.big")
    for tag in (1, 2, 17, 18, 22, 25, 30, 31, 33):
        write(output / f"team-{tag}.png", pictures[str(tag)])


def export(iso, output: Path):
    source = Source(iso)
    try:
        # -- fighters -------------------------------------------------------------------------------------------
        by_id = {f["fighterXml"]["ID"]: f for f in inventory["fighters"]}
        stats = {f["handle"].lower(): f for f in combat}
        roster = []
        for ident, record in sorted(by_id.items()):
            if record["model"] == "V2IP_999A":
                from hero_portrait import export_hero
                export_hero(ROOT, output / "fighters")
            else:
                # The four late roster replacements kept the outgoing fighters' XML IDs.
                # Their own front-end lettering and portraits use separate loading-card IDs.
                art_id = {"Teck": 85, "Erick Sermon": 91, "O.E.": 92, "Santos": 93}.get(record["name"], ident)
                lettering = f"screens/match/3_fighters/l_ML_{art_id}_2p.big"
                portrait = f"screens/match/3_fighters/p_ML_{art_id + 1}_2p.big"
                write(output / f"fighters/{ident}-n.png", next(iter(source.pictures(lettering).values())))
                pieces = list(source.pictures(portrait).values())
                write(output / f"fighters/{ident}-h.png", next(p for p in pieces if size(p) == (256, 256)))
                write(output / f"fighters/{ident}-c.png", next(p for p in pieces if size(p) == (256, 80)))
            c = stats.get(record["handle"].lower())
            roster.append({"id": ident, "handle": record["handle"], "name": record["name"], "model": record["model"],
                           "stats": c["stats"] if c else None, "styles": c["styles"] if c else []})
        (output / "roster.json").write_text(json.dumps(roster, indent=1) + "\n")
        thumbs(output, roster)
        from header_art import export as export_header
        export_header(source, output / "header")
        export_team(source, output)
        from match_type_art import export as export_match_type
        export_match_type(source, output / "match-type")

        # -- selector chrome (chooseF2) -------------------------------------------------------------------------
        f2 = source.pictures("screens/battle/chooseF2.big")
        keys = list(f2)
        def f2pic(index, name):
            write(output / f"{name}.png", f2[keys[index]])
        f2pic(0x7a, "select-bg-0"); f2pic(0x79, "select-bg-1"); f2pic(0x71, "ready"); f2pic(0x85, "thumb-paper")
        f2pic(0x86, "stat-labels"); f2pic(0x7b, "arrow")
        for n, index in enumerate(STICKERS):
            f2pic(index, f"sticker-{n + 1}")
        for style, index in STYLES.items():
            f2pic(index, f"style-{style}")


        f3 = source.pictures("screens/battle/chooseF3.big")
        for tag, name in (("343", "select3-bg-0"), ("342", "select3-bg-1"), ("330", "ready3"), ("373", "thumb-paper3")):
            write(output / f"{name}.png", f3[tag])
        f4 = source.pictures("screens/battle/chooseF4.big")
        for tag, name in (("344", "select4-bg-0"), ("343", "select4-bg-1"), ("338", "ready4"), ("376", "thumb-paper4")):
            write(output / f"{name}.png", f4[tag])

        # -- venues (chsVenue + chooseVenueArt + venThumb<feID>) ------------------------------------------------
        # battle/map.big is the retail map (red streets, borough names): a 3 x 3 grid of 512/512/336 by 512/512/92 pieces whose
        # order was recovered by matching edges (see TILES in screens.mjs): 9 7 6 / 5 4 3 / 2 1 8.
        for tag, tile in source.pictures("screens/battle/map.big").items():
            write(output / f"map-{tag}.png", tile)
        chs = source.pictures("screens/battle/chsVenue.big")
        for tag, name in (("143", "polaroid-a"), ("150", "polaroid-b"), ("157", "polaroid-c"), ("141", "tape"),
                          ("11", "paper-0"), ("14", "paper-1"), ("19", "paper-2"), ("8", "paper-3"), ("71", "red-0"), ("74", "red-1"),
                          ("79", "red-2"), ("68", "red-3"), ("4", "pin-red"), ("1", "pin-blue"), ("128", "pin-grey"), ("163", "label-strip")):
            write(output / f"{name}.png", chs[tag])
        art = source.pictures("screens/_art/chooseVenueArt.big")
        venues = []
        text = loc_strings(source)
        for venue in inventory["venues"]:
            n = VENUE_ART[venue["key"]]
            photo = art[str(206 + 3 * n)]
            write(output / f"venues/{venue['file']}.png", photo)
            note = f"screens/venuethumbs/venThumb{venue['feID']}.big"
            if source.has(note):
                write(output / f"notes/{venue['feID']}.png", next(iter(source.pictures(note).values())))
            venues.append({"file": venue["file"], "handle": venue["handle"], "name": venue["name"], "feID": venue["feID"],
                           "description": text[VENUE_TEXT[venue["key"]]].strip()})
        pins = {}
        movie = apt.Apt.parse(source.read("screens/battle/chsVenue.big")["chsVenue.apt"])
        for e in movie.flatten(0, 0):
            m = re.match(r"/map/pin(\d+)/greyPin", e["path"])
            if m:
                pins[int(m[1])] = [round((e["rect"][0] + e["rect"][2]) / 2, 1), round((e["rect"][1] + e["rect"][3]) / 2, 1)]
        for v in venues:
            v["pin"] = pins.get(v["feID"])
        (output / "venues.json").write_text(json.dumps(venues, indent=1) + "\n")
        print(f"{len(roster)} fighters, {len(venues)} venues")
    finally:
        source.disc.close()


def thumbs(output: Path, roster):
    """One atlas (8 columns) of 40x40 faces cropped from the head portraits."""
    cols = 8
    with tempfile.TemporaryDirectory() as tmp:
        cells = []
        for i, f in enumerate(roster):
            cell = Path(tmp) / f"{i:03d}.png"
            subprocess.run(["magick", str(output / f"fighters/{f['id']}-h.png"), "-background", "none", "-crop", "232x232+12+0",
                            "+repage", "-resize", f"{THUMB}x{THUMB}", str(cell)], check=True)
            cells.append(str(cell))
        rows = []
        for i in range(0, len(cells), cols):
            row = Path(tmp) / f"row{i // cols}.png"
            chunk = cells[i:i + cols]
            subprocess.run(["magick", *chunk, "-background", "none", "+append", "-extent", f"{cols * THUMB}x{THUMB}", str(row)], check=True)
            rows.append(str(row))
        subprocess.run(["magick", *rows, "-background", "none", "-append", "-colors", "256", f"PNG8:{output / 'thumbs.png'}"], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--output", type=Path, default=HERE / "art")
    args = parser.parse_args()
    export(args.iso, args.output)
