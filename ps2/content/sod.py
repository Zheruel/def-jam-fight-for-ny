"""Reads the retail disc files that define Def Jam: Fight for NY (SLUS-21004) unlocks.

Disc access is plain ISO9660 (a retail PS2 DVD only has the primary volume descriptor).
DJV2.SOD is EA's "SODB" object database. The layout decoded here is only what the unlock
inventory needs:

    0x00  "SODB", version 2, hash, SKMA offset, DATA offset, STRT offset
    SKMA  schema (field names are hashes only; not decoded)
    DATA  "DATA", class count, version 1, class name hashes[count], class header offsets[count]
          class header: name hash, index list, sub-list, instance count, ...
          index list:   index count, 1, index hashes[], index table offsets[]
          index table:  index hash, instance count, 1, instance key hashes[], record offsets[]
    STRT  "STRT", string count, then (hash, file offset) per string id

A live object handle is (class index << 24) | instance index; bit 23 is a flag the game masks
off (0xFF7FFFFF) whenever it compares handles. The instance index is the position in the
class's primary index table (the one whose hash equals the class hash), which is sorted by
instance key hash.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

SECTOR = 2048


class Disc:
    """Minimal ISO9660 reader: path lookup ignores case and the ';1' suffix."""

    def __init__(self, path):
        self._file = open(path, "rb")
        pvd = self._read(16 * SECTOR, SECTOR)
        if pvd[:6] != b"\x01CD001":
            raise ValueError(f"{path}: not an ISO9660 image")
        self.volume_id = pvd[40:72].decode("ascii", "replace").strip()
        self._root = pvd[156:190]

    def close(self):
        self._file.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _read(self, offset, size):
        self._file.seek(offset)
        data = self._file.read(size)
        if len(data) != size:
            raise ValueError("unexpected end of disc image")
        return data

    def _records(self, record):
        lba, size = struct.unpack_from("<I", record, 2)[0], struct.unpack_from("<I", record, 10)[0]
        data = self._read(lba * SECTOR, size)
        pos = 0
        while pos < len(data):
            length = data[pos]
            if not length:
                pos += SECTOR - pos % SECTOR
                continue
            entry = data[pos:pos + length]
            pos += length
            name = entry[33:33 + entry[32]]
            if name in (b"\x00", b"\x01"):
                continue
            yield name.decode("ascii").split(";")[0].upper(), entry

    def entry(self, path):
        """Returns (byte offset on disc, size) of a file."""
        record = self._root
        for part in path.strip("/").upper().split("/"):
            for name, child in self._records(record):
                if name == part:
                    record = child
                    break
            else:
                raise FileNotFoundError(path)
        return struct.unpack_from("<I", record, 2)[0] * SECTOR, struct.unpack_from("<I", record, 10)[0]

    def read(self, path):
        offset, size = self.entry(path)
        return self._read(offset, size)


@dataclass(frozen=True)
class SodClass:
    index: int
    hash: int
    header: int
    count: int
    records: tuple  # record file offsets, in instance-index order


class Sod:
    def __init__(self, data: bytes):
        if data[:4] != b"SODB" or self.u32(data, 4) != 2:
            raise ValueError("not a version 2 SODB database")
        self.data = data
        self.data_offset, self.strt_offset = self.u32(data, 16), self.u32(data, 20)
        if data[self.u32(data, 12):self.u32(data, 12) + 4] != b"SKMA":
            raise ValueError("SKMA chunk not found")
        if data[self.data_offset:self.data_offset + 4] != b"DATA":
            raise ValueError("DATA chunk not found")
        if data[self.strt_offset:self.strt_offset + 4] != b"STRT":
            raise ValueError("STRT chunk not found")
        self.string_count = self.u32(data, self.strt_offset + 4)
        count = self.u32(data, self.data_offset + 4)
        hashes = [self.u32(data, self.data_offset + 12 + 4 * i) for i in range(count)]
        headers = [self.u32(data, self.data_offset + 12 + 4 * (count + i)) for i in range(count)]
        self.classes = [self._class(i, h, o) for i, (h, o) in enumerate(zip(hashes, headers))]

    @staticmethod
    def u32(data, offset):
        return struct.unpack_from("<I", data, offset)[0]

    def _class(self, index, name_hash, header):
        d = self.data
        if self.u32(d, header) != name_hash:
            raise ValueError(f"class {index}: header hash mismatch")
        indexes, count = self.u32(d, header + 4), self.u32(d, header + 12)
        n = self.u32(d, indexes)
        index_hashes = [self.u32(d, indexes + 8 + 4 * i) for i in range(n)]
        tables = [self.u32(d, indexes + 8 + 4 * (n + i)) for i in range(n)]
        records = ()
        if name_hash in index_hashes:
            table = tables[index_hashes.index(name_hash)]
            if self.u32(d, table) != name_hash or self.u32(d, table + 4) != count:
                raise ValueError(f"class {index}: primary index mismatch")
            records = tuple(self.u32(d, table + 12 + 4 * (count + i)) for i in range(count))
        return SodClass(index, name_hash, header, count, records)

    def by_hash(self, name_hash):
        for cls in self.classes:
            if cls.hash == name_hash:
                return cls
        raise KeyError(hex(name_hash))

    def string(self, string_id):
        """Returns the string for an id, '' for the empty slot, or None when out of range."""
        if not 0 < string_id < self.string_count:
            return None
        offset = self.u32(self.data, self.strt_offset + 8 + 8 * string_id + 4)
        if not offset:
            return ""
        return self.data[offset:self.data.index(b"\0", offset)].decode("latin-1")

    def words(self, record, count):
        return [self.u32(self.data, record + 4 * i) for i in range(count)]
