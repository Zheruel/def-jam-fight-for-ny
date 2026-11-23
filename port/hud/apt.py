"""Reader for the EA "Apt" front-end movies in SCREENS.VIV (.apt + .const + SHPS .ssh), enough to lay a screen out.

Little-endian, every record starts with a type word and the signature 0x09876543.

    movie (9)      frameCount, framesPtr, 0, characterCount, charactersPtr, width, height, msPerFrame ...
    characters     a pointer table; character n is characters[n]; character 0 is the movie itself
    image (7)      its own character number (the SSH picture is chosen by size, see `pair_pictures`)
    shape (1)      bounds l t r b, own character number; the textured quad of the image character before it
    sprite (5)     frameCount, framesPtr
    editText (2)   bounds, font, align, colour ARGB, size, flags, ..., initial text ptr, variable ptr
    frame          {itemCount, itemsPtr}; items point at frame items
    placeObject(3) flags, depth, character, a b c d (matrix), tx ty, colour, ... name ptr
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

SIGNATURE = 0x09876543
MOVIE, SHAPE, EDIT_TEXT, FONT, BUTTON, SPRITE, SOUND, IMAGE = 9, 1, 2, 3, 4, 5, 6, 7
PLACE, REMOVE = 3, 4


@dataclass
class Placement:
    character: int
    depth: int
    matrix: tuple          # a b c d tx ty
    name: str | None
    flags: int


@dataclass
class Apt:
    data: bytes
    characters: list = field(default_factory=list)
    size: tuple = (640, 480)

    def u32(self, at): return struct.unpack_from("<I", self.data, at)[0]
    def f32(self, at): return struct.unpack_from("<f", self.data, at)[0]

    def cstring(self, at):
        if not at or at >= len(self.data): return None
        end = self.data.find(b"\0", at)
        return self.data[at:end].decode("latin-1")

    def kind(self, n): return self.u32(self.characters[n])

    @classmethod
    def parse(cls, data: bytes) -> "Apt":
        apt = cls(data)
        movie = data.find(struct.pack("<II", MOVIE, SIGNATURE))
        if movie < 0:
            raise ValueError("not an Apt movie")
        count, table = apt.u32(movie + 0x14), apt.u32(movie + 0x18)
        apt.characters = [apt.u32(table + 4 * i) for i in range(count)]
        apt.size = (apt.u32(movie + 0x1c), apt.u32(movie + 0x20))
        return apt

    # -- records ------------------------------------------------------------------------------------------------
    def bounds(self, n):
        p = self.characters[n]
        return tuple(self.f32(p + 8 + 4 * i) for i in range(4))

    def edit_text(self, n):
        p = self.characters[n]
        return {"bounds": self.bounds(n), "font": self.u32(p + 0x18), "align": self.u32(p + 0x1c),
                "color": self.u32(p + 0x20), "size": self.f32(p + 0x24), "multiline": bool(self.u32(p + 0x28)),
                "text": self.cstring(self.u32(p + 0x34)), "variable": self.cstring(self.u32(p + 0x38))}

    def frames(self, n):
        """Frames of the movie (n == 0) or of a sprite character: a list of placement lists."""
        p = self.characters[n]
        count, ptr = self.u32(p + 8), self.u32(p + 12)
        if n == 0: count, ptr = self.u32(p + 8), self.u32(p + 12)
        out = []
        for i in range(count):
            items, items_ptr = self.u32(ptr + 8 * i), self.u32(ptr + 8 * i + 4)
            placed = []
            for k in range(items):
                item = self.u32(items_ptr + 4 * k)
                if self.u32(item) == PLACE:
                    placed.append(Placement(
                        character=self.u32(item + 12), depth=self.u32(item + 8),
                        matrix=tuple(self.f32(item + 16 + 4 * j) for j in range(4)) + (self.f32(item + 32), self.f32(item + 36)),
                        name=self.cstring(self.u32(item + 52)) if self.u32(item + 52) else None, flags=self.u32(item + 4)))
                elif self.u32(item) == REMOVE:
                    placed.append(Placement(-1, self.u32(item + 4), (1, 0, 0, 1, 0, 0), None, 0))
            out.append(placed)
        return out

    # -- layout -------------------------------------------------------------------------------------------------
    def flatten(self, sprite=0, frame=0, parent=(1, 0, 0, 1, 0, 0), path="", depth_limit=8):
        """Draw list of one frame: rectangles for shapes and boxes for edit text, in screen space."""
        if depth_limit < 0: return []
        frames = self.frames(sprite)
        if frame >= len(frames): return []
        # the display list at `frame` is every placement up to it, a later one at the same depth replacing it
        shown = {}
        for items in frames[:frame + 1]:
            for item in items:
                if item.character < 0: shown.pop(item.depth, None)
                else: shown[item.depth] = item
        out = []
        for depth in sorted(shown):
            item = shown[depth]
            m = compose(parent, item.matrix)
            kind = self.kind(item.character)
            label = f"{path}/{item.name or item.character}"
            if kind == SHAPE:
                out.append({"kind": "image", "character": item.character, "path": label, "depth": depth,
                            "rect": transform_rect(m, self.bounds(item.character))})
            elif kind == EDIT_TEXT:
                out.append({"kind": "text", "character": item.character, "path": label, "depth": depth,
                            "rect": transform_rect(m, self.bounds(item.character)), **self.edit_text(item.character)})
            elif kind == SPRITE:
                out += self.flatten(item.character, 0, m, label, depth_limit - 1)
        return out


def compose(p, c):
    """Matrix c placed inside matrix p; (a b c d tx ty) with x' = a x + c y + tx, y' = b x + d y + ty."""
    pa, pb, pc, pd, ptx, pty = p
    a, b, cc, d, tx, ty = c
    return (pa * a + pc * b, pb * a + pd * b, pa * cc + pc * d, pb * cc + pd * d,
            pa * tx + pc * ty + ptx, pb * tx + pd * ty + pty)


def transform_rect(m, bounds):
    l, t, r, b = bounds
    xs, ys = [], []
    for x, y in ((l, t), (r, t), (l, b), (r, b)):
        xs.append(m[0] * x + m[2] * y + m[4]); ys.append(m[1] * x + m[3] * y + m[5])
    return [min(xs), min(ys), max(xs), max(ys)]


def pair_pictures(apt: Apt, tags: list):
    """Which SSH picture each image shape shows. `tags` are the SHPS directory names, which are the image character
    numbers: image character n is followed by its textured quad, shape n + 1. Shapes with no image before them are plain
    fills or pictures the script loads at run time, so they have no entry."""
    have = {int(t) for t in tags if t.strip().isdigit()}
    return {n: str(n - 1) for n in range(len(apt.characters)) if apt.kind(n) == SHAPE and (n - 1) in have}
