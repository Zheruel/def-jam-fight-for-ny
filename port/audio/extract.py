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
import mpf  # noqa: E402
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


# Retail battle music. The match-start builders (0x110a38 story, 0x111520 other modes, called from the stage
# start 0x127bec/0x127c04) build the "BACKEND::BATTLESONGS" list: one 0x10-byte heap block per song name, copied
# from the profile's song list, and when it is empty they log "[BACKEND] Setting primary song to default song"
# and use the tune "dirty". The list of a real match is read back from live PS2 RAM captured during two retail
# VS matches (private/verification/ps2-match/*/fighter-ram-0.bin): the same 16 tunes in both, in a different
# shuffle each time, "dirty" first and last-but-one, "mother" last.
DEFAULT_SONG = "dirty"
CAPTURES = ["private/verification/ps2-match/run-BjNMn0/fighter-ram-0.bin",
            "private/verification/ps2-match/run-zUpaXW/fighter-ram-0.bin"]
MUSIC_SEED = 1
MUSIC_BITRATE = "40k"


def captured_battle_songs(paths, tunes):
    """BATTLESONGS lists found in RAM dumps: the longest run of 0x10-aligned blocks that each hold a tune name."""
    lists = []
    for path in paths:
        ram = Path(path).read_bytes()
        best, run = [], []
        for at in range(0x4e0000, 0x4e4000, 0x10):
            name = ram[at:at + 16].split(b"\0")[0].decode("latin1")
            if name in tunes:
                run.append(name)
                continue
            if len(run) > len(best):
                best = run
            run = []
        if len(run) > len(best):
            best = run
        lists.append({"capture": Path(path).parent.name, "address": 0x4e20a0, "songs": best})
    return lists


def load_graph(disc, tune):
    viv, offset, size = music_member(disc, tune, "tune.mpf")
    return mpf.parse(disc.read(viv, offset, size))


def tune_summary(graph, path):
    samples = graph["samples"]
    seconds = lambda nodes: round(sum(samples[i][1] for i in mpf.samples_of(graph, nodes)) / 1000, 3)
    at = path["loopAt"]
    return {"nodes": len(graph["nodes"]), "samples": len(samples), "mainSamples": graph["trackSamples"][0],
            "ends": path["ends"], "introSeconds": seconds(path["nodes"][:at]) if at is not None else seconds(path["nodes"]),
            "loopSeconds": seconds(path["nodes"][at:]) if at is not None else 0}


def build_track(disc, decoder, tune, target):
    """One tune's retail fight path (intro, then the song body) as a single Opus file; returns its manifest entry."""
    graph = load_graph(disc, tune)
    path = mpf.fight_path(graph, MUSIC_SEED)
    order = mpf.samples_of(graph, path["nodes"])
    at = path["loopAt"]
    before = len(mpf.samples_of(graph, path["nodes"][:at])) if at is not None else len(order)
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        # Tracks: main.mus (streamed SCHl), loading0.mus and overlay0.mus (RAM banks, 24 kHz); .txtm maps them for vgmstream.
        files = ["main.mus", "loading0.mus", "overlay0.mus"]
        for name in files + ["tune.mpf"]:
            viv, offset, size = music_member(disc, tune, name)
            (root / name).write_bytes(disc.read(viv, offset, size))
        (root / ".txtm").write_text("tune.mpf: " + ", ".join(files) + "\n")
        pcm = {}
        for sample in dict.fromkeys(order):
            wav = root / "s.wav"
            info = probe(decoder, root / "tune.mpf", sample + 1)
            if info["channels"] != 2:
                raise ValueError(f"{tune} sample {sample}: {info['channels']} channels")
            run(decoder, "-i", "-s", sample + 1, "-o", wav, root / "tune.mpf", stdout=subprocess.DEVNULL)
            pcm[sample] = run("ffmpeg", "-nostdin", "-loglevel", "error", "-i", wav, "-af", "aresample=36000", "-f", "s16le", "-",
                              stdout=subprocess.PIPE).stdout
        joined = b"".join(pcm[i] for i in order)
        intro_frames = sum(len(pcm[i]) for i in order[:before]) // 4
        (root / "t.raw").write_bytes(joined)
        encode(["-f", "s16le", "-ar", "36000", "-ac", "2", "-i", root / "t.raw"], target, MUSIC_BITRATE, "aresample=48000")
    frames = len(joined) // 4
    entry = {"name": tune, "file": f"music/{tune}.ogg", "sourceRate": 36000, "rate": RATE, "sourceFrames": frames,
             "introSourceFrames": intro_frames, "introSeconds": intro_frames / 36000, "seconds": frames / 36000,
             "loops": not path["ends"], "seed": MUSIC_SEED, "path": path["nodes"], "loopAt": path["loopAt"],
             "sampleOrder": order}
    return entry


