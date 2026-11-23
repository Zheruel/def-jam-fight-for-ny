"""Parsers for the retail US disc's audio data (SLUS-21004).

Everything here reads bytes straight from the disc image; nothing is guessed from other games.

    SLUS_210.04   venue audio table, packed audio event dispatch sites
    AUDIO/TV.TXT  retail mix levels
    SFX0.VIV      DefJam2_eventsys.csi event names
    ANIMTAGS.DAT  per-animation frame tags that fire audio events
"""
import hashlib
import re
import struct

ELF_LOAD_DELTA = 0x100000 - 0x1000  # SLUS_210.04: file offset 0x1000 -> vaddr 0x100000
ELF_SHA256 = "4e65bf2947b3838ce372967cac448bfc8034709a6d70a87fd11d13c5f09b23b2"

# CGameAudio's per-stage table. The stage-start routine at 0x127270 indexes it by the
# current core venue id: record = 0x375d20 + 0x2c * coreID.
VENUE_TABLE = 0x375d20
VENUE_STRIDE = 0x2c
VENUE_RECORDS = 28
# Packs a 32-bit event word from (byte3, byte2, half0); every audio event the engine
# dispatches by id goes through it.
EVENT_PACKER = 0x24d5d8


def check_elf(elf):
    if hashlib.sha256(elf).hexdigest() != ELF_SHA256:
        raise ValueError("SLUS_210.04 is not the retail US executable")


def _u32(elf, vaddr):
    return struct.unpack_from("<I", elf, vaddr - ELF_LOAD_DELTA)[0]


def _cstr(elf, vaddr):
    if not 0x300000 < vaddr < 0x4f0000:
        return None
    start = vaddr - ELF_LOAD_DELTA
    return elf[start:elf.index(b"\0", start)].decode("latin1")


def venue_table(elf):
    """One entry per core venue id: speech, crowd, ambient, SFX bank and archive."""
    check_elf(elf)
    records = []
    for core in range(VENUE_RECORDS):
        at = VENUE_TABLE + VENUE_STRIDE * core
        word = lambda i: _u32(elf, at + 4 * i)
        archive = _cstr(elf, word(5))
        records.append({
            "coreID": core,
            "speechID": word(1),
            "announcerSet": _cstr(elf, word(2)),
            "speechSuffix": _cstr(elf, word(3)),
            "crowd": _cstr(elf, word(4)),
            "archive": archive.split("|")[0].split("/")[-1][:-4] if archive else None,
            "ambient": _cstr(elf, word(6)),
            "ambient2": _cstr(elf, word(7)),
            "sounds": _cstr(elf, word(8)),
            "flag": word(0),
            "mode": struct.unpack("<i", struct.pack("<I", word(10)))[0],
        })
    return records


def mix_settings(text):
    """AUDIO/TV.TXT: '#Name value' lines. Levels are 16-bit (32767 = full) except the
    Music/Speech percentages and the timing/AI constants, which stay raw."""
    values = {}
    for line in text.splitlines():
        match = re.match(r"#(\w+)\s+([-\d.]+)", line)
        if match:
            values[match[1]] = float(match[2]) if "." in match[2] else int(match[2])
    return values


def mix_gain(name, value):
    """Linear gain for a TV.TXT level, or None when the key is not a level."""
    if re.match(r"(?i)(speech_|music_vol|fe_music_vol)", name) and "Ann_" not in name:
        return value / 100
    if name.endswith(("_Vol", "_Submix1", "_Submix2", "_Submix3", "_Submix4", "_Submix5", "_SubmixGlobal")) \
            or name in ("CrowdWet_Level", "CrowdDry_Level"):
        return value / 32767
    return None


def csi_names(csi):
    """DefJam2_eventsys.csi: two row tables (event classes, then sound objects).
    A row is (name offset, a1c offset, 0); the classes are prefixed A1c[pbe]."""
    rows, at = [], 0x2c
    while at + 12 <= len(csi):
        name, data, _ = struct.unpack_from("<III", csi, at)
        if name < 0xb00 or name >= len(csi):
            break
        end = csi.index(b"\0", name)
        text = csi[name:end]
        if not text or not all(32 <= c < 127 for c in text):
            break
        rows.append({"name": text.decode(), "a1c": data})
        at += 12
    classes = [r for r in rows if r["name"].startswith("A1c")]
    objects = [r for r in rows if not r["name"].startswith("A1c")]
    return {"classes": classes, "objects": objects}


