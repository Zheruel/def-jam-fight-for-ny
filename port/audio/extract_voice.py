"""Build on-demand Battle voice sets from the original PS2 streaming resources."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import wave

from extract import Disc, speech_sets

HERE = Path(__file__).resolve().parent
CATEGORIES = {"Announcer", "Character", "Taunts", "Enviro", "Heckles"}


def export(disc, decoder, out):
    out.mkdir(parents=True, exist_ok=True)
    index = {}
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        for entry in speech_sets(disc):
            name = entry["set"]
            if name.split("/")[1] not in CATEGORIES:
                continue
            raw = disc.read("/AUDIO/" + entry["archive"] + ".VIV", *entry["dat"])
            positions = [match.start() for match in re.finditer(b"SCHl", raw)] + [len(raw)]
            parts = {}
            samples = 0
            channels = rate = None
            with (tmp / "decoded.pcm").open("wb") as output:
                for start, end in zip(positions, positions[1:]):
                    (tmp / "line.uv").write_bytes(raw[start:end])
                    subprocess.run([decoder, "-i", "-o", str(tmp / "line.wav"), str(tmp / "line.uv")],
                                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    with wave.open(str(tmp / "line.wav")) as wav:
                        if rate is None:
                            channels, rate = wav.getnchannels(), wav.getframerate()
                        if (channels, rate, 2) != (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()):
                            raise ValueError(f"Mixed PCM formats in {name}")
                        length = wav.getnframes()
                        output.write(wav.readframes(length))
                        parts[start] = [samples, length]
                        # Leave silence between lines so Opus overlap cannot bleed into the adjacent request.
                        gap = rate // 20
                        output.write(bytes(gap * channels * 2))
                        samples += length + gap
            if not parts:
                continue
            filename = hashlib.sha256(raw).hexdigest()[:24] + ".ogg"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                            "-f", "s16le", "-ar", str(rate), "-ac", str(channels), "-i", str(tmp / "decoded.pcm"),
                            "-fflags", "+bitexact", "-flags:a", "+bitexact", "-c:a", "libopus", "-b:a", "28k",
                            "-application", "voip", str(out / filename)], check=True)
            index[(name + ".dat").lower()] = {"file": filename, "rate": rate, "lines": parts}
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--decoder", default="vgmstream-cli")
    parser.add_argument("--out", type=Path, default=HERE / "voice")
    args = parser.parse_args()
    disc = Disc(args.iso)
    try:
        export(disc, args.decoder, args.out)
    finally:
        disc.close()
