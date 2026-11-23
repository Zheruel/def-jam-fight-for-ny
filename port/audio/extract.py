"""Decode the standard Foundation ambience and preserve its retail intro/loop boundary."""
import argparse
from pathlib import Path
import subprocess
import sys
import tempfile

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parents[1]/"ps2/battle"))
from battle_patch import Disc

def extract(iso,decoder,target):
    disc=Disc(iso)
    try:
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for ext in ("abk","ast"):
                member="sfx\\bsmt."+ext
                offset,size=disc.viv_entry("/AUDIO/SFX1.VIV",member)
                (root/("bsmt."+ext)).write_bytes(disc.read("/AUDIO/SFX1.VIV",offset,size))
            wav=root/"foundation.wav"
            # Four-channel stream 1 has two contiguous 3,526,972-frame
            # sections at 36 kHz. The second section repeats in the game.
            subprocess.run([decoder,"-i","-s","1","-o",str(wav),str(root/"bsmt.abk")],check=True)
            ast=(root/"bsmt.ast").read_bytes()
            if ast[:7601536] != ast[7601536:15203072]:
                raise ValueError("Foundation intro and loop are no longer identical")
            subprocess.run(["ffmpeg","-nostdin","-loglevel","error","-y","-i",str(wav),
                "-af","atrim=end_sample=3526972","-ac","2","-c:a","libopus","-b:a","80k",
                str(target/"foundation-loop.ogg")],check=True)
    finally:
        disc.close()

if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("iso")
    p.add_argument("--decoder",default="vgmstream-cli")
    args=p.parse_args()
    extract(args.iso,args.decoder,HERE)
