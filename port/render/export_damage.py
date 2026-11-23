"""Extract the retail br01 and br02 face tiles and verify their location against the intact atlas."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys

from PIL import Image, ImageChops, ImageStat

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "fighters"), str(HERE.parent / "geometry")]
from retail import Disc, read_member
from ssh import textures


def rgba(data):
    return Image.open(io.BytesIO(data)).convert("RGBA")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--check",action="store_true")
    args=parser.parse_args()
    target=HERE/"damage"
    target.mkdir(exist_ok=True)
    def save(path,data):
        if args.check:
            if path.read_bytes()!=data: raise ValueError(f"{path} differs from the disc")
        else:
            path.write_bytes(data)
    fighters=json.loads((HERE.parents[1]/"ps2/content/inventory.json").read_text())["fighters"]
    manifest={}
    disc=Disc(args.iso)
    try:
        for fighter in fighters:
            model=fighter["model"]
            shapes=textures(read_member(disc,model+".ssh")[1])
            levels={}
            for level in (1,2):
                tile=shapes.get(f"br0{level}")
                if tile is None: continue
                image=rgba(tile).convert("RGB")
                w,h=image.size
                candidates=[]
                for name,data in shapes.items():
                    if name.startswith("br"): continue
                    atlas=rgba(data).convert("RGB")
                    for x in range(0,atlas.width-w+1,w):
                        for y in range(0,atlas.height-h+1,h):
                            diff=ImageChops.difference(atlas.crop((x,y,x+w,y+h)),image)
                            candidates.append((sum(ImageStat.Stat(diff).mean)/3,name,x,y,atlas.size))
                candidates.sort()
                error,name,x,y,size=candidates[0]
                if error>12 or candidates[1][0]<error*2:
                    raise ValueError(f"Ambiguous damage tile for {model}/{level}")
                key=hashlib.sha256(tile).hexdigest()[:20]
                save(target/(key+".png"),tile)
                levels[level]={"file":key+".png","atlas":name,"x":x,"y":y,"size":size}
            if levels: manifest[model]=levels
    finally:
        disc.close()
    save(target/"tiles.json",(json.dumps(manifest,separators=(",",":"))+"\n").encode())


if __name__=="__main__":
    main()
