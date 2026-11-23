import gzip
import hashlib
import json
from pathlib import Path
import unittest

import extract

HERE = Path(__file__).resolve().parent
FOUNDATION = HERE / "foundation"


class SceneryTests(unittest.TestCase):
    def test_manifest_hashes_and_counts(self):
        scenery = json.loads((FOUNDATION / "scenery.json").read_text())
        self.assertEqual(scenery["venue"], "V2BG_02A")
        self.assertEqual(len(scenery["props"]), 8)
        self.assertEqual(len(scenery["nearCrowd"]), 30)
        self.assertEqual(scenery["instancedCrowd"]["instances"], 60)
        self.assertEqual(scenery["undecodedProps"], [])
        for name, digest in scenery["sources"]["sha256"].items():
            self.assertEqual(len(digest), 64, name)

    def test_checked_in_files_match_a_fresh_extraction_when_the_disc_is_present(self):
        if not extract.DEFAULT_ISO.exists():
            self.skipTest("retail disc image not present")
        self.assertEqual(extract.main(["--check"]), 0)


if __name__ == "__main__":
    unittest.main()
