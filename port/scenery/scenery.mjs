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
import { irradianceGLSL, sampleIrradiance } from "./irradiance.mjs";
import { bankPose, loadPeople, skinPalette, POSE_FLOATS } from "./people.mjs";
import { createParticles, trainLights } from "./particles.mjs";
import { createFader, eyeOf } from "./occlusion.mjs";
import { createTexAnim } from "./texanim.mjs";


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
  const wanted = [...new Set([...(manifest.weapons ?? []).map(w => w.model), ...(manifest.hiddenWeaponModels ?? []), ...(manifest.droppedWeaponModels ?? [])])];
  const weapons = new Map();
  await Promise.all(wanted.map(async model => {
    weapons.set(model, parseSkinned(await fetchPacked(new URL(`weapons/${model}.skin.gz`, base), signal)));
  }));
  // The subway's cars (venue 4) are one-bone meshes in the venue's own directory and are drawn like weapons.
  await Promise.all((manifest.subway?.objects ?? []).map(async model => {
    weapons.set(model, parseSkinned(await fetchPacked(new URL(`trains/${model}.skin.gz`, dir), signal)));
  }));
  // Gun Hill Garage's two cars: one mesh each (the body and every panel's damage states), in the venue's cars/ folder.
  await Promise.all((manifest.cars ?? []).map(async car => {
    weapons.set(car.name, parseSkinned(await fetchPacked(new URL(car.file, dir), signal)));
  }));
  // Venues with retail near-crowd positions list `people` in index.json (crowd_bank.py); the Foundation's own folder is "foundation/".
  const people = manifest.people ? await loadPeople(dir, { signal, parseSkinned }) : null;
  // The venue's JDI particle effects (particles.py): the effect table and its sprite sheet.
  const particles = manifest.particles
    ? { manifest: JSON.parse(new TextDecoder().decode(await fetchPacked(new URL("particles.json", dir), signal))),
        png: await fetchPacked(new URL("particles.png", dir), signal) }
    : null;
  // Animated texture planes (Red Hook's flames, texanim.py).
  const texanim = manifest.texanim
    ? { manifest: JSON.parse(new TextDecoder().decode(await fetchPacked(new URL("texanim.json", dir), signal))),
        png: await fetchPacked(new URL("texanim.png", dir), signal) }
    : null;
  return { manifest, props, crowd, weapons, people, particles, texanim };
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
in vec2 uv; in vec4 instance; in vec2 style; in vec3 shade; in float fade;
uniform highp usampler2D frames;   // 16-bit XYZ per vertex (x) per retail frame (y)
uniform mat4 viewProjection; uniform vec3 scale;
uniform vec2 loop;                 // first frame, frame count of the active cycle
uniform float tick;
out vec2 texcoord; out vec3 tint; out float shown;
void main() {
  float frame = loop.x + mod(floor(tick) + style.y, loop.y);
  vec3 raw = vec3(texelFetch(frames, ivec2(gl_VertexID, int(frame)), 0).rgb);
  vec3 p = (raw / 65536.0 - 0.5) * scale;
  float c = cos(instance.w), s = sin(instance.w);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) + instance.xyz;
  // The 256x256 atlas holds four outfits; the model's UVs cover the lower-right one (variant 4).
  float v = mod(style.x - 1.0, 4.0);   // variant 5 (rare, other venues) is not decoded: wrap onto the atlas
  texcoord = uv - vec2(mod(v, 2.0) < 0.5 ? 0.5 : 0.0, v < 1.5 ? 0.5 : 0.0); tint = shade; shown = fade;
  gl_Position = viewProjection * vec4(p, 1.0);
}`;
const WEAPON_VERTEX = `#version 300 es
in vec3 position; in vec3 normal; in vec2 uv;
uniform mat4 viewProjection; uniform mat4 model;
out vec2 texcoord; out vec3 shade;
uniform bool lit; uniform float lightScale;
` + irradianceGLSL + `
void main() {
  texcoord = uv;
  vec3 n = mat3(model) * normal;
  gl_Position = viewProjection * model * vec4(position, 1.0);
  shade = (lit ? vertexIrradiance(n) * lightScale : vec3(1.0)) * gl_Position.w;
}`;
const WEAPON_FRAGMENT = `#version 300 es
precision highp float;
in vec2 texcoord; in vec3 shade;
uniform sampler2D diffuse;
out vec4 color;
void main() {
  vec4 texel = texture(diffuse, texcoord);
  if (texel.a < 0.01) discard;
  vec3 k = shade * gl_FragCoord.w;
  color = vec4(texel.rgb * k, 1.0);
}`;
// Screen-door fade (occlusion.mjs): a 4 x 4 ordered dither against the figure's visibility, no blending or sorting.
const DITHER = `
const float bayer[16] = float[16](0.,8.,2.,10., 12.,4.,14.,6., 3.,11.,1.,9., 15.,7.,13.,5.);
float dither() {
  ivec2 p = ivec2(gl_FragCoord.xy) & 3;
  return (bayer[p.y * 4 + p.x] + 0.5) / 16.0;
}`;
const CROWD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 texcoord; in vec3 tint; in float shown;
uniform sampler2D diffuse;
out vec4 color;
` + DITHER + `
void main() {
  vec4 texel = texture(diffuse, texcoord);
  if (texel.a < 0.01 || shown <= dither()) discard;
  color = vec4(texel.rgb * tint, 1.0);
}`;
const PEOPLE_FRAGMENT = WEAPON_FRAGMENT.replace("uniform sampler2D diffuse;", "uniform sampler2D diffuse; uniform float fade;")
  .replace("void main() {", DITHER + "\nvoid main() {\n  if (fade <= dither()) discard;");
