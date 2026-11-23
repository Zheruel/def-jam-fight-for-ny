import { loadPoseBank, capturedIdles, poseIndex } from "../motion/pose-bank.mjs";
import { createBattleLineup } from "../battle/setup.mjs";
import { loadFighter, loadScene, uploadScene } from "./scene.mjs";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };

const canvas = document.querySelector("canvas");
const status = document.querySelector("#status");

const vertex = `#version 300 es
in vec3 position;
in vec4 rgba;
in vec3 normal;
in vec4 joints;
in vec4 weights;
layout(std140) uniform Skeleton { mat4 jointMatrix[128]; };
uniform bool skinned;
uniform vec3 origin;
uniform float heading;
in vec2 uv;
out vec2 texcoord;
uniform vec3 center;
uniform vec3 right;
uniform vec3 up;
uniform vec3 forward;
uniform vec3 scale;
uniform bool matchView;
uniform mat4 viewProjection;
out float height;
out vec3 world;
out vec3 vertexColor;
void main() {
  texcoord = uv;
  vec3 p = position;
  if (skinned) {
    mat4 pose = jointMatrix[int(joints.x)] * weights.x + jointMatrix[int(joints.y)] * weights.y
              + jointMatrix[int(joints.z)] * weights.z + jointMatrix[int(joints.w)] * weights.w;
    p = (pose * vec4(p, 1.0)).xyz;
    mat2 turn = mat2(cos(heading), -sin(heading), sin(heading), cos(heading));
    p.xz = turn * p.xz;
    p += origin;
    vec3 n = mat3(pose) * normal;
    n.xz = turn * n.xz;
    vertexColor = vec3(0.80 + 0.20 * dot(normalize(n), normalize(vec3(0.3,1.0,0.7))));
  } else {
    vertexColor = rgba.rgb * (255.0 / 128.0);
  }
  height = p.y;
  world = p - center;
  gl_Position = matchView ? viewProjection * vec4(p,1.0) : vec4(vec3(dot(world,right), dot(world,up), dot(world,forward)) * scale, 1.0);
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

  const battle = document.body.hasAttribute("data-battle");
  let fight, controls, camera, hud, paused = false, previousFrame, carry = 0, renderedFrames = 0;
  let scenery;
  let scene, request, skinRequest, selected = [];
  const selectors = [document.querySelector("#player1"),document.querySelector("#player2")];
  const pose = gl.createBuffer();
  const bind = new Float32Array(128 * 16);
  for (let i = 0; i < bind.length; i += 16) bind[i] = bind[i+5] = bind[i+10] = bind[i+15] = 1;
  gl.bindBuffer(gl.UNIFORM_BUFFER, pose);
  gl.bufferData(gl.UNIFORM_BUFFER, bind, gl.DYNAMIC_DRAW);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, pose);
  gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program,"Skeleton"), 0);
  for (const select of selectors) {
    for (const f of [...inventory.fighters].sort((a,b) => a.name.localeCompare(b.name))) {
      const variants = inventory.fighters.filter(other => other.name === f.name);
      const label = variants.length > 1 ? f.name + " (" + (variants.indexOf(f)+1) + ")" : f.name;
      select.add(new Option(label, f.handle));
    }
  }
  selectors[0].value = "0x07000030";
  selectors[1].value = "0x07000025";
  const params=new URLSearchParams(location.search);
  if(battle) selectors.forEach((s,i)=>{
    const handle=params.get("p"+(i+1));
    if(inventory.fighters.some(f=>f.handle===handle)) s.value=handle;
  });
  const venue = document.querySelector("#venue");
  for (const item of [...inventory.venues].sort((a,b) => a.name.localeCompare(b.name))) {
    const option = new Option(item.name, item.file);
    option.dataset.handle = item.handle;
    venue.add(option);
  }
  const requestedVenue = battle && new URLSearchParams(location.search).get("venue");
  const arena = inventory.venues.find(v=>v.file===requestedVenue) ?? inventory.venues.find(v=>v.file==="V2BG_02A");
  venue.value = arena.file;
  const uniform = key => gl.getUniformLocation(program, key);
  const right = uniform("right"), up = uniform("up"), forward = uniform("forward"), scale = uniform("scale");
  const skinned = uniform("skinned"), origin = uniform("origin"), heading = uniform("heading");
  const focus = uniform("center"), ceiling = uniform("ceiling");
  const perspective = uniform("matchView"), viewProjection=uniform("viewProjection");
  const cutaway = document.querySelector("#cutaway");
  let yaw = 0.28, pitch = 0.32, zoom = 1;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let lineup;
  function updateLineup() {
    if (selected.length === 2) lineup = createBattleLineup(venue.selectedOptions[0].dataset.handle,
      "SINGLE",selected.map(s => s.handle));
  }
  let scheduled = 0, started = performance.now();
  function frame(now) {
    scheduled = 0;
    if (document.hidden) { previousFrame = undefined; return; }
    if (fight && !paused && !controls.isGuest()) {
      const elapsed = previousFrame === undefined ? 0 : Math.min(100,now-previousFrame);
      carry += elapsed;
      try {
        while (carry >= 1000/60) {
          fight.tick(controls.inputs());
          camera.step(fight.states);
          carry -= 1000/60;
        }
      } catch (error) {
        paused = true;
        status.textContent = error.message + " Restart to return to the match.";
      }
    }
    previousFrame = now;
    if (!controls?.isGuest()) { draw(); renderedFrames++; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { previousFrame = undefined; cancelAnimationFrame(scheduled); scheduled = 0; }
    else draw();
  });
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
    gl.useProgram(program);
    gl.uniform1i(perspective,Boolean(camera));
    const projection=camera?.matrix();
    if(projection) gl.uniformMatrix4fv(viewProjection,false,projection);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    gl.uniform3f(right, cy, 0, -sy);
    gl.uniform3f(up, -sy * sp, cp, -cy * sp);
    gl.uniform3f(forward, -sy * cp, -sp, -cy * cp);
    // The two Foundation single-match slots straddle the origin. Center the
    // inspection camera on the fight floor when the upper room is clipped.
    const span = cutaway.checked ? 39 : radius;
    gl.uniform3fv(focus, cutaway.checked ? [0, 11, 0] : center);
    gl.uniform1f(ceiling, camera ? 1e8 : cutaway.checked ? 23 : max[1] + 1);
    const size = zoom * 0.98 / span;
    gl.uniform3f(scale, size * Math.min(1, height / width), size * Math.min(1, width / height), 0.98 / (radius * 2));
    gl.uniform1i(skinned, 0);
    scene.draw();
    if(scenery && projection) {
      scenery.render({viewProjection:projection,tick:fight?.diagnostics().ticks??0});
      gl.useProgram(program);
    }
    if (selected.length) {

      gl.uniform1i(skinned, 1);
      gl.uniform1f(ceiling, 1e8);
      selected.forEach(({body, bank, model}, i) => {
        const clip = bank?.clips[capturedIdles[model]];
        const time = clip ? 1 + Math.floor((performance.now()-started)*0.06) % clip.end : 0;
        const index = clip ? poseIndex(clip,time) : 0;
        gl.bindBuffer(gl.UNIFORM_BUFFER, pose);
        const live = fight?.states[i];
        gl.bufferSubData(gl.UNIFORM_BUFFER,0,live?.skin ?? (clip ? clip.poses[index] : bind));
        const [x,z] = lineup.participants[i].position;
        const target = lineup.participants[1-i].position;
        if (live) {
          gl.uniform3fv(origin,live.position);
          gl.uniform1f(heading,live.yaw*Math.PI/180);
        } else {
          gl.uniform3f(origin,x,0,z);
          gl.uniform1f(heading,Math.atan2(target[0]-x,target[1]-z));
        }
        body.draw(live?.damage??0);
      });
      if (fight) hud(fight.diagnostics());
      const animate = battle ? fight && !paused && !controls.isGuest() : !reducedMotion.matches && selected.some(s=>s.bank);
      if (animate && !document.hidden && !scheduled) scheduled = requestAnimationFrame(frame);
    }
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
    if (battle || !Object.hasOwn(keys, event.key)) return;
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
      updateLineup();
      zoom = 1;
      draw();
      status.textContent = "Drag to rotate · Scroll to zoom";
      canvas.dataset.venue = model;
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error.message;
    }
  }
  async function chooseFighters() {
    skinRequest?.abort();
    const controller = skinRequest = new AbortController();
    const next = [];
    try {
      for (const [i,select] of selectors.entries()) {
        if (selected[i]?.handle === select.value) { next.push(selected[i]); continue; }
        const fighter = inventory.fighters.find(f => f.handle === select.value);
        const data = await loadFighter(fighter.model, controller.signal);
        const draw = {record:fighter, handle: fighter.handle, model: fighter.model, body: uploadScene(gl, program, data)};
        next.push(draw);
        if(!battle) draw.bank = await loadPoseBank(fighter.model,controller.signal);
      }
      selected.filter(s=>!next.includes(s)).forEach(s => s.body.dispose());
      selected = next;
      updateLineup();
      draw();
      canvas.dataset.fighters = selected.map(s => s.handle).join(",");
    } catch (error) {
      next.filter(s=>!selected.includes(s)).forEach(s => s.body.dispose());
      if (!controller.signal.aborted) status.textContent = error.message;
    }
  }
  selectors.forEach((s,i)=>s.addEventListener("change",()=>{
    if(!battle) return chooseFighters();
    const destination=new URL(location.href);
    destination.searchParams.set("p"+(i+1),s.value);
    location.assign(destination);
  }));
  venue.addEventListener("change", () => {
    if (!battle) return select();
    const destination=new URL(location.href);
    destination.searchParams.set("venue",venue.value);
    location.assign(destination);
  });
  await Promise.all([select(), chooseFighters()]);
  if (battle && selected.length === 2 && scene) {
    const { loadFoundationFight } = await import("../battle/fight.mjs");
    const { battleControls } = await import("../battle/controls.mjs");
    const { foundationCamera } = await import("../battle/camera.mjs");
    const { createHud } = await import("../hud/hud.mjs");
    const { foundationAudio }=await import("../audio/foundation.mjs");
    const audio=arena.file==="V2BG_02A" ? foundationAudio() : undefined;
    if(!audio) document.querySelector("#sound").hidden=true;
    if(arena.file==="V2BG_02A") {
      const {createSceneryRenderer,loadScenery}=await import("../scenery/scenery.mjs");
      scenery=await createSceneryRenderer(gl,await loadScenery(arena.file));
    }
    camera=foundationCamera();
    hud=await createHud(gl);
    controls = battleControls(() => { previousFrame=undefined; draw(); },audio);
    fight = await loadFoundationFight(selected,arena);
    status.textContent = "WASD and arrows to move · Controls below";
    document.getElementById("restart").onclick = () => {
      controls.release(); fight.restart(); camera.reset(); audio?.restart(); paused=false; previousFrame=undefined; carry=0; draw();
      status.textContent = "WASD and arrows to move · Controls below";
    };
    window.nativeBattle = Object.freeze({ setInput:controls.setInput, diagnostics:() => ({
      ...fight.diagnostics(), renderedFrames, paused, network:controls.connection() }) });
    draw();
  }
}
display().catch(error => { status.textContent = error.message; });
