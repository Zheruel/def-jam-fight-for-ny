"""Tests for the SLUS-21004 unlock inventory and EE patch.

    python3 -m unittest discover -s ps2/content/tests

Disc-backed tests run only when private/ps2/reference.iso is present.
"""

import json
import pathlib
import struct
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
CONTENT = HERE.parent
REPO = CONTENT.parent.parent
ISO = REPO / "private/ps2/reference.iso"
sys.path.insert(0, str(CONTENT))

import unlocks  # noqa: E402


def words(manifest):
    return {int(p["address"], 16): int(p["value"], 16) for p in manifest["patches"]}


class Assembler(unittest.TestCase):
    def setUp(self):
        self.fill, self.wraps, self.wrappers = unlocks.assemble(7, 75, 23, 24)

    def test_fits_in_the_retired_buy_handlers(self):
        self.assertLessEqual(len(self.fill), unlocks.FILL_WORDS)
        self.assertLessEqual(len(self.wraps), unlocks.WRAP_WORDS)

    def test_reads_profile_from_registry_slot(self):
        # lui t0,0x40 ; lw t0,-0x2500(t0)  ->  [0x003FDB00]
        self.assertEqual(self.fill[:2], [0x3C080040, 0x8D08DB00])

    def test_handle_bases_and_counts(self):
        self.assertIn(0x3C0A1700, self.fill)  # lui t2,0x1700  venue class 23
        self.assertIn(0x3C0A0700, self.fill)  # lui t2,0x0700  fighter class 7
        self.assertIn(0x24180017, self.fill)  # addiu t8,zero,23
        self.assertIn(0x2418004A, self.fill)  # addiu t8,zero,74
        self.assertIn(0x296C0018, self.fill)  # slti t4,t3,24  (venue capacity check)
        self.assertIn(0x296C004B, self.fill)  # slti t4,t3,75  (fighter capacity check)

    def test_ends_with_tail_jump_through_t9(self):
        self.assertEqual(self.fill[-2:], [0x03200008, 0x00000000])

    def test_wrappers_load_handler_and_jump_to_fill(self):
        jump = (0x02 << 26) | (unlocks.FILL_AT >> 2)
        self.assertEqual(self.wraps[:2], [0x03E00008, 0x00001025])  # ret0: jr ra ; move v0,zero
        for name, (_, handler) in unlocks.BINDINGS.items():
            index = (self.wrappers[name] - unlocks.WRAP_AT) // 4
            lui, j, addiu = self.wraps[index:index + 3]
            target = unlocks.WRAP_AT if name.startswith("Buy") else handler
            lo = addiu & 0xFFFF
            value = ((lui & 0xFFFF) << 16) + (lo - 0x10000 if lo & 0x8000 else lo)
            self.assertEqual(j, jump, name)
            self.assertEqual(value & 0xFFFFFFFF, target, name)

    def test_branches_stay_inside_the_routine(self):
        for i, word in enumerate(self.fill):
            op = word >> 26
            if op in (0x01, 0x04, 0x05, 0x07):
                offset = word & 0xFFFF
                offset = offset - 0x10000 if offset & 0x8000 else offset
                dest = i + 1 + offset
                self.assertTrue(0 <= dest < len(self.fill), f"word {i}")


class CheckedInOutputs(unittest.TestCase):
    def test_manifests_agree(self):
        manifest = json.loads((CONTENT / "unlock-patch.json").read_text())
        disc = json.loads((CONTENT / "unlock-disc-patch.json").read_text())
        expected = words(manifest)
        got = {}
        for patch in disc["patches"]:
            data = bytes.fromhex(patch["replacement"])
            base = int(patch["eeAddress"], 16)
            self.assertEqual(patch["fileOffset"], base - unlocks.ELF_VADDR + unlocks.ELF_FILE_OFFSET)
            for i in range(0, len(data), 4):
                got[base + i] = struct.unpack_from("<I", data, i)[0]
        self.assertEqual(got, expected)

    def test_game_config_matches_manifest(self):
        manifest = json.loads((CONTENT / "unlock-patch.json").read_text())
        self.assertEqual((CONTENT / "GameConfig.xml").read_text(), unlocks.game_config(manifest))

    def test_inventory_handles(self):
        inv = json.loads((CONTENT / "inventory.json").read_text())
        self.assertEqual(len(inv["fighters"]), 75)
        self.assertEqual(len(inv["venues"]), 24)
        self.assertEqual([int(f["handle"], 16) for f in inv["fighters"]], [0x07000000 + i for i in range(75)])
        self.assertEqual([int(v["handle"], 16) for v in inv["venues"]], [0x17000000 + i for i in range(24)])
        self.assertEqual(len({f["model"] for f in inv["fighters"]}), 75)
        hidden = sorted(f["key"] for f in inv["fighters"] if not f["listed"])
        self.assertEqual(hidden, ["Blaze 2", "Blaze 3", "D-Mob 2", "D-Mob 3", "E3 Hero", "Sticky 2"])


@unittest.skipUnless(ISO.exists(), "retail disc not present")
class Disc(unittest.TestCase):
    def test_outputs_are_reproducible(self):
        inv, manifest = unlocks.patch_manifest(str(ISO))
        self.assertEqual(json.loads((CONTENT / "inventory.json").read_text()), inv)
        self.assertEqual(json.loads((CONTENT / "unlock-patch.json").read_text()), manifest)
        self.assertEqual(json.loads((CONTENT / "unlock-disc-patch.json").read_text()),
                         unlocks.disc_manifest(str(ISO), manifest))

    def test_patch_only_touches_retired_code_and_binding_slots(self):
        _, manifest = unlocks.patch_manifest(str(ISO))
        slots = {slot + 4 for slot, _ in unlocks.BINDINGS.values()}
        for address in words(manifest):
            in_fill = unlocks.FILL_AT <= address < unlocks.FILL_AT + 4 * unlocks.FILL_WORDS
            in_wrap = unlocks.WRAP_AT <= address < unlocks.WRAP_AT + 4 * unlocks.WRAP_WORDS
            self.assertTrue(in_fill or in_wrap or address in slots, hex(address))


if __name__ == "__main__":
    unittest.main()
