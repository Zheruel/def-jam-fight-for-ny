// Live pose extraction for retail Def Jam: Fight for NY fighters (SLUS-21004).
//
// A fighter's EAGL character object lives at u32[CHARACTER_TABLE + slot * 4]. Its CSkeleton starts at
// char + 0x170; the current final local pose is the array pointed to by u32[char + 0x17c] (the buffers at
// +0x180/+0x184 are previous/reference arrays and are not used here). The array has 94 entries of
// 48 bytes in the order of the model JSON `bones`: scale xyz1, quaternion xyzw, translation xyz1, all local
// to the parent bone. Bone 0 translation is relative to the actor, not the world.
//
// Matrices are row-major 4x4 with the row-vector convention `p' = p * M`, like the model JSON.

export const CHARACTER_TABLE = 0x471230;
export const POSE_POINTER_OFFSET = 0x17c;
export const SKELETON_POINTER_OFFSET = 0x174;
export const BONE_COUNT = 94;
export const ENTRY_BYTES = 48;
const EE_RAM_BYTES = 0x2000000;

function pointer(view, address, what) {
  if (!Number.isInteger(address) || address < 0 || address + 4 > view.byteLength || address + 4 > EE_RAM_BYTES) {
    throw new RangeError(`${what} 0x${address.toString(16)} is outside EE RAM`);
  }
  return view.getUint32(address, true);
}

function checkedArray(view, address, count, what) {
  if (address === 0 || address % 16 !== 0 || address + count * ENTRY_BYTES > view.byteLength
    || address + count * ENTRY_BYTES > EE_RAM_BYTES) {
    throw new RangeError(`${what} 0x${address.toString(16)} is not a pose array in EE RAM`);
  }
  return address;
}

/** Address of the actor's character object for a fighter slot. */
export function characterAddress(view, slot) {
  const address = pointer(view, CHARACTER_TABLE + slot * 4, "character table entry");
  if (address === 0) throw new RangeError(`slot ${slot} has no character`);
  return address;
}

/** Local entries of one pose array as {scale, quat, trans} Float32Array views copied out of RAM. */
export function readLocalPose(view, character, count = BONE_COUNT, pointerOffset = POSE_POINTER_OFFSET) {
  const base = checkedArray(view, pointer(view, character + pointerOffset, "pose pointer"), count, "pose array");
  const entries = new Float32Array(count * 12);
  for (let i = 0; i < count * 12; i++) entries[i] = view.getFloat32(base + i * 4, true);
  return entries;
}

/** Row-major 4x4 for one entry: scale, then the transposed quaternion rotation, then translation. */
export function localMatrix(entries, bone, out = new Float64Array(16), offset = 0) {
  const e = bone * 12;
  const sx = entries[e], sy = entries[e + 1], sz = entries[e + 2];
  const x = entries[e + 4], y = entries[e + 5], z = entries[e + 6], w = entries[e + 7];
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
  // Row i of the matrix is column i of R (row-vector convention), scaled by s_i.
  out.set([r00 * sx, r10 * sx, r20 * sx, 0, r01 * sy, r11 * sy, r21 * sy, 0, r02 * sz, r12 * sz, r22 * sz, 0,
    entries[e + 8], entries[e + 9], entries[e + 10], 1], offset);
  return out;
}

function multiply(a, ao, b, bo, out, oo) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[oo + r * 4 + c] = a[ao + r * 4] * b[bo + c] + a[ao + r * 4 + 1] * b[bo + 4 + c]
        + a[ao + r * 4 + 2] * b[bo + 8 + c] + a[ao + r * 4 + 3] * b[bo + 12 + c];
    }
  }
}

/**
 * Compose local entries into bone-to-model world matrices and skin matrices (inverseBind * world).
 * `model` is a def-jam-fny-fighter-model/1 document (needs `bones[].parent` and `.inverseBind`).
 * Parents always precede children, so one forward pass is enough.
 */
export function composePose(model, entries) {
  const bones = model.bones;
  const world = new Float32Array(bones.length * 16);
  const skin = new Float32Array(bones.length * 16);
  const local = new Float64Array(16);
  const w = new Float64Array(bones.length * 16);
  const s = new Float64Array(16);
  for (let k = 0; k < bones.length; k++) {
    localMatrix(entries, k, local);
    const parent = bones[k].parent;
    if (parent === null) w.set(local, k * 16);
    else multiply(local, 0, w, parent * 16, w, k * 16);
    multiply(bones[k].inverseBind, 0, w, k * 16, s, 0);
    world.set(w.subarray(k * 16, k * 16 + 16), k * 16);
    skin.set(s, k * 16);
  }
  return { world, skin };
}

