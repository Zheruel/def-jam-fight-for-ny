"""Locates files inside an ISO9660 image (the PS2 DVD) without extracting it.

    with Iso9660("private/ps2/reference.iso") as disc:
        entry = disc.entry("/SCREENS/FEFLOW.XML")   # Entry(path, lba, size)
        data = disc.read("/SLUS_210.04")

Only the primary volume descriptor is used, which is all a retail PS2 disc has.
Lookups ignore case and the ";1" version suffix.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

SECTOR = 2048


@dataclass(frozen=True)
class Entry:
    path: str
    lba: int
    size: int

    @property
    def offset(self) -> int:
        return self.lba * SECTOR


class Iso9660:
    def __init__(self, path: str):
        self._file = open(path, "rb")
        try:
            pvd = self._read(16 * SECTOR, SECTOR)
            if pvd[0] != 1 or pvd[1:6] != b"CD001":
                raise ValueError(f"{path}: not an ISO9660 image")
            self.volume_id = pvd[40:72].decode("ascii", "replace").strip()
            self.blocks = struct.unpack_from("<I", pvd, 80)[0]
            root = pvd[156:156 + 34]
            self._entries: dict[str, Entry] = {}
            self._walk(*struct.unpack_from("<I", root, 2), struct.unpack_from("<I", root, 10)[0], "", 0)
        except Exception:
            self._file.close()
            raise

    def __enter__(self) -> "Iso9660":
        return self

    def __exit__(self, *_) -> None:
        self.close()

    def close(self) -> None:
        self._file.close()

    def _read(self, offset: int, size: int) -> bytes:
        self._file.seek(offset)
        data = self._file.read(size)
        if len(data) != size:
            raise ValueError(f"short read at {offset:#x}")
        return data

    def _walk(self, lba: int, size: int, prefix: str, depth: int) -> None:
        if depth > 16:
            raise ValueError("directory tree too deep")
        records = self._read(lba * SECTOR, size)
        pos = 0
        while pos < len(records):
            length = records[pos]
            if length == 0:  # records never cross a sector boundary
                pos = (pos // SECTOR + 1) * SECTOR
                continue
            record = records[pos:pos + length]
            pos += length
            name = record[33:33 + record[32]]
            if name in (b"\x00", b"\x01"):
                continue
            path = prefix + "/" + name.decode("ascii", "replace").split(";")[0]
            extent, data_size = struct.unpack_from("<I", record, 2)[0], struct.unpack_from("<I", record, 10)[0]
            if record[25] & 2:
                self._walk(extent, data_size, path, depth + 1)
            else:
                self._entries[path.upper()] = Entry(path, extent, data_size)

    def paths(self) -> list[str]:
        return sorted(e.path for e in self._entries.values())

    def entry(self, path: str) -> Entry:
        try:
            return self._entries[path.upper().split(";")[0]]
        except KeyError:
            raise FileNotFoundError(path) from None

    def read(self, path: str) -> bytes:
        e = self.entry(path)
        return self._read(e.offset, e.size)
