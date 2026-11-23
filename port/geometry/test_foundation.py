import json
import math
import struct
import unittest

from foundation import HERE, OUTPUT, decode, encode, from_disc, triangle_indices


RETAIL_ISO = HERE.parents[1] / "private" / "ps2" / "reference.iso"


class FoundationGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.asset = json.loads(OUTPUT.read_text(encoding="utf-8"))

    def test_strip_boundary_restarts_winding(self):
        self.assertEqual(
            triangle_indices(10, [0, 4, 8]),
            [10, 11, 12, 12, 11, 13, 14, 15, 16, 16, 15, 17],
        )

    def test_published_mesh_is_safe_to_index(self):
        asset = self.asset
        counts = asset["counts"]
        self.assertEqual(counts, {"packets": 179, "strips": 1954, "vertices": 8538, "triangles": 4630})
        self.assertEqual(len(asset["positions"]), counts["vertices"] * 3)
        self.assertEqual(len(asset["texcoords"]), counts["vertices"] * 2)
        self.assertEqual(len(asset["colors"]), counts["vertices"] * 4)
        self.assertEqual(len(asset["indices"]), counts["triangles"] * 3)
        self.assertEqual(counts["triangles"], counts["vertices"] - 2 * counts["strips"])
        self.assertEqual(min(asset["indices"]), 0)
        self.assertEqual(max(asset["indices"]), counts["vertices"] - 1)
        self.assertTrue(all(math.isfinite(value) for value in asset["positions"] + asset["texcoords"]))
        self.assertTrue(all(0 <= value <= 128 for value in asset["colors"]))
        self.assertEqual(set(asset["colors"][3::4]), {128})
        for i in range(3):
            axis = asset["positions"][i::3]
            self.assertEqual(asset["bounds"]["min"][i], min(axis))
            self.assertEqual(asset["bounds"]["max"][i], max(axis))

    def test_first_retail_strip_and_color(self):
        asset = self.asset
        self.assertEqual(
            struct.pack("<3f", *asset["positions"][:3]),
            bytes.fromhex("d133b9c1 21566841 19d29bc2"),
        )
        self.assertEqual(
            struct.pack("<2f", *asset["texcoords"][:2]),
            bytes.fromhex("3e909f3d 7f042a3f"),
        )
        self.assertEqual(asset["indices"][:12], [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5])
        self.assertEqual(asset["indices"][18:24], [8, 9, 10, 10, 9, 11])
        self.assertEqual(asset["colors"][:4], [28, 26, 19, 128])

    def test_invalid_elf_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "ELF32/MIPS"):
            decode(b"BIGF")

    @unittest.skipUnless(RETAIL_ISO.is_file(), "local PS2 retail ISO is unavailable")
    def test_retail_extraction_matches_every_published_byte(self):
        decoded = from_disc(RETAIL_ISO)
        self.assertEqual(encode(decoded), OUTPUT.read_text(encoding="utf-8"))
        for key in ("positions", "texcoords"):
            pattern = f"<{len(decoded[key])}f"
            self.assertEqual(struct.pack(pattern, *self.asset[key]), struct.pack(pattern, *decoded[key]))


if __name__ == "__main__":
    unittest.main()
