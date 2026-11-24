// SLUS-21004 0x16ad18 blends the ten RGB vectors uploaded to VU1.
import { fetchPacked } from "../viewer/scene.mjs";

export async function loadLighting(venue, { signal, base = new URL("./", import.meta.url) } = {}) {
  const dir = new URL(venue === "V2BG_02A" ? "foundation/" : `${venue}/`, base);
  return JSON.parse(new TextDecoder().decode(await fetchPacked(new URL("lighting.json", dir), signal)));
}

// 0x32eb58 returns the dot product of the displacement with itself.
export function sampleIrradiance(set, position, out = new Float32Array(30)) {
  out.fill(0);
  let total = 0;
  for (let i = 0; i < set.spheres.length; i++) {
    const [x, y, z] = set.spheres[i];
    const dx = x - position[0], dy = y - position[1], dz = z - position[2];
    const weight = 1 / Math.max(1e-10, dx*dx + dy*dy + dz*dz);
    const probe = set.matrices[i];
    total += weight;
    for (let k = 0; k < 10; k++) {
      for (let c = 0; c < 3; c++) out[3*k+c] += weight * probe[k][c];
    }
  }
  if (total) {
    const scale = set.intensityMultiplier / total;
    for (let i = 0; i < out.length; i++) out[i] *= scale;
  }
  return out;
}

// IrradTexture_Skin0 reads VU memory 0x10f..0x118. Cross and linear terms
// each occur once. The shader uses the skinned normal without renormalizing it.
export function irradiance(k, [x, y, z], out = [0, 0, 0]) {
  for (let c = 0; c < 3; c++) {
    out[c] = k[c] + k[3+c]*x*x + k[6+c]*y*y + k[9+c]*z*z
      + k[12+c]*x*y + k[15+c]*x*z + k[18+c]*y*z
      + k[21+c]*x + k[24+c]*y + k[27+c]*z;
  }
  return out;
}

export const irradianceGLSL = `
uniform vec3 irradianceCoefficients[10];
vec3 irradiance(vec3 n) {
  return irradianceCoefficients[0]
    + irradianceCoefficients[1]*n.x*n.x + irradianceCoefficients[2]*n.y*n.y + irradianceCoefficients[3]*n.z*n.z
    + irradianceCoefficients[4]*n.x*n.y + irradianceCoefficients[5]*n.x*n.z + irradianceCoefficients[6]*n.y*n.z
    + irradianceCoefficients[7]*n.x + irradianceCoefficients[8]*n.y + irradianceCoefficients[9]*n.z;
}
vec3 vertexIrradiance(vec3 n) {
  // The skin packet supplies GS neutral grey 0x80. The VU packs unsigned bytes.
  return clamp(roundEven(128.0 * irradiance(n)), 0.0, 255.0) / 128.0;
}`;
