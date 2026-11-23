"""Check the shipped audio against the retail disc.

    python3 port/audio/verify.py private/ps2/reference.iso --decoder private/vgmstream/build/cli/vgmstream-cli

Re-reads the venue table, loop points, beds, animation tags and dispatch sites from the disc and
compares them to what is committed. Beds are decoded again and correlated with the shipped Opus.
"""
import argparse
import gzip
import json
import math
import subprocess
import sys
import tempfile
from array import array
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import combat  # noqa: E402
import extract  # noqa: E402
import retail  # noqa: E402


def pcm(command):
    raw = subprocess.run(command, check=True, stdout=subprocess.PIPE).stdout
    out = array("h")
    out.frombytes(raw)
    return out


def correlation(a, b, step=7):
    n = min(len(a), len(b))
    xs, ys = a[0:n:step], b[0:n:step]
    sx = sum(x * x for x in xs)
    sy = sum(y * y for y in ys)
    return sum(x * y for x, y in zip(xs, ys)) / math.sqrt(sx * sy)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("iso")
    parser.add_argument("--decoder", default="vgmstream-cli")
    args = parser.parse_args()
    disc = extract.Disc(args.iso)
    failures = []
    try:
        venues, elf = extract.venue_records(disc)
        shipped = json.loads((HERE / "venues.json").read_text())
        for fresh in venues:
            old = next(v for v in shipped["venues"] if v["file"] == fresh["file"])
            for key in ("coreID", "speechID", "announcerSet", "speechSuffix", "crowd", "archive", "ambient", "ambient2", "sounds"):
                if old[key] != fresh[key]:
                    failures.append(f"{fresh['file']} {key}: shipped {old[key]!r}, disc {fresh[key]!r}")
            xml = fresh["xml"]
            print(f"{fresh['file']:9} core {fresh['coreID']:2} bed {fresh['bedStem'] or '-':12} crowd {fresh['crowd'] or '-':10} bank {fresh['sounds']}")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for stem, bed in shipped["beds"].items():
                extract.stage_ci(disc, root, stem)
                info = extract.probe(args.decoder, root / f"{stem}.abk", bed["subsong"])
                loop = info["loopingInfo"]
                if (loop["start"], loop["end"]) != (bed["loopStart"], bed["loopEnd"]):
                    failures.append(f"{stem} loop points changed")
                wav = root / "bed.wav"
                extract.run(args.decoder, "-i", "-s", bed["subsong"], "-o", wav, root / f"{stem}.abk", stdout=subprocess.DEVNULL)
                mix = "pan=stereo|c0=0.5*c0+0.5*c2|c1=0.5*c1+0.5*c3" if info["channels"] == 4 else "anull"
                reference = pcm(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", wav, "-af",
                                 f"atrim=start_sample={loop['start']}:end_sample={loop['end']},asetpts=N/SR/TB,{mix},aresample=48000",
                                 "-f", "s16le", "-"])
                shipped_pcm = pcm(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", HERE / bed["file"], "-ac", "2", "-ar", "48000", "-f", "s16le", "-"])
                if abs(len(reference) - len(shipped_pcm)) > 2:
                    failures.append(f"{stem} length {len(shipped_pcm)} != {len(reference)}")
                r = correlation(reference, shipped_pcm)
                # Loop seam: the step across the loop point against the typical step.
                left = [reference[-2], reference[-1], reference[0], reference[1]]
                jump = abs(left[1] - left[2])
                typical = sum(abs(reference[i] - reference[i + 2]) for i in range(0, 20000, 2)) / 10000
                print(f"{stem:12} loop {loop['start']}-{loop['end']} corr {r:.4f} seam step {jump} (typical {typical:.0f})")
                if r < 0.9:
                    failures.append(f"{stem} shipped bed does not match the retail decode (corr {r:.3f})")
                wav.unlink()
        tags = retail.animtags(disc.read("/AUDIO/ANIMTAGS.DAT", 0, disc.iso.entry("/AUDIO/ANIMTAGS.DAT").size))
        stored = json.loads(gzip.decompress((HERE / "animtags.json.gz").read_bytes()))["anims"]
        if [[t["name"], t["tags"]] for t in tags] != stored:
            failures.append("animtags.json.gz differs from ANIMTAGS.DAT")
        shipped_combat = json.loads((HERE / "combat.json").read_text())
        if shipped_combat["classes"] != json.loads(json.dumps(combat.classes(elf, [[t["name"], t["tags"]] for t in tags]))):
            failures.append("combat.json tag classes differ from the executable and ANIMTAGS.DAT")
        if shipped_combat["venueOut"] != sorted(v["coreID"] for v in venues if v["flag"]):
            failures.append("combat.json outdoor venues differ from the venue table")
        events = json.loads((HERE / "events.json").read_text())
        if events["dispatch"] != json.loads(json.dumps(retail.packed_events(elf))):
            failures.append("events.json dispatch differs from the executable")
    finally:
        disc.close()
    if failures:
        print("\n".join("FAIL " + f for f in failures))
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
