"""Deterministic battle unlocks for Def Jam: Fight for NY, US PS2 (SLUS-21004).

    python3 ps2/content/unlocks.py inventory private/ps2/reference.iso   # -> inventory.json
    python3 ps2/content/unlocks.py patch     private/ps2/reference.iso   # -> unlock-patch.json,
                                                                         #    unlock-disc-patch.json, GameConfig.xml
    python3 ps2/content/unlocks.py verify    private/ps2/reference.iso   # re-derives both and diffs them

How the retail game gates fighters and venues
---------------------------------------------
The global profile object lives in registry slot 0x18 of the table at 0x003FDAA0 (the script
bindings cache it at this+0xD0C). Its body R = [obj + 4] holds two sorted handle sets that the
constructor at 0x001031B8 lays out as:

    venue set   R+0x0C capacity (30)  R+0x10 count  R+0x14 -> count mirror  R+0x18 -> data (inline, body+0x1268)
    fighter set R+0x20 capacity (80)  R+0x24 count  R+0x28 -> count mirror  R+0x2C -> data (inline, body+0x12E0)

Handles are (SOD class index << 24) | instance index; bit 23 is masked off (0xFF7FFFFF) on every
compare. BuyCharacter (0x0014BFB0) and BuyVenue (0x0014C970) are the only retail writers: they
subtract the cost from R+0x50 and insert one handle. GetGlobal*UnlockInfo, Get*CostInfo and
Get*List binary-search the sets.

The patch
---------
The script binder copies each handler's pointer-to-member from .rodata when the screen class is
registered. The patch points the unlock bindings (the shop/unlock screen's eight, plus the battle
setup screen's ResetFighterList/ResetVenueList and the story venue list) at three-word wrappers
that load the real handler into $t9 and jump to one shared fill routine. The routine reads the
profile from registry slot 0x18 directly, so it works from any screen class. The fill routine merges every SOD handle
of the fighter and venue classes into the two sets (keeping any existing entry and its flag bit),
updates the count and its mirror, and tail-jumps to $t9 with every argument register intact.
Bounds are checked against the live capacity words, so a profile that does not look like the
retail layout is left untouched. BuyCharacter and BuyVenue become "fill, return 0", so their
bodies hold the new code; with everything unlocked the game never offers a purchase.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import struct
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from sod import Disc, Sod  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
FORMAT = "def-jam-ps2-unlocks/1"
SERIAL = "SLUS-21004"
DISC_SIZE = 4_694_573_056
DISC_SHA1 = "5eda39dfd703804c8734b91bd23039f642317837"
ELF_PATH = "/SLUS_210.04"
ELF_SHA256 = "4e65bf2947b3838ce372967cac448bfc8034709a6d70a87fd11d13c5f09b23b2"
SOD_PATH = "/ASSETS/DJV2.SOD"
EXECUTABLE = "SLUS_210.04;1"  # Play! matches GameConfig entries on the boot path's file name

FIGHTER_CLASS_HASH = 0x4CE5B1B2
VENUE_CLASS_HASH = 0xD7DCA628
HANDLE_MASK = 0xFF7FFFFF

# Single PT_LOAD segment: file offset 0x1000 -> vaddr 0x00100000.
ELF_FILE_OFFSET, ELF_VADDR = 0x1000, 0x00100000

PROFILE_REGISTRY = 0x003FDAA0
PROFILE_SLOT = 0x18
VENUE_SET, FIGHTER_SET = 0x0C, 0x20  # offsets in R; set = {capacity, count, &mirror, data}
VENUE_CAPACITY, FIGHTER_CAPACITY = 30, 80

# name -> (pointer-to-member slot in .rodata, retail handler). Slot+4 holds the code pointer.
BINDINGS = {
    "GetGlobalCharUnlockInfo": (0x003B7AF0, 0x0014ABA0),
    "GetCharCostInfo": (0x003B7B08, 0x0014AF38),
    "GetCharacterList": (0x003B7B68, 0x0014B7C8),
    "BuyCharacter": (0x003B7B80, 0x0014BFB0),
    "GetGlobalVenueUnlockInfo": (0x003B7BA8, 0x0014C0F0),
    "GetVenueCostInfo": (0x003B7BC8, 0x0014C300),
    "GetVenueList": (0x003B7BE0, 0x0014C590),
    "BuyVenue": (0x003B7BF8, 0x0014C970),
    # Battle setup screen (character and venue select) builds its own lists from the sets.
    "ResetFighterList": (0x003B3DB8, 0x00136330),
    "ResetVenueList": (0x003B3E20, 0x00136398),
    # Story-mode venue list (same name, different screen class).
    "ResetVenueList (story)": (0x003BB618, 0x0015A898),
}
FILL_AT, FILL_WORDS = 0x0014BFB0, 80  # BuyCharacter body
WRAP_AT, WRAP_WORDS = 0x0014C970, 80  # BuyVenue body

# Retail words the patch depends on: (address, word, meaning). Checked before every build.
SIGNATURES = [
    (0x001031FC, 0xFFBF0150, "profile ctor: sd ra,0x150(sp)"),
    (0x00103210, 0x2405001E, "profile ctor: venue set capacity 30"),
    (0x001031BC, 0x24070050, "profile ctor: fighter set capacity 80"),
    (0x001031E8, 0x26241268, "profile ctor: venue data inline at body+0x1268"),
    (0x0010322C, 0x262412E0, "profile ctor: fighter data inline at body+0x12E0"),
    (0x0014AA20, 0x3C040040, "binder ctor: lui a0,0x40 (profile registry)"),
    (0x0014AA24, 0x24050018, "binder ctor: registry slot 0x18"),
    (0x0014AA2C, 0x2484DAA0, "binder ctor: registry 0x3FDAA0"),
    (0x0014AA30, 0xAE020D0C, "binder ctor: sw v0,0xd0c(s0)"),
    (0x0014BFEC, 0x8E030D0C, "BuyCharacter: lw v1,0xd0c(s0)"),
    (0x0014BFF8, 0x8C660004, "BuyCharacter: R = [obj+4]"),
    (0x0014C000, 0x24C90020, "BuyCharacter: fighter set at R+0x20"),
    (0x0014C018, 0x8CC80024, "BuyCharacter: fighter count at R+0x24"),
    (0x0014C9C0, 0x24C9000C, "BuyVenue: venue set at R+0x0C"),
    (0x0014C9D8, 0x8CC80010, "BuyVenue: venue count at R+0x10"),
    (0x0014C0B8, 0x8D230008, "BuyCharacter: count mirror pointer at set+8"),
    (0x0014C0E4, 0x03E00008, "BuyCharacter: last word (jr ra)"),
    (0x0014CAA4, 0x03E00008, "BuyVenue: last word (jr ra)"),
    (0x00360990, 0x8C830000, "handle key: lw v1,0(a0)"),
    (0x00360998, 0x3442FFFF, "handle key: mask 0xFF7FFFFF"),
]

# ---------------------------------------------------------------- minimal R5900 assembler

REG = {n: i for i, n in enumerate(
    "zero at v0 v1 a0 a1 a2 a3 t0 t1 t2 t3 t4 t5 t6 t7 s0 s1 s2 s3 s4 s5 s6 s7 t8 t9 k0 k1 gp sp fp ra".split())}


def _i(op, rs, rt, imm):
    return (op << 26) | (REG[rs] << 21) | (REG[rt] << 16) | (imm & 0xFFFF)


def _r(rs, rt, rd, funct, sa=0):
    return (REG[rs] << 21) | (REG[rt] << 16) | (REG[rd] << 11) | (sa << 6) | funct


class Asm:
    def __init__(self, base):
        self.base, self.code, self.labels, self.fixups = base, [], {}, []

    @property
    def pc(self):
        return self.base + 4 * len(self.code)

    def label(self, name):
        self.labels[name] = self.pc

    def emit(self, word):
        self.code.append(word & 0xFFFFFFFF)

    def branch(self, op, rs, rt, target):  # beq/bne/bgtz/bltz-style, resolved later
        self.fixups.append((len(self.code), target))
        self.emit(_i(op, rs, rt, 0))

    def link(self):
        for index, target in self.fixups:
            dest = self.labels[target] if isinstance(target, str) else target
            delta = (dest - (self.base + 4 * index + 4)) >> 2
            if not -0x8000 <= delta < 0x8000:
                raise ValueError("branch out of range")
            self.code[index] = (self.code[index] & 0xFFFF0000) | (delta & 0xFFFF)
        return self.code

    # instructions
    def nop(self): self.emit(0)
    def lw(self, rt, off, rs): self.emit(_i(0x23, rs, rt, off))
    def sw(self, rt, off, rs): self.emit(_i(0x2B, rs, rt, off))
    def lui(self, rt, imm): self.emit(_i(0x0F, "zero", rt, imm))
    def ori(self, rt, rs, imm): self.emit(_i(0x0D, rs, rt, imm))
    def addiu(self, rt, rs, imm): self.emit(_i(0x09, rs, rt, imm))
    def slti(self, rt, rs, imm): self.emit(_i(0x0A, rs, rt, imm))
    def or_(self, rd, rs, rt): self.emit(_r(rs, rt, rd, 0x25))
    def and_(self, rd, rs, rt): self.emit(_r(rs, rt, rd, 0x24))
    def addu(self, rd, rs, rt): self.emit(_r(rs, rt, rd, 0x21))
    def sll(self, rd, rt, sa): self.emit(_r("zero", rt, rd, 0x00, sa))
    def jr(self, rs): self.emit(_r(rs, "zero", "zero", 0x08))
    def beq(self, rs, rt, target): self.branch(0x04, rs, rt, target)
    def bne(self, rs, rt, target): self.branch(0x05, rs, rt, target)
    def bgtz(self, rs, target): self.branch(0x07, rs, "zero", target)
    def bltz(self, rs, target): self.branch(0x01, rs, "zero", target)  # REGIMM rt=0

    def j(self, target):
        if (target ^ (self.pc + 4)) & 0xF0000000:
            raise ValueError("jump out of region")
        self.emit((0x02 << 26) | ((target >> 2) & 0x03FFFFFF))


def hi_lo(value):
    lo = value & 0xFFFF
    return ((value - (lo - 0x10000 if lo & 0x8000 else lo)) >> 16) & 0xFFFF, lo


def assemble(fighter_class, fighter_count, venue_class, venue_count):
    """Returns (fill words, wrapper words, {binding: wrapper address})."""
    a = Asm(FILL_AT)
    # $t9 = real handler; $a0-$a3 untouched. Uses only caller-saved temporaries.
    hi, lo = hi_lo(PROFILE_REGISTRY + 4 * PROFILE_SLOT)
    a.lui("t0", hi)
    a.lw("t0", lo, "t0")                   # profile object = registry[0x18]
    a.beq("t0", "zero", "done")
    a.lui("t7", HANDLE_MASK >> 16)         # delay slot, harmless
    a.lw("t0", 4, "t0")                    # R = profile body
    a.beq("t0", "zero", "done")
    a.ori("t7", "t7", HANDLE_MASK & 0xFFFF)
    for name, offset, cls, count in (("venue", VENUE_SET, venue_class, venue_count),
                                     ("fighter", FIGHTER_SET, fighter_class, fighter_count)):
        skip, loop, store = name + "_skip", name + "_loop", name + "_store"
        a.addiu("t1", "t0", offset)        # set
        a.lw("t3", 0, "t1")                # capacity
        a.slti("t4", "t3", count)
        a.bne("t4", "zero", skip)          # capacity < count: not the retail layout
        a.lw("t5", 4, "t1")                # count (delay slot)
        a.slti("t4", "t5", count + 1)
        a.beq("t4", "zero", skip)          # count > every handle: not the retail layout
        a.lw("t6", 12, "t1")               # data (delay slot)
        a.beq("t6", "zero", skip)
        a.lui("t2", cls << 8)              # handle base (delay slot)
        a.addiu("t5", "t5", -1)            # j = last existing entry
        a.addiu("t8", "zero", count - 1)   # i = last handle
        a.label(loop)
        a.or_("v0", "t2", "t8")            # handle i
        a.bltz("t5", store)
        a.sll("v1", "t5", 2)               # delay slot
        a.addu("v1", "v1", "t6")
        a.lw("v1", 0, "v1")                # existing entry j
        a.and_("at", "v1", "t7")
        a.bne("at", "v0", store)
        a.nop()
        a.or_("v0", "v1", "zero")          # keep the existing entry and its flag bit
        a.addiu("t5", "t5", -1)
        a.label(store)
        a.sll("v1", "t8", 2)
        a.addu("v1", "v1", "t6")
        a.sw("v0", 0, "v1")                # data[i]; i >= j so no unread entry is overwritten
        a.bgtz("t8", loop)
        a.addiu("t8", "t8", -1)            # delay slot
        a.addiu("v0", "zero", count)
        a.sw("v0", 4, "t1")                # count
        a.lw("v1", 8, "t1")                # count mirror
        a.beq("v1", "zero", skip)
        a.nop()
        a.sw("v0", 0, "v1")
        a.label(skip)
    a.label("done")
    a.jr("t9")
    a.nop()
    fill = a.link()
    if len(fill) > FILL_WORDS:
        raise ValueError(f"fill routine needs {len(fill)} words, {FILL_WORDS} available")

    w = Asm(WRAP_AT)
    w.label("ret0")
    w.jr("ra")
    w.or_("v0", "zero", "zero")
    wrappers = {}
    for name, (_, handler) in BINDINGS.items():
        target = WRAP_AT if name.startswith("Buy") else handler  # Buy* become "fill, return 0"
        hi, lo = hi_lo(target)
        wrappers[name] = w.pc
        w.lui("t9", hi)
        w.j(FILL_AT)
        w.addiu("t9", "t9", lo)
    words = w.link()
    if len(words) > WRAP_WORDS:
        raise ValueError("wrappers do not fit")
    return fill, words, wrappers


# ---------------------------------------------------------------- disc inventory


class Elf:
    def __init__(self, data):
        if hashlib.sha256(data).hexdigest() != ELF_SHA256:
            raise ValueError("SLUS_210.04 is not the retail US executable")
        self.data = data

    def word(self, address):
        return struct.unpack_from("<I", self.data, address - ELF_VADDR + ELF_FILE_OFFSET)[0]


def xml_records(text, tag):
    for block in re.findall(rf"<{tag}>(.*?)</{tag}>", text, re.S):
        yield {k: v.strip() for k, v in re.findall(r"<(\w+)>(.*?)</\1>", block, re.S)}


def read_disc(iso):
    path = pathlib.Path(iso)
    if path.stat().st_size != DISC_SIZE:
        raise ValueError(f"{iso}: expected {DISC_SIZE} bytes")
    with Disc(iso) as disc:
        files = {name: disc.read(name) for name in (ELF_PATH, SOD_PATH, "/FIGHTER.XML", "/VENUE.XML")}
        entries = {name: disc.entry(name) for name in files}
    return files, entries


def source(entries, files, name):
    offset, size = entries[name]
    return {"path": name, "isoOffset": offset, "bytes": size, "sha256": hashlib.sha256(files[name]).hexdigest()}


def inventory(iso):
    files, entries = read_disc(iso)
    elf = Elf(files[ELF_PATH])
    for address, word, meaning in SIGNATURES:
        if elf.word(address) != word:
            raise ValueError(f"signature {address:#010x} ({meaning}) does not match")
    sod = Sod(files[SOD_PATH])
    fighter_xml = {r["model"]: r for r in xml_records(files["/FIGHTER.XML"].decode("latin-1"), "fighter")}
    venue_xml = list(xml_records(files["/VENUE.XML"].decode("latin-1"), "venue"))

    fcls, vcls = sod.by_hash(FIGHTER_CLASS_HASH), sod.by_hash(VENUE_CLASS_HASH)
    fighters = []
    for index, record in enumerate(fcls.records):
        w = sod.words(record, 26)
        model = sod.string(w[14])
        xml = fighter_xml.get(model)
        if xml is None:
            raise ValueError(f"fighter record {index}: model {model} not in FIGHTER.XML")
        fighters.append({
            "handle": f"0x{(fcls.index << 24) | index:08X}",
            "index": index,
            "key": sod.string(w[0]),
            "name": sod.string(w[5]),
            "model": model,
            "cost": w[4],
            "listed": w[13],  # 0 only for story variants and the E3 placeholder hero
            "sodRecordOffset": record,
            "fighterXml": {"ID": int(xml["ID"]), "coreID": int(xml["coreID"]), "name": xml["name"],
                           "dispname": xml["dispname"]},
        })
    venues = []
    for index, record in enumerate(vcls.records):
        w = sod.words(record, 19)
        filename = sod.string(w[13])
        xml = [r for r in venue_xml if r["filename"] == filename and int(r["coreID"]) == w[11]]
        if len(xml) != 1:
            raise ValueError(f"venue record {index}: {filename} core {w[11]} not unique in VENUE.XML")
        venues.append({
            "handle": f"0x{(vcls.index << 24) | index:08X}",
            "index": index,
            "key": sod.string(w[0]),
            "name": sod.string(w[9]),
            "file": filename,
            "cost": w[5],
            "coreID": w[11],
            "feID": w[10],
            "sodRecordOffset": record,
            "venueXml": {"ID": int(xml[0]["ID"]), "name": xml[0]["name"], "dispname": xml[0]["dispname"]},
        })
    in_sod = {v["venueXml"]["ID"] for v in venues}
    excluded = [{"ID": int(r["ID"]), "name": r["name"], "dispname": r["dispname"], "file": r["filename"]}
                for r in venue_xml if r["name"].startswith("ARENA_") and int(r["ID"]) not in in_sod]
    return {
        "format": FORMAT,
        "serial": SERIAL,
        "disc": {"size": DISC_SIZE, "sha1": DISC_SHA1},
        "sources": [source(entries, files, n) for n in (ELF_PATH, SOD_PATH, "/FIGHTER.XML", "/VENUE.XML")],
        "handleRule": "(SOD class index << 24) | position in the class's primary index; bit 23 masked on compare",
        "fighterClass": {"hash": f"0x{fcls.hash:08X}", "index": fcls.index, "count": fcls.count},
        "venueClass": {"hash": f"0x{vcls.hash:08X}", "index": vcls.index, "count": vcls.count},
        "fighters": fighters,
        "venues": venues,
        "venueXmlArenasNotInSod": excluded,
    }


def build_patch(inv):
    fc, vc = inv["fighterClass"], inv["venueClass"]
    if fc["count"] > FIGHTER_CAPACITY or vc["count"] > VENUE_CAPACITY:
        raise ValueError("handle count exceeds the profile set capacity")
    fill, wraps, wrappers = assemble(fc["index"], fc["count"], vc["index"], vc["count"])
    words = [(FILL_AT + 4 * i, w, "fill routine") for i, w in enumerate(fill)]
    words += [(WRAP_AT + 4 * i, w, "binding wrappers") for i, w in enumerate(wraps)]
    words += [(slot + 4, wrappers[name], f"{name} -> wrapper") for name, (slot, _) in BINDINGS.items()]
    return fill, wraps, wrappers, words


def patch_manifest(iso):
    inv = inventory(iso)
    files, _ = read_disc(iso)
    elf = Elf(files[ELF_PATH])
    for name, (slot, handler) in BINDINGS.items():
        if elf.word(slot) != 0xFFFF0000 or elf.word(slot + 4) != handler:
            raise ValueError(f"{name}: binding slot {slot:#x} does not hold {handler:#x}")
    _, _, wrappers, words = build_patch(inv)
    return inv, {
        "format": FORMAT,
        "serial": SERIAL,
        "executable": EXECUTABLE,
        "elfSha256": ELF_SHA256,
        "description": "Every SOD fighter and venue handle is merged into the profile unlock sets "
                       "whenever an unlock binding runs.",
        "unlocks": {"fighters": inv["fighterClass"]["count"], "venues": inv["venueClass"]["count"],
                    "fighterHandles": [inv["fighters"][0]["handle"], inv["fighters"][-1]["handle"]],
                    "venueHandles": [inv["venues"][0]["handle"], inv["venues"][-1]["handle"]]},
        "profile": {"registry": f"0x{PROFILE_REGISTRY:08X}", "slot": PROFILE_SLOT,
                    "pointerChain": "R = [[0x003FDB00] + 4]",
                    "venueSet": f"R+0x{VENUE_SET:X}", "fighterSet": f"R+0x{FIGHTER_SET:X}",
                    "setLayout": ["capacity", "count", "countMirrorPointer", "dataPointer"]},
        "signatures": [{"address": f"0x{a:08X}", "word": f"0x{w:08X}", "meaning": m} for a, w, m in SIGNATURES],
        "wrappers": {name: f"0x{address:08X}" for name, address in wrappers.items()},
        # Retail bytes are not stored; unlock-disc-patch.json carries the SHA-256 of every range.
        "patches": [{"address": f"0x{a:08X}", "value": f"0x{v:08X}", "what": what} for a, v, what in words],
    }


OVERLAY_FORMAT = "def-jam-ps2-battle-patch/1"  # the read-time range format ps2/battle/overlay.mjs applies


def disc_manifest(iso, manifest):
    """The same patch words as ISO byte ranges, for a read-time disc overlay (any emulator)."""
    files, entries = read_disc(iso)
    elf, (elf_offset, _) = files[ELF_PATH], entries[ELF_PATH]
    words = sorted((int(p["address"], 16), int(p["value"], 16)) for p in manifest["patches"])
    runs = []
    for address, value in words:
        if runs and runs[-1][0] + 4 * len(runs[-1][1]) == address:
            runs[-1][1].append(value)
        else:
            runs.append((address, [value]))
    patches = []
    for address, values in runs:
        file_offset = address - ELF_VADDR + ELF_FILE_OFFSET
        original = elf[file_offset:file_offset + 4 * len(values)]
        patches.append({
            "id": f"unlocks-{address:08x}",
            "file": ELF_PATH,
            "fileOffset": file_offset,
            "isoOffset": elf_offset + file_offset,
            "eeAddress": f"0x{address:08X}",
            "originalSha256": hashlib.sha256(original).hexdigest(),
            "replacement": b"".join(struct.pack("<I", v) for v in values).hex(),
            "description": "Unlock-all fill routine" if address == FILL_AT else
                           "Unlock binding wrappers" if address == WRAP_AT else "Unlock binding pointer",
        })
    with Disc(iso) as disc:
        volume = disc.volume_id
    return {"format": OVERLAY_FORMAT, "version": 1, "serial": SERIAL,
            "disc": {"size": DISC_SIZE, "sha1": DISC_SHA1, "volumeId": volume, "elfSha256": ELF_SHA256},
            "patches": patches}


def game_config(manifest):
    lines = [f'\t<GameConfig Executable="{manifest["executable"]}" Title="Def Jam: Fight for NY">']
    for p in manifest["patches"]:
        lines.append(f'\t\t<Patch Address="{p["address"]}" Value="{p["value"]}" Description="Unlocks: {p["what"]}" />')
    lines.append("\t</GameConfig>")
    return "<GameConfigs>\n" + "\n".join(lines) + "\n</GameConfigs>\n"


def dump(path, value):
    text = json.dumps(value, indent=2) + "\n" if not isinstance(value, str) else value
    pathlib.Path(path).write_text(text)
    return text


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("command", choices=["inventory", "patch", "verify"])
    parser.add_argument("iso")
    args = parser.parse_args(argv)
    inv, manifest = patch_manifest(args.iso)
    outputs = {HERE / "inventory.json": json.dumps(inv, indent=2) + "\n",
               HERE / "unlock-patch.json": json.dumps(manifest, indent=2) + "\n",
               HERE / "unlock-disc-patch.json": json.dumps(disc_manifest(args.iso, manifest), indent=2) + "\n",
               HERE / "GameConfig.xml": game_config(manifest)}
    if args.command == "verify":
        stale = [p.name for p, text in outputs.items() if not p.exists() or p.read_text() != text]
        if stale:
            sys.exit("stale: " + ", ".join(stale))
        print(f"ok: {len(inv['fighters'])} fighters, {len(inv['venues'])} venues, "
              f"{len(manifest['patches'])} patch words")
        return
    wanted = [HERE / "inventory.json"] if args.command == "inventory" else list(outputs)
    for p in wanted:
        p.write_text(outputs[p])
        print("wrote", p.relative_to(HERE.parent.parent))


if __name__ == "__main__":
    main()
