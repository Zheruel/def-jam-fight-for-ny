"""Extract The Foundation's original stage props and instanced crowd from the retail PS2 disc.

  python3 port/scenery/extract.py [iso] [--check]

Writes port/scenery/foundation/{props.scene.gz,crowd.bin.gz,scenery.json}. Every value
comes from the retail archives ASSETS/V2BG.VIV and ASSETS/ICROWD.VIV; nothing is authored.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "port" / "geometry"))
sys.path.insert(0, str(REPO / "ps2" / "battle"))
sys.path.insert(0, str(REPO / "port" / "fighters"))
sys.path.insert(0, str(REPO / "port" / "render"))

import venues  # noqa: E402
from battle_patch import Disc  # noqa: E402
import retail  # noqa: E402
from foundation import elf_links, triangle_indices, vif_tag  # noqa: E402
from refpack import decompress  # noqa: E402
from ssh import textures  # noqa: E402

DEFAULT_ISO = REPO / "private" / "ps2" / "reference.iso"
OUTPUT = HERE / "foundation"
STAGE = "/ASSETS/V2BG.VIV"
CROWD = "/ASSETS/ICROWD.VIV"
ENTITY = "/ASSETS/ENTITY.XML"
ENTITY_BYTES = 91612
VENUE = "V2BG_02A"
CROWD_MODEL = "icrowd01"
CROWD_LAYOUT = "icl_02A"
U32 = struct.Struct("<I")
VERTEX = struct.Struct("<5f4B")


def member(disc: Disc, archive: str, name: str) -> bytes:
    at, size = disc.viv_entry(archive, name)
    raw = disc.read(archive, at, size)
    return decompress(raw) if raw[:2] == b"\x10\xfb" else raw


def sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


# ---------------------------------------------------------------- stage XML

def stage_text(blob: bytes) -> str:
    # The exporter wrote Shift-JIS comments inside unterminated <? ... processing
    # instructions, so the files are read as tagged text, not as XML documents.
    return blob.decode("shift_jis").replace("\r", "")


def section(text: str, tag: str) -> str:
    match = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.S)
    if not match:
        raise ValueError(f"missing <{tag}>")
    return match[1]


def blocks(text: str, tag: str) -> list[str]:
    return re.findall(rf"<{tag}>(.*?)</{tag}>", text, re.S)


def values(text: str, tag: str) -> list[str]:
    return [v.strip() for v in re.findall(rf"<{tag}>([^<]*)</{tag}>", text)]


def vector(text: str) -> list[float]:
    return [float(v) + 0.0 for v in text.split(",")]


def placements(text: str, group: str, item: str) -> list[dict]:
    body = section(text, group)
    found = [{"name": values(b, "name")[0], "translate": vector(values(b, "translate")[0]),
              "rotate": vector(values(b, "rotate")[0])} for b in blocks(body, item)]
    if int(values(body, "counts")[0]) != len(found):
        raise ValueError(f"<{group}> count disagrees with its entries")
    return found


def stage_objects(objects_xml: str) -> list[dict]:
    result = []
    for body in blocks(section(objects_xml, "stageobjects"), "object"):
        result.append({"name": values(body, "name")[0],
                       "alpha": values(body, "alpha") == ["on"],
                       "geometry": values(body, "geometry"),
                       "morphs": values(body, "morph")})
    return result


def stage_weapon(stage_xml: str) -> dict:
    """<stageweapon>: the weapons the crowd can drop and how long each lasts (retail 0x1c33a0 reads these)."""
    body = section(stage_xml, "stageweapon")
    pair = lambda v: [float(x) for x in v.split(",")]
    return {"drops": [d.strip() for d in values(body, "drop")],
            "weakCatch": (values(body, "weakcatch") or [None])[0], "strongCatch": (values(body, "strongcatch") or [None])[0],
            "life": [float(v) for v in values(body, "life")],
            "interval": pair(values(body, "time")[0]) if values(body, "time") else None,
            "pass": [[v.split(",")[0].strip(), float(v.split(",")[1])] for v in values(body, "pass")],
            "limit": int(values(body, "limit")[0]) if values(body, "limit") else None}


def environment_attacks(stage_xml: str) -> list[dict]:
    attacks = []
    for body in blocks(section(stage_xml, "stageenvironment"), "environmentattack"):
        # Drop commented-out lines (an unterminated "<?" starts each comment).
        body = "\n".join(line for line in body.split("\n") if not line.lstrip().startswith("<?"))
        if not values(body, "name"):
            continue
        attack = {"name": values(body, "name")[0]}
        for tag, key in (("geometry", "geometry"), ("particle", "particles"),
                         ("movparticle", "movingParticles"), ("delparticle", "deleteParticles"),
                         ("venueweapon", "weapons"), ("light", "light"), ("sound", "sounds"),
                         ("weaponsound", "weaponSounds"), ("animation", "animations"), ("weapon", "spawnWeapons")):
            entries = [[part.strip() for part in v.split(",")] for v in values(body, tag)]
            if entries:
                attack[key] = entries
        attacks.append(attack)
    return attacks


# ---------------------------------------------------------------- props

class Window(dict):
    """Relocations restricted to one geometry state's display-list block.

    venues.geometry walks `keys()` for draw calls and checks `items()` for unreached
    packets; lookups through `[]` still see the whole object.
    """

    def __init__(self, mapping: dict, lo: int, hi: int):
        super().__init__(mapping)
        self.lo, self.hi = lo, hi

    def keys(self):
        return {k for k in dict.keys(self) if self.lo <= k < self.hi}

    def items(self):
        return [(k, v) for k, v in dict.items(self) if self.lo <= k < self.hi]


def prop_states(name: str, blob: bytes) -> list[dict]:
    """Decode each geometry state of a breakable prop.

    EAGL stores the states as consecutive display-list blocks that each begin with the
    microcode relocation. Each block is decoded with the venue decoder on its own, and
    its bounds must equal one retail per-geometry bounding record exactly.
    """
    model = f"__Model:::{name}_branch"
    data, local, external = elf_links(blob, model)
    starts = sorted(at for at, symbol in external.items() if symbol.endswith("__EAGLMicroCode"))
    states = []
    original = venues.elf_links
    try:
        for k, lo in enumerate(starts):
            hi = starts[k + 1] if k + 1 < len(starts) else len(data)
            venues.elf_links = lambda _blob, _model, lo=lo, hi=hi: (
                data, Window(local, lo, hi), Window(external, lo, hi))
            vertices, indices, meta = venues.geometry(name, blob)
            record = struct.pack("<8f", *meta["bounds"]["min"], 1, *meta["bounds"]["max"], 1)
            hits = [at for at in range(0, len(data) - 31, 4) if data[at:at + 32] == record]
            if not hits:
                raise ValueError(f"{name} state {k}: bounds match no retail bounding record")
            states.append({"vertices": vertices, "indices": indices, "meta": meta,
                           "boundsRecord": hits[0]})
    finally:
        venues.elf_links = original
    reached = sum(s["meta"]["packets"] for s in states)
    whole = venues.geometry(name, blob)[2]["packets"]
    if reached != whole:
        raise ValueError(f"{name}: states reach {reached} of {whole} draws")
    return states


def pack_props(objects: list[dict], decoded: dict, images: dict) -> tuple[bytes, dict]:
    vertices, indices, shapes = bytearray(), [], set()
    manifest = []
    for obj in objects:
        states = decoded[obj["name"]]
        entry = {"name": obj["name"], "alpha": obj["alpha"], "states": []}
        for state_name, state in zip(obj["geometry"], states):
            base = len(vertices) // VERTEX.size
            first = len(indices)
            vertices.extend(state["vertices"])
            indices.extend(i + base for i in state["indices"])
            batches = [{"shape": b["shape"], "first": b["first"] + first, "count": b["count"]}
                       for b in state["meta"]["batches"]]
            shapes.update(b["shape"] for b in batches if b["shape"])
            entry["states"].append({"name": state_name, "bounds": state["meta"]["bounds"],
                                    "packets": state["meta"]["packets"],
                                    "vertices": len(state["vertices"]) // VERTEX.size,
                                    "boundsRecord": state["boundsRecord"], "batches": batches})
        manifest.append(entry)
    header = {"model": f"{VENUE}_props", "vertices": len(vertices) // VERTEX.size,
              "indices": len(indices), "indexBytes": 2 if max(indices) < 65536 else 4,
              "objects": manifest, "textures": {}}
    buf = bytearray(vertices)
    buf.extend(struct.pack(f"<{len(indices)}" + ("H" if header["indexBytes"] == 2 else "I"), *indices))
    for shape in sorted(shapes):
        header["textures"][shape] = [len(buf), len(images[shape])]
        buf.extend(images[shape])
    return djs(b"DJS1", header, buf), header


def djs(magic: bytes, header: dict, payload: bytes) -> bytes:
    text = json.dumps(header, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    return gzip.compress(magic + U32.pack(len(text)) + text + payload, compresslevel=9, mtime=0)


# ---------------------------------------------------------------- instanced crowd

def word(data: bytes, at: int) -> int:
    return U32.unpack_from(data, at)[0]


def unpack(data: bytes, at: int, command: int, count: int, address: int) -> int:
    """Return the payload offset of a masked, unsigned VIF UNPACK at `at`."""
    if word(data, at) != (command << 24 | count << 16 | 0xC000 | address):
        raise ValueError(f"expected UNPACK {command:#x} x{count} @{address:#x} at {at}")
    return at + 4


def crowd_positions(data: bytes, at: int, count: int) -> bytes:
    # STMASK 0x40404040 (W from the row), STROW 1.0, STCYCL 1, V3-16 unsigned to VU 1.
    if word(data, at) != 0x20000000 or word(data, at + 4) != 0x40404040:
        raise ValueError("crowd frame: expected STMASK 0x40404040")
    if word(data, at + 8) != 0x30000000 or data[at + 12:at + 28] != struct.pack("<4f", 1, 1, 1, 1):
        raise ValueError("crowd frame: expected STROW 1.0")
    if word(data, at + 28) != 0x05000001:
        raise ValueError("crowd frame: expected STMOD 1")
    start = unpack(data, at + 32, 0x79, count, 1)
    return data[start:start + 6 * count]


def crowd_static(data: bytes, at: int, count: int) -> tuple[bytes, list[int]]:
    if data[at + 12:at + 32] != vif_tag(0x6C, 1, 0) + struct.pack("<4I", count, 0, 0, 0):
        raise ValueError("crowd part: vertex count header disagrees")
    at += 32
    if word(data, at) != 0x20000000 or word(data, at + 4) != 0x50505050:
        raise ValueError("crowd part: expected UV STMASK")
    if data[at + 8:at + 28] != U32.pack(0x30000000) + struct.pack("<4f", 0, 0, 1, 1):
        raise ValueError("crowd part: expected UV STROW")
    if word(data, at + 28) != 0x05000001:
        raise ValueError("crowd part: expected UV STMOD 1")
    start = unpack(data, at + 32, 0x74, count, 0x61)
    uv = data[start:start + 8 * count]
    at = start + 8 * count
    if data[at:at + 12] != bytes.fromhex("00000020 00000000 00000005".replace(" ", "")):
        raise ValueError("crowd part: expected strip STMASK/STMOD")
    at += 12
    boundary = b""
    for address in (0xC1, 0xC2, 0xC3):
        boundary += data[unpack(data, at, 0x6E, 1, address):][:4]
        at += 8
    if word(data, at) != 0x17000000:
        raise ValueError("crowd part: missing MSCNT")
    boundary = boundary.rstrip(b"\0")
    if any(v % 3 for v in boundary):
        raise ValueError("crowd part: strip boundary not a multiple of 3")
    cuts = [0, *(v // 3 for v in boundary), count]
    if any(b - a < 3 for a, b in zip(cuts, cuts[1:])):
        raise ValueError("crowd part: invalid strip")
    return uv, cuts


def decode_crowd(blob: bytes) -> dict:
    data, local, external = elf_links(blob, f"__Model:::{CROWD_MODEL}")
    top = 388648
    if word(data, top + 8) != 383:
        raise ValueError("unexpected crowd frame count")
    frames = word(data, top + 8)
    scale = list(struct.unpack_from("<3f", data, top + 0x4C))
    half = struct.unpack_from("<3f", data, top + 0x5C)
    if any(abs(h * 2 - s) > 1e-5 for h, s in zip(half, scale)):
        raise ValueError("crowd scale and half-scale disagree")
    # Display list: CALL into a table of one DMA CALL per frame.
    call = next(at for at, symbol in external.items() if symbol == "InstanceCrowd0__EAGLMicroCode")
    table_at = next(at for at in range(call, call + 128, 4)
                    if word(data, at - 4) == 0x04000002 and at in local)
    table = local[table_at]
    parts = []
    per_frame = []
    for f in range(frames):
        if word(data, table + 16 * f) != 0x50000000:
            raise ValueError(f"crowd frame {f}: expected DMA CALL")
        sub = local[table + 16 * f + 4]
        refs = []
        for r in range(4):
            tag = word(data, sub + 16 * r)
            if tag >> 28 != 3:
                raise ValueError(f"crowd frame {f}: expected REF")
            refs.append((local[sub + 16 * r + 4], tag & 0xFFFF))
        if word(data, sub + 64) >> 28 != 6:
            raise ValueError(f"crowd frame {f}: expected RET")
        per_frame.append(refs)
    statics = {(refs[1], refs[3]) for refs in per_frame}
    if len(statics) != 1:
        raise ValueError("crowd frames must share one static topology")
    (static0, static1), = statics
    counts = []
    for static in (static0, static1):
        count = word(data, static[0] + 16)
        uv, cuts = crowd_static(data, static[0], count)
        counts.append(count)
        parts.append({"vertices": count, "strips": cuts, "uv": uv})
    positions = bytearray()
    mins, maxs = [math.inf] * 3, [-math.inf] * 3
    for refs in per_frame:
        for (at, _), count in zip((refs[0], refs[2]), counts):
            raw = crowd_positions(data, at, count)
            positions.extend(raw)
            for i, value in enumerate(struct.unpack(f"<{3 * count}H", raw)):
                p = (value / 65536 - 0.5) * scale[i % 3]
                mins[i % 3] = min(mins[i % 3], p)
                maxs[i % 3] = max(maxs[i % 3], p)
    bbox = struct.unpack_from("<6f", data, 350176)
    # Positions are 16-bit, so the retail box holds them to within one quantum per axis.
    step = [s / 65536 for s in scale] * 2
    if any(abs(a - b) > q for a, b, q in zip(mins + maxs, bbox, step)):
        raise ValueError(f"crowd positions {mins}{maxs} disagree with __BBOX {bbox}")
    return {"frames": frames, "scale": scale, "parts": parts, "positions": bytes(positions),
            "bbox": {"min": list(bbox[:3]), "max": list(bbox[3:])}}


def crowd_layout(blob: bytes) -> list[dict]:
    """Read the 60 instance transforms from the ICROWD skeleton in icl_02A.o."""
    section_table, = struct.unpack_from("<I", blob, 32)
    count, names_index = struct.unpack_from("<HH", blob, 48)
    sections = [struct.unpack_from("<10I", blob, section_table + 40 * i) for i in range(count)]
    strings = lambda s: blob[s[4]:s[4] + s[5]]
    names = strings(sections[names_index])
    named = {names[s[0]:names.index(b"\0", s[0])].decode(): i for i, s in enumerate(sections)}
    data = strings(sections[named[".data"]])
    symbols = strings(sections[named[".symtab"]])
    symbol_names = strings(sections[sections[named[".symtab"]][6]])
    bones = {}
    for name_at, value, *_ in struct.iter_unpack("<IIIBBH", symbols):
        name = symbol_names[name_at:symbol_names.index(b"\0", name_at)].decode()
        if name.startswith("__Bone:::ICROWD."):
            bones[word(data, value)] = name.split(".", 1)[1]
        elif name == "__Skeleton:::ICROWD":
            skeleton = value
    total = word(data, skeleton + 8)
    if skeleton + 16 + total * 112 != len(data) or len(bones) != total:
        raise ValueError("unexpected ICROWD skeleton layout")
    instances = []
    for i in range(total):
        at = skeleton + 16 + 112 * i
        scale = struct.unpack_from("<3f", data, at)
        parent, = struct.unpack_from("<i", data, at + 12)
        quat = struct.unpack_from("<4f", data, at + 16)
        translate = struct.unpack_from("<3f", data, at + 32)
        index = word(data, at + 44)
        inverse = struct.unpack_from("<16f", data, at + 48)
        if index != i or scale != (1, 1, 1):
            raise ValueError("unexpected ICROWD bone record")
        if i == 0:
            if parent != -1 or bones[0] != "ICROWD":
                raise ValueError("ICROWD root expected first")
            continue
        if parent != 0 or abs(quat[0]) > 1e-6 or abs(quat[2]) > 1e-6:
            raise ValueError("crowd instance is not a yaw-only child of the root")
        yaw = 2 * math.atan2(quat[1], quat[3])
        # Inverse bind is Ry(-yaw) and -R^T t; check both against the quaternion.
        c, s = math.cos(yaw), math.sin(yaw)
        expect_t = (-(c * translate[0] - s * translate[2]), -translate[1],
                    -(s * translate[0] + c * translate[2]))
        if any(abs(a - b) > 1e-3 for a, b in zip(expect_t, inverse[12:15])) or \
                abs(inverse[0] - c) > 1e-5 or abs(inverse[2] - s) > 1e-5:
            raise ValueError(f"bone {bones[i]}: inverse bind disagrees with its transform")
        group, row, variant = bones[i].split("_")
        instances.append({"name": bones[i], "group": group, "row": int(row), "variant": int(variant),
                          "translate": [round(v, 5) + 0.0 for v in translate],
                          "quaternion": [round(v, 7) + 0.0 for v in quat],
                          "yawDegrees": round(math.degrees(yaw), 4)})
    return instances


def pack_crowd(crowd: dict, instances: list[dict], image: bytes, loops: dict) -> tuple[bytes, dict]:
    buf = bytearray(crowd["positions"])
    layout = {"positions": [0, len(buf)]}
    uv = b"".join(p["uv"] for p in crowd["parts"])
    layout["uv"] = [len(buf), len(uv)]
    buf.extend(uv)
    indices, base = [], 0
    for part in crowd["parts"]:
        indices.extend(triangle_indices(base, part["strips"]))
        base += part["vertices"]
    layout["indices"] = [len(buf), 2 * len(indices)]
    buf.extend(struct.pack(f"<{len(indices)}H", *indices))
    buf.extend(b"\0" * (-len(buf) % 4))
    layout["texture"] = [len(buf), len(image)]
    buf.extend(image)
    header = {"model": CROWD_MODEL, "frames": crowd["frames"],
              "vertices": base, "parts": [{"vertices": p["vertices"], "strips": p["strips"]}
                                          for p in crowd["parts"]],
              "indices": len(indices), "scale": crowd["scale"], "bounds": crowd["bbox"],
              "loops": loops, "instances": instances, "layout": layout,
              "quantization": "position = (uint16 / 65536 - 0.5) * scale"}
    return djs(b"DJC1", header, buf), header


def crowd_loops(crowd: dict, xml: str) -> dict:
    """Frame ranges for icrowd01.xml's idle and excited cycles.

    383 = 240 idle + 3 rest + 140 excited. Frames 1, 241, 242 and 382 equal frame 0 (the
    rest pose) exactly, so both cycles pass through the rest pose and can hand over there.
    """
    idle, excited = int(values(xml, "idle")[0]), int(values(xml, "excited")[0])
    frames, vertices = crowd["frames"], sum(p["vertices"] for p in crowd["parts"])
    stride = 6 * vertices
    frame = lambda f: crowd["positions"][f * stride:(f + 1) * stride]
    rest = [f for f in range(frames) if frame(f) == frame(0)]
    if rest != [0, 1, idle + 1, idle + 2, frames - 1] or frames - idle - excited != 3:
        raise ValueError(f"unexpected crowd cycle layout, rest frames {rest}")
    return {"idle": [0, idle], "excited": [frames - excited, frames], "rest": rest}


# ---------------------------------------------------------------- lighting (.irr)

def parse_irr(blob: bytes) -> list[dict]:
    """Each .irr holds light sets of irradiance spheres: probe positions, four intensity floats,
    ten (r, g, b) coefficients of a symmetric 4x4 irradiance matrix per probe, and a ten-float list
    the engine copies into the coefficients' fourth lane. EAGL loads two sets per file."""
    lines = blob.decode("latin-1").replace("\r", "").split("\n")
    sets, i = [], 0

    def blank():
        nonlocal i
        while i < len(lines) and not lines[i].strip():
            i += 1

    def rows(count, width):
        nonlocal i
        blank()
        out = [[float(v) for v in lines[i + k].split(",")] for k in range(count)]
        i += count
        if any(len(r) != width for r in out):
            raise ValueError("unexpected .irr row width")
        return out

    while i < len(lines):
        if not lines[i].startswith("intensityMultiplier"):
            i += 1
            continue
        head = {}
        while i < len(lines) and lines[i].strip():
            key, value = lines[i].split()
            head[key] = float(value)
            i += 1
        spheres, rim, shadows = int(head["numSphere"]), int(head["numRim"]), int(head["numShadows"])
        entry = {"intensityMultiplier": head["intensityMultiplier"],
                 "rim": {k: head[k] for k in ("rimShadowBias", "rimLightness", "rimFalloff", "rimfade")},
                 "shadow": {"colour": [head[f"shadowColour{c}"] for c in "RGBA"],
                            "toneDown": head["shadowToneDown"], "blend": int(head["shadowBlend"])},
                 "spheres": rows(spheres, 3), "rimLights": rows(rim, 3), "shadowLights": rows(shadows, 3),
                 "intensity": rows(spheres, 4)}
        blank()
        entry["lane"] = [float(lines[i + k]) for k in range(10)]
        i += 10
        entry["matrices"] = [rows(10, 3) for _ in range(spheres)]
        sets.append(entry)
    if len(sets) != 2:
        raise ValueError(f"expected two light sets, found {len(sets)}")
    return sets


