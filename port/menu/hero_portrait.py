"""Render the unlisted E3 Hero's selector portrait from his packed retail mesh."""
import gzip
from io import BytesIO
import json
import math
import struct

from PIL import Image, ImageDraw, ImageFont


def export_hero(root, output):
    data = gzip.decompress((root / "port/render/fighters/V2IP_999A.skin.gz").read_bytes())
    meta_end = 8 + struct.unpack_from("<I", data, 4)[0]
    mesh = json.loads(data[8:meta_end])
    points = [struct.unpack_from("<8f", data, meta_end + i * 52) for i in range(mesh["vertices"])]
    indices = struct.unpack_from(f"<{mesh['indices']}H", data, meta_end + len(points) * 52)
    # Frame the head and chest on the same 256 x 336 transparent canvas as the retail portraits.
    scale = 47
    top = max(p[1] for p in points)
    angle = math.radians(-12)
    cosine, sine = math.cos(angle), math.sin(angle)
    projected = [(128 + scale * (x * cosine + z * sine), 8 + (top - y) * scale,
                  z * cosine - x * sine, u, v, 0.82 + 0.18 * max(0, ny * 0.5 + nz * 0.85))
                 for x, y, z, nx, ny, nz, u, v in points]
    portrait = Image.new("RGBA", (256, 336))
    pixels = portrait.load()
    depths = [-math.inf] * (256 * 336)
    for batch in mesh["batches"]:
        offset, size = mesh["textures"][batch["shape"]]
        texture = Image.open(BytesIO(data[meta_end + offset:meta_end + offset + size])).convert("RGBA")
        texels = texture.load()
        for i in range(batch["first"], batch["first"] + batch["count"], 3):
            a, b, c = (projected[j] for j in indices[i:i + 3])
            x0, y0 = a[:2]
            ux, uy = b[0] - x0, b[1] - y0
            vx, vy = c[0] - x0, c[1] - y0
            area = ux * vy - uy * vx
            if abs(area) < 1e-8:
                continue
            for y in range(max(0, math.floor(min(y0, b[1], c[1]))), min(336, math.ceil(max(y0, b[1], c[1])))):
                for x in range(max(0, math.floor(min(x0, b[0], c[0]))), min(256, math.ceil(max(x0, b[0], c[0])))):
                    dx, dy = x + 0.5 - x0, y + 0.5 - y0
                    w1, w2 = (dx * vy - dy * vx) / area, (ux * dy - uy * dx) / area
                    w0 = 1 - w1 - w2
                    if min(w0, w1, w2) < 0:
                        continue
                    z, u, v, light = (w0 * a[k] + w1 * b[k] + w2 * c[k] for k in range(2, 6))
                    at = y * 256 + x
                    if z <= depths[at]:
                        continue
                    r, g, bval, alpha = texels[min(texture.width - 1, max(0, int(u * texture.width))),
                                              min(texture.height - 1, max(0, int(v * texture.height)))]
                    if not alpha:
                        continue
                    depths[at] = z
                    pixels[x, y] = (round(r * light), round(g * light), round(bval * light), 255)
    portrait.crop((0, 0, 256, 256)).save(output / "141-h.png")
    portrait.crop((0, 256, 256, 336)).save(output / "141-c.png")
    name = Image.new("RGBA", (208, 100))
    font = ImageFont.truetype(str(root / "port/hud/names.ttf"), 42)
    ImageDraw.Draw(name).text((8, 25), "HERO", font=font, fill="#f3e2bd", stroke_width=2, stroke_fill="#30271f")
    name.save(output / "141-n.png")
