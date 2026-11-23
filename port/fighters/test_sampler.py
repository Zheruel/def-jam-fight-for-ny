"""Offline retail sampler regressions (live tests skip without private/fighter-sampler and the BjNMn0 snapshot)."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "sampler"))
import bake  # noqa: E402
import bank  # noqa: E402

SNAPSHOT = HERE.parents[1] / "private" / "verification" / "ps2-match" / "run-BjNMn0" / "fighter-ram-0.bin"
MOTIONS = HERE / "motions"
LIVE = bake.SAMPLER.is_file() and SNAPSHOT.is_file()
# retail 0x132c60(slot, bank, clip) results, i.e. the lengths the actor update uses (slot, bank, engine clip) -> end
DURATIONS = {(0, 0, 11): 67, (0, 0, 16): 65, (0, 0, 62): 29, (0, 0, 66): 12, (0, 0, 69): 35, (0, 0, 72): 21,
             (0, 0, 328): 25, (0, 0, 334): 25, (0, 1, 67): 39, (1, 1, 1069): 54}


def fixture(name):
    return json.loads((MOTIONS / f"fixture-{name}.json").read_text())


class FixtureBankTests(unittest.TestCase):
    def test_bank_ends_are_the_retail_durations(self):
        for name in ("base00", "wres005-blaze", "wres010-doc"):
            index = fixture(name)
            for clip in index["clips"]:
                self.assertEqual(clip["end"], DURATIONS[(index["slot"], index["bank"], clip["local"])], (name, clip["local"]))

    def test_bank_files_are_complete(self):
        for name in ("base00", "wres005-blaze", "wres010-doc"):
            index = fixture(name)
            data = (MOTIONS / f"fixture-{name}.bin").read_bytes()
            self.assertEqual(sum(c["length"] for c in index["clips"]), len(data))
            self.assertEqual(index["format"], bank.FORMAT)


@unittest.skipUnless(LIVE, "private sampler build or snapshot missing")
class RetailDurationTests(unittest.TestCase):
    def test_duration_service_matches_every_fixture_clip(self):
        queries = list(DURATIONS)
        self.assertEqual([int(v) for v in bank.durations(SNAPSHOT, queries)], [DURATIONS[q] for q in queries])

    def test_sampled_poses_stay_unit_scale_and_rooted(self):
        (pose, root), = bake.sample_with_root(SNAPSHOT, [(0, 5.0, 0, 11)])
        driven = [k for k in range(bake.BONES) if k not in bake.HELD]
        self.assertTrue(all(abs(pose[k * bake.ENTRY] - 1) < 1e-5 for k in driven))
        self.assertEqual(len(root), 4)


if __name__ == "__main__":
    unittest.main()
