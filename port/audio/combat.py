"""Combat audio routing recovered from the retail disc.

Animation tag classes (ANIMTAGS.DAT) post named events; each event is a module of an ABKC bank.
This builds `combat.json`: class -> event, event -> (bank, module, players, cue numbers, mix levels).

    python3 port/audio/extract.py private/ps2/reference.iso --only combat
"""
import re
import struct

import abk

# Trailer after the BNK data: records of <tag u16> <hash u16> <NUL-terminated string> <zero padding>.
# The tag is constant within a bank. A module's records are its mix variables (gXxxVol, the first is
# always gMasterVol) followed by its event name.
VARIABLE = re.compile(r"^g[A-Z_]\w*Vol\w?$|^gSfx_|^gSFX_")


def trailer_records(data):
    """Module strings in order, split into the modules they belong to."""
    first = data.find(b"gMasterVol")
    if first < 0:
        return []
    pos = first - 4
    tag = data[pos:pos + 2]
    modules, current = [], []
    while data[pos:pos + 2] == tag:
        end = data.index(b"\0", pos + 4)
        text = data[pos + 4:end].decode("latin1")
        if VARIABLE.match(text):
            current.append(text)
        else:
            modules.append({"event": text, "vars": [v for v in current if v != "gMasterVol"]})
            current = []
        nxt = data.find(tag, end, end + 12)
        if nxt < 0:
            break
        pos = nxt
    return modules


def normal(text):
    return re.sub(r"[^a-z0-9]", "", text.lower())


ALIASES = {"gMatFallSuperVol": "MatSuperFall_Vol", "gEnvironAttackVol": "EnvAttack_Vol"}


def mix_key(variable, gains):
    """gBodyCollideVol -> BodyCollide_Vol in TV.TXT's levels, or None when the engine has no such level
    (submix sends and a few one-off variables)."""
    if variable in ALIASES:
        return ALIASES[variable]
    submix = re.match(r"^g(?:Sfx|SFX)_SubmixVol(\d)$", variable)
    if submix:
        return f"SFX_Submix{submix.group(1)}"
    fall = re.match(r"^g(\w+?)FallsVol$", variable)
    if fall:
        return next((k for k in gains if normal(k) == normal(f"Fall{fall.group(1)}_Vol")), None)
    base = normal(re.sub(r"^g|Vol\w?$", "", variable))
    for wanted in (base, base.rstrip("s")):
        for key in gains:
            if normal(re.sub(r"_(Vol|Level)$", "", key)) == wanted:
                return key
    return None


def bank(data, gains):
    parsed = abk.parse(data)
    records = trailer_records(data)
    modules = []
    for module in parsed["modules"]:
        record = records[module["index"]] if module["index"] < len(records) else {"event": None, "vars": []}
        modules.append({
            "event": record["event"],
            "vars": record["vars"],
            "mix": [mix_key(v, gains) for v in record["vars"]],
            "players": [[c for c in p["cues"] if c] for p in module["players"]],
        })
    return {"cues": parsed["cues"], "records": len(records), "modules": modules}


def classes(elf, tags):
    """Tag class -> the events its handler posts, with each payload word's observed range."""
    import retail
    seen = {}
    for _, anim in tags:
        for tag in anim:
            span = seen.setdefault(tag[2], [])
            words = tag[3:]
            for i, word in enumerate(words):
                while len(span) <= i:
                    span.append([word, word])
                span[i] = [min(span[i][0], word), max(span[i][1], word)]
    out = {}
    for cls, info in retail.tag_classes(elf).items():
        out[str(cls)] = {"handler": hex(info["handler"]), "events": info["events"],
                         "count": sum(1 for _, a in tags for t in a if t[2] == cls),
                         "words": seen.get(cls, [])}
    return out
