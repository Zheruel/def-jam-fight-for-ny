"""Extract the retail PS2 Battle fighter records and GAMECORE combat settings."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "ps2" / "content"))
from sod import Disc, Sod  # noqa: E402


SOD_PATH = "/ASSETS/DJV2.SOD"
CORE_PATH = "/ASSETS/GAMECORE.XML"
ELF_PATH = "/SLUS_210.04"
SOURCE_HASHES = {
    SOD_PATH: "5aabadea5478ee6dff9474fd5777f9613930c99e990b77c0a75305fd2b16048c",
    CORE_PATH: "995336a6bed1f3a989e80972018013456475c9ce171416ecb163b143dbc2f2fa",
    ELF_PATH: "4e65bf2947b3838ce372967cac448bfc8034709a6d70a87fd11d13c5f09b23b2",
}
DISC_SIZE = 4_694_573_056
DISC_SHA1 = "5eda39dfd703804c8734b91bd23039f642317837"
CHARACTER_HASH = 0x4CE5B1B2
STYLE_HASH = 0x906455C6
BLAZIN_HASH = 0x47D305FD
HANDLE_MASK = 0xFF7FFFFF
NO_OWNER = 0xFFFFFFFF
# Query constants in GetCharacterStats, in the order it writes UPR/LOW/SPD/TGH/HLT/CHA.
STAT_HASHES = {
    "upperPower": 0xE2824A3D,
    "lowerPower": 0xCD759ABA,
    "speed": 0xD19F0636,
    "toughness": 0xF8779D25,
    "health": 0x9CD237DB,
    "charisma": 0xA5D6AECD,
}
# GAMECORE slot order. Each style record identifies its slot in word 6 and bit in word 5.
STYLES = {
    "Street": "streetfighting",
    "Kick": "kickboxing",
    "Sub": "submissions",
    "Wrestle": "wrestling",
    "Martial": "martialArts",
}
STYLE_COMMENT = "streetfighter, kickboxing, submission, wrestling, martialarts"


def checked_disc_file(disc, path):
    data = disc.read(path)
    if hashlib.sha256(data).hexdigest() != SOURCE_HASHES[path]:
        raise ValueError(f"{path} does not match SLUS-21004")
    return data


def schema_columns(sod_data):
    skma = struct.unpack_from("<I", sod_data, 12)[0]
    kind, count, version = struct.unpack_from("<4sII", sod_data, skma)
    if (kind, version) != (b"SKMA", 2):
        raise ValueError("expected a version 2 SKMA table")
    hashes = struct.unpack_from(f"<{count}I", sod_data, skma + 12)
    offset = skma + 12 + 4 * count
    schema = dict(zip(hashes, struct.iter_unpack("<II", sod_data[offset:offset + 8 * count])))

    def column(query, field_type):
        key = CHARACTER_HASH ^ query
        if key not in schema:
            raise ValueError(f"missing Character schema field {key:#010x}")
        index, actual_type = schema[key]
        if not 0 <= index < 26 or actual_type != field_type:
            raise ValueError(f"unexpected Character schema field {key:#010x}")
        return index

    return {key: column(query, 2) for key, query in STAT_HASHES.items()}, column(STYLE_HASH, 6)


def record_rows(sod, cls, width):
    offsets = sorted(cls.records)
    if cls.count != len(offsets) or any(b - a != 4 * width for a, b in zip(offsets, offsets[1:])):
        raise ValueError(f"unexpected {cls.hash:#010x} record width")
    return [sod.words(offset, width) for offset in cls.records]


def decode_styles(sod):
    cls = sod.by_hash(STYLE_HASH)
    styles = {}
    for words in record_rows(sod, cls, 7):
        key = STYLES[sod.string(words[0])]
        styles[key] = {"name": sod.string(words[4]), "bit": 1 << words[5], "tuningIndex": words[6]}
    if set(styles) != set(STYLES.values()) or {style["bit"] for style in styles.values()} != {1, 2, 4, 8, 16}:
        raise ValueError("unexpected FightingStyle keys or masks")
    if [styles[key]["tuningIndex"] for key in STYLES.values()] != list(range(len(STYLES))):
        raise ValueError("FightingStyle indices do not match GAMECORE annotations")
    return styles


def format_handle(handle):
    return f"0x{handle:08X}"


def decode_fighters(sod, styles, stat_columns, style_column):
    cls = sod.by_hash(CHARACTER_HASH)
    handles = [(cls.index << 24) | index for index in range(cls.count)]
    styles_by_bit = sorted(styles, key=lambda key: styles[key]["bit"])
    moves = {}
    unassigned = []
    motions = set()
    blazin_class = sod.by_hash(BLAZIN_HASH)
    for index, words in enumerate(record_rows(sod, blazin_class, 6)):
        key, owner, _, _, motion_id, motion = words
        record = {
            "handle": format_handle((blazin_class.index << 24) | index),
            "key": sod.string(key),
            "motionId": motion_id,
            "motionKey": sod.string(motion),
        }
        if record["motionKey"] != f"blazin_{motion_id:02d}" or motion_id in motions:
            raise ValueError(f"invalid or duplicate Blazin motion {motion_id}")
        motions.add(motion_id)
        if owner == NO_OWNER:
            unassigned.append(record)
            continue
        owner &= HANDLE_MASK
        if owner not in handles or owner in moves:
            raise ValueError(f"invalid or duplicate Blazin owner {owner:#010x}")
        moves[owner] = record

    fighters = []
    for handle, words in zip(handles, record_rows(sod, cls, 26), strict=True):
        mask = words[style_column]
        if not 0 < mask <= 31:
            raise ValueError(f"unexpected character style mask {mask:#x}")
        fighters.append({
            "handle": format_handle(handle),
            "key": sod.string(words[0]),
            "name": sod.string(words[5]),
            "model": sod.string(words[14]),
            "stats": {key: words[index] for key, index in stat_columns.items()},
            "styleMask": mask,
            "styles": [key for key in styles_by_bit if mask & styles[key]["bit"]],
            "blazin": moves.get(handle),
        })
    return fighters, unassigned


def element_matches(source, tag):
    tag = re.escape(tag)
    return list(re.finditer(rf"<{tag}>(.*?)</{tag}>([^\S\n]*<\?.*?\?>)?", source, re.DOTALL))


def element(source, tag):
    matches = element_matches(source, tag)
    if len(matches) != 1:
        raise ValueError(f"expected one <{tag}> block, found {len(matches)}")
    return matches[0]


def block(source, tag):
    return element(source, tag)[1]


def numeric(source, tag, count=1, *, styles=False):
    match = element(source, tag)
    values = [float(value.strip()) for value in match[1].split(",")]
    if len(values) != count or not all(map(math.isfinite, values)):
        raise ValueError(f"<{tag}> must contain {count} finite numbers")
    if styles and (not match[2] or match[2].strip()[2:-2].strip() != STYLE_COMMENT):
        raise ValueError(f"unexpected style order annotation on <{tag}>")
    return values[0] if count == 1 else values


def scalar_fields(source, tags):
    return {key: numeric(source, tag) for key, tag in tags.items()}


def decode_tuning(source, styles):
    root = block(source, "gamecore parameter")
    skill_section = element(root, "skill effects")
    skill = skill_section[1]
    top = root[:skill_section.start()] + root[skill_section.end():]
    speed = block(top, "animatioin speed tuning")
    difficulty = block(top, "momentum scale per difficulty level")
    blazin_penalty = block(top, "momentum penalty per landed blazin move")
    style_fields = {
        "damage": {
            "punch": "style damage rate strike punch",
            "kick": "style damage rate strike kickh",
            "grapple": "style damage rate grapple move",
            "diving": "style damage rate diving attack",
        },
        "blockFrames": {key: f"block {key} frame" for key in ("start", "end", "counter", "invalid")},
        "grappleCatchFrames": {
            "normal": "normal grapple catch frame",
            "strong": "strong grapple catch frame",
        },
        "speed": {
            "strikeToContact": "strike to contact speed",
            "strikeRetraction": "strike retraction speed",
            "strikeGuardAfter": "strike guard after speed",
            "punch": "strike punch speed",
            "kick": "strike kick speed",
            "normalGrappleMove": "normal grapple move speed",
            "strongGrappleMove": "strong grapple move speed",
            "diving": "diving attack speed",
        },
    }
    columns = {
        group: {key: numeric(speed if group == "speed" else top, tag, 5, styles=True) for key, tag in tags.items()}
        for group, tags in style_fields.items()
    }
    button_escape = numeric(top, "button escape rate", 5, styles=True)
    by_style = {}
    for key in STYLES.values():
        index = styles[key]["tuningIndex"]
        by_style[key] = {
            group: {name: values[index] for name, values in fields.items()}
            for group, fields in columns.items()
        }
        by_style[key]["buttonEscapeRate"] = button_escape[index]

    global_fields = scalar_fields(top, {
        "stunRecoveryRate": "stun recovery rate",
        "healthRecoveryRate": "health recovery rate",
        "momentumHealthRecoveryEffect": "momentum health recovery effect",
        "healthTankMinimumPercent": "health tank minimum level",
        "momentumExpiryRate": "momentum expiry rate",
        "staminaSpendRate": "stamina spend rate",
        "staminaReplenishmentRate": "stamina replenishment rate",
        "submissionDurationSeconds": "submission duration",
        "grappleStrikeDurationSeconds": "grapple strike duration",
        "buttonEscape": "button escape",
        "walkStickThreshold": "L stick recognized value walk",
        "shoveStickThreshold": "L stick recognized value shove",
        "fightingComboLinkSeconds": "fighting combo link time",
        "scoringComboLinkSeconds": "scorring combo link time",
        "catchRandomPercent": "catch random rate",
        "pressureK1Rate": "pressure k1 rate",
    })
    return {
        "byStyle": by_style,
        **global_fields,
        "moveRepetitionPenaltyPercent": numeric(top, "move repetition penalty", 5),
        "pressureParameters": numeric(top, "pressure parameter", 6),
        "stunDuration": {
            key: dict(zip(("minSeconds", "maxSeconds", "validStunPercent"), numeric(top, tag, 3)))
            for key, tag in {
                "ground": "ground stun duration",
                "standing": "standing stun duration",
                "stickyPoint": "sticky point stun duration",
            }.items()
        },
        "runningSpeed": scalar_fields(speed, {"normal": "normal running speed", "slow": "slow running speed"}),
        "skillEffects": scalar_fields(skill, {
            "upperPower": "upper power",
            "lowerPower": "lower power",
            "speedStrike": "speed strike",
            "speedBlock": "speed block",
            "speedDash": "speed dash",
            "toughnessDamageDecrease": "toughness damage decrease",
            "toughnessHealthRecovery": "toughness health recovery",
            "healthBaseAmount": "health base amount",
            "healthRecoveryRate": "health recovery rate",
            "healthStaminaRecoveryRate": "health stamina recovery rate",
            "charisma": "charisma",
        }),
        "koSlowMotion": scalar_fields(block(top, "KO slow-motion"), {
            "minSpeed": "min speed", "maxSpeed": "max speed", "seconds": "time",
        }),
        "momentumScaleByDifficulty": {
            label: dict(zip(("easy", "normal", "hard"), numeric(difficulty, tag, 3)))
            for label, tag in (("player", "player"), ("ai", "AI"))
        },
        "momentumPenaltyPerLandedBlazin": {
            key: numeric(blazin_penalty, tag, 5)
            for key, tag in {
                "singleMatch": "single match",
                "team2v2": "2vs2 team",
                "freeForAll": "free for all",
                "teamSurvival": "team survival",
                "subway": "subway",
                "inferno": "inferno",
                "demolition": "demolition",
                "window": "window",
            }.items()
        },
    }


def extract(iso):
    if iso.stat().st_size != DISC_SIZE:
        raise ValueError("unexpected SLUS-21004 disc size")
    with Disc(iso) as disc:
        sod_bytes = checked_disc_file(disc, SOD_PATH)
        gamecore = checked_disc_file(disc, CORE_PATH).decode("utf-8")
        checked_disc_file(disc, ELF_PATH)
    sod = Sod(sod_bytes)
    stat_columns, style_column = schema_columns(sod_bytes)
    styles = decode_styles(sod)
    fighters, unassigned = decode_fighters(sod, styles, stat_columns, style_column)
    data = {
        "source": {"serial": "SLUS-21004", "retailDiscSha1": DISC_SHA1, "fileSha256": SOURCE_HASHES},
        "fightingStyles": styles,
        "fighters": fighters,
        "unassignedBlazin": unassigned,
        "combatTuning": decode_tuning(gamecore, styles),
    }
    return "// Generated by extract_combat.py from SLUS-21004.\nexport default " + json.dumps(data, indent=2) + ";\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--check", action="store_true", help="compare to the committed module")
    args = parser.parse_args()
    output = HERE / "combat-data.mjs"
    try:
        generated = extract(args.iso).encode("utf-8")
        if args.check:
            if generated != output.read_bytes():
                raise ValueError(f"{output.name} differs from the extracted data")
            print(f"{output.name} matches SLUS-21004")
        else:
            output.write_bytes(generated)
    except (OSError, ValueError, KeyError, struct.error) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