/** Read slot `slot` from a DataView over a 32MB EE RAM image and return its posed matrices. */
export function readPose(view, model, slot) {
  const character = characterAddress(view, slot);
  const entries = readLocalPose(view, character, model.bones.length);
  return { character, entries, ...composePose(model, entries) };
}

/** Linear blend skinning of a model's bind positions with skin matrices; returns Float32Array xyz. */
export function skinPositions(model, skin, out = new Float32Array(model.positions.length)) {
  const { positions, joints, weights } = model;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const px = positions[3 * i], py = positions[3 * i + 1], pz = positions[3 * i + 2];
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < 4; j++) {
      const weight = weights[4 * i + j];
      if (weight === 0) continue;
      const m = joints[4 * i + j] * 16;
      x += weight * (px * skin[m] + py * skin[m + 4] + pz * skin[m + 8] + skin[m + 12]);
      y += weight * (px * skin[m + 1] + py * skin[m + 5] + pz * skin[m + 9] + skin[m + 13]);
      z += weight * (px * skin[m + 2] + py * skin[m + 6] + pz * skin[m + 10] + skin[m + 14]);
    }
    out[3 * i] = x;
    out[3 * i + 1] = y;
    out[3 * i + 2] = z;
  }
  return out;
}

/** Actor placement: yaw (degrees about +Y, as the match trace `facing`) plus world position. */
export function actorMatrix(position, facingDegrees) {
  const a = facingDegrees * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, position[0], position[1], position[2], 1]);
}

/** Bounding box of a Float32Array of xyz triples. */
export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return { min, max };
}

/**
 * Retail bone ids (what 0x132a28 / 0x132ab8 take; id 1 = root) -> bone index. Read from the table at 0x3CCDB8; ids 1..40 are valid
 * (a 41st entry names bone 94, which the 94-bone fighter skeletons do not have).
 */
export const NAMED_BONES = Object.freeze([0, 1, 12, 13, 14, 57, 58, 81, 15, 16, 17, 18, 19, 20, 36, 37, 38, 39, 40, 41,
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93]);
export const WAIST_ID = 4;   // bone 13 "waist"
export const HEAD_ID = 7;    // bone 58 "head"

function quatMul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}

/**
 * Retail 0x132ab8(slot, boneId, euler): the procedural bone rotation the actor update (0x308a30) layers on the sampled pose.
 * `euler` is degrees (x, y, z); x turns about the quaternion's Y axis, y about X, z about Z, y first, and the result multiplies the
 * entry's quaternion from the left: q' = Rz(z) * RY(x) * RX(y) * q (verified exact against the recompiled retail call). It edits
 * `entries` in place and never renormalises.
 */
export function applyBoneEuler(entries, boneId, euler) {
  const bone = NAMED_BONES[boneId - 1];
  if (bone === undefined) throw new RangeError(`bone id ${boneId} is not a retail bone id`);
  const axis = (a, degrees) => { const h = degrees * Math.PI / 360, q = [0, 0, 0, Math.cos(h)]; q[a] = Math.sin(h); return q; };
  const delta = quatMul(axis(2, euler[2]), quatMul(axis(1, euler[0]), axis(0, euler[1])));
  const e = bone * 12;
  const q = quatMul(delta, [entries[e + 4], entries[e + 5], entries[e + 6], entries[e + 7]]);
  entries[e + 4] = q[0]; entries[e + 5] = q[1]; entries[e + 6] = q[2]; entries[e + 7] = q[3];
  return entries;
}

/** Retail 0x132a28(out, slot, boneId): the bone's row-major world matrix (translation in row 3) = bone-to-model world * actor matrix. */
export function boneWorldMatrix(model, entries, actor, boneId, composed = composePose(model, entries).world) {
  const bone = NAMED_BONES[boneId - 1];
  if (bone === undefined) throw new RangeError(`bone id ${boneId} is not a retail bone id`);
  const out = new Float64Array(16);
  multiply(composed, bone * 16, actor, 0, out, 0);
  return out;
}
