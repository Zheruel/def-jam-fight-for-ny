// Keeps the fighters visible when a spectator stands between them and the camera.
//
// Retail has no rule for this (checked, not assumed): the 30 crowd records of every RAM capture carry alpha 1.0 for every
// spectator, including one 1.6 units from the Gun Hill camera; the stage XML and the crowd update (0x17dfa0, which only
// turns heads toward the nearest fighter within 25 units) have no distance or fade rule either, and the retail picture
// shows front-row backs in the foreground at the fight start. So spectators and the instanced crowd stay exactly as
// placed, and this port-side rule only fades the ones that would cover a fighter:
//
//   * sight line: the segment from the camera eye to a point in the middle of each fighter, stopped `STOP` units short of
//     the fighter so a spectator standing beside one is untouched. A spectator whose body (a vertical segment, `HEIGHT`
//     tall) passes within `INNER` of a sight line is hidden, fading in over `INNER..OUTER`.
//   * lens: anything within `LENS` of the eye is hidden too (retail's near plane is 9 units; a spectator the camera is
//     inside would otherwise fill the frame), fading in over the next `LENS_FADE`.
//
// The fade is drawn as a screen-door dither (no sorting, no blending), smoothed over a few frames.
export const HEIGHT = 9, INNER = 3.5, OUTER = 7, STOP = 8, LENS = 9, LENS_FADE = 5, CHEST = 4, SPEED = 0.15;

/** Camera position from a view-projection (column-major 4x4): the point where clip x, y and w are all zero. */
export function eyeOf(m) {
  // clip.x = clip.y = clip.w = 0 is a 3 x 3 system A p = -k (rows x, y, w; k their translation terms), solved by Cramer's rule.
  const rows = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[3], m[7], m[11]]], k = [-m[12], -m[13], -m[15]];
  const det = r => r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
    + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  const d = det(rows);
  if (Math.abs(d) < 1e-9) return null;
  return [0, 1, 2].map(c => det(rows.map((r, i) => r.map((v, j) => j === c ? k[i] : v))) / d);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Distance between segments p1..q1 and p2..q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segmentDistance(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  return Math.hypot(...sub(c1, c2));
}

const ramp = (distance, inner, outer) => Math.min(1, Math.max(0, (distance - inner) / (outer - inner)));

/**
 * Target visibility (0 hidden .. 1 shown) of a figure standing at `position` (feet) seen from `eye` with `fighters`
 * (their feet positions) in the shot.
 */
export function visibility(eye, fighters, position) {
  const body = [position, [position[0], position[1] + HEIGHT, position[2]]];
  let shown = ramp(segmentDistance(eye, eye, body[0], body[1]), LENS, LENS + LENS_FADE);
  for (const fighter of fighters) {
    const target = [fighter[0], fighter[1] + CHEST, fighter[2]];
    const ray = sub(target, eye), length = Math.hypot(...ray);
    if (length < 1e-6) continue;
    const reach = Math.max(0, 1 - STOP / length);
    const end = [eye[0] + ray[0] * reach, eye[1] + ray[1] * reach, eye[2] + ray[2] * reach];
    shown = Math.min(shown, ramp(segmentDistance(eye, end, body[0], body[1]), INNER, OUTER));
  }
  return shown;
}

/** One fade value per figure (start at 1); `update` moves each toward its target and returns the array. */
export function createFader(positions) {
  const values = new Float32Array(positions.length).fill(1);
  return {
    values,
    update(eye, fighters) {
      for (let i = 0; i < positions.length; i++) {
        const target = eye && fighters.length ? visibility(eye, fighters, positions[i]) : 1;
        const step = target - values[i];
        values[i] = Math.abs(step) <= SPEED ? target : values[i] + Math.sign(step) * SPEED;
      }
      return values;
    },
  };
}
