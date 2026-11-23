import gzip
import json
import struct
import unittest

from venues import INVENTORY, OUTPUT, VERTEX
from foundation import HERE


def unpack(model):
    data = gzip.decompress((OUTPUT / (model + ".scene.gz")).read_bytes())
    magic, length = struct.unpack_from("<4sI", data)
    assert magic == b"DJS1"
    return json.loads(data[8 : 8 + length]), data[8 + length :]


class VenueTests(unittest.TestCase):
    def test_all_battle_venues_have_valid_batches_indices_and_textures(self):
        for venue in json.loads(INVENTORY.read_text())["venues"]:
            with self.subTest(venue=venue["name"]):
                meta, payload = unpack(venue["file"])
                self.assertEqual(meta["model"], venue["file"])
                index_offset = VERTEX.size * meta["vertices"]
                index_type = "H" if meta["indexBytes"] == 2 else "I"
                indices = struct.unpack_from(
                    f"<{meta['indices']}{index_type}", payload, index_offset
                )
                self.assertLess(max(indices), meta["vertices"])
                at = 0
                for batch in meta["batches"]:
                    self.assertEqual(batch["first"], at)
                    self.assertEqual(batch["count"] % 3, 0)
                    if batch["shape"] is not None:
                        self.assertIn(batch["shape"], meta["textures"])
                    at += batch["count"]
                self.assertEqual(at, len(indices))
                for start, size in meta["textures"].values():
                    self.assertLessEqual(start + size, len(payload))
                    self.assertEqual(payload[start : start + 8], b"\x89PNG\r\n\x1a\n")

    def test_foundation_attributes_match_the_previously_verified_export(self):
        retail = json.loads((HERE / "foundation.json").read_text())
        meta, payload = unpack("V2BG_02A")
        self.assertEqual(meta["objectSha256"], retail["source"]["elfSha256"])
        self.assertEqual(meta["batches"][0]["shape"], "0009")
        self.assertEqual(meta["vertices"], len(retail["positions"]) // 3)
        for i in range(meta["vertices"]):
            self.assertEqual(
                payload[i * 24 : (i + 1) * 24],
                VERTEX.pack(
                    *retail["positions"][3 * i : 3 * i + 3],
                    *retail["texcoords"][2 * i : 2 * i + 2],
                    *retail["colors"][4 * i : 4 * i + 4],
                ),
            )
        self.assertEqual(
            struct.unpack_from(f"<{meta['indices']}H", payload, meta["vertices"] * 24),
            tuple(retail["indices"]),
        )
