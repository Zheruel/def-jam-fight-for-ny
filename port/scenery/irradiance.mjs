// Retail EAGL irradiance lighting (.irr), decoded by extract.py into <venue>/lighting.json.
//
// A light set is a handful of probe spheres. The engine (SLUS-21004 0x16ae00) blends the probes by
// inverse distance to the character, weights normalised to 1, scales by intensityMultiplier, and hands
// ten (r, g, b) coefficients to the skin microcode. They are read as a symmetric 4x4 irradiance
// matrix; the order below makes the matrix pair M00 = -M11 that the data shows and gives the
// expected strong upward term:  [M33, M00, M11, M22, M01, M02, M12, M03, M13, M23].
// The microcode itself (VU1) is not disassembled, so that order and the final scale are inferred.
//
//   const { settings } = await loadLighting("V2BG_02A");
//   const set = settings[0].sets[0];                 // set 0 lights the fight; set 1 is another rig
//   const coefficients = sampleIrradiance(set, [x, y, z]);
//   const rgb = irradiance(coefficients, [nx, ny, nz]);
import { fetchPacked } from "../viewer/scene.mjs";

export async function loadLighting(venue, { signal, base = new URL("./", import.meta.url) } = {}) {
  const dir = new URL(venue === "V2BG_02A" ? "foundation/" : `${venue}/`, base);
  return JSON.parse(new TextDecoder().decode(await fetchPacked(new URL("lighting.json", dir), signal)));
}

/** Inverse-distance blend of a light set's probe matrices at `position`: Float32Array(30) = 10 x rgb. */
export function sampleIrradiance(set, position, out = new Float32Array(30)) {
  const weights = set.spheres.map(s => 1 / Math.max(1e-3, Math.hypot(position[0] - s[0], position[1] - s[1], position[2] - s[2])));
  const total = weights.reduce((a, b) => a + b, 0);
  out.fill(0);
  weights.forEach((w, i) => {
    const scale = w / total * set.intensityMultiplier;
    for (let k = 0; k < 10; k++) for (let c = 0; c < 3; c++) out[3 * k + c] += scale * set.matrices[i][k][c];
  });
  return out;
}

/** Irradiance n^T M n with n = (x, y, z, 1), per channel. Unclamped: callers clamp to taste. */
export function irradiance(k, normal, out = [0, 0, 0]) {
  const [x, y, z] = normal;
  for (let c = 0; c < 3; c++) {
    const [m33, m00, m11, m22, m01, m02, m12, m03, m13, m23] = Array.from({ length: 10 }, (_, i) => k[3 * i + c]);
    out[c] = m00 * x * x + m11 * y * y + m22 * z * z + m33
      + 2 * (m01 * x * y + m02 * x * z + m12 * y * z + m03 * x + m13 * y + m23 * z);
  }
  return out;
}

/** GLSL for the same evaluation: `uniform vec3 irradianceCoefficients[10]; vec3 irradiance(vec3 n)`. */
export const irradianceGLSL = `
uniform vec3 irradianceCoefficients[10];
vec3 irradiance(vec3 n) {
  vec3 c0 = irradianceCoefficients[0], m00 = irradianceCoefficients[1], m11 = irradianceCoefficients[2],
       m22 = irradianceCoefficients[3], m01 = irradianceCoefficients[4], m02 = irradianceCoefficients[5],
       m12 = irradianceCoefficients[6], m03 = irradianceCoefficients[7], m13 = irradianceCoefficients[8],
       m23 = irradianceCoefficients[9];
  return m00 * n.x * n.x + m11 * n.y * n.y + m22 * n.z * n.z + c0
    + 2.0 * (m01 * n.x * n.y + m02 * n.x * n.z + m12 * n.y * n.z + m03 * n.x + m13 * n.y + m23 * n.z);
}`;
