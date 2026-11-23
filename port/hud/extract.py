"""Export the two-player Battle HUD sprites and anchors from the retail SHPS directory."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parents[1] / "ps2/battle"), str(HERE.parent / "geometry")]
from battle_patch import Disc
from refpack import decompress
from ssh import textures

SPRITES = ("healthBar","momentumBar","mainBarContainer_1","blazin","danger","tapBarContainer_1","tapBarMeter","tapHealthMeter",
           *(f"blazinFire0{i}" for i in range(1,5)))

def extract(iso, output):
    disc = Disc(iso)
    try:
        archive = "/ASSETS/MISC.VIV"
        blob = disc.read(archive, *disc.viv_entry(archive,"hud.ssh"))
        fonts = "/FONTS/FONTS.VIV"
        for output_name, member in [("names.ttf","TradeGothicLTStd-BoldExt.ttf"),("numbers.ttf","TradeBld.ttf")]:
            data = disc.read(fonts,*disc.viv_entry(fonts,member))
            output.mkdir(parents=True,exist_ok=True)
            (output/output_name).write_bytes(decompress(data) if data[:2] == bytes.fromhex("10fb") else data)
    finally:
        disc.close()
    source = decompress(blob)
    count = struct.unpack_from("<I",source,8)[0]
    directory = bytearray(source)
    names, anchors, overlays = {}, {}, {}
    for i in range(count):
        _, start = struct.unpack_from("<4sI",source,16+i*8)
        end = struct.unpack_from("<I",source,28+i*8)[0] if i+1<count else len(source)
        matches = re.findall(rb"p\0\0\0([A-Za-z0-9_]+)\0",source[start:end])
        if not matches:
            continue
        name = matches[-1].decode()
        if name.startswith(("pos_p1_","pos_p2_","text_p1_","text_p2_")) or name=="text_time":
            anchors[name] = struct.unpack_from("<hh",source,start+12)
        if name.startswith(("uv_over_", "pos_over_")):
            overlays[name] = struct.unpack_from("<hh",source,start+12)
        if name == "Overlays":
            names[name] = f"{i:04x}"
        if name.startswith("tex_"):
            names[name[4:]] = f"{i:04x}"
    # SHPS allows duplicate four-byte codes. Decode by ordinal, retain full names.
    for i in range(count):
        directory[16+i*8:20+i*8] = f"{i:04x}".encode()
    art = textures(directory)
    output.mkdir(parents=True,exist_ok=True)
    for name in (*SPRITES, "Overlays"):
        (output / (name+".png")).write_bytes(art[names[name]])
    (output / "layout.json").write_text(json.dumps({"sourceSha256":hashlib.sha256(source).hexdigest(),
        "size":[640,448],"anchors":anchors,"overlays":overlays},indent=2)+"\n")

if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--output",type=Path,default=HERE)
    args=parser.parse_args()
    extract(args.iso,args.output)
