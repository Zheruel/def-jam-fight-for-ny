// Native renderer for retail Battle scenery: breakable props (DJS1) and the instanced
// background crowd (DJC1), both extracted by extract.py from the licensed PS2 disc.
//
//   const scenery = await loadScenery("V2BG_02A", { signal });
//   const draw = createSceneryRenderer(gl, scenery);
//   draw.render({ viewProjection, frame, excited, props });   // after the venue mesh
//   draw.dispose();
//
// Coverage: props are static meshes with discrete break states (pick one state per prop);
// the instanced crowd is vertex-animated (383 retail frames, idle and excited loops).
import { fetchPacked } from "../viewer/scene.mjs";
import { irradiance, irradianceGLSL, sampleIrradiance } from "./irradiance.mjs";

const U32 = 4;

function header(buffer, magic) {
  const view = new DataView(buffer);
  if (view.getUint32(0) !== magic) throw new Error("Unknown scenery format");
  const size = view.getUint32(4, true);
  return [JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, size))), 8 + size];
}

export function parseProps(buffer) {
  const [mesh, start] = header(buffer, 0x444a5331); // "DJS1"
  const vertexBytes = mesh.vertices * 24;
  const vertices = new Uint8Array(buffer, start, vertexBytes);
  const indices = new Uint8Array(buffer, start + vertexBytes, mesh.indices * mesh.indexBytes);
  const textures = new Map(Object.entries(mesh.textures).map(([shape, [at, size]]) =>
    [shape, new Uint8Array(buffer, start + at, size)]));
  return { mesh, vertices, indices, textures };
}

export function parseCrowd(buffer) {
  const [mesh, start] = header(buffer, 0x444a4331); // "DJC1"
  const slice = ([at, size]) => buffer.slice(start + at, start + at + size);
  return { mesh, positions: new Uint16Array(slice(mesh.layout.positions)),
           uv: new Float32Array(slice(mesh.layout.uv)), indices: new Uint16Array(slice(mesh.layout.indices)),
           texture: new Uint8Array(slice(mesh.layout.texture)) };
}

/** Venues with decoded scenery: { [venue]: { dir, props, propStates, crowdInstances, undecodedProps } }. */
export async function loadSceneryIndex({ signal, base = new URL("./", import.meta.url) } = {}) {
  return JSON.parse(new TextDecoder().decode(await fetchPacked(new URL("index.json", base), signal)));
}

/** DJF1 skinned mesh (the fighter container). Weapons are one-bone models, drawn in their bind pose. */
export function parseSkinned(buffer) {
  const [mesh, start] = header(buffer, 0x444a4631);
  const vertices = new Uint8Array(buffer, start, mesh.vertices * 52);
  const indices = new Uint8Array(buffer, start + mesh.vertices * 52, mesh.indices * 2);
  const textures = new Map(Object.entries(mesh.textures).map(([shape, [at, size]]) =>
    [shape, new Uint8Array(buffer, start + at, size)]));
  return { mesh, vertices, indices, textures };
}

export async function loadScenery(venue, { signal, base = new URL("./", import.meta.url) } = {}) {
  const dir = new URL(venue === "V2BG_02A" ? "foundation/" : `${venue}/`, base);
  const manifest = JSON.parse(new TextDecoder().decode(await fetchPacked(new URL("scenery.json", dir), signal)));
  const props = manifest.propsFile ? parseProps(await fetchPacked(new URL(manifest.propsFile, dir), signal)) : null;
  let crowd = null;
  const placed = manifest.instancedCrowd;
  if (placed) {
    // The Foundation ships its own file; every other venue shares one retail model and carries its layout here.
    crowd = parseCrowd(await fetchPacked(new URL(placed.file ?? placed.modelFile, dir), signal));
    if (placed.placements) crowd.mesh.instances = placed.placements;
  }
  // Weapon/bottle models this venue places or spawns, from the shared port/scenery/weapons/.
  const wanted = [...new Set([...(manifest.weapons ?? []).map(w => w.model), ...(manifest.hiddenWeaponModels ?? [])])];
  const weapons = new Map();
  await Promise.all(wanted.map(async model => {
    weapons.set(model, parseSkinned(await fetchPacked(new URL(`weapons/${model}.skin.gz`, base), signal)));
  }));
  return { manifest, props, crowd, weapons };
}