def entity_lighting(entity_text: str) -> dict[str, list[str]]:
    """venue -> its lighting setting names, in ENTITY.XML order."""
    found = {}
    for body in re.findall(r"<entity>(.*?)</entity>", entity_text, re.S):
        name = values(body, "name")[0]
        light = re.search(r"<lighting>(.*?)</lighting>", body, re.S)
        if name.startswith("V2BG_") and light:
            found[name] = re.findall(r"<name>(.*?)</name>", light[1])
    return found


# ---------------------------------------------------------------- weapons (V2WP.VIV)

WEAPONS = "/ASSETS/V2WP.VIV"


def weapon_decode_packet(data: bytes, part: dict):
    """retail.decode_packet with the VU addresses read from the packet: weapon microcode batches fewer
    slots than a fighter's, so the UV and normal streams sit at different addresses."""
    table, batches, batch = None, [], None
    for code in retail.vif_codes(data, part["packet"], part["qwc"]):
        if "unpack" not in code:
            continue
        kind, address, at, count = code["unpack"], code["address"], code["data"], code["count"]
        if kind == 0xC and not code["tops"] and address == 4:
            table = [struct.unpack_from("<4I", data, at + 16 * i) for i in range(count)]
        elif kind == 0xC and address == 0:
            batch = {"header": struct.unpack_from("<4I", data, at), "bounds": b""}
        elif kind == 0xE and address in (1, 2, 3):
            batch["bounds"] += data[at:at + 4]
        elif kind == 0xD and address == 4:
            batch["a"] = struct.unpack_from(f"<{4 * count}H", data, at)
        elif kind == 0xD and not code["unsigned"]:
            batch["b"] = struct.unpack_from(f"<{4 * count}h", data, at)
        elif kind == 0xC and code["tops"] and address > 4:
            batch["c"] = struct.unpack_from(f"<{4 * count}I", data, at)
            batch["count"] = count
            batches.append(batch)
    return (table, batches) if table is not None and batches else None


