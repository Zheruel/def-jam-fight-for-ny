"""Decode the retail PS2 audio the native port plays: venue ambience, combat/crowd/voice cue
banks, mix levels, animation audio tags and event dispatch tables.

    python3 port/audio/extract.py private/ps2/reference.iso [--only venues cues data combat music speech]
    python3 port/audio/extract.py private/ps2/reference.iso --music asiandragon --out tune.ogg
    python3 port/audio/extract.py private/ps2/reference.iso --speech ANN_Climb_Object_E1 --out lines.ogg

Needs FFmpeg (libopus) and a vgmstream-cli build (--decoder). Runs one process at a time.
"""
import argparse
import gzip
import json
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "ps2/battle"))
sys.path.insert(0, str(HERE))
from battle_patch import Disc  # noqa: E402
import combat  # noqa: E402
import retail  # noqa: E402

RATE = 48000
GAP = 1152  # frames of silence between packed cues, so Opus never bleeds one cue into the next
INVENTORY = HERE.parents[1] / "ps2/content/inventory.json"
SFX = {"SFX0": "/AUDIO/SFX0.VIV", "SFX1": "/AUDIO/SFX1.VIV", "SFX2": "/AUDIO/SFX2.VIV"}

# Bank groups. Impact banks hold the PS-ADPCM hit/foley one-shots the Punch_Kick, Face_Hits,
# Body_Contacts, Falls, Special_* and Weapon_* event classes draw from.
IMPACT = ["Fighter_Small_Hits_Ring", "Fighter_Small_Hits_Out", "Fighter_Med_Hits_Ring", "Fighter_Med_Hits_Out",
          "Fighter_Big_Hits_Ring", "Fighter_Big_Hits_Out", "Spec_Ass", "Spec_Boob", "Spec_Chest", "Spec_Cork",
          "Spec_Kick", "Spec_Punch", "Chops", "WCommon1", "WCommon2", "Train_Kill_Female", "Train_Kill_Male",
          "randomr"]
VOICE = ["Grunts_AsianGuy", "Grunts_BBGuy", "Grunts_BGirl", "Grunts_Girl1", "Grunts_Girl2", "Grunts_Girl3_girly",
         "Grunts_LatinoGuy", "Grunts_SBGuy", "Grunts_WGuy"]
CROWD = ["csmall", "cmed", "csmall_out", "crlarge", "cmomets", "cctrl"]


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def encode(source_args, target, bitrate, filter_graph=None):
    command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", *source_args]
    if filter_graph:
        command += ["-af", filter_graph]
    run(*command, "-c:a", "libopus", "-b:a", bitrate, "-vbr", "on", target)


def probe(decoder, path, subsong):
    out = run(decoder, "-I", "-s", subsong, path, stdout=subprocess.PIPE).stdout
    return json.loads(out)


def member(disc, viv, name):
    offset, size = disc.viv_entry(viv, name)
    return disc.read(viv, offset, size)


def find_member(disc, stem, ext):
    """Case-insensitive stem lookup, since the retail table and the archives disagree on case."""
    for key, viv in SFX.items():
        for name in archive_names(disc, viv):
            if name.lower() == f"sfx\\{stem}.{ext}".lower():
                return key, name
    return None, None


_names = {}


def archive_names(disc, viv):
    if viv not in _names:
        head = disc.read(viv, 0, 16)
        count, header_size = struct.unpack_from(">II", head, 8)
        table = disc.read(viv, 0, header_size)
        names, pos = [], 16
        for _ in range(count):
            end = table.index(b"\0", pos + 8)
            names.append(table[pos + 8:end].decode("latin1"))
            pos = end + 1
        _names[viv] = names
    return _names[viv]


def stage_ci(disc, root, stem):
    """Stage <stem>.abk/.ast by case-insensitive name from any SFX archive."""
    archive = None
    for ext in ("abk", "ast"):
        key, name = find_member(disc, stem, ext)
        if name:
            offset, size = disc.viv_entry(SFX[key], name)
            (root / f"{stem}.{ext}").write_bytes(disc.read(SFX[key], offset, size))
            archive = archive or key
    if archive is None:
        raise FileNotFoundError(stem)
    return archive