// Euler placement from the stage XML: degrees, applied X then Y then Z (all retail Foundation
// placements are the identity). Returns a column-major 4x4.
export function placementMatrix({ translate, rotate }) {
  const [rx, ry, rz] = rotate.map(d => d * Math.PI / 180);
  const [sx, cx, sy, cy, sz, cz] = [Math.sin(rx), Math.cos(rx), Math.sin(ry), Math.cos(ry), Math.sin(rz), Math.cos(rz)];
  // R = Rz * Ry * Rx
  return new Float32Array([
    cz * cy, sz * cy, -sy, 0,
    cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx, 0,
    cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx, 0,
    translate[0], translate[1], translate[2], 1]);
}

// Instances start at a stable scattered phase so rows do not move in lockstep. The retail
// per-instance timing is not decoded; the idle and excited cycles themselves are retail data.
export function instancePhase(index) { return (index * 97) % 140; }

// Retail frame shown by `instance` at a 60 Hz `tick`; matches the vertex shader.
export function crowdFrame(loops, excited, tick, index = 0) {
  const [from, to] = excited ? loops.excited : loops.idle;
  return from + (Math.floor(tick) + instancePhase(index)) % (to - from);
}

const PROP_VERTEX = `#version 300 es
in vec3 position; in vec2 uv; in vec4 rgba;
uniform mat4 viewProjection; uniform mat4 model;
out vec2 texcoord; out vec3 tint;
void main() {
  texcoord = uv; tint = rgba.rgb * (255.0 / 128.0);
  gl_Position = viewProjection * model * vec4(position, 1.0);
}`;
const CROWD_VERTEX = `#version 300 es
in vec2 uv; in vec4 instance; in vec2 style; in vec3 shade;
uniform highp usampler2D frames;   // 16-bit XYZ per vertex (x) per retail frame (y)
uniform mat4 viewProjection; uniform vec3 scale;
uniform vec2 loop;                 // first frame, frame count of the active cycle
uniform float tick;
out vec2 texcoord; out vec3 tint;
void main() {
  float frame = loop.x + mod(floor(tick) + style.y, loop.y);
  vec3 raw = vec3(texelFetch(frames, ivec2(gl_VertexID, int(frame)), 0).rgb);
  vec3 p = (raw / 65536.0 - 0.5) * scale;
  float c = cos(instance.w), s = sin(instance.w);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) + instance.xyz;
  // The 256x256 atlas holds four outfits; the model's UVs cover the lower-right one (variant 4).
  float v = mod(style.x - 1.0, 4.0);   // variant 5 (rare, other venues) is not decoded: wrap onto the atlas
  texcoord = uv - vec2(mod(v, 2.0) < 0.5 ? 0.5 : 0.0, v < 1.5 ? 0.5 : 0.0); tint = shade;
  gl_Position = viewProjection * vec4(p, 1.0);
}`;
const WEAPON_VERTEX = `#version 300 es
in vec3 position; in vec3 normal; in vec2 uv;
uniform mat4 viewProjection; uniform mat4 model;
out vec2 texcoord; out vec3 world;
void main() {
  texcoord = uv; world = mat3(model) * normal;
  gl_Position = viewProjection * model * vec4(position, 1.0);
}`;
const WEAPON_FRAGMENT = `#version 300 es
precision highp float;
in vec2 texcoord; in vec3 world;
uniform sampler2D diffuse; uniform bool lit; uniform float lightScale;
out vec4 color;
` + irradianceGLSL + `
void main() {
  vec4 texel = texture(diffuse, texcoord);
  if (texel.a < 0.01) discard;
  vec3 k = lit ? clamp(irradiance(normalize(world)) * lightScale, 0.0, 1.5) : vec3(1.0);
  color = vec4(texel.rgb * k, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 texcoord; in vec3 tint;
uniform sampler2D diffuse;
out vec4 color;
void main() {
  vec4 texel = texture(diffuse, texcoord);
  if (texel.a < 0.01) discard;
  color = vec4(texel.rgb * tint, 1.0);
}`;