def weapon_names(disc: Disc) -> list[str]:
    """V2WP archive members named V2WP_nnnX, sorted. The index in this list is the retail weapon type number."""
    table = disc.read(WEAPONS, 0, 16)
    count, header_size = struct.unpack_from(">II", table, 8)
    listing = disc.read(WEAPONS, 0, header_size)
    names, at = [], 16
    for _ in range(count):
        end = listing.index(b"\0", at + 8)
        names.append(listing[at + 8:end].decode("latin-1"))
        at = end + 1
    return sorted(n[:-2] for n in names if re.fullmatch(r"V2WP_\d{3}[A-Z]\.o", n))


def weapon_models(disc: Disc) -> dict[str, bytes]:
    """Every V2WP_nnnX model as a DJF1 skinned mesh (same container as port/render/fighters)."""
    import export_fighters
    original = retail.decode_packet, export_fighters.read_member
    retail.decode_packet = weapon_decode_packet
    export_fighters.read_member = lambda d, name: (None, member(d, WEAPONS, name), None)
    try:
        table = disc.read(WEAPONS, 0, 16)
        count, header_size = struct.unpack_from(">II", table, 8)
        listing = disc.read(WEAPONS, 0, header_size)
        names, at = [], 16
        for _ in range(count):
            end = listing.index(b"\0", at + 8)
            names.append(listing[at + 8:end].decode("latin-1"))
            at = end + 1
        return {name[:-2]: export_fighters.pack(disc, name[:-2])
                for name in names if re.fullmatch(r"V2WP_\d{3}[A-Z]\.o", name)}
    finally:
        retail.decode_packet, export_fighters.read_member = original


