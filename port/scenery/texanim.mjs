// Animated texture planes (texanim.py): Red Hook's flames and torches. Each plane is a fixed world-space strip, drawn additive
// (retail's own render state: ABM_ADD, alpha, no Z writes) with one of 33 frames of a 16-frame sequence.
//
// VERIFIED from the retail files: plane positions, sizes, ST coordinates, sequence names and the frame lists, the blend.
// INFERRED: playback runs one frame per RATE game ticks; the colour scale 0.849 scales colour and alpha; and the Inferno's
// shrinking fire radius (`fire.radius`, retail 0x2dea90) fades the flame and coal planes that lie beyond it.
export const RATE = 4;
const REACH = 3, FADE = 6;   // planes stay full to `fire.radius + REACH` and fade out over the next FADE units

const VERTEX = `#version 300 es
in vec3 position; in vec2 uv; in vec3 info;   // info: frame, scale, visibility
uniform mat4 viewProjection;
out vec2 texcoord; out vec3 plane;
void main() {
  texcoord = uv; plane = info;
  gl_Position = viewProjection * vec4(position, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 texcoord; in vec3 plane;
uniform sampler2D atlas; uniform float grid;
out vec4 color;
void main() {
  vec2 tile = vec2(mod(plane.x, grid), floor(plane.x / grid));
  // Inset by half a texel so neighbouring frames do not bleed in.
  vec2 uv = (tile + clamp(texcoord, 0.0, 1.0) * (127.0 / 128.0) + 0.5 / 128.0) / grid;
  vec4 texel = texture(atlas, uv);
  float a = texel.a * plane.y * plane.z;
  if (a < 0.004) discard;
  color = vec4(texel.rgb * plane.y, a);
}`;

/** The strips of a plane's vertices: a vertex list may hold several strips (the coal wedges), split where the radial pairs jump. */
export function strips(vertices) {
  const radius = v => Math.hypot(v[0], v[2]);
  const out = [];
  let current = [vertices[0], vertices[1]];
  for (let i = 2; i + 1 < vertices.length; i += 2) {
    const [a, b, c, d] = [vertices[i - 2], vertices[i - 1], vertices[i], vertices[i + 1]];
    if (vertices.length > 6 && (Math.abs(radius(a) - radius(c)) > 1 || Math.abs(radius(b) - radius(d)) > 1)) {
      out.push(current);
      current = [c, d];
    } else current.push(c, d);
  }
  out.push(current);
  return out.filter(strip => strip.length >= 4);
}

/** Frame of a sequence at a game tick. */
export const frameAt = (frames, tick) => frames[Math.floor(tick / RATE) % frames.length];

/** How much of a plane the Inferno's fire still covers: 1 inside the fire radius (plus REACH), fading to 0 over FADE units beyond it. */
export const covered = (centreRadius, fire) => fire ? Math.min(1, Math.max(0, (fire.radius + REACH + FADE - centreRadius) / FADE)) : 1;

export async function createTexAnim(gl, manifest, atlasPng) {
  const triangles = [];   // { plane, position, uv }
  const meta = [];
  manifest.planes.forEach((plane, index) => {
    const centre = plane.vertices.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]).map(v => v / plane.vertices.length);
    meta.push({ frames: manifest.sequences[plane.sequence], scale: plane.scale, radius: Math.hypot(centre[0], centre[2]), torch: plane.sequence.startsWith("torch") });
    for (const strip of strips(plane.vertices.map((v, i) => ({ v, st: plane.st[i] })).map(({ v, st }) => Object.assign([...v], { st })))) {
      for (let i = 0; i + 2 < strip.length; i++) {
        const tri = i % 2 ? [strip[i + 1], strip[i], strip[i + 2]] : [strip[i], strip[i + 1], strip[i + 2]];
        for (const vertex of tri) triangles.push({ plane: index, position: [vertex[0], vertex[1], vertex[2]], uv: vertex.st });
      }
    }
  });
  const count = triangles.length;
  const data = new Float32Array(count * 8);
  triangles.forEach((t, i) => data.set([...t.position, ...t.uv, 0, 0, 0], i * 8));
  const prog = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(prog, shader);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  for (const [name, size, offset] of [["position", 3, 0], ["uv", 2, 12], ["info", 3, 20]]) {
    const at = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, 32, offset);
  }
  const bitmap = await createImageBitmap(new Blob([atlasPng], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const atlas = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  bitmap.close();
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const uniform = { viewProjection: gl.getUniformLocation(prog, "viewProjection"), atlas: gl.getUniformLocation(prog, "atlas"), grid: gl.getUniformLocation(prog, "grid") };
  gl.bindVertexArray(null);

  return {
    count: manifest.planes.length,
    /** Draw every plane at game tick `tick`; `fire` ({ radius }) fades the flame and coal planes the fire has shrunk away from. */
    draw(viewProjection, { tick = 0, fire = null } = {}) {
      for (let i = 0; i < count; i++) {
        const m = meta[triangles[i].plane];
        data[i * 8 + 5] = frameAt(m.frames, tick);
        data[i * 8 + 6] = m.scale;
        data[i * 8 + 7] = m.torch ? 1 : covered(m.radius, fire);
      }
      const cull = gl.isEnabled(gl.CULL_FACE);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uniform.viewProjection, false, viewProjection);
      gl.uniform1i(uniform.atlas, 0);
      gl.uniform1f(uniform.grid, manifest.atlas.grid);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.drawArrays(gl.TRIANGLES, 0, count);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      if (cull) gl.enable(gl.CULL_FACE);
      gl.bindVertexArray(null);
    },
    dispose() { gl.deleteProgram(prog); gl.deleteTexture(atlas); gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); },
  };
}
