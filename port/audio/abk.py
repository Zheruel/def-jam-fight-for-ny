"""EA ABKC sound bank structure (PS2, little endian).

    0x0a u16 module count   0x1c u32 module table   0x20 u32 BNK offset
    module (0x3c + 4 * (players + controllers) bytes): u8 players at +0x24, u8 controllers at +0x27,
        u32 module data at +0x2c, player offsets at +0x3c
    player (module data + offset): u32 sound table at +0x04
    sound table: u32 count, then 0x0c-byte entries (u8 type, u8 priority, u32 index/offset, u32 loop)

Cue numbers follow vgmstream: unique sound tables in module/player order, skipping type-0 entries
that point at sound 0.
"""
import struct


def parse(data):
    if data[:4] != b"ABKC":
        raise ValueError("not an ABKC bank")
    u8 = lambda o: data[o]
    u16 = lambda o: struct.unpack_from("<H", data, o)[0]
    u32 = lambda o: struct.unpack_from("<I", data, o)[0]
    modules, at, seen, cue = [], u32(0x1c), {}, 0
    for index in range(u16(0x0a)):
        players, controllers = u8(at + 0x24), u8(at + 0x27)
        module_data = u32(at + 0x2c)
        module = {"index": index, "header": data[at:at + 0x3c].hex(), "players": [], "controllers": controllers}
        for slot in range(players):
            offset = u32(at + 0x3c + 4 * slot)
            player = module_data + offset
            table = u32(player + 4)
            entry = {"player": slot, "offset": player, "table": table, "words": list(struct.unpack_from("<8I", data, player))}
            if table not in seen:
                count, sounds = u32(table), []
                for k in range(count):
                    e = table + 4 + 12 * k
                    kind = u8(e)
                    if kind == 0 and u32(e + 4) == 0:
                        sounds.append(None)  # dummy
                        continue
                    cue += 1
                    sounds.append(cue)
                seen[table] = sounds
            entry["cues"] = seen[table]
            module["players"].append(entry)
        modules.append(module)
        at += 0x3c + (players + controllers) * 4
    return {"modules": modules, "cues": cue}