def weapon_table(xml: bytes) -> dict[str, dict]:
    """weapon.xml: grip/carry placements and material per weapon (`nm` = V2WP_<nm>)."""
    rows = {}
    for body in blocks(xml.decode("shift_jis", errors="replace").replace("\r", ""), "weapon"):
        fields = dict(re.findall(r"<(\w+)>([^<]*)</\w+>", body))
        rows[fields.pop("nm").strip()] = {k: ([float(x) for x in v.split(",")] if "," in v else v.strip())
                                          for k, v in fields.items()}
    return rows


def subway_match(stage_xml: str) -> dict | None:
    """The 125th Street Station's <subwaymatch>: the train car models, the track span and the glow lights."""
    try:
        body = section(stage_xml, "subwaymatch")
    except ValueError:
        return None
    lights = []
    for text in values(body, "trainlight"):
        name, *numbers = [part.strip() for part in text.split(",")]
        lights.append({"name": name, "translate": [float(v) for v in numbers[:3]], "rotate": [float(v) for v in numbers[3:6]]})
    return {"objects": values(body, "object"), "width": float(values(body, "width")[0]),
            "length": float(values(body, "length")[0]), "lights": lights,
            "off": [v.strip() for v in values(section(stage_xml, "defaultparticles"), "off")]}


