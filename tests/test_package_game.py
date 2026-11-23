import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
SPEC = importlib.util.spec_from_file_location("package_game", TOOLS / "package-game.py")
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)


class GamePackageTests(unittest.TestCase):
    def setUp(self):
        self.page = 2048
        self.repeated = b"\x00\xff" * (self.page // 2)
        self.source = self.repeated + bytes(self.page) + self.repeated + b"tail\x00"
        self.options = {
            "expected_size": len(self.source),
            "expected_sha1": hashlib.sha1(self.source).hexdigest(),
            "block_size": self.page,
        }
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "game-assets"

    def package(self, source=None, *, workers=2):
        return packager.build(
            io.BytesIO(self.source if source is None else source), self.output,
            files={"DATA.VIV": {"offset": 0, "bytes": len(self.repeated)}},
            workers=workers, **self.options,
        )

    def test_round_trip_is_sparse_deduplicated_and_deterministic(self):
        manifest, compressed = self.package()
        blocks = manifest["blocks"]
        self.assertIsNone(blocks[1])
        self.assertEqual(blocks[0], blocks[2])
        self.assertEqual(len(list((self.output / "blocks").iterdir())), 2)
        self.assertEqual(manifest["files"]["DATA.VIV"], {"offset": 0, "bytes": self.page})

        decoded = bytearray()
        for index, digest in enumerate(blocks):
            length = min(self.page, len(self.source) - index * self.page)
            decoded.extend(gzip.decompress((self.output / "blocks" / (digest + ".gz")).read_bytes())
                           if digest is not None else bytes(length))
        self.assertEqual(decoded, self.source)
        self.assertEqual(packager.verify(self.output, **self.options), (manifest, compressed))

        original = {path.relative_to(self.output): path.read_bytes()
                    for path in self.output.glob("**/*") if path.is_file()}
        self.assertEqual(self.package(workers=1), (manifest, compressed))
        self.assertEqual({path.relative_to(self.output): path.read_bytes()
                          for path in self.output.glob("**/*") if path.is_file()}, original)

    def test_verifier_detects_wrong_hash_wrong_length_and_swapped_blocks(self):
        manifest, _ = self.package()
        asset = self.output / "blocks" / (manifest["blocks"][0] + ".gz")
        for invalid_data in (b"a" * self.page, self.repeated + b"a"):
            with self.subTest(length=len(invalid_data)):
                asset.write_bytes(gzip.compress(invalid_data))
                with self.assertRaisesRegex(ValueError, "Asset data mismatch"):
                    packager.verify(self.output, **self.options)
        self.package()
        packager.verify(self.output, **self.options)

        manifest["blocks"][0], manifest["blocks"][1] = manifest["blocks"][1], manifest["blocks"][0]
        (self.output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "do not reproduce"):
            packager.verify(self.output, **self.options)

    def test_failed_build_preserves_the_published_package(self):
        manifest, compressed = self.package()
        original = (self.output / "manifest.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.package(b"!" + self.source[1:])
        self.assertEqual((self.output / "manifest.json").read_bytes(), original)
        self.assertEqual(packager.verify(self.output, **self.options), (manifest, compressed))
        self.assertEqual(list(self.output.glob(".package-*")), [])


if __name__ == "__main__":
    unittest.main()