def animtags(data):
    """ANIMTAGS.DAT: 'TAGS', count, offsets[count]; entry = 8-byte right-aligned animation
    name, u32 tag count, then tags of u16 frame, u16 n, (n + 1) u16 words, i.e. 2n + 6 bytes."""
    if data[:4] != b"TAGS":
        raise ValueError("not ANIMTAGS.DAT")
    count = struct.unpack_from("<I", data, 4)[0]
    offsets = list(struct.unpack_from(f"<{count}I", data, 8)) + [len(data)]
    out = []
    for i in range(count):
        entry = data[offsets[i]:offsets[i + 1]]
        name = entry[:8].lstrip(b"\0").decode("latin1")
        n = struct.unpack_from("<I", entry, 8)[0]
        at, tags = 12, []
        for _ in range(n):
            frame, kind = struct.unpack_from("<HH", entry, at)
            size = 2 * kind + 6
            words = struct.unpack_from(f"<{kind + 1}H", entry, at + 4)
            tags.append([frame, kind, *words])
            at += size
        if at != len(entry):
            raise ValueError(f"animtags entry {name} does not end on its boundary")
        out.append({"name": name, "tags": tags})
    return out


def _constants(words, first, last):
    """Constants held in registers after replaying simple li/move instructions."""
    regs = {}
    for j in range(max(0, first), last):
        word = words[j]
        op, rs, rt, imm = word >> 26, word >> 21 & 31, word >> 16 & 31, word & 0xffff
        if op == 9 and rs == 0:
            regs[rt] = imm if imm < 0x8000 else imm - 0x10000
        elif op == 0xd and rs == 0:
            regs[rt] = imm
        elif op == 0 and word & 0x3f in (0x21, 0x25, 0x2d) and rt == 0:
            rd = word >> 11 & 31
            if rs == 0:
                regs[rd] = 0
            else:
                regs.pop(rd, None)
        elif op in (0x23, 0xf, 0x24, 0x25, 0x20, 0x21, 0x31, 0x37, 0x1b) or (op == 0 and word & 0x3f in (0x21, 0x25, 0x2d, 0x18, 0x12, 0x10)):
            regs.pop(word >> 11 & 31 if op == 0 else rt, None)
    return regs


def _function_start(words, pc):
    i = (pc - ELF_LOAD_DELTA) // 4
    while i > 0:
        if words[i] >> 16 == 0x27bd and words[i] & 0xffff >= 0x8000:  # addiu sp, sp, -N
            return i * 4 + ELF_LOAD_DELTA
        i -= 1
    return None


def packed_events(elf):
    """Every call of the event packer 0x24d5d8, the SND post that follows, and the callers of the
    containing function. The packer builds the event word as (a0 << 24) | (a1 << 16) | a2. The
    SND post is the function pointer stored at 0x3996... by 0x24b9fc (0x24cd38): it takes
    (event word, argc, args...), queues a message {event word, args[argc]} and returns."""
    check_elf(elf)
    words = struct.unpack_from(f"<{len(elf) // 4}I", elf, 0)
    callers = {}
    for i, word in enumerate(words):
        if word >> 26 == 3:
            callers.setdefault((word & 0x3ffffff) << 2, []).append(i * 4 + ELF_LOAD_DELTA)
    sites = []
    for i, word in enumerate(words):
        if word >> 26 != 3 or (word & 0x3ffffff) << 2 != EVENT_PACKER:
            continue
        pc = i * 4 + ELF_LOAD_DELTA
        packer = _constants(words, i - 12, i + 2)
        # the packer's argument registers are loaded before the call; the post follows it
        post = None
        for k in range(i + 1, min(i + 14, len(words))):
            if words[k] >> 26 == 0 and words[k] & 0x3f == 9:  # jalr
                regs = _constants(words, k - 8, k + 2)
                post = {"argc": regs.get(5), "args": [regs.get(r) for r in (6, 7, 8)]}
                break
        function = _function_start(words, pc)
        sites.append({
            "pc": pc, "function": function, "a0": packer.get(4), "a1": packer.get(5), "id": packer.get(6),
            "post": post, "callers": callers.get(function, [])[:6],
        })
    return sites


def sound_class_table(elf):
    """The retail 12-byte (value, flags, -1) table that follows the venue records. Indexed by the
    class id carried in type-5 animation tags; flags are kept raw."""
    check_elf(elf)
    rows = []
    for at in range(0x3761f0, 0x3766d0, 12):
        value, flags = _u32(elf, at), _u32(elf, at + 4)
        rows.append([None if value == 0xffffffff else value, flags])
    return rows
