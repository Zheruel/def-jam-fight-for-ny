// Synchronous sampling of the keyframe motion banks written by sampler/bank.py (`def-jam-fny-motion-bank/2`).
// Poses come out in the engine entry layout (94 x 12 floats: scale xyz1, quaternion xyzw, translation xyz1) so they feed
// composePose()/skinPositions() in pose.mjs directly. The banks reproduce the recompiled retail sampler (0x132b48) at any
// time, including its half-frame breaks, to about 1e-3.
//
//   const rig = JSON.parse(rigText);                                   // rig-blaze.json / rig-doc.json
//   const bank = new MotionBank(JSON.parse(indexText), bytes, rig);     // bytes: ArrayBuffer of <bank>.bin
//   bank.clip(11).end;                                                   // 67, the game's own duration (0x132c60)
//   const root = bank.sample(11, 16.5, entries);                         // fills entries, returns {x, y, z, yaw}
//
// Engine clip numbers (`local`): BASE00 = its name index (A112 = 11, B101 = 66, B201 = 69, B301 = 72, A373 = 62,
// Q101 = 328, Q107 = 334); fighter banks = index into the WRES bank (+1000 for slot 1, e.g. Doc's N01C7AA kick = 1069).
// `root` is the engine's absolute offset from the motion start (y = hip height) and the root yaw in degrees.

export const FORMAT = "def-jam-fny-motion-bank/2";
const BONES = 94;

/** xyzw from the stored smallest three (the dropped component is the largest and positive). */
function unpack(index, a, b, c, out, at) {
  const largest = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
  if (index === 0) { out[at] = largest; out[at + 1] = a; out[at + 2] = b; out[at + 3] = c; }
  else if (index === 1) { out[at] = a; out[at + 1] = largest; out[at + 2] = b; out[at + 3] = c; }
  else if (index === 2) { out[at] = a; out[at + 1] = b; out[at + 2] = largest; out[at + 3] = c; }
  else { out[at] = a; out[at + 1] = b; out[at + 2] = c; out[at + 3] = largest; }
}

/** Index i such that times[i] <= t < times[i + 1] (clamped to the track). */
function segment(times, t) {
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return lo;
}

export class MotionBank {
  constructor(index, buffer, rig) {
    if (index.format !== FORMAT) throw new Error(`unsupported motion bank ${index.format}`);
    this.index = index;
    this.view = new DataView(buffer);
    this.rig = rig;
    this.quant = index.quant;
    this.unit = index.timeUnit;
    this.held = new Set(Object.keys(rig.held).map(Number));
    this.byLocal = new Map(index.clips.map((clip) => [clip.local, clip]));
    this.byName = new Map(index.clips.map((clip) => [clip.name, clip]));
    this.decoded = new Map();
  }

  /** Clip record `{name, local, end, ...}` by engine clip number or name. */
  clip(local) {
    const clip = typeof local === "string" ? this.byName.get(local) : this.byLocal.get(local);
    if (!clip) throw new RangeError(`motion ${local} is not in bank ${this.index.name}`);
    return clip;
  }

