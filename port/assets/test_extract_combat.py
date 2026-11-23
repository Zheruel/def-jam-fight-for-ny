import struct
import unittest

from extract_combat import numeric, schema_columns


class ExtractCombatTests(unittest.TestCase):
    def test_schema_joins_elf_queries_to_character_columns(self):
        # Synthetic SKMA table holding the seven observed entries in sorted hash order.
        fields = [
            (0x81902B08, 16, 2),
            (0x9D7AB784, 22, 2),
            (0xAE67FB8F, 17, 2),
            (0xB4922C97, 25, 2),
            (0xD0378669, 12, 2),
            (0xDC81E474, 9, 6),
            (0xE9331F7F, 2, 2),
        ]
        contents = bytearray(16)
        struct.pack_into("<I", contents, 12, 16)
        contents.extend(struct.pack("<4sII", b"SKMA", len(fields), 2))
        contents.extend(b"".join(struct.pack("<I", key) for key, _, _ in fields))
        contents.extend(b"".join(struct.pack("<II", index, kind) for _, index, kind in fields))

        stats, style = schema_columns(contents)
        self.assertEqual(stats, {
            "upperPower": 17, "lowerPower": 16, "speed": 22,
            "toughness": 25, "health": 12, "charisma": 2,
        })
        self.assertEqual(style, 9)
        contents[-4:] = struct.pack("<I", 6)
        with self.assertRaisesRegex(ValueError, "unexpected Character schema field"):
            schema_columns(contents)

    def test_gamecore_preserves_and_checks_annotated_style_order(self):
        values = "<block start frame> 10, 10, 10, 10, 5 </block start frame>"
        good = values + "\t<? streetfighter, kickboxing, submission, wrestling, martialarts ?>"
        bad = values + "\t<? wrestling, kickboxing, submission, streetfighter, martialarts ?>"
        self.assertEqual(numeric(good, "block start frame", 5, styles=True), [10, 10, 10, 10, 5])
        with self.assertRaisesRegex(ValueError, "unexpected style order"):
            numeric(bad, "block start frame", 5, styles=True)
        with self.assertRaisesRegex(ValueError, "must contain 4 finite numbers"):
            numeric(good, "block start frame", 4, styles=True)
        with self.assertRaisesRegex(ValueError, "expected one"):
            numeric(values + values, "block start frame", 5)
