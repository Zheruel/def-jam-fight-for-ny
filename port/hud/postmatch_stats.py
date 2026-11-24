"""Write port/hud/postmatch/stats.json: the names of the 37 per-player match counters on the versus score sheet.

    python3 port/hud/postmatch_stats.py <EE RAM dump taken on the sheet> [output]

Retail builds the table (0x80-byte entries starting at 0x8aa014, name at +4) from its localized text when the session starts
(SLUS 0x15f1f8); the sheet lists a player's non-zero counters under these names ("none" entries are never listed). The counters
live at session(0x8a99c0)+0x3c8+0x10+0xa0*player and hold the points each earned: the sheet's TOTAL POINTS is SCORE plus them.
"""
import json
import struct
import sys
from pathlib import Path

SESSION, TABLE, ENTRY = 0x8A99C0, 0x8AA014, 0x80


def names(ram):
    out = []
    for index in range(37):
        raw = ram[TABLE + ENTRY * index + 4:TABLE + ENTRY * (index + 1)].split(b"\0")[0].decode("ascii")
        out.append(None if raw.lower() == "none" else raw.upper())
    return out


if __name__ == "__main__":
    ram = Path(sys.argv[1]).read_bytes()
    assert struct.unpack_from("<I", ram, 0x3FDB00)[0] == SESSION
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent / "postmatch" / "stats.json"
    table = names(ram)
    assert table[15] == "BILL OF HEALTH" and table[19] == "CROWD FAVORITE" and table[27] == "FIRST ATTACK"
    target.write_text(json.dumps({"names": table, "address": "session+0x3c8+0x10+0xa0*player", "pointsPerCash": 100}, indent=1) + "\n")
    print(target, sum(n is not None for n in table), "named counters")
