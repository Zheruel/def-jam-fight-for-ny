// Native stage particles: the sprite effects of a venue's JDI (see particles.py), drawn as camera-facing quads.
//
//   const particles = await createParticles(gl, manifest, atlasPng);
//   particles.update({ tick, events, fire, train });       // once per frame, before draw
//   particles.draw(viewProjection);
//
// What is VERIFIED against the retail data: the effect table (names, sprite sheet, tiles, start/end colours, lifetimes),
// the train lights' colours and attachment points, the Inferno clock (0x4c1930, +1.2 a frame) and the formulas the
// retail code derives from it. What is INFERRED, from the field values and the retail screenshots, and tuned by eye: how
// the remaining fields move a sprite (speeds, sizes, counts), where the Inferno flames stand, and the blend modes.
// See the README ("Stage particles").
const TICK = 1 / 60;
const MAX = 6000;
const SIZE = { glow: 40, flame: 26, smoke: 30, debris: 2.6, spark: 3 };

function random(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** What an effect is, from its data: debris falls (negative rise), flames and smoke rise, lights stay put. */
export function classify(name, def) {
  if (/light|glow|flare|neon|juke(?!_)|sign/i.test(name) && def.points.length === 1 && def.count === 0) return "glow";
  if (def.rise[0] < 0) return "debris";
  if (/smoke|dust/i.test(name)) return "smoke";
  if (def.rise[0] > 0 || /fire|fobj/i.test(name)) return "flame";
  return def.blend === 1 ? "spark" : "debris";
}

// Inferno clock formulas (retail 0x2dea90): the clock gains 1.2 a frame; the fire is full until 7200, then dies out
// linearly by 4500 more; its radius is 37 + 20 x intensity.
export function infernoFire(clock) {
  const intensity = clock < 7200 ? 1 : 1 - (Math.min(clock, 11700) - 7200) * 2.1555e-4;
  return { intensity, radius: 37 + 20 * intensity };
}

const VERTEX = `#version 300 es
in vec2 corner;
in vec4 centre;   // xyz, size
in vec4 color;
in vec4 tile;     // u, v, tile size, rotation
uniform mat4 viewProjection;
uniform vec3 right; uniform vec3 up;
out vec2 uv; out vec4 tint;
void main() {
  float c = cos(tile.w), s = sin(tile.w);
  vec2 q = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
  vec3 world = centre.xyz + (right * q.x + up * q.y) * centre.w * 0.5;
  uv = tile.xy + (vec2(corner.x, -corner.y) * 0.5 + 0.5) * tile.z;
  tint = color;
  gl_Position = viewProjection * vec4(world, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv; in vec4 tint;
uniform sampler2D atlas; uniform float additive;
out vec4 outColor;
void main() {
  vec4 texel = texture(atlas, uv);
  float a = texel.a * tint.a;
  if (a < 0.004) discard;
  // Additive sprites glow with the sprite's own brightness; the others are plain alpha.
  outColor = vec4(texel.rgb * tint.rgb, a * (additive > 0.5 ? 1.0 : 1.0));
}`;

function program(gl) {
  const p = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(p, shader);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

/**
 * The simulation without any GL (testable in Node): spawn, step and the sprite list a frame draws.
 * `effects` is the venue's manifest `effects` object.
 */
export function createSimulation(effects, { seed = 1 } = {}) {
  const rand = random(seed);
  const live = [];
  let tick = 0, fireEmitters = null, fireAt = 0, lastFire = null;
  const lightList = [];

  const frame = (def, age, life) => def.tiles[Math.min(def.tiles.length - 1, Math.floor(def.tiles.length * age / Math.max(life, 1)))] ?? [0, 0, 0.25];
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  /** A burst of `name` at a world position (the retail `particle` event: name, position, rotation). */
  function burst(name, position, rotation = [0, 0, 0]) {
    const def = effects[name];
    if (!def) return 0;
    const kind = classify(name, def);
    const points = def.points.length || 1;
    const per = Math.max(1, Math.round(def.count || (kind === "debris" ? 3 : 2)) * Math.max(1, def.mode || 1));
    const total = Math.min(40, kind === "debris" ? per : Math.max(per, 4));
    const life = Math.max(20, Math.round((def.life || 1500) * 60 / 1000));
    for (let i = 0; i < total; i++) {
      const a = rand() * Math.PI * 2, s = (def.speed[0] || 30) / 8 * (0.4 + rand() * 0.8);
      const up = kind === "debris" ? (def.speed[1] || 30) / 6 * (0.3 + rand()) : kind === "flame" || kind === "smoke" ? 3 + rand() * 4 : 2 + rand() * 6;
      live.push({ name, kind, def, life, age: 0, tile: Math.floor(rand() * def.tiles.length),
        p: [position[0] + (rand() - 0.5) * 1.5, position[1] + rand() * 1.5, position[2] + (rand() - 0.5) * 1.5],
        v: [Math.cos(a) * s * TICK, up * TICK, Math.sin(a) * s * TICK],
        g: kind === "debris" ? 0.045 : 0, size: def.size * SIZE[kind] * (0.6 + rand() * 0.7),
        spin: (rand() - 0.5) * 0.3, rot: rand() * 6.28 });
    }
    return total;
  }

  /** Persistent flame emitters for the Inferno: an annulus of flames around the arena and tall ones on the pillars. */
  function fire(state) {
    lastFire = state;
    if (!fireEmitters) {
      const r = random(7);
      fireEmitters = [];
      for (let i = 0; i < 90; i++) {
        const a = (i + r() * 0.8) / 90 * Math.PI * 2;
        fireEmitters.push({ angle: a, phase: Math.floor(r() * 12), scale: 0.8 + r() * 0.6, spread: r() });
      }
    }
  }

  function spawnFire() {
    if (!lastFire || lastFire.intensity <= 0.02) return;
    // Two sprite families of the stage's own sheet: the flame column (fx_plfire, sheet column 1) and the flame blob (fx_fobj,
    // column 0). Retail tints them orange (fx_fobj start colour 216 153 63); the rest of the look is tuned by eye.
    const tongue = effects.fx_plfire1 ?? effects.fx_fobj1, blob = effects.fx_fobj2 ?? tongue;
    if (!tongue) return;
    const radius = lastFire.radius + 8;
    for (const e of fireEmitters) {
      if ((tick + e.phase) % 12 !== 0) continue;
      const wide = rand() < 0.35, def = wide ? blob : tongue;
      const r = radius + (e.spread - 0.3) * 22;
      live.push({ name: "fire", kind: "flame", def, life: 60 + Math.floor(rand() * 40), age: 0, tile: 0, fire: true,
        tint: [0.9, 0.42 + rand() * 0.2, 0.1 + rand() * 0.08], boost: wide ? 0.35 : 0.6,
        p: [Math.cos(e.angle) * r, 0, Math.sin(e.angle) * r * 0.85],
        v: [(rand() - 0.5) * 0.02, 0.14 + rand() * 0.1, (rand() - 0.5) * 0.02], g: 0,
        size: (wide ? 20 : 26) * e.scale * lastFire.intensity, spin: 0, rot: 0 });
    }
  }

  /** Head and tail lights of the subway car: glow sprites at the attachment points while the car is in the tunnel. */
  function lights(list) { lightList.length = 0; lightList.push(...(list ?? [])); }

  function step() {
    tick++;
    spawnFire();
    for (let i = live.length - 1; i >= 0; i--) {
      const q = live[i];
      q.age++;
      if (q.age >= q.life) { live.splice(i, 1); continue; }
      q.v[1] -= q.g;
      q.p[0] += q.v[0]; q.p[1] += q.v[1]; q.p[2] += q.v[2];
      if (q.kind === "debris" && q.p[1] < 0.3) { q.p[1] = 0.3; q.v[0] *= 0.6; q.v[2] *= 0.6; q.v[1] = Math.abs(q.v[1]) * 0.25; }
      q.rot += q.spin;
    }
    if (live.length > MAX) live.splice(0, live.length - MAX);
  }

  /** The sprites to draw: { additive: [[x,y,z,size, r,g,b,a, u,v,s,rot], ...], alpha: [...] }. */
  function sprites() {
    const additive = [], alpha = [];
    for (const q of live) {
      const t = q.age / q.life, def = q.def;
      const col = lerp(def.start, def.end, Math.min(1, t * 1.2)).map(v => v / 255);
      if (q.tint) { col[0] = q.tint[0]; col[1] = q.tint[1]; col[2] = q.tint[2]; col[3] = q.boost; }
      let a = col[3] * (q.tint ? 1 : def.opacity || 1);
      if (q.kind === "flame" || q.kind === "smoke") a *= Math.min(1, t * 6) * (1 - t) ** 0.8;
      else a *= t > 0.7 ? (1 - t) / 0.3 : 1;
      const tile = q.fire ? frame(def, q.age, 24) : frame(def, q.age, q.life);
      const growth = q.kind === "flame" || q.kind === "smoke" ? 0.6 + t * 0.8 : 1;
      (def.blend === 1 || q.kind === "flame" ? additive : alpha).push([q.p[0], q.p[1], q.p[2], q.size * growth, col[0], col[1], col[2], a, tile[0], tile[1], tile[2], q.rot]);
    }
    for (const l of lightList) additive.push([l.position[0], l.position[1], l.position[2], l.size, ...l.color, ...l.tile, 0]);
    return { additive, alpha };
  }

  return { burst, fire, lights, step, sprites, get count() { return live.length; }, get tick() { return tick; }, clear() { live.length = 0; } };
}

/** Light sprites for the train: both ends are attached to the car (car-local points from the manifest, world = car matrix x point). */
export function trainLights(subway, effects, car, phase) {
  if (!car || !subway?.lights) return [];
  const m = car.matrix, out = [];
  for (const light of subway.lights) {
    const def = effects[light.name];
    if (!def) continue;
    const p = light.translate;
    const world = [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
    // The head lights fade in with the siren as the train comes down the tunnel; both ends glow while it is in view.
    const rgba = def.start.map(v => v / 255);
    out.push({ name: light.name, position: world, size: def.size * 60, color: [rgba[0], rgba[1], rgba[2], rgba[3] * Math.min(1, (phase + 0.7) * 3)], tile: def.tiles[0] });
  }
  return out;
}

export async function createParticles(gl, manifest, atlasPng, { seed = 1 } = {}) {
  const sim = createSimulation(manifest.effects, { seed });
  const prog = program(gl);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  const cornerAt = gl.getAttribLocation(prog, "corner");
  gl.enableVertexAttribArray(cornerAt);
  gl.vertexAttribPointer(cornerAt, 2, gl.FLOAT, false, 0, 0);
  const instances = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferData(gl.ARRAY_BUFFER, MAX * 48 * 2, gl.DYNAMIC_DRAW);
  for (const [name, offset] of [["centre", 0], ["color", 16], ["tile", 32]]) {
    const at = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 4, gl.FLOAT, false, 48, offset);
    gl.vertexAttribDivisor(at, 1);
  }
  const bitmap = await createImageBitmap(new Blob([atlasPng], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const atlas = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  bitmap.close();
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const uniform = Object.fromEntries(["viewProjection", "right", "up", "atlas", "additive"].map(n => [n, gl.getUniformLocation(prog, n)]));
  gl.bindVertexArray(null);
  const buffer = new Float32Array(MAX * 12);
  let ticked = null;

  return {
    sim,
    /** Advance to `tick` (one sim step per tick, at most 6 per call) and route what the environment emitted. */
    update({ tick, events = [], fire = null, lights = null }) {
      if (ticked === null || tick < ticked) { sim.clear(); ticked = tick; }
      for (const e of events) if (e.particle) sim.burst(e.particle, e.position ?? [0, 0, 0], e.rotation);
      if (fire) sim.fire(fire);
      sim.lights(lights);
      for (let n = Math.min(6, tick - ticked); n > 0; n--) sim.step();
      ticked = tick;
    },
    draw(viewProjection) {
      const { additive, alpha } = sim.sprites();
      if (!additive.length && !alpha.length) return;
      // The camera's right and up in the world are the first two rows of view x projection (up to positive scale).
      const norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
      const m = viewProjection;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uniform.viewProjection, false, m);
      gl.uniform3fv(uniform.right, norm(m[0], m[4], m[8]));
      gl.uniform3fv(uniform.up, norm(m[1], m[5], m[9]));
      gl.uniform1i(uniform.atlas, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.depthMask(false);
      for (const [list, add] of [[alpha, false], [additive, true]]) {
        if (!list.length) continue;
        const count = Math.min(list.length, MAX);
        for (let i = 0; i < count; i++) buffer.set(list[i], i * 12);
        gl.bindBuffer(gl.ARRAY_BUFFER, instances);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, buffer, 0, count * 12);
        gl.blendFunc(gl.SRC_ALPHA, add ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(uniform.additive, add ? 1 : 0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
    dispose() { gl.deleteProgram(prog); gl.deleteTexture(atlas); gl.deleteBuffer(instances); gl.deleteBuffer(corners); gl.deleteVertexArray(vao); },
  };
}
