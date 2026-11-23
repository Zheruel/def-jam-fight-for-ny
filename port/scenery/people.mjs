// Skinned spectators (the retail near crowd): the pose bank, the skin palette, and the loader.
//
// Every spectator shares the 13-bone crowd rig. A bank frame holds one local pose per spectator and bone
// ([qx qy qz qw tx ty tz], scale 1, local to the parent), recorded from the retail game (see crowd_bank.py).
// The skin matrix of a bone is inverseBind x world, in the PS2's row-vector convention; uploaded as the
// 16 floats stored it reads as a column-vector mat4 in GLSL.
import { fetchPacked } from "../viewer/scene.mjs";

const BONES = 13, ENTRY = 7;
export const POSE_FLOATS = BONES * ENTRY;

export function parseBank(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0) !== 0x444a5042) throw new Error("Not a crowd pose bank"); // "DJPB"
  const size = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, size)));
  const data = new Float32Array(buffer.slice(8 + size));
  if (data.length !== header.frames * header.names.length * POSE_FLOATS) throw new Error("Crowd pose bank is the wrong size");
  return { ...header, data };
}

/** Row-major 4x4 of one local pose entry (scale 1): the engine's matrix from the raw quaternion. */
function local(source, at, out) {
  const [x, y, z, w] = [source[at], source[at + 1], source[at + 2], source[at + 3]];
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + z * w); out[2] = 2 * (x * z - y * w); out[3] = 0;
  out[4] = 2 * (x * y - z * w); out[5] = 1 - 2 * (x * x + z * z); out[6] = 2 * (y * z + x * w); out[7] = 0;
  out[8] = 2 * (x * z + y * w); out[9] = 2 * (y * z - x * w); out[10] = 1 - 2 * (x * x + y * y); out[11] = 0;
  out[12] = source[at + 4]; out[13] = source[at + 5]; out[14] = source[at + 6]; out[15] = 1;
}

function multiply(a, ao, b, bo, out, oo) {
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    out[oo + r * 4 + c] = a[ao + r * 4] * b[bo + c] + a[ao + r * 4 + 1] * b[bo + 4 + c]
      + a[ao + r * 4 + 2] * b[bo + 8 + c] + a[ao + r * 4 + 3] * b[bo + 12 + c];
  }
}

/** The pose of `spectator` at (fractional) bank frame `at`, looping, neighbours blended (nlerp on the short arc). */
export function bankPose(bank, spectator, at, out = new Float32Array(POSE_FLOATS)) {
  const frames = bank.frames, stride = bank.names.length * POSE_FLOATS;
  const wrapped = ((at % frames) + frames) % frames;
  const a = Math.floor(wrapped), t = wrapped - a, b = (a + 1) % frames;
  const from = a * stride + spectator * POSE_FLOATS, to = b * stride + spectator * POSE_FLOATS;
  for (let bone = 0; bone < BONES; bone++) {
    const i = bone * ENTRY;
    if (t === 0) { for (let k = 0; k < ENTRY; k++) out[i + k] = bank.data[from + i + k]; continue; }
    let dot = 0;
    for (let k = 0; k < 4; k++) dot += bank.data[from + i + k] * bank.data[to + i + k];
    const sign = dot < 0 ? -1 : 1;
    let length = 0;
    for (let k = 0; k < 4; k++) {
      out[i + k] = bank.data[from + i + k] * (1 - t) + sign * bank.data[to + i + k] * t;
      length += out[i + k] * out[i + k];
    }
    length = Math.sqrt(length) || 1;
    for (let k = 0; k < 4; k++) out[i + k] /= length;
    for (let k = 4; k < ENTRY; k++) out[i + k] = bank.data[from + i + k] * (1 - t) + bank.data[to + i + k] * t;
  }
  return out;
}

const scratch = { local: new Float32Array(16), world: new Float32Array(BONES * 16) };

/**
 * Skin palette (13 row-major 4x4s, inverseBind x world) for one pose. Bones come parent-first.
 * `inverseBind` and `parents` are the class mesh's (`mesh.bones`).
 */
export function skinPalette(pose, bones, out = new Float32Array(BONES * 16)) {
  const { local: m, world } = scratch;
  for (let i = 0; i < BONES; i++) {
    local(pose, i * ENTRY, m);
    const parent = bones[i].parent;
    if (parent === null) world.set(m, i * 16); else multiply(m, 0, world, parent * 16, world, i * 16);
    multiply(bones[i].inverseBind, 0, world, i * 16, out, i * 16);
  }
  return out;
}

/** The people manifest, three class meshes (DJF1), the clothed texture atlases and the pose bank of a venue's spectators. */
export async function loadPeople(dir, { signal, parseSkinned } = {}) {
  const base = new URL("people/", dir);
  const manifest = JSON.parse(new TextDecoder().decode(await fetchPacked(new URL("people.json", base), signal)));
  const [classes, bank] = await Promise.all([
    Promise.all(manifest.classes.map(async file => parseSkinned(await fetchPacked(new URL(file, base), signal)))),
    fetchPacked(new URL(manifest.bank.file, base), signal).then(parseBank),
  ]);
  // Each distinct clothed atlas ("M1-02-3": slot, layer, palette), shared by the spectators who wear it.
  const keys = [...new Set(manifest.spectators.flatMap(s => Object.values(s.outfit)))];
  const outfits = new Map(await Promise.all(keys.map(async key => [key, await fetchPacked(new URL(`outfits/${key}.png`, base), signal)])));
  return { manifest, classes, bank, outfits };
}
