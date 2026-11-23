// Contact records and queries from retail SLUS-21004. All positions use PS2 world units.
const f = Math.fround;
const sum = (a, b) => f(a + b);
const sub = (a, b) => f(a - b);
const mul = (a, b) => f(a * b);

export function decodeCollision(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint32(0) !== 0x434c4c49) throw new Error("Invalid CLLI header");
  const countOffset = 8 + view.getUint32(4, true) * 48;
  if (countOffset > view.byteLength - 4) throw new Error("Invalid CLLI group count");
  const count = view.getUint32(countOffset, true);
  if (countOffset + 4 + count * 72 !== view.byteLength) throw new Error("Invalid CLLI plane count");
  const planes = [];
  for (let p = countOffset + 4; p < view.byteLength; p += 72) {
    const flags = view.getUint32(p, true);
    const vector = at => [0, 4, 8].map(offset => view.getFloat32(p + at + offset, true));
    planes.push({
      flags,
      vertices: (flags & 0x1000000 ? [4,16,28] : [4,16,28,40]).map(vector),
      normal: vector(52),
      area: view.getFloat32(p + 64, true),
      group: view.getUint32(p + 68, true),
    });
  }
  return planes;
}

// 0x2e30d8 compares the sum of the edge triangle areas to a precomputed value.
// The cross products are scaled before taking the norm, including at boundaries.
export function containsPoint(plane, point) {
  const { vertices, area } = plane;
  let total = 0;
  let a = vertices[0].map((n,i) => sub(n, point[i]));
  for (let j = 1; j <= vertices.length; j++) {
    const b = vertices[j % vertices.length].map((n,i) => sub(n, point[i]));
    const x = mul(sub(mul(a[1], b[2]), mul(a[2], b[1])), f(0.1));
    const y = mul(sub(mul(a[2], b[0]), mul(a[0], b[2])), f(0.1));
    const z = mul(sub(mul(a[0], b[1]), mul(a[1], b[0])), f(0.1));
    total = sum(total, f(Math.sqrt(sum(sum(mul(x,x), mul(y,y)), mul(z,z)))));
    a = b;
  }
  return Math.abs(sub(area, total)) < f(0.01);
}

// 0x2e1000 returns 1 for the face, 2/3 for a shallow/deep corner contact.
// Its corner fallback explicitly probes only the first two vertices.
export function contactPlane(plane, point, radius, depthScale) {
  const { vertices, normal } = plane;
  const [x,y,z] = point;
  const v = vertices[0];
  const d = sum(sum(mul(sub(x,v[0]), normal[0]), mul(sub(y,v[1]), normal[1])), mul(sub(z,v[2]), normal[2]));
  const gap = sub(d, radius);
  if (gap >= 0 || gap <= -mul(radius, depthScale)) return null;
  const projected = point.map((n,i) => sum(n, mul(-d, normal[i])));
  const depth = Math.abs(gap);
  if (containsPoint(plane, projected)) return { type: 1, depth };
  for (let i = 0; i < 2; i++) {
    const dx = sub(x, vertices[i][0]), dz = sub(z, vertices[i][2]);
    const length = f(Math.sqrt(sum(mul(dx,dx), mul(dz,dz))));
    if (length > radius) continue;
    const overlap = sub(radius, length);
    const direction = length > f(0.0001) ? [f(dx/length), 0, f(dz/length)] : [0,0,0];
    return { type: overlap < mul(radius, 0.5) ? 2 : 3, depth, overlap, direction };
  }
  return null;
}
