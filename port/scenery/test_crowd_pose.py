import json
import math
from pathlib import Path
import unittest

import crowd_pose

HERE = Path(__file__).resolve().parent
FIXTURE = json.loads((HERE / "foundation" / "crowd-poses.json").read_text())
MODELS = HERE.parents[1] / "private" / "scenery" / "v2cm"


def entries(rows):
    return [[1, 1, 1, 1, *r[:4], *r[4:7], 1] for r in rows]


class CrowdPoseTests(unittest.TestCase):
    def test_the_rig_is_the_thirteen_bone_crowd_skeleton(self):
        self.assertEqual(FIXTURE["bones"], crowd_pose.BONES)
        self.assertEqual(FIXTURE["parents"], crowd_pose.PARENTS)
        self.assertEqual(len(FIXTURE["bind"]), 13)

    def test_every_instance_is_named_by_the_stage_and_posed_off_the_bind_pose(self):
        scenery = json.loads((HERE / "foundation" / "scenery.json").read_text())
        placed = {p["name"] for p in scenery["nearCrowd"]}
        for frame, instances in FIXTURE["frames"].items():
            self.assertEqual(len(instances), 26, frame)
            self.assertLessEqual(set(instances), placed, frame)
            for name, pose in instances.items():
                self.assertEqual(len(pose), 13)
                moved = max(abs(a - b) for entry, bind in zip(pose, FIXTURE["bind"]) for a, b in zip(entry, bind))
                self.assertGreater(moved, 0.05, f"{frame} {name} is still in the bind (T) pose")
                for entry in pose:
                    self.assertAlmostEqual(math.sqrt(sum(v * v for v in entry[:4])), 1, delta=0.2, msg=name)

    def test_the_poses_animate_between_frames(self):
        a, b = (FIXTURE["frames"][k] for k in ("four-start/start-0", "four-start/start-70"))
        changed = sum(1 for name in a if max(abs(x - y) for p, q in zip(a[name], b[name]) for x, y in zip(p, q)) > 0.05)
        self.assertGreaterEqual(changed, 20)

    def test_arms_come_in_from_the_t_pose(self):
        bind = crowd_pose.world(entries(FIXTURE["bind"]))
        self.assertAlmostEqual(bind[10][12], -5.5, delta=0.1)   # the bind pose holds the elbows out at x = +-5.5
        arms = [crowd_pose.world(entries(p))[10][12] for p in FIXTURE["frames"]["four-start/start-70"].values()]
        self.assertGreaterEqual(sum(abs(x) < 5 for x in arms), 22, arms)   # most spectators stand with the arms in; a few reach out

    @unittest.skipUnless(MODELS.exists(), "extracted V2CM models not present")
    def test_the_bind_reference_composes_onto_every_model_skeleton(self):
        bind = crowd_pose.world(entries(FIXTURE["bind"]))
        for model in sorted(MODELS.glob("V2CM_*A.o")):
            try:
                names, inverse = crowd_pose.inverse_bind(MODELS, model.name)
            except (ValueError, KeyError):
                continue
            if names != crowd_pose.BONES:
                continue
            for i in range(13):
                product = crowd_pose.multiply(bind[i], inverse[i])
                identity = [1 if r == c else 0 for r in range(4) for c in range(4)]
                self.assertLess(max(abs(a - b) for a, b in zip(product, identity)), 1e-3, f"{model.name} bone {i}")


if __name__ == "__main__":
    unittest.main()
