import { loadScene, uploadScene } from "./scene.mjs";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };

const canvas = document.querySelector("canvas");
const status = document.querySelector("#status");

const vertex = `#version 300 es
in vec3 position;
in vec4 rgba;
in vec2 uv;
out vec2 texcoord;
uniform vec3 center;
uniform vec3 right;
uniform vec3 up;
uniform vec3 forward;
uniform vec3 scale;
out float height;
out vec3 world;
out vec3 vertexColor;
void main() {
  texcoord = uv;
  height = position.y;
  world = position - center;
  // The retail GS uses 128 for a full modulation factor.
  vertexColor = rgba.rgb * (255.0 / 128.0);
  gl_Position = vec4(vec3(dot(world,right), dot(world,up), dot(world,forward)) * scale, 1.0);
}`;
const fragment = `#version 300 es
precision highp float;
in float height;
uniform float ceiling;
in vec3 world;
in vec2 texcoord;
uniform sampler2D diffuse;
in vec3 vertexColor;
out vec4 color;
void main() {
  if (height > ceiling) discard;
  vec4 texel = texture(diffuse, texcoord);
  if (texel.a < 0.01) discard;
  color = vec4(texel.rgb * vertexColor, 1.0);
}`;

function createProgram(gl) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

async function display() {
  const gl = canvas.getContext("webgl2", { alpha: false });
  if (!gl) throw new Error("WebGL 2 is required to inspect this mesh");
  const program = createProgram(gl);
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.10, 0.115, 0.12, 1);

  let scene, request;
  const venue = document.querySelector("#venue");
  for (const item of [...inventory.venues].sort((a,b) => a.name.localeCompare(b.name))) {
    venue.add(new Option(item.name, item.file));
  }
  venue.value = "V2BG_02A";
  const uniform = key => gl.getUniformLocation(program, key);
  const right = uniform("right"), up = uniform("up"), forward = uniform("forward"), scale = uniform("scale");
  const focus = uniform("center"), ceiling = uniform("ceiling");
  const cutaway = document.querySelector("#cutaway");
  let yaw = 0.65, pitch = 0.70, zoom = 1;

  function draw() {
    if (!scene) return;
    const { min, max } = scene.bounds;
    const center = min.map((value, i) => (value + max[i]) / 2);
    const radius = Math.hypot(...max.map((value, i) => value - center[i]));
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    gl.uniform3f(right, cy, 0, -sy);
    gl.uniform3f(up, -sy * sp, cp, -cy * sp);
    gl.uniform3f(forward, -sy * cp, -sp, -cy * cp);
    // The two Foundation single-match slots straddle the origin. Center the
    // inspection camera on the fight floor when the upper room is clipped.
    const span = cutaway.checked ? 100 : radius;
    gl.uniform3fv(focus, cutaway.checked ? [0, 11, 0] : center);
    gl.uniform1f(ceiling, cutaway.checked ? 23 : max[1] + 1);
    const size = zoom * 0.98 / span;
    gl.uniform3f(scale, size * Math.min(1, height / width), size * Math.min(1, width / height), 0.98 / (radius * 2));
    scene.draw();
  }
  function move(dx, dy, magnification = 1) {
    yaw += dx;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + dy));
    zoom = Math.max(0.4, Math.min(12, zoom * magnification));
    draw();
  }
  canvas.addEventListener("pointerdown", event => canvas.setPointerCapture(event.pointerId));
  canvas.addEventListener("pointermove", event => {
    if (canvas.hasPointerCapture(event.pointerId)) move(-event.movementX * 0.008, event.movementY * 0.008);
  });
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    move(0, 0, Math.exp(-Math.sign(event.deltaY) * 0.12));
  }, { passive: false });
  const keys = { ArrowLeft: [-0.12, 0], ArrowRight: [0.12, 0], ArrowUp: [0, 0.12],
    ArrowDown: [0, -0.12], "+": [0, 0, 1.15], "=": [0, 0, 1.15], "-": [0, 0, 1 / 1.15] };
  canvas.addEventListener("keydown", event => {
    if (!Object.hasOwn(keys, event.key)) return;
    event.preventDefault();
    move(...keys[event.key]);
  });
  cutaway.addEventListener("change", draw);
  new ResizeObserver(draw).observe(canvas);
  async function select() {
    request?.abort();
    const controller = request = new AbortController();
    const model = venue.value;
    status.textContent = "Loading venue…";
    try {
      const data = await loadScene(model, controller.signal);
      const next = uploadScene(gl, program, data);
      scene?.dispose();
      scene = next;
      zoom = 1;
      draw();
      status.textContent = "Drag to rotate · Scroll to zoom";
      canvas.dataset.venue = model;
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error.message;
    }
  }
  venue.addEventListener("change", select);
  await select();
}
display().catch(error => { status.textContent = error.message; });
