"""Battle-only patch for Def Jam: Fight for NY, US PS2 (SLUS-21004).

Nothing from the disc is stored in this repository. Patches are either hand-written bytes
placed at a fixed offset (BytesPatch), or same-size string edits inside RefPack-compressed
front-end screens (VivStringPatch), which are computed from the retail disc when a manifest
or an image is built. Retail bytes are only ever recorded as SHA-256 hashes.

    python3 ps2/battle/battle_patch.py verify   private/ps2/reference.iso
    python3 ps2/battle/battle_patch.py manifest private/ps2/reference.iso
    python3 ps2/battle/battle_patch.py build    private/ps2/reference.iso private/ps2-battle/battle.iso

`manifest` writes private/ps2-battle/battle-patch.json: absolute ISO byte ranges with the
retail hash and the patched bytes, which overlay.mjs applies to disc reads in the browser.
`build` clones the ISO (an APFS copy-on-write clone where available, so it costs almost no
space), writes the same ranges into the clone and verifies it. The retail ISO is never
opened for writing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refpack  # noqa: E402
from iso9660 import Iso9660  # noqa: E402

FORMAT = "def-jam-ps2-battle-patch/1"
VERSION = 2
HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_ISO = REPO / "private/ps2/reference.iso"
DEFAULT_MANIFEST = REPO / "private/ps2-battle/battle-patch.json"

# Retail US disc (Redump-verified; see private/ps2/reference.json).
SERIAL = "SLUS-21004"
DISC_SIZE = 4_694_573_056
DISC_SHA1 = "5eda39dfd703804c8734b91bd23039f642317837"
VOLUME_ID = "DJFFNY"
ELF_PATH = "/SLUS_210.04"
ELF_SHA256 = "4e65bf2947b3838ce372967cac448bfc8034709a6d70a87fd11d13c5f09b23b2"
FEFLOW_PATH = "/SCREENS/FEFLOW.XML"
FEFLOW_SHA256 = "56316affe9a26f9fd33a004f15db9cad181f76493fb64df8d0fb4187272be61c"
SCREENS_PATH = "/SCREENS/SCREENS.VIV"

# SLUS_210.04 has a single PT_LOAD segment: file offset 0x1000 -> vaddr 0x100000.
ELF_LOAD_DELTA = 0x100000 - 0x1000


@dataclass(frozen=True)
class BytesPatch:
    """Hand-written bytes at a fixed offset inside a disc file."""
    id: str
    file: str
    offset: int
    original_sha256: str
    replacement: bytes
    description: str


@dataclass(frozen=True)
class VivStringPatch:
    """Same-size string edits inside one RefPack-compressed entry of a .VIV archive."""
    id: str
    file: str
    entry: str
    entry_sha256: str  # retail compressed entry
    edits: tuple[tuple[bytes, bytes], ...]
    patched_entry_sha256: str  # pins the deterministic re-encoding
    description: str


def elf_offset(vaddr: int) -> int:
    return vaddr - ELF_LOAD_DELTA


def words(*values: int) -> bytes:
    return struct.pack("<%dI" % len(values), *values)


def xml_transition(to: str, between: str, userdata: int, kind: int, length: int) -> bytes:
    """A FEFLOW <transition> body, padded with spaces to exactly `length` bytes."""
    body = (f"<to>{to}</to>\r\n\t\t\t\t<between>{between}</between>\r\n\t\t\t\t"
            f"<userdata>{userdata}</userdata>\r\n\t\t\t\t<type>{kind}</type>\r\n\t\t\t\t"
            f"<class>0</class>").encode("ascii")
    if len(body) > length:
        raise ValueError(f"transition to {to} does not fit in {length} bytes")
    return body + b" " * (length - len(body))


def swf_name(name: str, length: int) -> bytes:
    """An APT string constant: the name, NUL-padded to the length of the one it replaces."""
    data = name.encode("ascii")
    if len(data) > length:
        raise ValueError(f"{name} is longer than {length} bytes")
    return data + b"\0" * (length - len(data))


PATCHES: list[BytesPatch | VivStringPatch] = [
    # Title screen. Its ActionScript ends the bootup memory-card check with
    # _parent.transitionStart("intMain/mainMenu.swf"); the transition is looked up by name in
    # FEFLOW.XML, so both the request and the flow entry have to name the new screen.
    VivStringPatch(
        id="title-requests-battle",
        file=SCREENS_PATH,
        entry="screens/intMain/prestart.big",
        entry_sha256="e2217840019e2c8575bb6e109eb25c688006a222d4c6876a6a1bbf30547be13a",
        edits=((b"intMain/mainMenu.swf", swf_name("battle/cmtype.swf", 20)),),
        patched_entry_sha256="22514f983290d8e2268ff89c6a405316ebff4e001267a1accd5ffbd375fcd79f",
        description="Title screen asks for battle/cmtype.swf instead of the main menu.",
    ),
    BytesPatch(
        id="feflow-title-to-battle",
        file=FEFLOW_PATH,
        offset=867,  # the <to>..</class> body of intMain/preStart's only transition
        original_sha256="62ee3b5a5162b7fa1f7d39036f98e7a3d69db09bc9e110f18901d10c28c1a004",
        replacement=xml_transition("battle/cmtype", "trans/t1", 2514, 2, 998 - 867),
        description="FEFLOW: the title screen's transition leads to Battle > match type.",
    ),
]


# ----------------------------------------------------------------------------- engine

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class Range:
    id: str
    file: str
    file_offset: int
    iso_offset: int
    original_sha256: str
    replacement: bytes
    description: str


@dataclass
class Disc:
    """An open ISO plus helpers to read inside its files."""
    path: str
    iso: Iso9660 = field(init=False)

    def __post_init__(self) -> None:
        self.iso = Iso9660(self.path)

    def close(self) -> None:
        self.iso.close()

    def read(self, file: str, offset: int, size: int) -> bytes:
        entry = self.iso.entry(file)
        if offset < 0 or offset + size > entry.size:
            raise ValueError(f"read outside {file}")
        with open(self.path, "rb") as f:
            f.seek(entry.offset + offset)
            return f.read(size)

    def viv_entry(self, file: str, name: str) -> tuple[int, int]:
        """(offset, size) of an archive member, relative to the .VIV file."""
        head = self.read(file, 0, 16)
        if head[:4] not in (b"BIGF", b"BIG4"):
            raise ValueError(f"{file}: not a BIG archive")
        count, header_size = struct.unpack_from(">II", head, 8)
        table = self.read(file, 0, header_size)
        pos = 16
        for _ in range(count):
            offset, size = struct.unpack_from(">II", table, pos)
            end = table.index(b"\0", pos + 8)
            if table[pos + 8:end].decode("latin-1") == name:
                return offset, size
            pos = end + 1
        raise FileNotFoundError(f"{file}: no member {name}")


def patched_viv_blob(patch: VivStringPatch, blob: bytes) -> bytes:
    for old, new in patch.edits:
        blob = refpack.patch_same_size(blob, old, new)
    return blob


def resolve(disc: Disc) -> list[Range]:
    """The byte ranges the patches change, computed from a retail disc."""
    ranges = []
    for patch in PATCHES:
        base = disc.iso.entry(patch.file).offset
        if isinstance(patch, BytesPatch):
            original = disc.read(patch.file, patch.offset, len(patch.replacement))
            if sha256(original) != patch.original_sha256:
                raise ValueError(f"{patch.id}: {patch.file} is not retail at {patch.offset}")
            ranges.append(Range(patch.id, patch.file, patch.offset, base + patch.offset,
                                patch.original_sha256, patch.replacement, patch.description))
            continue
        offset, size = disc.viv_entry(patch.file, patch.entry)
        blob = disc.read(patch.file, offset, size)
        if sha256(blob) != patch.entry_sha256:
            raise ValueError(f"{patch.id}: {patch.entry} is not retail")
        new = patched_viv_blob(patch, blob)
        if patch.patched_entry_sha256 and sha256(new) != patch.patched_entry_sha256:
            raise ValueError(f"{patch.id}: re-encoding changed (got {sha256(new)})")
        changed = [i for i, (a, b) in enumerate(zip(blob, new)) if a != b]
        first, last = changed[0], changed[-1] + 1
        ranges.append(Range(patch.id, patch.file, offset + first, base + offset + first,
                            sha256(blob[first:last]), new[first:last], patch.description))
    ranges.sort(key=lambda r: r.iso_offset)
    for a, b in zip(ranges, ranges[1:]):
        if a.iso_offset + len(a.replacement) > b.iso_offset:
            raise ValueError(f"patches {a.id} and {b.id} overlap")
    return ranges


def check_identity(disc: Disc) -> None:
    if os.path.getsize(disc.path) != DISC_SIZE:
        raise ValueError(f"{disc.path}: {os.path.getsize(disc.path)} bytes is not the US PS2 disc ({DISC_SIZE})")
    if disc.iso.volume_id != VOLUME_ID:
        raise ValueError(f"{disc.path}: volume {disc.iso.volume_id!r} is not {VOLUME_ID}")


def patch_state(disc: Disc, patch: BytesPatch | VivStringPatch) -> str:
    if isinstance(patch, BytesPatch):
        current = disc.read(patch.file, patch.offset, len(patch.replacement))
        if sha256(current) == patch.original_sha256:
            return "retail"
        return "patched" if current == patch.replacement else "unknown"
    offset, size = disc.viv_entry(patch.file, patch.entry)
    digest = sha256(disc.read(patch.file, offset, size))
    if digest == patch.entry_sha256:
        return "retail"
    return "patched" if digest == patch.patched_entry_sha256 else "unknown"


def state(path: str) -> str:
    """'retail', 'patched' or 'mixed'; raises if the image is not SLUS-21004."""
    disc = Disc(path)
    try:
        check_identity(disc)
        states = {p.id: patch_state(disc, p) for p in PATCHES}
        unknown = [k for k, v in states.items() if v == "unknown"]
        if unknown:
            raise ValueError(f"{path}: unexpected bytes for {', '.join(unknown)}")
        found = set(states.values())
        if sha256(disc.iso.read(ELF_PATH)) != ELF_SHA256 and not any(
                isinstance(p, BytesPatch) and p.file == ELF_PATH for p in PATCHES):
            raise ValueError(f"{path}: {ELF_PATH} is not the retail executable")
        return found.pop() if len(found) == 1 else "mixed"
    finally:
        disc.close()


def manifest(path: str) -> dict:
    disc = Disc(path)
    try:
        check_identity(disc)
        if sha256(disc.iso.read(ELF_PATH)) != ELF_SHA256:
            raise ValueError(f"{path}: {ELF_PATH} is not the retail executable")
        if sha256(disc.iso.read(FEFLOW_PATH)) != FEFLOW_SHA256:
            raise ValueError(f"{path}: {FEFLOW_PATH} is not retail")
        ranges = resolve(disc)
    finally:
        disc.close()
    return {
        "format": FORMAT,
        "version": VERSION,
        "serial": SERIAL,
        "disc": {"size": DISC_SIZE, "sha1": DISC_SHA1, "volumeId": VOLUME_ID, "elfSha256": ELF_SHA256},
        "patches": [{
            "id": r.id,
            "file": r.file,
            "fileOffset": r.file_offset,
            "isoOffset": r.iso_offset,
            "originalSha256": r.original_sha256,
            "replacement": r.replacement.hex(),
            "description": r.description,
        } for r in ranges],
    }


def clone(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    if os.path.exists(dst):
        os.remove(dst)
    if sys.platform == "darwin":
        # APFS clonefile: copy-on-write, so the derived ISO shares the retail blocks.
        if subprocess.run(["cp", "-c", src, dst], capture_output=True).returncode == 0:
            return
    shutil.copyfile(src, dst)


def write_ranges(path: str, data: dict) -> None:
    with open(path, "r+b") as f:
        for p in data["patches"]:
            f.seek(p["isoOffset"])
            f.write(bytes.fromhex(p["replacement"]))


def build(iso: str, out: str) -> dict:
    if os.path.realpath(iso) == os.path.realpath(out):
        raise ValueError("refusing to patch the retail ISO in place")
    data = manifest(iso)
    tmp = out + ".partial"
    clone(iso, tmp)
    os.chmod(tmp, 0o600)
    write_ranges(tmp, data)
    if state(tmp) != "patched":
        os.remove(tmp)
        raise RuntimeError("patched image failed verification")
    os.replace(tmp, out)
    pathlib.Path(out + ".json").write_text(json.dumps(data, indent=2) + "\n")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("verify", help="print retail, patched or mixed")
    p.add_argument("iso", nargs="?", default=str(DEFAULT_ISO))
    p = sub.add_parser("manifest", help="write the overlay manifest from the retail ISO")
    p.add_argument("iso", nargs="?", default=str(DEFAULT_ISO))
    p.add_argument("--output", default=str(DEFAULT_MANIFEST))
    p = sub.add_parser("build", help="write a patched copy of the retail ISO")
    p.add_argument("iso")
    p.add_argument("output")
    args = parser.parse_args(argv)
    try:
        if args.command == "verify":
            print(state(args.iso))
        elif args.command == "manifest":
            os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
            pathlib.Path(args.output).write_text(json.dumps(manifest(args.iso), indent=2) + "\n")
            print(args.output)
        else:
            build(args.iso, args.output)
            print(args.output)
    except (ValueError, RuntimeError, FileNotFoundError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
