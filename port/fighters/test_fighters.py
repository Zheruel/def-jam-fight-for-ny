import json
import math
import random
import struct
import unittest

from extract import DEFAULT_MODELS, DEFAULT_OUTPUT, FORMAT, encode
from retail import (Disc, Elf, POSITION_ZERO, PARENTS, decode_model, decode_packet, decode_skeleton,
                    find_parts, matrix_inverse, model_from_disc, roster, vif_codes)
from pathlib import Path

from animbank import read_bank, clip_names

RETAIL_ISO = Path(__file__).resolve().parents[2] / "private" / "ps2" / "reference.iso"


def load(name):
    return json.loads((DEFAULT_OUTPUT / f"{name}.json").read_text(encoding="utf-8"))


class FighterModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.blaze = load("V2IP_113A")
        cls.doc = load("V2IP_109A")

    def test_arrays_are_consistent_and_safe_to_index(self):
        for model in (self.blaze, self.doc):
            self.assertEqual(model["format"], FORMAT)
            counts = model["counts"]
            vertices = counts["vertices"]
            self.assertEqual(len(model["positions"]), vertices * 3)
            self.assertEqual(len(model["normals"]), vertices * 3)
            self.assertEqual(len(model["uvs"]), vertices * 2)
            self.assertEqual(len(model["joints"]), vertices * 4)
            self.assertEqual(len(model["weights"]), vertices * 4)
            self.assertEqual(len(model["indices"]), counts["triangles"] * 3)
            self.assertEqual(counts["bones"], 94)
            self.assertTrue(0 <= min(model["indices"]) and max(model["indices"]) < vertices)
            self.assertTrue(0 <= min(model["joints"]) and max(model["joints"]) < counts["bones"])
            self.assertTrue(all(math.isfinite(v) for v in model["positions"] + model["normals"] + model["weights"]))
            for i in range(vertices):
                weights = model["weights"][4 * i:4 * i + 4]
                self.assertAlmostEqual(sum(weights), 1.0, places=3)
                self.assertEqual(weights[3], 0.0)
            end = 0
            for part in model["parts"]:
                self.assertEqual(part["firstIndex"], end)
                end += part["indexCount"]
            self.assertEqual(end, len(model["indices"]))

    def test_positions_are_the_retail_16_bit_quanta(self):
        # Every stored position is (u16 - 0x8001) * boundingBoxExtent / 16384 for the retail u16 offsets.
        for model in (self.blaze, self.doc):
            scale = model["positionScale"]
            for k in range(3):
                for value in model["positions"][k::3]:
                    quanta = value / scale[k]
                    self.assertAlmostEqual(quanta, round(quanta), delta=0.01)
                    self.assertLessEqual(abs(round(quanta)), 0x4000)
            self.assertEqual(scale[0], max(abs(model["bounds"]["min"][0]), model["bounds"]["max"][0]) / 0x4000)

    def test_first_blaze_vertex_matches_retail_stream(self):
        # First vertex of the first display-list part in V2IP_113A.o: u16 (33221, 47189, 37877), UV (2768, 696).
        scale = self.blaze["positionScale"]
        expected = [(33221 - POSITION_ZERO) * scale[0], (47189 - POSITION_ZERO) * scale[1], (37877 - POSITION_ZERO) * scale[2]]
        for got, want in zip(self.blaze["positions"][:3], expected):
            self.assertAlmostEqual(got, want, places=5)
        self.assertEqual(self.blaze["uvs"][:2], [2768 / 4096, 696 / 4096])

    def test_skeleton_is_a_bind_pose_tree(self):
        for model in (self.blaze, self.doc):
            bones = model["bones"]
            self.assertEqual([b["name"] for b in bones][:5], ["root", "tophip", "L_hipbone_root", "L_hipbone", "L_hipbone_eff"])
            self.assertIsNone(bones[0]["parent"])
            for index, bone in enumerate(bones[1:], 1):
                self.assertTrue(0 <= bone["parent"] < index, bone["name"])
                self.assertEqual(bones[bone["parent"]]["name"], PARENTS[bone["name"]])
                product = [sum(bone["inverseBind"][r * 4 + k] * bone["bindWorld"][k * 4 + c] for k in range(4))
                           for r in range(4) for c in range(4)]
                for value, want in zip(product, (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)):
                    self.assertAlmostEqual(value, want, places=3)
            world = {b["name"]: b["bindWorld"][12:15] for b in bones}
            # T-pose: hands are about 8.6 units out of the hips, feet at the ground, head above the chest.
            self.assertAlmostEqual(world["L_hand"][0], 8.57, delta=0.05)
            self.assertAlmostEqual(world["R_hand"][0], -8.56, delta=0.05)
            self.assertLess(world["L_foot"][1], 2.0)
            self.assertGreater(world["head"][1], world["chest"][1])

    def test_weights_bind_vertices_to_nearby_bones(self):
        # With the bone palette decoded correctly the heaviest bone sits near its vertex; a wrong palette would not.
        model = self.blaze
        bones = [b["bindWorld"][12:15] for b in model["bones"]]
        rng = random.Random(7)
        near = []
        far = []
        for i in rng.sample(range(model["counts"]["vertices"]), 1500):
            vertex = model["positions"][3 * i:3 * i + 3]
            weights = model["weights"][4 * i:4 * i + 4]
            best = max(range(4), key=lambda j: weights[j])
            bone = model["joints"][4 * i + best]
            near.append(math.dist(vertex, bones[bone]))
            far.append(math.dist(vertex, bones[rng.randrange(94)]))
        near.sort()
        far.sort()
        self.assertLess(near[len(near) // 2], 2.0)
        self.assertLess(near[len(near) * 9 // 10], 5.0)
        self.assertGreater(far[len(far) // 2], 8.0)

    def test_triangles_face_the_stored_normals(self):
        for model in (self.blaze, self.doc):
            agree = total = 0
            p, n, ix = model["positions"], model["normals"], model["indices"]
            for t in range(0, len(ix), 3):
                a, b, c = ix[t:t + 3]
                u = [p[3 * b + k] - p[3 * a + k] for k in range(3)]
                v = [p[3 * c + k] - p[3 * a + k] for k in range(3)]
                face = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                normal = [n[3 * a + k] + n[3 * b + k] + n[3 * c + k] for k in range(3)]
                dot = sum(face[k] * normal[k] for k in range(3))
                if abs(dot) > 1e-9:
                    total += 1
                    agree += dot > 0
            self.assertGreater(agree / total, 0.97)

    def test_blaze_and_doc_are_different_meshes_on_one_rig(self):
        self.assertEqual([b["name"] for b in self.blaze["bones"]], [b["name"] for b in self.doc["bones"]])
        self.assertNotEqual(self.blaze["positions"][:30], self.doc["positions"][:30])
        self.assertNotEqual(self.blaze["source"]["memberSha256"], self.doc["source"]["memberSha256"])

    def test_invalid_input_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "ELF32/MIPS"):
            decode_model(b"BIGF")

    def test_vif_walker_reads_unpack_and_strow(self):
        data = (struct.pack("<I", 0x30000000) + struct.pack("<4I", 1, 2, 3, 4)
                + struct.pack("<I", 0x6E01C0B8) + bytes(8))
        codes = list(vif_codes(data, 0, 2))
        self.assertEqual([c.get("command") for c in codes[:1]], [0x30])
        self.assertEqual(codes[1]["unpack"], 0xE)
        self.assertEqual((codes[1]["address"], codes[1]["unsigned"], codes[1]["tops"]), (0xB8, True, True))


@unittest.skipUnless(RETAIL_ISO.is_file(), "local PS2 retail ISO is unavailable")
class RetailDiscTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.disc = Disc(str(RETAIL_ISO))

    @classmethod
    def tearDownClass(cls):
        cls.disc.close()

    def test_checked_in_models_match_retail_byte_for_byte(self):
        for name in DEFAULT_MODELS:
            self.assertEqual(encode(name, model_from_disc(self.disc, name)),
                             (DEFAULT_OUTPUT / f"{name}.json").read_text(encoding="utf-8"))

    def test_whole_roster_shares_the_rig_and_decodes(self):
        names = roster(self.disc)
        self.assertEqual(len(names), 78)
        rig = None
        for name in names:
            model = model_from_disc(self.disc, name)
            bones = [b["name"] for b in model["bones"]]
            rig = rig or bones
            self.assertEqual(bones, rig, name)
            self.assertTrue(4000 < len(model["positions"]) // 3 < 8000, name)
            self.assertTrue(model["indices"] and max(model["indices"]) < len(model["positions"]) // 3, name)

    def test_animation_banks_resolve_clip_objects_and_channels(self):
        base = read_bank(self.disc, "/MOTION/BASE00.VIV", "base00")
        self.assertEqual(len(base.names), 709)
        self.assertEqual((base.names[11], base.names[16]), ("A112", "A117"))   # Blaze and Doc idle
        idle = base.clip("A112")
        self.assertEqual((idle["skeletonChannels"], len(idle["bones"]), idle["bones"][:4]), (67, 50, [3, 6, 9, 12]))
        self.assertEqual(sorted(idle["objects"]), list("dfhst"))
        self.assertEqual(base.clip("B101")["source"], "AA101")
        punch = read_bank(self.disc, "/MOTION/WRES_ALL.VIV", "wres005")
        self.assertEqual(punch.clip(punch.names[0])["source"], "N0103AA1")

    def test_clip_name_list_is_validated(self):
        with self.assertRaisesRegex(ValueError, "name list"):
            clip_names(b"\x01\x00\x00\x00\x01\x00\x00\x00A101")


if __name__ == "__main__":
    unittest.main()
