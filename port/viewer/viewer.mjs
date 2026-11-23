import { shadowProjection } from "../render/shadow.mjs";
import { irradianceGLSL, loadLighting, sampleIrradiance } from "../scenery/irradiance.mjs";
import { loadPoseBank, capturedIdles, poseIndex } from "../motion/pose-bank.mjs";
import { createBattleLineup } from "../battle/setup.mjs";
import { MODES, freeForAllAvailable, parseBattleQuery, venueSupports } from "../battle/modes.mjs";
import { rematchChoice } from "../hud/rematch.mjs";
import { REMATCH_DELAY } from "../hud/result.mjs";
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
uniform bool shadowPass;
uniform mat4 shadowMatrix;
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
out vec3 worldNormal;
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
    if(shadowPass) {
      gl_Position=viewProjection*shadowMatrix*vec4(p,1.0);
      return;
    }
    vec3 n = mat3(pose) * normal;
    n.xz = turn * n.xz;
    worldNormal = n;
    vertexColor = vec3(0.80 + 0.20 * dot(normalize(n), normalize(vec3(0.3,1.0,0.7))));
  } else {
    worldNormal = vec3(0.0,1.0,0.0);
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
in vec3 worldNormal;
uniform bool skinned;
uniform bool lightFighters;
uniform bool shadowPass;
uniform vec4 shadowColour;
${irradianceGLSL}
out vec4 color;
void main() {
  if(shadowPass) {color=shadowColour;return;}
  if (height > ceiling) discard;
  vec4 texel = texture(diffuse, texcoord);
  if (texel.a < 0.01) discard;
  vec3 tint = skinned && lightFighters ? clamp(1.2 * irradiance(normalize(worldNormal)), 0.0, 1.5) : vertexColor;
  color = vec4(texel.rgb * tint, 1.0);
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
  const gl = canvas.getContext("webgl2", {alpha:false,stencil:document.body.hasAttribute("data-battle")});
  if (!gl) throw new Error("WebGL 2 is required to inspect this mesh");
  const program = createProgram(gl);
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.10, 0.115, 0.12, 1);

  const battle = document.body.hasAttribute("data-battle");
  const stepMs = 1000/60;
  let fight, controls, camera, hud, rematch, paused = false, previousFrame, carry = stepMs/2, renderedFrames = 0;
  let scenery, lighting, combatAudio, environment, trainAudio;
  const coefficients = new Float32Array(30);
  let scene, request, skinRequest, selected = [];
  const params=new URLSearchParams(location.search);
  const ffaAllowed = battle && freeForAllAvailable();
  const query = battle ? parseBattleQuery(params,{fighters:inventory.fighters,venues:inventory.venues,ffa:ffaAllowed}) : null;
  const mode = query?.mode ?? "1v1", count = MODES[mode].fighters;
  const selectors = [1,2,3,4].slice(0,count).map(n=>document.querySelector("#player"+n));
  const modeSelect = document.querySelector("#mode");
  if(modeSelect) {
    modeSelect.replaceChildren(...Object.entries(MODES).map(([key,value])=>new Option(value.label,key)));
    modeSelect.hidden = !ffaAllowed;
    modeSelect.value = mode;
  }
  document.querySelectorAll("#player3,#player4").forEach((select,i)=>select.hidden = i+2 >= count);
  document.body.dataset.mode = mode;
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
  if(battle) selectors.forEach((s,i)=>{ s.value=query.handles[i]; });
  // One fighter per seat in Free For All: a fighter another seat holds (or a namesake) cannot be picked again.
  function distinctFighters() {
    if(count <= 2) return;
    const held = selectors.map(s=>inventory.fighters.find(f=>f.handle===s.value));
    selectors.forEach((select,i)=>{
      for(const option of select.options) {
        const f=inventory.fighters.find(entry=>entry.handle===option.value);
        option.disabled = held.some((other,j)=>j!==i && (other.fighterXml.coreID===f.fighterXml.coreID || other.name===f.name));
      }
    });
  }
  distinctFighters();
  const venue = document.querySelector("#venue");
  for (const item of [...inventory.venues].sort((a,b) => a.name.localeCompare(b.name))) {
    const option = new Option(item.name, item.file);
    option.dataset.handle = item.handle;
    venue.add(option);
  }
  const arena = inventory.venues.find(v=>v.file===(battle ? query.venue : "V2BG_02A")) ?? inventory.venues.find(v=>v.file==="V2BG_02A");
  venue.value = arena.file;
  if(battle) for(const option of venue.options) option.disabled = !venueSupports(option.value,mode);
  const uniform = key => gl.getUniformLocation(program, key);
  const right = uniform("right"), up = uniform("up"), forward = uniform("forward"), scale = uniform("scale");
  const skinned = uniform("skinned"), origin = uniform("origin"), heading = uniform("heading");
  const shadowPass=uniform("shadowPass"), shadowMatrix=uniform("shadowMatrix"), shadowColour=uniform("shadowColour");
  const lightPosition=new Float32Array(3), projected=new Float32Array(16);
  const hasStencil=gl.getContextAttributes().stencil;
  const lightFighters = uniform("lightFighters"), lightCoefficients = uniform("irradianceCoefficients[0]");
  const focus = uniform("center"), ceiling = uniform("ceiling");
  const perspective = uniform("matchView"), viewProjection=uniform("viewProjection");
  const cutaway = document.querySelector("#cutaway");
  let yaw = 0.28, pitch = 0.32, zoom = 1;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let lineup;
  function updateLineup() {
    if (selected.length === count) lineup = createBattleLineup(venue.selectedOptions[0].dataset.handle,
      MODES[mode].formation,selected.map(s => s.handle));
  }
  let scheduled = 0, started = performance.now();
  function frame(now) {
    scheduled = 0;
    if (document.hidden) { previousFrame = undefined; return; }
    let advanced = false;
    if (fight && !paused && !controls.isGuest()) {
      const elapsed = previousFrame === undefined ? 0 : Math.min(100,now-previousFrame);
      carry += elapsed;
      try {
        while (carry >= stepMs) {
          fight.tick(controls.inputs());
          combatAudio?.tick(fight);
          if(environment) { environment.update(fight.memory,1,fight.states); const effects=environment.effects(); combatAudio?.environment?.(effects); trainAudio?.effects(effects); }
          camera.step();
          carry -= stepMs;
          advanced = true;
        }
      } catch (error) {
        paused = true;
        status.textContent = error.message + " Restart to return to the match.";
      }
    }
    previousFrame = now;
    if (controls?.isGuest()) return;
    // On a high-refresh display multiple callbacks can share a simulation tick.
    // Keep polling input, and submit the scene only when a new pose is available.
    if (fight && !advanced && !paused) scheduled = requestAnimationFrame(frame);
    else { draw(); renderedFrames++; }
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
    // Two times the retail framebuffer resolution keeps high-DPI screens within the same GPU budget.
    const ratio = battle ? Math.min(devicePixelRatio,2,1280/rect.width,960/rect.height) : Math.min(devicePixelRatio,2);
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
    // The NTSC output places its 640 × 448 picture inside a 640 × 480 frame.
    const viewHeight = camera ? Math.round(height * 448 / 480) : height;
    gl.viewport(0, Math.floor((height-viewHeight)/2), width, viewHeight);
    if (camera) gl.clearColor(0,0,0,1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
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
    gl.uniform1i(lightFighters, Boolean(lighting));
    scene.draw();
    const matchState = fight?.diagnostics();
    if(scenery && projection) {
      scenery.render({viewProjection:projection,tick:matchState?.ticks??0,...environment?.state()});
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
        const target = lineup.participants[(i+1)%lineup.participants.length].position;
        if (live) {
          if (lighting) gl.uniform3fv(lightCoefficients,sampleIrradiance(lighting,live.position,coefficients));
          gl.uniform3fv(origin,live.position);
          gl.uniform1f(heading,live.yaw*Math.PI/180);
        } else {
          gl.uniform3f(origin,x,0,z);
          gl.uniform1f(heading,Math.atan2(target[0]-x,target[1]-z));
        }
        if(live && hasStencil && lighting?.shadowLights.length) {
          gl.uniform1i(shadowPass,1);
          gl.uniformMatrix4fv(shadowMatrix,false,shadowProjection(lighting,live.position,projected,lightPosition));
          const [r,g,b,a]=lighting.shadow.colour;
          gl.uniform4f(shadowColour,r/128,g/128,b/128,a/128);
          // Each covered pixel receives the shadow blend once, regardless of how
          // many triangles flatten onto it. Scenery already occupies the depth buffer.
          gl.enable(gl.STENCIL_TEST);
          gl.stencilFunc(gl.NOTEQUAL,1,0xff);
          gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          body.drawSilhouette();
          gl.depthMask(true);
          gl.disable(gl.BLEND);
          gl.disable(gl.STENCIL_TEST);
          gl.uniform1i(shadowPass,0);
        }
        body.draw(live?.damage??0);
      });
      if (matchState) hud({...matchState,rematch});
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
  modeSelect?.addEventListener("change",()=>{
    const destination=new URL(location.href);
    destination.searchParams.set("mode",modeSelect.value);
    // Seats and the venue list differ by mode; the parser fills in what the new mode needs.
    location.assign(destination);
  });
  venue.addEventListener("change", () => {
    if (!battle) return select();
    const destination=new URL(location.href);
    destination.searchParams.set("venue",venue.value);
    location.assign(destination);
  });
  await Promise.all([select(), chooseFighters()]);
  if (battle && selected.length === count && scene) {
    const { loadFoundationFight } = await import("../battle/fight.mjs");
    const { battleControls } = await import("../battle/controls.mjs");
    const { battleCamera } = await import("../battle/camera.mjs");
    const { createHud } = await import("../hud/hud.mjs");
    const { venueAudio } = await import("../audio/venue.mjs");
    let music, voicePlayer;
    const audio = venueAudio(arena.file,{onStart: async () => {
      // First gesture: the retail battle music joins the same bus (and so the guests' stream) as the cues.
      import("../audio/voice.mjs").then(async ({loadVoicePlayer})=>{
        voicePlayer=await loadVoicePlayer(audio);
        fight?.setVoicePlayer(voicePlayer);
      })
        .catch(error=>console.error("Could not start fighter voices",error));
      import("../audio/music.mjs").then(async ({createMusic}) => { music = createMusic(audio); await music.start(); })
        .catch(error => console.error("Could not start battle music",error));
      try {
        const [{loadMatchAudio},{default:clips}] = await Promise.all([
          import("../audio/match.mjs"),import("../motion/library.json",{with:{type:"json"}})
        ]);
        combatAudio = await loadMatchAudio(audio,{file:arena.file,
          fighters:selected.map(f=>f.record.fighterXml),clips});
      } catch (error) { console.error("Could not load combat audio",error); }
    }});
    const {createSceneryRenderer,loadScenery} = await import("../scenery/scenery.mjs");
    const [stage, lights] = await Promise.all([loadScenery(arena.file),loadLighting(arena.file)]);
    lighting = lights.settings[0]?.sets[0];
    scenery = await createSceneryRenderer(gl,stage,{lighting});
    const [{createEnvironment},events] = await Promise.all([import("../scenery/environment.mjs"),
      fetch(new URL("../scenery/events.json",import.meta.url)).then(r=>r.json())]);
    environment = createEnvironment(stage.manifest,events.names,{weaponModels:events.weaponModels});
    if(stage.manifest.subway) { const {createTrainAudio}=await import("../scenery/train.mjs"); trainAudio=createTrainAudio(audio,{fighters:selected.map(f=>f.record.fighterXml)}); }
    hud=await createHud(gl);
    // Explicit CPU seats only (?cpu=N, the last N seats): the retail AI plays them and no controller or guest can.
    selected.forEach((f,i)=>{ f.cpu = i >= count - query.cpu; });
    controls = battleControls(() => { previousFrame=undefined; draw(); },audio,{seats:count,cpu:query.cpu});
    fight = await loadFoundationFight(selected,arena,MODES[mode].formation);
    if(voicePlayer)fight.setVoicePlayer(voicePlayer);
    camera = battleCamera(fight.kernel, arena.file);
    const cpuNote = query.cpu ? " · "+query.cpu+(query.cpu>1?" CPU opponents":" CPU opponent") : "";
    const hint = (count>2 ? MODES[mode].label+" · WASD, arrows, gamepads and guests · Controls below" : "WASD and arrows to move · Controls below")+cpuNote;
    status.textContent = hint;
    document.getElementById("restart").onclick = () => {
      rematch.reset(); controls.release(); fight.restart(); camera.reset(); combatAudio?.reset(); environment?.reset(); trainAudio?.reset(); audio?.restart(); paused=false; previousFrame=undefined; carry=stepMs/2; draw();
      status.textContent = hint;
    };
    // Once the result hold is over the retail REMATCH? card takes left/right (or A/D) and Enter: YES restarts the match.
    rematch = rematchChoice(() => { const result = fight.outcome(); return result.result && result.ticksSinceOver >= REMATCH_DELAY; },
      () => document.getElementById("restart").click());
    addEventListener("keydown",event => { if (rematch.key(event)) { event.preventDefault(); draw(); } });
    window.nativeBattle = Object.freeze({ setInput:controls.setInput, diagnostics:() => ({
      ...fight.diagnostics(), renderedFrames, paused, network:controls.connection(), environment:environment?.state(), music:music?.tune }) });
    draw();
  }
}
display().catch(error => { status.textContent = error.message; });