def train_decode_packet(data: bytes, part: dict, cache: dict = {}):
    """weapon_decode_packet, but a stage model's weight table is sent once: later packets reuse the first one."""
    table, batches, batch = None, [], None
    for code in retail.vif_codes(data, part["packet"], part["qwc"]):
        if "unpack" not in code:
            continue
        kind, address, at, count = code["unpack"], code["address"], code["data"], code["count"]
        if kind == 0xC and not code["tops"] and address == 4:
            table = cache["table"] = [struct.unpack_from("<4I", data, at + 16 * i) for i in range(count)]
        elif kind == 0xC and address == 0:
            batch = {"header": struct.unpack_from("<4I", data, at), "bounds": b""}
        elif kind == 0xE and address in (1, 2, 3):
            batch["bounds"] += data[at:at + 4]
        elif kind == 0xD and address == 4:
            batch["a"] = struct.unpack_from(f"<{4 * count}H", data, at)
        elif kind == 0xD and not code["unsigned"]:
            batch["b"] = struct.unpack_from(f"<{4 * count}h", data, at)
        elif kind == 0xC and code["tops"] and address > 4:
            batch["c"] = struct.unpack_from(f"<{4 * count}I", data, at)
            batch["count"] = count
            batches.append(batch)
    table = table or cache.get("table")
    return (table, batches) if table is not None and batches else None


def train_models(disc: Disc, venue: str, names: list[str]) -> dict[str, bytes]:
    """Each subway car as a DJF1 skinned mesh (one bone, drawn in its bind pose like a weapon), textured from the venue's .ssh."""
    import export_fighters
    original = retail.decode_packet, export_fighters.read_member
    retail.decode_packet = train_decode_packet
    export_fighters.read_member = lambda d, name: (None, member(d, STAGE, venue + ".ssh" if name.endswith(".ssh") else name), None)
    try:
        return {name: export_fighters.pack(disc, name[:-2] if name.endswith(".o") else name) for name in names}
    finally:
        retail.decode_packet, export_fighters.read_member = original


# ---------------------------------------------------------------- Demolition cars (Gun Hill Garage)
#
# <demolitionmatch> lists the two cars of Gun Hill Garage as containers: a whole-car model (the body without its breakable
# panels) and one model per breakable panel. A panel's model holds its damage states as consecutive display-list blocks that
# each open with the skin microcode relocation: block 0 is `base`, then `break1`..`break3` (the order of its <geometry>
# names). A block draws one or more position packets, each with its own SHAPENAME material: that is the display map.
# A state named in an environment attack but not modelled hides the panel: `null` (the inner windscreen pieces) and
# `break4` (the fourth stage of a window, which has no mesh of its own).
#
# The models are in car space (front towards +x, left flank towards -z, floor at y = 0). The stage XML places no car. Each
# car sits where its glass and headlight particle emitters (the environment attacks' `<particle>` world positions) meet
# the centres of the panels they break. Fitting a yaw and a translation to those anchors (CAR_ANCHORS, checked by
# test_extract.py) leaves at most 1.7 units of residual, which is the precision of the hand-placed emitters.
CAR_PLACEMENT = {   # container -> rotate Y (degrees, the stage XML convention) and translate
    "V2BG_17A_B": {"translate": [-51.0, 0.0, -44.6], "rotate": [0.0, -30.0, 0.0]},
    "V2BG_17A_A": {"translate": [47.9, 0.0, -43.4], "rotate": [0.0, -150.0, 0.0]},
}
# panel -> (centre x, centre z in car space, emitter x, z in the world) for every anchor used
CAR_ANCHORS = {
    "V2BG_17A_B": {"P": (2.05, 10.75, -54, -34), "O": (14.65, 10.7, -45, -29), "N": (21.35, 0.0, -33, -34),
                   "L": (37.85, 9.55, -22, -17), "K": (37.85, -9.55, -13, -33), "Q": (-10.5, 10.8, -66, -41)},
    "V2BG_17A_A": {"L": (17.8, 0.0, 32, -35), "M": (11.4, -11.5, 45, -28), "N": (-1.85, -11.5, 55, -34),
                   "O": (-14.65, -11.7, 66, -40)},
}
STATE_HIDDEN = ("break4", "null")


def demolition_match(objects_xml: str) -> list[dict]:
    """<demolitionmatch>: each car container and its models, whole-car model first."""
    try:
        body = section(objects_xml, "demolitionmatch")
    except ValueError:
        return []
    return [{"name": values(c, "name")[0], "models": values(c, "model")} for c in blocks(body, "container")]


def car_blocks(blob: bytes, name: str, mesh: dict, states: bool = True) -> list[list[tuple[int, str]]]:
    """The display map of a model: per damage state, the (part index, SHAPENAME) it draws."""
    data, local, external = elf_links(blob, f"__Model:::{name}_branch")
    word = lambda at: U32.unpack_from(data, at)[0]
    parts = {p["packet"]: i for i, p in enumerate(mesh["parts"])}
    found, groups, shape, current = [], {}, None, None
    for at in sorted(local.keys() | external.keys()):
        symbol = external.get(at)
        if symbol is not None:
            if "__EAGLMicroCode" in symbol:
                current, shape = [], None
                groups.setdefault(symbol, []).append(current)
            match = re.search(r";SHAPENAME=(\w{4}),1;", symbol)
            if match:
                shape = match[1]
            continue
        target = local[at]
        draws = []
        if word(at - 4) == 0x04000002 and word(target) == 0x50000000:
            tag = local[target + 4]
            while (head := word(tag)) >> 28 in (0, 1, 3):
                if head >> 28 == 3 and local.get(tag + 4) in parts:
                    draws.append(parts[local[tag + 4]])
                tag += 16 if head >> 28 != 1 else 16 + 16 * (head & 0xFFFF)
        elif target in parts and word(at - 4) >> 28 == 3:
            draws.append(parts[target])
        if draws and current is not None:
            current.extend((index, shape) for index in draws)
    # A panel drawn with two skin microcodes lists the blocks of each microcode in turn: state k is the k-th block of every group.
    counts = {len(blocks_) for blocks_ in groups.values()} if states else {1}
    if not states:   # the whole-car model has no states: everything it draws, in order
        groups = {"": [sum((b for blocks_ in groups.values() for b in blocks_), [])]}
    if len(counts) != 1:
        raise ValueError(f"{name}: microcode groups of {sorted(len(b) for b in groups.values())} blocks")
    found = [sum((blocks_[k] for blocks_ in groups.values()), []) for k in range(counts.pop())]
    reached = sorted(i for block in found for i, _ in block)
    if reached != list(range(len(mesh["parts"]))):
        raise ValueError(f"{name}: display lists reach parts {reached} of {len(mesh['parts'])}")
    return found


