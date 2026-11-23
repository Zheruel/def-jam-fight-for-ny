"""Tests for the Battle-only patch.

    python3 -m unittest discover -s ps2/battle/tests

The synthetic tests always run. The retail tests need private/ps2/reference.iso (the
verified US disc) and are skipped without it; set BATTLE_BUILD_ISO=1 to also build and
check a derived image under private/ps2-battle/ (an APFS clone, so nearly free on macOS).
"""

from __future__ import annotations

import io
import json
import os
import pathlib
import re
import struct
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import battle_patch as bp  # noqa: E402
import refpack  # noqa: E402
from iso9660 import SECTOR, Iso9660  # noqa: E402

RETAIL = bp.DEFAULT_ISO
HAVE_RETAIL = RETAIL.is_file() and RETAIL.stat().st_size == bp.DISC_SIZE


# ------------------------------------------------------------------ synthetic fixtures

def literal_run(data: bytes) -> bytes:
    assert len(data) % 4 == 0 and 4 <= len(data) <= 112
    return bytes([0xE0 + len(data) // 4 - 1]) + data


def refpack_stream(*parts: bytes, size: int) -> bytes:
    return bytes([0x10, 0xFB]) + size.to_bytes(3, "big") + b"".join(parts) + b"\xFC"


def dir_record(name: bytes, lba: int, size: int, directory: bool) -> bytes:
    length = 33 + len(name) + (len(name) + 1) % 2
    record = bytearray(length)
    record[0] = length
    struct.pack_into("<I", record, 2, lba)
    struct.pack_into(">I", record, 6, lba)
    struct.pack_into("<I", record, 10, size)
    struct.pack_into(">I", record, 14, size)
    record[25] = 2 if directory else 0
    record[32] = len(name)
    record[33:33 + len(name)] = name
    return bytes(record)


def tiny_iso(files: dict[str, bytes]) -> bytes:
    """An ISO9660 image with a root directory holding `files` (one level)."""
    root_lba, data_lba = 18, 19
    entries, blobs, lba = [], [], data_lba
    for name, data in files.items():
        entries.append(dir_record(name.encode() + b";1", lba, len(data), False))
        blobs.append((lba, data))
        lba += max(1, -(-len(data) // SECTOR))
    root = dir_record(b"\0", root_lba, SECTOR, True) + dir_record(b"\1", root_lba, SECTOR, True) + b"".join(entries)
    image = bytearray(lba * SECTOR)
    pvd = bytearray(SECTOR)
    pvd[0], pvd[1:6], pvd[6] = 1, b"CD001", 1
    pvd[40:72] = b"TESTDISC".ljust(32)
    struct.pack_into("<I", pvd, 80, lba)
    pvd[156:156 + 34] = dir_record(b"\0", root_lba, SECTOR, True)
    image[16 * SECTOR:17 * SECTOR] = pvd
    image[17 * SECTOR] = 255  # terminator
    image[root_lba * SECTOR:root_lba * SECTOR + len(root)] = root
    for at, data in blobs:
        image[at * SECTOR:at * SECTOR + len(data)] = data
    return bytes(image)


class RefPackTests(unittest.TestCase):
    def setUp(self) -> None:
        # "intMain/mainMenu.swf" (20 bytes of literals), padding, then a 2-byte copy of
        # 8 bytes ("intMain/") from 24 bytes back, then more literals.
        self.text = b"intMain/mainMenu.swf\0\0\0\0intMain/preStart.swf"
        self.blob = refpack_stream(
            literal_run(self.text[:24]),
            bytes([((24 - 1) >> 8) << 5 | (8 - 3) << 2 | 0, (24 - 1) & 0xFF]),
            literal_run(b"preStart.swf"),
            size=len(self.text),
        )

    def test_decompress(self) -> None:
        self.assertEqual(refpack.decompress(self.blob), self.text)

    def test_same_size_patch_repairs_later_copies(self) -> None:
        new = refpack.patch_same_size(self.blob, b"intMain/mainMenu.swf", b"battle/cmtype.swf\0\0\0")
        self.assertEqual(len(new), len(self.blob))
        # The copy of "intMain/" that followed must still decode to "intMain/".
        self.assertEqual(refpack.decompress(new),
                         b"battle/cmtype.swf\0\0\0\0\0\0\0intMain/preStart.swf")

    def test_rejects_length_change_and_ambiguity(self) -> None:
        with self.assertRaises(ValueError):
            refpack.patch_same_size(self.blob, b"intMain", b"main")
        with self.assertRaises(ValueError):
            refpack.patch_same_size(self.blob, b"intMain/", b"INTMAIN/")  # occurs twice

    def test_rejects_non_refpack(self) -> None:
        with self.assertRaises(ValueError):
            refpack.commands(b"BIGF\0\0\0\0")


class Iso9660Tests(unittest.TestCase):
    def test_locates_and_reads_files(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".iso") as f:
            f.write(tiny_iso({"SYSTEM.CNF": b"BOOT2 = cdrom0:\\X;1\n", "DATA.BIN": bytes(range(256)) * 9}))
            f.flush()
            with Iso9660(f.name) as disc:
                self.assertEqual(disc.volume_id, "TESTDISC")
                self.assertEqual(disc.paths(), ["/DATA.BIN", "/SYSTEM.CNF"])
                self.assertEqual(disc.read("/system.cnf;1"), b"BOOT2 = cdrom0:\\X;1\n")
                entry = disc.entry("/DATA.BIN")
                self.assertEqual(entry.size, 2304)
                self.assertEqual(entry.offset % SECTOR, 0)
                with self.assertRaises(FileNotFoundError):
                    disc.entry("/MISSING")

    def test_rejects_non_iso(self) -> None:
        with tempfile.NamedTemporaryFile() as f:
            f.write(bytes(18 * SECTOR))
            f.flush()
            with self.assertRaises(ValueError):
                Iso9660(f.name)


class PatchDefinitionTests(unittest.TestCase):
    def test_xml_transition_keeps_length(self) -> None:
        body = bp.xml_transition("battle/cmtype", "trans/t1", 2514, 2, 131)
        self.assertEqual(len(body), 131)
        self.assertTrue(body.startswith(b"<to>battle/cmtype</to>\r\n"))
        with self.assertRaises(ValueError):
            bp.xml_transition("x" * 200, "trans/t1", 0, 0, 131)

    def test_jal_encoding(self) -> None:
        self.assertEqual(bp.jal(0x135A48), 0x0C04D692)
        self.assertEqual(bp.jal(0x101EF8), 0x0C0407BE)  # as in retail ResetMatchTypeList
        with self.assertRaises(ValueError):
            bp.jal(0x135A4A)

    def test_patches_are_well_formed(self) -> None:
        ids = [p.id for p in bp.PATCHES]
        self.assertEqual(len(ids), len(set(ids)))
        for p in bp.PATCHES:
            if isinstance(p, bp.BytesPatch):
                self.assertRegex(p.original_sha256, r"^[0-9a-f]{64}$")
                self.assertTrue(p.replacement)
            else:
                self.assertRegex(p.entry_sha256, r"^[0-9a-f]{64}$")
                self.assertRegex(p.patched_entry_sha256, r"^[0-9a-f]{64}$")
                for old, new in p.edits:
                    self.assertEqual(len(old), len(new))

    def test_elf_patch_only_reorders_retail_lookups(self) -> None:
        patch = next(p for p in bp.PATCHES if p.id == "match-types-start-battle-mode")
        got = struct.unpack("<6I", patch.replacement)
        # Same instructions as retail except the first lookup became jal StartBattleMode.
        self.assertEqual(got, (0x0C04D692, 0x0000882D, 0x0200202D, 0x0C0407BE, 0x24050018, 0x8C540004))
        self.assertEqual(patch.offset, 0x138108 - 0x100000 + 0x1000)


def flow(text: bytes) -> dict[str, list[str]]:
    """FEFLOW screens and the targets of their transitions, in order."""
    out = {}
    for block in re.findall(rb"<screen>(.*?)</screen>", text, re.S):
        name = re.search(rb"<name>(.*?)</name>", block).group(1).decode()
        out[name] = [t.decode() for t in re.findall(rb"<to>(.*?)</to>", block)]
    return out


@unittest.skipUnless(HAVE_RETAIL, "needs private/ps2/reference.iso (retail SLUS-21004)")
class RetailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = bp.manifest(str(RETAIL))

    def test_retail_disc_is_unpatched(self) -> None:
        self.assertEqual(bp.state(str(RETAIL)), "retail")

    def test_manifest_ranges(self) -> None:
        m = self.manifest
        self.assertEqual(m["format"], bp.FORMAT)
        self.assertEqual(m["disc"]["size"], bp.DISC_SIZE)
        by_id = {p["id"]: p for p in m["patches"]}
        self.assertEqual(set(by_id), {p.id for p in bp.PATCHES})
        self.assertEqual(by_id["match-types-start-battle-mode"]["isoOffset"], 3976171784)
        self.assertEqual(by_id["title-requests-battle"]["isoOffset"], 3750507318)
        offsets = [p["isoOffset"] for p in m["patches"]]
        self.assertEqual(offsets, sorted(offsets))
        with open(RETAIL, "rb") as f:
            for p in m["patches"]:
                f.seek(p["isoOffset"])
                original = f.read(len(p["replacement"]) // 2)
                self.assertEqual(bp.sha256(original), p["originalSha256"], p["id"])
                self.assertNotEqual(original.hex(), p["replacement"], p["id"])

    def test_patched_files(self) -> None:
        """Apply the manifest to the affected files in memory and inspect the results."""
        disc = bp.Disc(str(RETAIL))
        try:
            files = {}
            for p in self.manifest["patches"]:
                if p["file"] not in files:
                    files[p["file"]] = bytearray(disc.iso.read(p["file"]))
                data = bytes.fromhex(p["replacement"])
                files[p["file"]][p["fileOffset"]:p["fileOffset"] + len(data)] = data
            screens = files[bp.SCREENS_PATH]

            def member(name: str) -> bytes:
                offset, size = disc.viv_entry(bp.SCREENS_PATH, name)
                return refpack.decompress(bytes(screens[offset:offset + size]))

            def retail_member(name: str) -> bytes:
                offset, size = disc.viv_entry(bp.SCREENS_PATH, name)
                return refpack.decompress(disc.read(bp.SCREENS_PATH, offset, size))
        finally:
            disc.close()

        flows = flow(bytes(files[bp.FEFLOW_PATH]))
        self.assertEqual(flows["intMain/preStart"], ["battle/cmtype"])
        self.assertEqual(flows["battle/cmtype"],
                         ["options/battleID", "battle/chooseF2", "options/userID", "intMain/preStart"])
        self.assertEqual(len(files[bp.FEFLOW_PATH]), 26988)

        for name, old, new in (
                ("screens/intMain/prestart.big", b"intMain/mainMenu.swf", b"battle/cmtype.swf\0\0\0"),
                ("screens/battle/cmtype.big", b"intMain/mainMenu.swf", b"intMain/preStart.swf")):
            before, after = retail_member(name), member(name)
            self.assertEqual(after, before.replace(old, new), name)  # nothing else changed
            self.assertNotIn(b"intMain/mainMenu.swf", after)

        elf = files[bp.ELF_PATH]
        at = bp.elf_offset(0x138108)
        self.assertEqual(struct.unpack_from("<I", elf, at)[0], bp.jal(0x135A48))
        # Retail StartBattleMode prologue is untouched: it is the function being called.
        self.assertEqual(struct.unpack_from("<2I", elf, bp.elf_offset(0x135A48)), (0x27BDFFE0, 0x3C040040))

    def test_mixed_state_is_reported(self) -> None:
        """A disc with only part of the patch is 'mixed' (built on a sparse clone)."""
        if not os.environ.get("BATTLE_BUILD_ISO"):
            self.skipTest("set BATTLE_BUILD_ISO=1 to clone the 4.7 GB image")
        out = bp.REPO / "private/ps2-battle/test-mixed.iso"
        try:
            bp.clone(str(RETAIL), str(out))
            first = dict(self.manifest, patches=self.manifest["patches"][:1])
            bp.write_ranges(str(out), first)
            self.assertEqual(bp.state(str(out)), "mixed")
        finally:
            out.unlink(missing_ok=True)

    def test_build_derived_iso(self) -> None:
        if not os.environ.get("BATTLE_BUILD_ISO"):
            self.skipTest("set BATTLE_BUILD_ISO=1 to clone the 4.7 GB image")
        out = bp.REPO / "private/ps2-battle/test-battle.iso"
        try:
            bp.build(str(RETAIL), str(out))
            self.assertEqual(bp.state(str(out)), "patched")
            self.assertEqual(bp.state(str(RETAIL)), "retail")
            saved = json.loads(pathlib.Path(str(out) + ".json").read_text())
            self.assertEqual(saved, self.manifest)
            with open(out, "rb") as f:
                for p in saved["patches"]:
                    f.seek(p["isoOffset"])
                    self.assertEqual(f.read(len(p["replacement"]) // 2).hex(), p["replacement"])
            with self.assertRaises(ValueError):
                bp.manifest(str(out))  # a manifest must come from the retail disc
            with self.assertRaises(ValueError):
                bp.build(str(RETAIL), str(RETAIL))
        finally:
            out.unlink(missing_ok=True)
            pathlib.Path(str(out) + ".json").unlink(missing_ok=True)


class CliTests(unittest.TestCase):
    def test_verify_rejects_other_discs(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".iso") as f:
            f.write(tiny_iso({"SYSTEM.CNF": b"x"}))
            f.flush()
            stderr = io.StringIO()
            old, sys.stderr = sys.stderr, stderr
            try:
                self.assertEqual(bp.main(["verify", f.name]), 1)
            finally:
                sys.stderr = old
            self.assertIn("is not the US PS2 disc", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
