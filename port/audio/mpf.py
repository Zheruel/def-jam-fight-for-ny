"""EA PathFinder music graph (`tune.mpf`, "PFDx", version 4) as used by the retail PS2 US disc.

Layout (little endian, as read from the retail files; vgmstream only names the sample table):

    0x00 "xDFP"  0x04 version (4)  0x0d tracks  0x0e sections  0x0f events  0x10 routers  0x11 vars
    0x12 u16 node count   0x20 u16[nodes] node offsets (x4)
    node: u16 sample, u16 flags (low byte = section id), u32 be {bits 20..23: sub-entry count, byte 0: kind},
          8 bytes (data), then `count` 4-byte sub-entries (lo u8, hi u8, target u16; 0xffff ends the section)
          kind 4 = plays sample `sample`; kind 1 = marker/junction.
    sub-entries: one entry = next node. Several entries are ranges [lo, hi) of a 0..127 draw (a weighted
          random choice). A pair (0,0,exit) + (1,127,loop) is a loop router: the game decides between
          leaving and looping, and its exit is the first entry.
    after the nodes: events (u16 offsets x4 -> action lists), routers, then per-track sample tables of
          (offset, milliseconds); vgmstream subsong N is sample N-1 of the whole table.

`fight_path` is the walk this module commits to for a fight: the section entered at node 0, waiting loops
played through once and left by their router exit, then the song body, which loops. What retail's events
send to leave a waiting loop is not decoded, so the router exits stand in for those events.
"""
import random
import struct


def parse(data):
    if data[:4] != b"xDFP" or data[4] != 4:
        raise ValueError("not a version 4 little-endian PFDx file")
    tracks, sections, events, routers = data[0x0d], data[0x0e], data[0x0f], data[0x10]
    count = struct.unpack_from("<H", data, 0x12)[0]
    nodes = []
    for index, offset in enumerate(struct.unpack_from(f"<{count}H", data, 0x20)):
        offset *= 4
        sample, flags = struct.unpack_from("<HH", data, offset)
        word = struct.unpack_from(">I", data, offset + 4)[0]
        subs = [(data[offset + 0x10 + 4 * k], data[offset + 0x11 + 4 * k], struct.unpack_from("<H", data, offset + 0x12 + 4 * k)[0])
                for k in range((word >> 20) & 0xF)]
        nodes.append({"i": index, "kind": word & 0xff, "sample": sample, "section": flags & 0xff, "flags": flags,
                      "subs": subs, "end": offset + 0x10 + 4 * len(subs)})
    # Sample tables sit after the events and routers (the same walk vgmstream does).
    last = nodes[-1]
    at = last["end"]
    event_offsets = [o * 4 for o in struct.unpack_from(f"<{events}H", data, at)]
    event = event_offsets[-1]
    event += 0x10 + ((struct.unpack_from(">I", data, event + 0x0c)[0] >> 8) & 0x3F) * 0x10
    table = struct.unpack_from("<I", data, event + routers * 4)[0] * 4
    starts = struct.unpack_from(f"<{tracks + 1}I", data, table)
    samples_at = table + (tracks + 1) * 4
    total = (starts[tracks] * 4 - samples_at) // 8
    samples = [struct.unpack_from("<II", data, samples_at + 8 * i) for i in range(total)]
    # track boundaries are byte offsets into the sample table
    bounds = [(s * 4 - samples_at) // 8 for s in starts]
    return {"tracks": tracks, "sections": sections, "events": events, "routers": routers, "nodes": nodes,
            "samples": samples, "trackSamples": [bounds[i + 1] - bounds[i] for i in range(tracks)],
            "eventOffsets": event_offsets}


def _router(node):
    subs = node["subs"]
    return len(subs) == 2 and subs[0][:2] == (0, 0) and subs[1][:2] == (1, 127)


def _forward(nodes, start, limit=4):
    out, i = [], start
    for _ in range(limit):
        if i == 0xffff or i in out:
            break
        out.append(i)
        subs = nodes[i]["subs"]
        if len(subs) != 1:
            break
        i = subs[0][2]
    return out


def fight_path(graph, seed=1, start=0):
    """Walk the graph from `start`: returns {"nodes": [...], "loopAt": index or None, "ends": bool}.

    Weighted branches draw from the seeded generator; a cycle with no branch in it is a waiting loop,
    played once and then left by the first loop router whose loop leads back into the path so far; a cycle with a branch is the song body.
    """
    nodes, rng = graph["nodes"], random.Random(seed)
    routers = [n for n in nodes if _router(n)]
    seq, seen, i = [], {}, start
    while True:
        if i == 0xffff:
            return {"nodes": seq, "loopAt": None, "ends": True}
        if i in seen:
            cycle = seq[seen[i]:]
            if any(len(nodes[n]["subs"]) > 1 for n in cycle):
                return {"nodes": seq, "loopAt": seen[i], "ends": False}
            exit_ = next((r["subs"][0][2] for r in routers
                          if r["subs"][0][2] not in seen and set(_forward(nodes, r["subs"][1][2], 12)) & set(seq)), None)
            if exit_ is None:
                return {"nodes": seq, "loopAt": seen[i], "ends": False}
            for n in cycle:  # the wait is over: its nodes may not be re-entered as a loop
                seen.pop(n, None)
            seen.update({n: -1 for n in cycle})
            i = exit_
            continue
        seen[i] = len(seq)
        seq.append(i)
        subs = nodes[i]["subs"]
        if not subs:
            return {"nodes": seq, "loopAt": None, "ends": True}
        if len(subs) == 1 or _router(nodes[i]):
            i = subs[0][2]
        else:
            draw = rng.random() * 127
            i = next((t for lo, hi, t in subs if lo <= draw < hi), subs[-1][2])


def samples_of(graph, nodes):
    return [graph["nodes"][n]["sample"] for n in nodes if graph["nodes"][n]["kind"] == 4]