function program(gl, vertex, fragment = FRAGMENT) {
  const p = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
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

async function texture(gl, png) {
  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }),
    { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  bitmap.close();
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

/**
 * Upload scenery and return { render, dispose }.
 * render({ viewProjection, props, frame, excited, tick, crowd }):
 *   viewProjection  column-major 4x4 (the retail Battle matrix from battle/camera.mjs)
 *   props           { [objectName]: stateName | false } — default each prop's "base" state;
 *                   false hides it (e.g. after the retail break animation removes it)
 *   crowd           false hides the instanced crowd; otherwise tick/excited drive its frame
 */
export async function createSceneryRenderer(gl, { manifest, props, crowd, weapons = new Map() }, { lighting = null, lightScale = 1 } = {}) {
  const state = { props: null, crowd: null, weapons: null };
  const placements = new Map(manifest.props.map(p => [p.name, p.placement]));

  if (props) {
    const prog = program(gl, PROP_VERTEX);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer(), ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, props.vertices, gl.STATIC_DRAW);
    for (const [key, size, type, offset] of [["position", 3, gl.FLOAT, 0], ["uv", 2, gl.FLOAT, 12], ["rgba", 4, gl.UNSIGNED_BYTE, 20]]) {
      const at = gl.getAttribLocation(prog, key);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, type, key === "rgba", 24, offset);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, props.indices, gl.STATIC_DRAW);
    const textures = new Map();
    for (const [shape, png] of props.textures) textures.set(shape, await texture(gl, png));
    state.props = { prog, vao, vbo, ibo, textures };
  }
  if (crowd) {
    const prog = program(gl, CROWD_VERTEX);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const uv = gl.createBuffer(), ibo = gl.createBuffer(), instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uv);
    gl.bufferData(gl.ARRAY_BUFFER, crowd.uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(gl.getAttribLocation(prog, "uv"));
    gl.vertexAttribPointer(gl.getAttribLocation(prog, "uv"), 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, crowd.indices, gl.STATIC_DRAW);
    const list = crowd.mesh.instances;
    const data = new Float32Array(list.flatMap((i, n) => {
      const yaw = i.yawDegrees * Math.PI / 180;
      // The crowd mesh has no normals: shade each figure once, by the irradiance toward where it faces.
      const light = lighting ? irradiance(sampleIrradiance(lighting, i.translate), [Math.sin(yaw), 0, Math.cos(yaw)]) : [1, 1, 1];
      return [...i.translate, yaw, i.variant, instancePhase(n), ...(lighting ? light.map(v => Math.min(1.5, Math.max(0, v * lightScale))) : light)];
    }));
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (const [key, size, offset] of [["instance", 4, 0], ["style", 2, 16], ["shade", 3, 24]]) {
      const at = gl.getAttribLocation(prog, key);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, 36, offset);
      gl.vertexAttribDivisor(at, 1);
    }
    const frames = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, frames);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, crowd.mesh.vertices, crowd.mesh.frames, 0,
      gl.RGB_INTEGER, gl.UNSIGNED_SHORT, crowd.positions);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const atlas = await texture(gl, crowd.texture);
    state.crowd = { prog, vao, uv, ibo, instances, frames, atlas, count: list.length };
  }
  if (weapons.size) {
    const prog = program(gl, WEAPON_VERTEX, WEAPON_FRAGMENT);
    const models = new Map();
    for (const [name, data] of weapons) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer(), ibo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
      for (const [key, size, offset] of [["position", 3, 0], ["normal", 3, 12], ["uv", 2, 24]]) {
        const at = gl.getAttribLocation(prog, key);
        gl.enableVertexAttribArray(at);
        gl.vertexAttribPointer(at, size, gl.FLOAT, false, 52, offset);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
      const textures = new Map();
      for (const [shape, png] of data.textures) textures.set(shape, await texture(gl, png));
      models.set(name, { vao, vbo, ibo, textures, batches: data.mesh.batches });
    }
    state.weapons = { prog, models };
  }
  gl.bindVertexArray(null);

  function render({ viewProjection, props: choice = {}, tick = 0, excited = false, crowd: showCrowd = true, weapons: shown = {}, hiddenWeapons = false }) {
    if (state.props) {
      const { prog, vao, textures } = state.props;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, "viewProjection"), false, viewProjection);
      gl.bindVertexArray(vao);
      const type = props.mesh.indexBytes === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
      for (const object of props.mesh.objects) {
        const want = choice[object.name] ?? "base";
        if (want === false) continue;
        const shown = object.states.find(s => s.name === want);
        if (!shown) throw new Error(`${object.name} has no state ${want}`);
        const place = placements.get(object.name);
        gl.uniformMatrix4fv(gl.getUniformLocation(prog, "model"), false,
          place ? placementMatrix(place) : placementMatrix({ translate: [0, 0, 0], rotate: [0, 0, 0] }));
        for (const { shape, first, count } of shown.batches) {
          gl.bindTexture(gl.TEXTURE_2D, textures.get(shape) ?? null);
          gl.drawElements(gl.TRIANGLES, count, type, first * props.mesh.indexBytes);
        }
      }
    }
    if (state.crowd && showCrowd) {
      const { prog, vao, frames, atlas, count } = state.crowd;
      const [from, to] = excited ? crowd.mesh.loops.excited : crowd.mesh.loops.idle;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, "viewProjection"), false, viewProjection);
      gl.uniform3fv(gl.getUniformLocation(prog, "scale"), crowd.mesh.scale);
      gl.uniform2f(gl.getUniformLocation(prog, "loop"), from, to - from);
      gl.uniform1f(gl.getUniformLocation(prog, "tick"), tick);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, frames);
      gl.uniform1i(gl.getUniformLocation(prog, "frames"), 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.uniform1i(gl.getUniformLocation(prog, "diffuse"), 0);
      gl.drawElementsInstanced(gl.TRIANGLES, crowd.mesh.indices, gl.UNSIGNED_SHORT, 0, count);
    }
    if (state.weapons) {
      const { prog, models } = state.weapons;
      // hiddenWeapons: true reveals every hidden weapon at its placement; an array of names reveals only those.
      const hidden = new Set((manifest.hiddenWeapons ?? []).map(n => "weapon_" + n));
      const revealed = new Set(Array.isArray(hiddenWeapons) ? hiddenWeapons.map(n => n.startsWith("weapon_") ? n : "weapon_" + n) : []);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, "viewProjection"), false, viewProjection);
      gl.uniform1i(gl.getUniformLocation(prog, "lit"), lighting ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(prog, "lightScale"), lightScale);
      gl.uniform1i(gl.getUniformLocation(prog, "diffuse"), 0);
      gl.activeTexture(gl.TEXTURE0);
      for (const base of manifest.weapons ?? []) {
        const choice = shown[base.name];
        // A weapon entry is false (gone), or { translate, rotate } to show it somewhere else, such as a dropped bottle.
        const over = choice && typeof choice === "object" ? choice : null;
        if (choice === false || (!over && hidden.has(base.name) && hiddenWeapons !== true && !revealed.has(base.name))) continue;
        const w = over ? { ...base, ...over } : base;
        const model = models.get(w.model);
        if (!model) continue;
        if (lighting) gl.uniform3fv(gl.getUniformLocation(prog, "irradianceCoefficients"), sampleIrradiance(lighting, w.translate));
        gl.uniformMatrix4fv(gl.getUniformLocation(prog, "model"), false, placementMatrix(w));
        gl.bindVertexArray(model.vao);
        for (const { shape, first, count } of model.batches) {
          gl.bindTexture(gl.TEXTURE_2D, model.textures.get(shape) ?? null);
          gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2);
        }
      }
    }
    gl.bindVertexArray(null);
  }

  function dispose() {
    const free = part => {
      for (const v of Object.values(part)) {
        if (v instanceof WebGLBuffer) gl.deleteBuffer(v);
        else if (v instanceof WebGLTexture) gl.deleteTexture(v);
        else if (v instanceof WebGLVertexArrayObject) gl.deleteVertexArray(v);
        else if (v instanceof Map) for (const t of v.values()) t instanceof WebGLTexture ? gl.deleteTexture(t) : free(t);
      }
    };
    for (const part of Object.values(state)) {
      if (!part) continue;
      gl.deleteProgram(part.prog);
      free(part);
    }
  }
  return { render, dispose };
}