  decode(clip) {
    let motion = this.decoded.get(clip.local);
    if (motion) return motion;
    const view = this.view, unit = this.unit;
    let at = clip.offset;
    const tclass = new Uint8Array(BONES);
    for (let k = 0; k < BONES; k++) tclass[k] = view.getUint8(at + k);
    at += BONES;
    const times = (n) => { const t = new Float32Array(n); for (let i = 0; i < n; i++, at += 2) t[i] = view.getUint16(at, true) / unit; return t; };
    const quats = new Array(BONES), trans = new Array(BONES), constTrans = new Float32Array(BONES * 3);
    for (let k = 0; k < BONES; k++) {
      if (this.held.has(k)) continue;
      const n = view.getUint16(at, true); at += 2;
      const t = times(n), index = at; at += n;
      const planes = [at, at + 2 * n, at + 4 * n]; at += 6 * n;
      const q = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        unpack(view.getUint8(index + i), view.getInt16(planes[0] + 2 * i, true) / this.quant,
          view.getInt16(planes[1] + 2 * i, true) / this.quant, view.getInt16(planes[2] + 2 * i, true) / this.quant, q, i * 4);
      }
      quats[k] = { times: t, values: q };
      if (tclass[k] === 1) { for (let a = 0; a < 3; a++, at += 4) constTrans[k * 3 + a] = view.getFloat32(at, true); }
      else if (tclass[k] === 2) {
        const m = view.getUint16(at, true); at += 2;
        const tt = times(m), v = new Float32Array(m * 3);
        for (let i = 0; i < m * 3; i++, at += 4) v[i] = view.getFloat32(at, true);
        trans[k] = { times: tt, values: v };
      }
    }
    const n = view.getUint16(at, true); at += 2;
    const rootTimes = times(n), rootValues = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++, at += 4) rootValues[i] = view.getFloat32(at, true);
    motion = { clip, tclass, quats, trans, constTrans, root: { times: rootTimes, values: rootValues } };
    this.decoded.set(clip.local, motion);
    return motion;
  }

  /**
   * Pose of motion `local` at `frame` (retail frame units) written to `out` (Float32Array(94 * 12)); the pose is held
   * before 0 and after the last key. `loop` wraps at the motion's duration instead. Returns {x, y, z, yaw}.
   */
  sample(local, frame, out = new Float32Array(BONES * 12), { loop = false } = {}) {
    const clip = this.clip(local), motion = this.decode(clip);
    const t = loop ? ((frame % clip.end) + clip.end) % clip.end : frame;
    const defaults = this.rig.defaultTranslations;
    for (let k = 0; k < BONES; k++) {
      const o = k * 12;
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 1;
      out[o + 11] = 1;
      if (this.held.has(k)) {
        const held = this.rig.held[k];
        for (let i = 0; i < 4; i++) out[o + 4 + i] = held[i];
        for (let i = 0; i < 3; i++) out[o + 8 + i] = held[4 + i];
        continue;
      }
      const { times, values } = motion.quats[k], last = times.length - 1;
      if (last === 0 || t <= times[0]) {
        for (let i = 0; i < 4; i++) out[o + 4 + i] = values[i];
      } else if (t >= times[last]) {
        for (let i = 0; i < 4; i++) out[o + 4 + i] = values[last * 4 + i];
      } else {
        const a = segment(times, t) * 4, b = a + 4, w = (t - times[a / 4]) / (times[b / 4] - times[a / 4]);
        const sign = values[a] * values[b] + values[a + 1] * values[b + 1] + values[a + 2] * values[b + 2] + values[a + 3] * values[b + 3] < 0 ? -1 : 1;
        const x = values[a] * (1 - w) + sign * values[b] * w, y = values[a + 1] * (1 - w) + sign * values[b + 1] * w;
        const z = values[a + 2] * (1 - w) + sign * values[b + 2] * w, s = values[a + 3] * (1 - w) + sign * values[b + 3] * w;
        const length = Math.hypot(x, y, z, s) || 1;
        out[o + 4] = x / length; out[o + 5] = y / length; out[o + 6] = z / length; out[o + 7] = s / length;
      }
      const track = motion.trans[k];
      if (track) interpolate(track, t, 3, out, o + 8);
      else if (motion.tclass[k] === 1) { for (let i = 0; i < 3; i++) out[o + 8 + i] = motion.constTrans[k * 3 + i]; }
      else { for (let i = 0; i < 3; i++) out[o + 8 + i] = defaults[k][i]; }
    }
    const r = [0, 0, 0, 0];
    interpolate(motion.root, t, 4, r, 0);
    return { x: r[0], y: r[1], z: r[2], yaw: r[3] };
  }
}

function interpolate({ times, values }, t, width, out, at) {
  const last = times.length - 1;
  if (last === 0 || t <= times[0]) { for (let i = 0; i < width; i++) out[at + i] = values[i]; return; }
  if (t >= times[last]) { for (let i = 0; i < width; i++) out[at + i] = values[last * width + i]; return; }
  const a = segment(times, t), w = (t - times[a]) / (times[a + 1] - times[a]);
  for (let i = 0; i < width; i++) out[at + i] = values[a * width + i] * (1 - w) + values[(a + 1) * width + i] * w;
}