def build_music(disc, decoder, tunes=None):
    out = HERE / "music"
    out.mkdir(exist_ok=True)
    names = tune_names(disc)
    captured = captured_battle_songs([p for p in CAPTURES if Path(p).exists()], set(names))
    if not captured:
        old = json.loads((HERE / "music.json").read_text())["battleSongs"]["captures"]
        captured = old  # the RAM dumps are private; keep what an earlier build recorded
    sets = [sorted(set(c["songs"])) for c in captured]
    if any(x != sets[0] for x in sets):
        raise SystemExit("captured battle song sets differ")
    battle = sets[0]
    wanted = tunes or battle
    shipped = []
    for tune in wanted:
        entry = build_track(disc, decoder, tune, out / f"{tune}.ogg")
        shipped.append(entry)
        print(f"music/{tune}: {entry['seconds']:.1f}s intro {entry['introSeconds']:.1f}s "
              f"{'loops' if entry['loops'] else 'ends'}, {(out / (tune + '.ogg')).stat().st_size // 1024} KiB", flush=True)
    summary = {}
    for tune in tune_names(disc):
        graph = load_graph(disc, tune)
        summary[tune] = tune_summary(graph, mpf.fight_path(graph, MUSIC_SEED))
    mix = json.loads((HERE / "mix.json").read_text())
    (HERE / "music.json").write_text(json.dumps({
        "format": "def-jam-music/2",
        "default": DEFAULT_SONG,
        "battleSongs": {"set": battle, "primary": captured[0]["songs"][0], "captures": captured,
                        "source": "BACKEND::BATTLESONGS heap blocks read from RAM captured in two retail VS matches"},
        "confirmed": ["PFDx v4 node graph, sample table and .mus pairing (shipped tracks re-decode at correlation 1.0)",
                      "tune start, waiting loops, loop routers, four-lane weighted bars, looping song body",
                      "Music_Vol 60% x Master_Vol = gain 0.6; ducker, fade and filter settings",
                      "match-start builders create BACKEND::BATTLESONGS and fall back to the tune dirty when it is empty",
                      "BATTLESONGS in two real matches: the same 16 tunes (battleSongs.set), dirty first, in a different shuffle each time"],
        "unconfirmed": ["which listed tune a match plays and when the next starts: the music player lives on the IOP, not in the EE RAM dumps; "
                        "dirty is first in both captures, so it is used first",
                        "how the list depends on the profile: the captured profile came from a memory card save and song unlocks are not decoded, "
                        "so a fresh profile's list may be shorter; the port has no song unlock state and uses the captured set",
                        "the music events that leave a waiting loop (router exits stand in)",
                        "runtime lane draws (one seeded realization is shipped per tune)",
                        "ducking, fades and the two music filters are recorded, not applied",
                        "tunes[*] intro/loop seconds use the sample table, which misreports RAM-bank sample lengths"],
        "levels": {key: mix["raw"][key] for key in ("Music_Vol", "FE_Music_Vol", "Music_ScaleMul", "Music_Fade_Time",
                                                     "Crowd_Ducker", "Crowd_Ducker_2", "Ambient_Ducker", "SFX_Ducker")},
        "gain": mix["gain"]["Music_Vol"] * mix["gain"]["Master_Vol"],
        "tracks": {entry["name"]: entry for entry in shipped},
        "tunes": summary}, separators=(",", ":")) + "\n")


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
            return print(json.dumps(build_track(disc, args.decoder, args.music, args.out or f"{args.music}.ogg")))
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