const PEOPLE_VERTEX = `#version 300 es
in vec3 position; in vec3 normal; in vec2 uv; in uvec4 joints; in vec4 weights;
uniform mat4 viewProjection; uniform mat4 model; uniform mat4 bones[13];
out vec2 texcoord; out vec3 shade;
uniform bool lit; uniform float lightScale;
` + irradianceGLSL + `
void main() {
  mat4 skin = bones[joints.x] * weights.x + bones[joints.y] * weights.y + bones[joints.z] * weights.z + bones[joints.w] * weights.w;
  texcoord = uv;
  vec3 n = mat3(model) * mat3(skin) * normal;
  gl_Position = viewProjection * model * skin * vec4(position, 1.0);
  shade = (lit ? vertexIrradiance(n) * lightScale : vec3(1.0)) * gl_Position.w;
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
export async function createSceneryRenderer(gl, { manifest, props, crowd, weapons = new Map(), people = null, particles = null, texanim = null }, { lighting = null, crowdLighting = lighting, lightScale = 1 } = {}) {
  const state = { props: null, crowd: null, weapons: null, people: null };
  const stageTexAnim = texanim ? await createTexAnim(gl, texanim.manifest, texanim.png) : null;
  const stageParticles = particles ? await createParticles(gl, particles.manifest, particles.png) : null;
  let drawWeapon = () => {};
  const identity = placementMatrix({translate:[0,0,0], rotate:[0,0,0]});
  const placements = new Map(manifest.props.map(p => [p.name, p.placement ? placementMatrix(p.placement) : identity]));
  const hidden = new Set((manifest.hiddenWeapons ?? []).map(name => "weapon_" + name));
  const placedCars = (manifest.cars ?? []).map(car => ({
    car, matrix: placementMatrix(car.placement), light: lighting ? sampleIrradiance(lighting, car.placement.translate) : null,
  }));
  const placedWeapons = (manifest.weapons ?? []).map(base => ({
    base, matrix: placementMatrix(base), light: lighting ? sampleIrradiance(lighting, base.translate) : null,
  }));
  const uniforms = (prog, names) => Object.fromEntries(names.map(name => [name, gl.getUniformLocation(prog, name)]));

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
    state.props = { prog, vao, vbo, ibo, textures, uniform: uniforms(prog, ["viewProjection","model"]) };
  }
  if (crowd) {
    const prog = program(gl, CROWD_VERTEX, CROWD_FRAGMENT);
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
      // 0x1e9a28 uses light set 1. Its basis at 0x3daea0 selects only the constant coefficient.
      const light = crowdLighting ? sampleIrradiance(crowdLighting, i.translate).slice(0, 3).map(c => c * lightScale) : [1, 1, 1];
      return [...i.translate, yaw, i.variant, instancePhase(n), ...light];
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
    const uniform = uniforms(prog, ["viewProjection","scale","loop","tick","frames","diffuse"]);
    gl.useProgram(prog);
    gl.uniform3fv(uniform.scale, crowd.mesh.scale);
    gl.uniform1i(uniform.frames, 1);
    gl.uniform1i(uniform.diffuse, 0);
    // Per-instance visibility (occlusion.mjs), refreshed every frame.
    const fadeBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fadeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(list.length).fill(1), gl.DYNAMIC_DRAW);
    const fadeAt = gl.getAttribLocation(prog, "fade");
    gl.enableVertexAttribArray(fadeAt);
    gl.vertexAttribPointer(fadeAt, 1, gl.FLOAT, false, 4, 0);
    gl.vertexAttribDivisor(fadeAt, 1);
    state.crowd = { prog, vao, uv, ibo, instances, frames, atlas, count: list.length, uniform, fadeBuffer,
      fader: createFader(list.map(i => i.translate)) };
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
    const uniform = uniforms(prog, ["viewProjection","model","irradianceCoefficients","lit","lightScale","diffuse"]);
    gl.useProgram(prog);
    gl.uniform1i(uniform.lit, lighting ? 1 : 0);
    gl.uniform1f(uniform.lightScale, lightScale);
    gl.uniform1i(uniform.diffuse, 0);
    state.weapons = { prog, models, uniform };
    const lightBuffer = new Float32Array(30);
    drawWeapon = (name, matrix, at, light, panels = null) => {
      const model = models.get(name);
      if (!model) return;
      if (lighting) gl.uniform3fv(uniform.irradianceCoefficients, light ?? sampleIrradiance(lighting, at, lightBuffer));
      gl.uniformMatrix4fv(uniform.model, false, matrix);
      gl.bindVertexArray(model.vao);
      for (const { shape, first, count, object, state } of model.batches) {
        // A car's batches belong to a panel in one damage state (`panels` is the choice per panel); the body has neither.
        if (object !== undefined && state !== (panels[object] ?? "base")) continue;
        gl.bindTexture(gl.TEXTURE_2D, model.textures.get(shape) ?? null);
        gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2);
      }
    };
  }
  if (people) {
    const prog = program(gl, PEOPLE_VERTEX, PEOPLE_FRAGMENT);
    const classes = [];
    for (const data of people.classes) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer(), ibo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
      for (const [key, size, type, offset] of [["position", 3, gl.FLOAT, 0], ["normal", 3, gl.FLOAT, 12], ["uv", 2, gl.FLOAT, 24], ["joints", 4, gl.UNSIGNED_BYTE, 32], ["weights", 4, gl.FLOAT, 36]]) {
        const at = gl.getAttribLocation(prog, key);
        gl.enableVertexAttribArray(at);
        if (key === "joints") gl.vertexAttribIPointer(at, size, type, 52, offset);
        else gl.vertexAttribPointer(at, size, type, false, 52, offset);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
      classes.push({ vao, vbo, ibo, batches: data.mesh.batches, bones: data.mesh.bones });
    }
    const outfits = new Map();
    for (const [key, png] of people.outfits) outfits.set(key, await texture(gl, png));
    const uniform = uniforms(prog, ["viewProjection","model","bones","irradianceCoefficients","lit","lightScale","diffuse","fade"]);
    gl.useProgram(prog);
    gl.uniform1i(uniform.lit, crowdLighting ? 1 : 0);
    gl.uniform1f(uniform.lightScale, lightScale);
    gl.uniform1i(uniform.diffuse, 0);
    const spectators = people.manifest.spectators.map(s => ({
      ...s, matrix: placementMatrix(s), light: crowdLighting ? sampleIrradiance(crowdLighting, s.translate) : null }));
    state.people = { prog, classes, outfits, uniform, spectators, bank: people.bank, pose: new Float32Array(POSE_FLOATS), palette: new Float32Array(13 * 16),
      fader: createFader(spectators.map(s => s.translate)) };
  }
  gl.bindVertexArray(null);

  function render({ viewProjection, props: choice = {}, tick = 0, excited = false, crowd: showCrowd = true, people: showPeople = true, particleEvents = [], fire = null, particles: showParticles = true, sight = [], occlusion = false, weapons: shown = {}, hiddenWeapons = false, dynamicWeapons = [] }) {
    // Opt-in (retail has no such rule): spectators and the instanced crowd standing between the camera and a fighter fade out, see occlusion.mjs.
    const eye = occlusion && sight.length ? eyeOf(viewProjection) : null;
    if (state.props) {
      const { prog, vao, textures, uniform } = state.props;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uniform.viewProjection, false, viewProjection);
      gl.bindVertexArray(vao);
      const type = props.mesh.indexBytes === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
      for (const object of props.mesh.objects) {
        const want = choice[object.name] ?? "base";
        if (want === false) continue;
        const shown = object.states.find(s => s.name === want);
        if (!shown) throw new Error(`${object.name} has no state ${want}`);
        gl.uniformMatrix4fv(uniform.model, false, placements.get(object.name) ?? identity);
        for (const { shape, first, count } of shown.batches) {
          gl.bindTexture(gl.TEXTURE_2D, textures.get(shape) ?? null);
          gl.drawElements(gl.TRIANGLES, count, type, first * props.mesh.indexBytes);
        }
      }
    }
    if (state.crowd && showCrowd) {
      const { prog, vao, frames, atlas, count, uniform, fadeBuffer, fader } = state.crowd;
      const [from, to] = excited ? crowd.mesh.loops.excited : crowd.mesh.loops.idle;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uniform.viewProjection, false, viewProjection);
      gl.uniform2f(uniform.loop, from, to - from);
      gl.uniform1f(uniform.tick, tick);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, fadeBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, fader.update(eye, sight));
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, frames);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.drawElementsInstanced(gl.TRIANGLES, crowd.mesh.indices, gl.UNSIGNED_SHORT, 0, count);
    }
    if (state.people && showPeople) {
      const { prog, classes, outfits, uniform, spectators, bank, pose, palette, fader } = state.people;
      const fades = fader.update(eye, sight);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uniform.viewProjection, false, viewProjection);
      gl.activeTexture(gl.TEXTURE0);
      for (const [n, spectator] of spectators.entries()) {
        if (fades[n] <= 0) continue;
        gl.uniform1f(uniform.fade, fades[n]);
        const model = classes[spectator.class];
        // Each spectator plays its track from its own offset (`phase`, game ticks) so rows do not move in lockstep.
        skinPalette(bankPose(bank, spectator.trackIndex, tick + spectator.phase, pose), model.bones, palette);
        if (crowdLighting) gl.uniform3fv(uniform.irradianceCoefficients, spectator.light);
        gl.uniformMatrix4fv(uniform.model, false, spectator.matrix);
        gl.uniformMatrix4fv(uniform.bones, false, palette);
        gl.bindVertexArray(model.vao);
        for (const { shape, first, count } of model.batches) {
          gl.bindTexture(gl.TEXTURE_2D, outfits.get(spectator.outfit[shape]) ?? null);
          gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2);
        }
      }
    }
    if (state.weapons) {
      const { prog, uniform } = state.weapons;
      // hiddenWeapons: true reveals every hidden weapon at its placement; an array of names reveals only those.
      const revealed = new Set(Array.isArray(hiddenWeapons) ? hiddenWeapons.map(n => n.startsWith("weapon_") ? n : "weapon_" + n) : []);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uniform.viewProjection, false, viewProjection);
      gl.activeTexture(gl.TEXTURE0);
      for (const {base, matrix, light} of placedWeapons) {
        const choice = shown[base.name];
        // A weapon entry is false (gone), or { translate, rotate } to show it somewhere else, such as a dropped bottle.
        const over = choice && typeof choice === "object" ? choice : null;
        if (choice === false || (!over && hidden.has(base.name) && hiddenWeapons !== true && !revealed.has(base.name))) continue;
        if (over) {
          const w = {...base, ...over};
          drawWeapon(w.model, over.matrix ?? placementMatrix(w), w.translate);
        } else drawWeapon(base.model, matrix, base.translate, light);
      }
      // Cars: the placed body and each panel in the damage state the environment events chose (`props` names panels too).
      for (const { car, matrix, light } of placedCars) drawWeapon(car.name, matrix, car.placement.translate, light, choice);
      // Weapons the match holds or has dropped: a model and a world matrix (column-major, translation last).
      for (const { model, matrix } of dynamicWeapons) drawWeapon(model, matrix, [matrix[12], matrix[13], matrix[14]]);
    }
    if (stageTexAnim && showParticles) stageTexAnim.draw(viewProjection, { tick, fire });
    if (stageParticles && showParticles) {
      const train = dynamicWeapons.find(w => w.train);
      stageParticles.update({ tick, events: particleEvents,
        lights: trainLights(manifest.subway, particles.manifest.effects, train, train?.phase) });
      stageParticles.draw(viewProjection);
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