def pack_cues(decoder, root, stem, subsongs, target, bitrate="64k"):
    """Decode each subsong of <stem>.abk, convert to 48 kHz stereo, concatenate with short gaps
    into one Opus file and return the per-cue frame table."""
    pcm, cues, cursor = bytearray(), [], 0
    silence = bytes(GAP * 4)
    for index in subsongs:
        try:
            info = probe(decoder, root / f"{stem}.abk", index)
        except subprocess.CalledProcessError:
            cues.append({"i": index, "error": "undecodable"})
            continue
        wav = root / "cue.wav"
        try:
            run(decoder, "-i", "-s", index, "-o", wav, root / f"{stem}.abk", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            cues.append({"i": index, "error": "undecodable"})
            continue
        channels = info["channels"]
        pan = "pan=stereo|c0=c0|c1=c0" if channels == 1 else "pan=stereo|c0=c0|c1=c1" if channels == 2 else \
            "pan=stereo|c0=0.5*c0+0.5*c2|c1=0.5*c1+0.5*c3"
        raw = run("ffmpeg", "-nostdin", "-loglevel", "error", "-i", wav, "-af", f"{pan},aresample={RATE}",
                  "-f", "s16le", "-", stdout=subprocess.PIPE).stdout
        frames = len(raw) // 4
        cues.append({"i": index, "start": cursor, "frames": frames, "rate": info["sampleRate"],
                     "channels": channels, "samples": info["numberOfSamples"],
                     "peak": peak(raw)})
        pcm += raw + silence
        cursor += frames + GAP
    if not any("start" in c for c in cues):
        return None
    raw_file = root / "pack.raw"
    raw_file.write_bytes(pcm)
    encode(["-f", "s16le", "-ar", str(RATE), "-ac", "2", "-i", raw_file], target, bitrate)
    raw_file.unlink()
    return {"file": str(Path(target).relative_to(HERE)), "rate": RATE, "frames": cursor, "cues": cues}


def peak(raw):
    samples = memoryview(raw).cast("h")
    return max(max(samples[:], default=0), -min(samples[:], default=0)) if len(samples) else 0


def subsong_count(decoder, path):
    try:
        out = run(decoder, "-m", path, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode()
    except subprocess.CalledProcessError:
        return 0  # a control bank with no samples (cctrl)
    match = re.search(r"stream count: (\d+)", out)
    return int(match[1]) if match else 1


def build_ambience(disc, decoder, venues, shots=False):
    """One loop file per ambient bed. The retail bed has an intro section and a loop section with
    identical audio, so only the looped section [loop start, loop end) is stored."""
    out = HERE / "ambience"
    out.mkdir(exist_ok=True)
    beds = {}
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for venue in venues:
            stem, ambient = venue["bedStem"], venue["ambient"]
            if not stem or stem in beds:
                continue
            archive = stage_ci(disc, root, stem)
            count = subsong_count(decoder, root / f"{stem}.abk")
            # The bed is the 4-channel (or 2-channel) segmented stream: subsong 1 in the ambient
            # banks, the last subsong in fire.abk.
            bed = count if stem.lower() == "fire" else 1
            info = probe(decoder, root / f"{stem}.abk", bed)
            start, end = info["loopingInfo"]["start"], info["loopingInfo"]["end"]
            wav = root / "bed.wav"
            run(decoder, "-i", "-s", bed, "-o", wav, root / f"{stem}.abk", stdout=subprocess.DEVNULL)
            channels = info["channels"]
            mix = "pan=stereo|c0=0.5*c0+0.5*c2|c1=0.5*c1+0.5*c3" if channels == 4 else "anull"
            target = out / f"{stem.lower()}.ogg"
            encode(["-i", wav], target, "48k",
                   f"atrim=start_sample={start}:end_sample={end},asetpts=N/SR/TB,{mix},aresample={RATE}")
            wav.unlink()
            decoded = ffmpeg_frames(target)
            beds[stem] = {
                "file": f"ambience/{target.name}", "archive": archive, "bank": stem, "subsong": bed,
                "sourceRate": info["sampleRate"], "sourceChannels": channels,
                "introFrames": start, "loopStart": start, "loopEnd": end, "loopFrames": end - start,
                "loopSeconds": (end - start) / info["sampleRate"], "frames": decoded, "rate": RATE,
            }
            # Mono one-shots of the same bank (the 'AmbienceRandom' spots); the retail scheduler
            # is compiled into the bank, so only the samples are exported.
            if shots and count > 1 and stem.lower() != "fire":
                pack = pack_cues(decoder, root, stem, [i for i in range(1, count + 1) if i != bed],
                                 out / f"{stem.lower()}.shots.ogg", "40k")
                if pack:
                    beds[stem]["shots"] = pack
    return beds


def ffmpeg_frames(path):
    raw = run("ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "2", "-ar", str(RATE), "-",
              stdout=subprocess.PIPE).stdout
    return len(raw) // 4


def venue_records(disc):
    elf = disc.read("/SLUS_210.04", 0, disc.iso.entry("/SLUS_210.04").size)
    table = retail.venue_table(elf)
    inventory = json.loads(INVENTORY.read_text())
    venues = []
    for item in sorted(inventory["venues"], key=lambda v: v["coreID"]):
        record = table[item["coreID"]]
        ambient = record["ambient"]
        # Inferno has no ambient entry; its crowd entry 'fire' names the fire bank, whose
        # looped stream is the venue bed.
        stem = ambient or ("fire" if record["crowd"] == "fire" else None)
        venues.append({
            "file": item["file"], "coreID": item["coreID"], "name": item["name"],
            **{k: record[k] for k in ("speechID", "announcerSet", "speechSuffix", "crowd", "archive",
                                      "ambient", "ambient2", "sounds", "flag", "mode")},
            "xml": item["venueXml"], "bedStem": stem,
        })
    return venues, elf


def build_venues(disc, decoder, shots=False):
    venues, elf = venue_records(disc)
    beds = build_ambience(disc, decoder, venues, shots)
    for venue in venues:
        stem = venue.pop("bedStem")
        venue["bed"] = beds[stem]["file"] if stem else None
        venue["bedBank"] = stem
    mix = retail.mix_settings(disc.read("/AUDIO/TV.TXT", 0, disc.iso.entry("/AUDIO/TV.TXT").size).decode("latin1"))
    (HERE / "venues.json").write_text(json.dumps({
        "format": "def-jam-venue-audio/1", "source": "SLUS_210.04 table 0x375d20, stride 0x2c, indexed by coreID",
        "mix": {"ambience": retail.mix_gain("Ambience_Vol", mix["Ambience_Vol"])},
        "venues": venues, "beds": beds}, indent=1, sort_keys=False) + "\n")
    return venues


def build_cues(disc, decoder, venues):
    out = HERE / "cues"
    out.mkdir(exist_ok=True)
    banks = {"impact": IMPACT, "voice": VOICE, "crowd": CROWD}
    banks["venue"] = sorted({v["sounds"] for v in venues if v["sounds"]} | {"train", "fire"})
    result = {}
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for group, names in banks.items():
            for name in names:
                try:
                    archive = stage_ci(disc, root, name)
                except FileNotFoundError:
                    result[name] = {"group": group, "error": "missing"}
                    continue
                count = subsong_count(decoder, root / f"{name}.abk")
                first = 1
                if name.lower() == "fire":  # the loop bed is the last subsong; its cues are the rest
                    count -= 1
                pack = pack_cues(decoder, root, name, range(first, count + 1), out / f"{name.lower()}.ogg")
                result[name] = {"group": group, "archive": archive, **(pack or {"error": "empty"})}
                for ext in ("abk", "ast"):
                    (root / f"{name}.{ext}").unlink(missing_ok=True)
                print(f"{group}/{name}: {len(pack['cues']) if pack else 0} cues", flush=True)
    (HERE / "cues.json").write_text(json.dumps({"format": "def-jam-cue-banks/1", "rate": RATE, "gap": GAP,
                                                "banks": result}, separators=(",", ":")) + "\n")


def build_data(disc):
    elf = disc.read("/SLUS_210.04", 0, disc.iso.entry("/SLUS_210.04").size)
    retail.check_elf(elf)
    mix = retail.mix_settings(disc.read("/AUDIO/TV.TXT", 0, disc.iso.entry("/AUDIO/TV.TXT").size).decode("latin1"))
    gains = {k: retail.mix_gain(k, v) for k, v in mix.items() if retail.mix_gain(k, v) is not None}
    (HERE / "mix.json").write_text(json.dumps({"format": "def-jam-audio-mix/1", "source": "AUDIO/TV.TXT",
                                               "raw": mix, "gain": gains}, indent=1) + "\n")
    csi = retail.csi_names(member(disc, SFX["SFX0"], "sfx\\DefJam2_eventsys.csi"))
    tags = retail.animtags(disc.read("/AUDIO/ANIMTAGS.DAT", 0, disc.iso.entry("/AUDIO/ANIMTAGS.DAT").size))
    packed = [[t["name"], t["tags"]] for t in tags]
    with gzip.GzipFile(HERE / "animtags.json.gz", "wb", mtime=0) as f:
        f.write(json.dumps({"format": "def-jam-animtags/1",
                            "layout": "tag = [frame, n, ...n+1 words]; n=5: [class, id, variant, 0, 0, 0]",
                            "anims": packed}, separators=(",", ":")).encode())
    (HERE / "events.json").write_text(json.dumps({
        "format": "def-jam-audio-events/1",
        "eventSystem": csi,
        "soundClasses": retail.sound_class_table(elf),
        "snd": {"packer": retail.EVENT_PACKER, "post": 0x24cd38, "postPointer": 0x389748, "playing": 0x12be80,
                "note": "post(eventWord, argc, args...) queues {eventWord, args[argc]}; eventWord = a0<<24|a1<<16|id"},
        "dispatch": retail.packed_events(elf)}, indent=1) + "\n")


GRUNT_SETS = ["AsianGuy", "BBGuy", "BGirl", "Girl1", "Girl2", "Girl3_girly", "LatinoGuy", "SBGuy", "WGuy"]
HIT_SIZES = {1: "Small", 2: "Med", 3: "Big"}


def build_combat(disc):
    """combat.json: which tag classes fire which events, and where each event lives in the banks."""
    elf = disc.read("/SLUS_210.04", 0, disc.iso.entry("/SLUS_210.04").size)
    retail.check_elf(elf)
    gains = json.loads((HERE / "mix.json").read_text())["gain"]
    cues = json.loads((HERE / "cues.json").read_text())["banks"]
    tags = [[t["name"], t["tags"]] for t in retail.animtags(disc.read("/AUDIO/ANIMTAGS.DAT", 0, disc.iso.entry("/AUDIO/ANIMTAGS.DAT").size))]
    banks = {}
    with tempfile.TemporaryDirectory() as temp:
        for name, info in cues.items():
            if info["group"] == "crowd" or "error" in info:
                continue
            root = Path(temp)
            stage_ci(disc, root, name)
            found = combat.bank((root / f"{name}.abk").read_bytes(), gains)
            for ext in ("abk", "ast"):
                (root / f"{name}.{ext}").unlink(missing_ok=True)
            packed_cues = {c["i"] for c in info["cues"]}  # the Inferno's fire loop bed is a stream, not a cue
            for module in found["modules"]:
                module["players"] = [[c for c in player if c in packed_cues] for player in module["players"]]
            banks[name] = {"group": info["group"], "modules": found["modules"]}
    fighters = {}
    for core, (speech, flags) in enumerate(retail.sound_class_table(elf)):
        if flags:
            fighters[str(core)] = {"speechID": speech, "hit": HIT_SIZES.get(flags & 0xff), "voice": (flags >> 8) & 0xff,
                                   "grunts": GRUNT_SETS[(flags >> 16) & 0xff] if (flags >> 16) & 0xff < len(GRUNT_SETS) else None,
                                   "flags": flags}
    (HERE / "combat.json").write_text(json.dumps({
        "format": "def-jam-combat-audio/1",
        "classes": combat.classes(elf, tags),
        "banks": banks,
        "fighters": fighters,
        "venueOut": sorted(v["coreID"] for v in venue_records(disc)[0] if v["flag"]),
    }, separators=(",", ":")) + "\n")


def tune_names(disc):
    return sorted({n.split("\\")[1] for v in ("MUSIC0", "MUSIC1", "MUSIC2", "MUSIC3", "MUSIC4")
                   for n in archive_names(disc, f"/AUDIO/{v}.VIV") if n.startswith("music\\") and n.endswith("tune.mpf")})


def music_member(disc, tune, name):
    for v in ("MUSIC0", "MUSIC1", "MUSIC2", "MUSIC3", "MUSIC4"):
        viv = f"/AUDIO/{v}.VIV"
        if f"music\\{tune}\\{name}" in archive_names(disc, viv):
            return viv, *disc.viv_entry(viv, f"music\\{tune}\\{name}")
    return None


def main_sections(decoder, mpf, count):
    """Sections that decode from tune.mus (track 0). The graph also lists sections that live in the
    loading/overlay .mus files, which vgmstream cannot pair; those follow the main ones."""
    sections = []
    for i in range(1, count + 1):
        try:
            info = probe(decoder, mpf, i)
        except subprocess.CalledProcessError:
            break
        sections.append([info["numberOfSamples"], info["sampleRate"], info["channels"]])
    return sections


def build_music(disc, decoder):
    tunes = []
    for tune in tune_names(disc):
        entry = {"name": tune}
        for name in ("main.mus", "loading0.mus", "overlay0.mus", "tune.mpf"):
            found = music_member(disc, tune, name)
            if found:
                entry[name] = {"archive": found[0].split("/")[-1], "offset": found[1], "size": found[2]}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, new in (("main.mus", "tune.mus"), ("tune.mpf", "tune.mpf")):
                viv, offset, size = music_member(disc, tune, name)
                (root / new).write_bytes(disc.read(viv, offset, size))
            count = subsong_count(decoder, root / "tune.mpf")
            sections = main_sections(decoder, root / "tune.mpf", count)
            entry["streams"] = count  # the rest belong to the loading/overlay tracks (other .mus files)
            entry["sections"] = sections
            entry["seconds"] = round(sum(s[0] / s[1] for s in sections), 3)
        tunes.append(entry)
        print(f"music/{tune}: {len(sections)} sections {entry['seconds']}s", flush=True)
    (HERE / "music.json").write_text(json.dumps({
        "format": "def-jam-music/1",
        "note": "main.mus is the EA PathFinder stream; tune.mpf is its node graph (sections in playback-file order). "
                "The retail loop graph is not decoded; sections are exported in file order.",
        "tunes": tunes}, separators=(",", ":")) + "\n")


def decode_music(disc, decoder, tune, target):
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for name, new in (("main.mus", "tune.mus"), ("tune.mpf", "tune.mpf")):
            viv, offset, size = music_member(disc, tune, name)
            (root / new).write_bytes(disc.read(viv, offset, size))
        count = len(main_sections(decoder, root / "tune.mpf", subsong_count(decoder, root / "tune.mpf")))
        pcm = bytearray()
        for i in range(1, count + 1):
            wav = root / "s.wav"
            run(decoder, "-i", "-s", i, "-o", wav, root / "tune.mpf", stdout=subprocess.DEVNULL)
            pcm += run("ffmpeg", "-nostdin", "-loglevel", "error", "-i", wav, "-ac", "2", "-ar", str(RATE), "-f", "s16le", "-",
                       stdout=subprocess.PIPE).stdout
        (root / "m.raw").write_bytes(pcm)
        encode(["-f", "s16le", "-ar", str(RATE), "-ac", "2", "-i", root / "m.raw"], target, "96k")


def speech_sets(disc):
    sets = []
    for viv in ("SPEECH1", "SPEECH2", "SPEECH3"):
        for name in archive_names(disc, f"/AUDIO/{viv}.VIV"):
            if name.endswith(".dat"):
                offset, size = disc.viv_entry(f"/AUDIO/{viv}.VIV", name)
                hdr = name[:-4] + ".hdr"
                sets.append({"set": name.replace("\\", "/")[:-4], "archive": viv, "dat": [offset, size],
                             "hdr": list(disc.viv_entry(f"/AUDIO/{viv}.VIV", hdr)) if hdr in archive_names(disc, f"/AUDIO/{viv}.VIV") else None})
    return sets


def build_speech(disc):
    sets = speech_sets(disc)
    (HERE / "speech.json").write_text(json.dumps({
        "format": "def-jam-speech/1",
        "note": "Each .dat is a run of EA SCHl streams (one per line); .hdr indexes them. Lines decode with "
                "vgmstream as .uv. Sets are not pre-decoded: use --speech SET to export one on demand.",
        "sets": sets}, separators=(",", ":")) + "\n")


def decode_speech(disc, decoder, name, target):
    found = [s for s in speech_sets(disc) if s["set"].split("/")[-1].lower() == name.lower()]
    if not found:
        raise SystemExit("no speech set " + name)
    info = found[0]
    data = disc.read(f"/AUDIO/{info['archive']}.VIV", *info["dat"])
    starts = [m.start() for m in re.finditer(b"SCHl", data)] + [len(data)]
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        pcm, lines = bytearray(), []
        for a, b in zip(starts, starts[1:]):
            (root / "line.uv").write_bytes(data[a:b])
            wav = root / "line.wav"
            try:
                run(decoder, "-i", "-o", wav, root / "line.uv", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except subprocess.CalledProcessError:
                continue
            raw = run("ffmpeg", "-nostdin", "-loglevel", "error", "-i", wav, "-ac", "2", "-ar", str(RATE), "-f", "s16le", "-",
                      stdout=subprocess.PIPE).stdout
            lines.append([len(pcm) // 4 + len(lines) * GAP, len(raw) // 4])
            pcm += raw + bytes(GAP * 4)
        (root / "s.raw").write_bytes(pcm)
        encode(["-f", "s16le", "-ar", str(RATE), "-ac", "2", "-i", root / "s.raw"], target, "40k")
    print(json.dumps(lines))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("iso")
    parser.add_argument("--decoder", default="vgmstream-cli")
    parser.add_argument("--only", nargs="*", choices=["venues", "cues", "data", "combat", "music", "speech"],
                        default=["venues", "cues", "data", "combat", "speech"])
    parser.add_argument("--shots", action="store_true", help="also export each ambient bank's mono one-shots (~15 MB)")
    parser.add_argument("--music")
    parser.add_argument("--speech")
    parser.add_argument("--out")
    args = parser.parse_args()
    disc = Disc(args.iso)
    try:
        if args.music:
            return decode_music(disc, args.decoder, args.music, args.out or f"{args.music}.ogg")
        if args.speech:
            return decode_speech(disc, args.decoder, args.speech, args.out or f"{args.speech}.ogg")
        venues = None
        if "venues" in args.only or "cues" in args.only:
            venues = build_venues(disc, args.decoder, args.shots) if "venues" in args.only else venue_records(disc)[0]
        if "cues" in args.only:
            build_cues(disc, args.decoder, venues)
        if "data" in args.only:
            build_data(disc)
        if "combat" in args.only:
            build_combat(disc)
        if "music" in args.only:
            build_music(disc, args.decoder)
        if "speech" in args.only:
            build_speech(disc)
    finally:
        disc.close()


if __name__ == "__main__":
    main()