def car_model(disc: Disc, venue: str, container: dict, objects: dict[str, list[str]]) -> tuple[bytes, dict]:
    """One car as a DJF1 mesh (bind pose, like a weapon). Each batch names its panel and damage state; the whole-car
    model's batches carry no panel and are always drawn."""
    ssh = textures(member(disc, STAGE, venue + ".ssh"))
    vertices, elements, batches, panels, images = bytearray(), [], [], [], {}
    import export_fighters
    original = retail.decode_packet
    try:
        for name in container["models"]:
            blob = member(disc, STAGE, name + ".o")
            cache = {}
            retail.decode_packet = lambda d, p, cache=cache: train_decode_packet(d, p, cache)
            # Panels are drawn in car space, unskinned: no bone transform is applied, so the skeleton is not decoded.
            elf = retail.Elf(blob)
            mesh = retail.build_mesh(elf, [{} for s, _, _ in elf.symbols if s.startswith("__Bone:::root.")])
            states = objects.get(name)
            display = car_blocks(blob, name, mesh, states is not None)
            if states is not None:
                if len(display) > len(states):
                    raise ValueError(f"{name}: {len(display)} blocks for states {states}")
                panels.append({"name": name, "states": states, "hidden": [s for s in STATE_HIDDEN if s not in states],
                               "modelled": states[:len(display)]})
            base = len(vertices) // export_fighters.VERTEX.size
            for i in range(len(mesh["positions"]) // 3):
                values_ = []
                for key, n in (("positions", 3), ("normals", 3), ("uvs", 2), ("joints", 4), ("weights", 4)):
                    values_.extend(mesh[key][n * i:n * (i + 1)])
                vertices.extend(export_fighters.VERTEX.pack(*values_))
            for k, block in enumerate(display):
                for shape in dict.fromkeys(shape for _, shape in block):
                    triangles = [i + base for part, material in block if material == shape
                                 for i in mesh["indices"][mesh["parts"][part]["firstIndex"]:
                                                          mesh["parts"][part]["firstIndex"] + mesh["parts"][part]["indexCount"]]]
                    if shape not in ssh:
                        raise ValueError(f"{name}: material {shape} is not in {venue}.ssh")
                    images[shape] = ssh[shape]
                    entry = {"shape": shape, "first": len(elements), "count": len(triangles)}
                    if states is not None:
                        entry.update({"object": name, "state": states[k]})
                    batches.append(entry)
                    elements.extend(triangles)
    finally:
        retail.decode_packet = original
    if len(vertices) // export_fighters.VERTEX.size > 65535:
        raise ValueError(f"{container['name']}: too many vertices for 16-bit indices")
    payload = bytearray(vertices)
    payload.extend(struct.pack(f"<{len(elements)}H", *elements))
    textures_ = {}
    for shape, image in sorted(images.items()):
        textures_[shape] = [len(payload), len(image)]
        payload.extend(image)
    meta = {"model": container["name"], "vertices": len(vertices) // export_fighters.VERTEX.size,
            "indices": len(elements), "batches": batches, "textures": textures_, "bones": []}
    header = json.dumps(meta, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    blob = gzip.compress(b"DJF1" + U32.pack(len(header)) + header + bytes(payload), compresslevel=9, mtime=0)
    return blob, {"name": container["name"], "file": f"cars/{container['name']}.skin.gz", "approximate": True,
                  "placement": CAR_PLACEMENT[container["name"]], "objects": panels}


def build_weapons(iso: Path) -> dict[str, bytes]:
    disc = Disc(str(iso))
    try:
        models = weapon_models(disc)
        xml = member(disc, WEAPONS, "weapon.xml")
    finally:
        disc.close()
    table = weapon_table(xml)
    files = {f"{name}.skin.gz": blob for name, blob in models.items()}
    index = {name: {"file": f"{name}.skin.gz", **table.get(name[6:], {})} for name in sorted(models)}
    files["index.json"] = (json.dumps({"format": "def-jam-ps2-weapons/1", "sourceSha256": sha256(xml),
                                       "models": index}, indent=1) + "\n").encode()
    return files


# ---------------------------------------------------------------- build

EVENT_TABLE = 0x379f70   # retail table of environment-event names, indexed by the id in the event queue
EVENT_COUNT = 468        # 0x191be8 rejects ids >= 468


def event_names(disc: Disc) -> list[str]:
    """Names of the retail environment events ("02A_1A"...). Fighter code queues them by index."""
    delta = 0x100000 - 0x1000
    exe = lambda vaddr, size: disc.read("/SLUS_210.04", vaddr - delta, size)
    names = []
    for pointer, in struct.iter_unpack("<I", exe(EVENT_TABLE, EVENT_COUNT * 4)):
        names.append(exe(pointer, 16).split(b"\0")[0].decode("ascii"))
    return names


def optional(fn, *args, default):
    try:
        return fn(*args)
    except (ValueError, IndexError):   # the tag is absent from this venue's XML
        return default


def single_state(name: str, blob: bytes) -> list[dict]:
    """Objects without named geometry states are one static model."""
    vertices, indices, meta = venues.geometry(name, blob)
    return [{"vertices": vertices, "indices": indices, "meta": meta, "boundsRecord": None}]


def venue_props(disc: Disc, venue: str, objects_xml: str) -> tuple[list[dict], dict, list[dict], dict]:
    """Decode every stage object of one venue except the venue's own base mesh."""
    objects, decoded, skipped, sources = [], {}, [], {}
    for obj in stage_objects(objects_xml):
        if obj["name"] == venue:
            continue
        try:
            blob = member(disc, STAGE, obj["name"] + ".o")
        except (KeyError, ValueError):
            skipped.append({"name": obj["name"], "reason": "no model file"})
            continue
        try:
            states = prop_states(obj["name"], blob) if obj["geometry"] else single_state(obj["name"], blob)
            if len(states) != max(1, len(obj["geometry"])):
                raise ValueError(f"{len(states)} blocks for {len(obj['geometry'])} named states")
        except ValueError as error:
            skipped.append({"name": obj["name"], "reason": str(error).split(", materials")[0]})
            continue
        obj = {**obj, "geometry": obj["geometry"] or ["base"]}
        objects.append(obj)
        decoded[obj["name"]] = states
        sources[obj["name"] + ".o"] = sha256(blob)
    return objects, decoded, skipped, sources


def crowd_locators(entity_text: str) -> dict[str, str]:
    """venue -> instanced-crowd layout name, from ASSETS/ENTITY.XML."""
    found = {}
    for body in re.findall(r"<entity>(.*?)</entity>", entity_text, re.S):
        name = values(body, "name")[0]
        locator = values(body, "instancecrowdlocator")
        if name.startswith("V2BG_") and locator:
            found[name] = locator[0]
    return found


def build(iso: Path, venue: str = "V2BG_02A") -> dict[str, bytes]:
    """Files for one venue: props.scene.gz, scenery.json and, when the venue has one, its crowd."""
    global VENUE
    VENUE = venue
    disc = Disc(str(iso))
    crowd_blob = packed_crowd = crowd_header = layout_name = None
    try:
        get = lambda archive, name: member(disc, archive, name)
        entity_blob = disc.read(ENTITY, 0, ENTITY_BYTES)
        stage_xml_blob = get(STAGE, f"{venue}.xml")
        objects_xml_blob = get(STAGE, f"{venue}_O.xml")
        ssh_blob = get(STAGE, f"{venue}.ssh")
        stage_xml, objects_xml = stage_text(stage_xml_blob), stage_text(objects_xml_blob)
        sources = {f"{venue}.xml": sha256(stage_xml_blob), f"{venue}_O.xml": sha256(objects_xml_blob),
                   f"{venue}.ssh": sha256(ssh_blob)}
        objects, decoded, skipped, object_sources = venue_props(disc, venue, objects_xml)
        sources.update(object_sources)
        subway = optional(subway_match, objects_xml, default=None)
        trains = {}
        if subway:
            trains = train_models(disc, venue, subway["objects"])
            raw = gzip.decompress(trains[subway["objects"][0]])
            subway["bounds"] = json.loads(raw[8:8 + U32.unpack_from(raw, 4)[0]])["bounds"]
            skipped = [x for x in skipped if x["name"] not in subway["objects"]]
            for name in subway["objects"]:
                sources[name + ".o"] = sha256(member(disc, STAGE, name + ".o"))
        cars = []
        car_files = {}
        for container in optional(demolition_match, objects_xml, default=[]):
            states = {o["name"]: o["geometry"] for o in stage_objects(objects_xml) if o["geometry"]}
            blob, entry = car_model(disc, venue, container, states)
            car_files[entry["file"]] = blob
            cars.append(entry)
            taken = set(container["models"])
            skipped = [x for x in skipped if x["name"] not in taken]
            objects = [o for o in objects if o["name"] not in taken]
            for name in container["models"]:
                sources[name + ".o"] = sha256(member(disc, STAGE, name + ".o"))
        props = props_header = None
        if objects:
            props, props_header = pack_props(objects, decoded, textures(ssh_blob))
        layout_name = crowd_locators(entity_blob.decode("latin-1")).get(venue)
        lighting = []
        for setting in entity_lighting(entity_blob.decode("latin-1")).get(venue, []):
            try:
                irr = get(STAGE, setting + ".irr")
            except (KeyError, ValueError):
                continue
            sources[setting + ".irr"] = sha256(irr)
            lighting.append({"name": setting, "sets": parse_irr(irr)})
        sources["ENTITY.XML"] = sha256(entity_blob)
        crowd = layout = None
        if layout_name:
            layout_blob = get(CROWD, layout_name + ".o")
            layout = crowd_layout(layout_blob)
            sources[layout_name + ".o"] = sha256(layout_blob)
            crowd_blob = get(CROWD, CROWD_MODEL + ".o")
            crowd_ssh = get(CROWD, CROWD_MODEL + ".ssh")
            crowd_xml = get(CROWD, CROWD_MODEL + ".xml")
            crowd = decode_crowd(crowd_blob)
            images = textures(crowd_ssh)
            if list(images) != ["Low_"]:
                raise ValueError("unexpected crowd textures")
            loops = crowd_loops(crowd, crowd_xml.decode("ascii"))
            for name, blob in ((CROWD_MODEL + ".o", crowd_blob), (CROWD_MODEL + ".ssh", crowd_ssh),
                               (CROWD_MODEL + ".xml", crowd_xml)):
                sources[name] = sha256(blob)
            packed_crowd, crowd_header = pack_crowd(crowd, layout if venue == "V2BG_02A" else [],
                                                    images["Low_"], loops)
    finally:
        disc.close()

    alpha = {p["name"].replace("alpha_", "V2BG_"): p
             for p in optional(placements, objects_xml, "alphaposition", "alpha", default=[])}
    known = {o["name"] for o in objects} | {s["name"] for s in skipped}
    own = next((o for o in stage_objects(objects_xml) if o["name"] == venue), None)
    scenery = {
        "format": "def-jam-ps2-scenery/1",
        "venue": venue,
        "sources": {"archives": {"stage": STAGE[1:], "crowd": CROWD[1:]}, "sha256": sources},
        "props": [{"name": o["name"], "alpha": o["alpha"], "states": o["geometry"],
                   "morphs": o["morphs"],
                   # Without an alphaposition entry, the model is already in venue space.
                   "placement": ({k: alpha[o["name"]][k] for k in ("translate", "rotate")}
                                 if o["name"] in alpha else None)}
                  for o in objects],
        "undecodedProps": skipped,
        # alphaposition entries whose object has no stage-object entry (kept, not applied)
        "unmatchedPlacements": sorted(set(alpha) - known),
        "venueMorphs": own["morphs"] if own else [],
        "environmentAttacks": optional(environment_attacks, stage_xml, default=[]),
        "nearCrowd": optional(placements, objects_xml, "crowdposition", "crowd", default=[]),
        "weapons": [{**w, "model": "V2WP_" + w["name"].split("_")[-1]}
                    for w in optional(placements, objects_xml, "weaponposition", "weapon", default=[])],
        "hiddenWeapons": optional(lambda: values(section(stage_xml, "hiddenweapon"), "name"), default=[]),
        "hiddenWeaponModels": optional(lambda: ["V2WP_" + n.split("_")[-1]
                                                for n in values(section(stage_xml, "hiddenweapon"), "name")], default=[]),
        "stageWeapon": optional(stage_weapon, stage_xml, default=None),
        "droppedWeaponModels": optional(lambda: ["V2WP_0" + d if len(d) == 3 else "V2WP_" + d
                                                 for d in values(section(stage_xml, "stageweapon"), "drop")], default=[]),
        "crowdGroup": optional(lambda: {k: int(values(stage_xml, f"crowdgroup{k}num")[0])
                                        for k in ("normal", "reduced")}, default=None),
        "crowdModelRatio": optional(lambda: {tag: vector(values(section(stage_xml, "crowdsmodelratio"), tag)[0])
                                             for tag in ("sex", "class", "seasonal", "racial", "brightness",
                                                         "temperature", "vividness")}, default=None),
        "defaultParticles": optional(lambda: [[p.strip() for p in v.split(",")]
                                              for v in values(section(stage_xml, "defaultparticles"), "particle")],
                                     default=[]),
        "propsFile": "props.scene.gz" if props else None,
        "instancedCrowd": None,
    }
    if subway:
        scenery["subway"] = subway
    if cars:
        scenery["cars"] = cars
    files = {"scenery.json": None}
    if lighting:
        scenery["lighting"] = {"file": "lighting.json", "settings": [x["name"] for x in lighting]}
        files["lighting.json"] = (json.dumps({"format": "def-jam-ps2-irradiance/1", "settings": lighting},
                                             separators=(",", ":")) + "\n").encode()
    if props:
        files["props.scene.gz"] = props
    for name, blob in trains.items():
        files[f"trains/{name}.skin.gz"] = blob
    files.update(car_files)
    if crowd_header:
        scenery["instancedCrowd"] = {"model": CROWD_MODEL, "layout": layout_name,
                                     "frames": crowd_header["frames"], "loops": crowd_header["loops"],
                                     "instances": len(layout)}
        if venue == "V2BG_02A":
            scenery["instancedCrowd"]["file"] = "crowd.bin.gz"
            files["crowd.bin.gz"] = packed_crowd
        else:
            # The retail model is the same in every venue; only the layout differs.
            scenery["instancedCrowd"]["modelFile"] = "../crowd/icrowd01.crowd.gz"
            scenery["instancedCrowd"]["placements"] = layout
            files["../crowd/icrowd01.crowd.gz"] = packed_crowd
    # crowd_bank.py writes <dir>/people.json (retail-rig spectators); the manifest only records that it is there
    if (OUTPUT.parent / directory(venue) / "people.json").exists():
        scenery["people"] = True
    # particles.py writes <dir>/particles.{json,png} (the stage's JDI effects)
    if (OUTPUT.parent / directory(venue) / "particles.json").exists():
        scenery["particles"] = True
    # texanim.py writes <dir>/texanim.{json,png} (animated flame planes, Red Hook only)
    if (OUTPUT.parent / directory(venue) / "texanim.json").exists():
        scenery["texanim"] = True
    files["scenery.json"] = (json.dumps(scenery, indent=1, ensure_ascii=False) + "\n").encode()
    return files


def venue_list() -> list[str]:
    inventory = json.loads((REPO / "ps2" / "content" / "inventory.json").read_text())
    return sorted(v["file"] for v in inventory["venues"])


def directory(venue: str) -> str:
    return "foundation" if venue == "V2BG_02A" else venue


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("iso", type=Path, nargs="?", default=DEFAULT_ISO)
    ap.add_argument("--venue", default="all", help="V2BG_xx or all")
    ap.add_argument("--check", action="store_true", help="compare with the committed files")
    args = ap.parse_args(argv)
    chosen = venue_list() if args.venue == "all" else [args.venue]
    bad = []
    index = {}
    for venue in chosen:
        built = build(args.iso, venue)
        manifest = json.loads(built["scenery.json"])
        crowd = manifest["instancedCrowd"]
        index[venue] = {"dir": directory(venue), "props": [p["name"] for p in manifest["props"]],
                        "propStates": {p["name"]: p["states"] for p in manifest["props"]},
                        "crowdInstances": crowd["instances"] if crowd else 0,
                        "nearCrowdPositions": len(manifest["nearCrowd"]),
                        "lighting": manifest.get("lighting", {}).get("settings", []),
                        "undecodedProps": [p["name"] for p in manifest["undecodedProps"]]}
        if manifest.get("subway"):
            index[venue]["trains"] = manifest["subway"]["objects"]
        if manifest.get("cars"):
            index[venue]["cars"] = [car["file"] for car in manifest["cars"]]
        # crowd_bank.py writes <dir>/people.json (retail-rig spectators); the index only records that it is there
        shown = OUTPUT.parent / directory(venue) / "people.json"
        if shown.exists():
            index[venue]["people"] = len(json.loads(shown.read_text())["spectators"])
        # particles.py writes <dir>/particles.{json,png}; the index records the effect count
        effects = OUTPUT.parent / directory(venue) / "particles.json"
        if effects.exists():
            index[venue]["particles"] = len(json.loads(effects.read_text())["effects"])
        planes = OUTPUT.parent / directory(venue) / "texanim.json"
        if planes.exists():
            index[venue]["texanim"] = len(json.loads(planes.read_text())["planes"])
        for name, blob in built.items():
            path = OUTPUT.parent / directory(venue) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if args.check:
                current = path.read_bytes() if path.exists() else b""
                same = (gzip.decompress(current) == gzip.decompress(blob)) if name.endswith(".gz") and current \
                    else current == blob
                if not same:
                    bad.append(str(path.relative_to(OUTPUT.parent)))
            else:
                path.write_bytes(blob)
    if args.venue == "all":
        for name, blob in build_weapons(args.iso).items():
            path = OUTPUT.parent / "weapons" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if args.check:
                same = path.exists() and (gzip.decompress(path.read_bytes()) == gzip.decompress(blob)
                                          if name.endswith(".gz") else path.read_bytes() == blob)
                if not same:
                    bad.append("weapons/" + name)
            else:
                path.write_bytes(blob)
        disc = Disc(str(args.iso))
        try:
            events = {"format": "def-jam-ps2-environment-events/1", "queue": 0x476e28, "names": event_names(disc),
                      "weaponManager": 0x472144, "weaponModels": weapon_names(disc)}
        finally:
            disc.close()
        blob = (json.dumps(events, indent=1) + "\n").encode()
        path = OUTPUT.parent / "events.json"
        if args.check:
            if not path.exists() or path.read_bytes() != blob:
                bad.append("events.json")
        else:
            path.write_bytes(blob)
        blob = (json.dumps(index, indent=1) + "\n").encode()
        path = OUTPUT.parent / "index.json"
        if args.check:
            if not path.exists() or path.read_bytes() != blob:
                bad.append("index.json")
        else:
            path.write_bytes(blob)
    if bad:
        print("out of date: " + ", ".join(bad))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
