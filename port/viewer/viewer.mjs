import {pauseMenu} from "../hud/pause.mjs";
import { shadowProjection } from "../render/shadow.mjs";
import { irradianceGLSL, loadLighting, sampleIrradiance } from "../scenery/irradiance.mjs";
import { loadPoseBank, capturedIdles, poseIndex } from "../motion/pose-bank.mjs";
import { createBattleLineup } from "../battle/setup.mjs";
import { MODES, freeForAllAvailable, parseBattleQuery, venueSupports } from "../battle/modes.mjs";
import { closeMatchLoading, showMatchLoading } from "../menu/loading.mjs";
import { rematchChoice } from "../hud/rematch.mjs";
import { REMATCH_DELAY } from "../hud/result.mjs";
import { createPostmatch } from "../hud/postmatch.mjs";
import { roomSession } from "../battle/controls.mjs";
import { loadFighter, loadScene, uploadScene } from "./scene.mjs";
import inventory from "../../ps2/content/inventory.json" with { type: "json" };

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

// One match (or the inspection view) from setup to dispose(). `leave` is where a finished or quit match goes next.
async function display(leave) {
  const canvas = document.querySelector("canvas");
  // Everything this run adds to the page or the window goes through `lifetime`, so a hosted room can play another match
  // in the same page without listeners, render loops or media tracks piling up.
  const lifetime = new AbortController(), {signal} = lifetime, cleanups = [];
  let disposed = false;
  const gl = canvas.getContext("webgl2", {alpha:false,stencil:document.body.hasAttribute("data-battle")});
  if (!gl) throw new Error("WebGL 2 is required to inspect this mesh");
  const program = createProgram(gl);
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.10, 0.115, 0.12, 1);

  const battle = document.body.hasAttribute("data-battle");
  const stepMs = 1000/60;
  let fight, controls, camera, hud, rematch, postmatch, paused = false, previousFrame, carry = stepMs/2, renderedFrames = 0;
  let scenery, lighting, combatAudio, environment, trainAudio, vibration;
  const coefficients = new Float32Array(30);
  let scene, request, skinRequest, selected = [];
  const params=new URLSearchParams(location.search);
  const ffaAllowed = battle && freeForAllAvailable();
  const query = battle ? parseBattleQuery(params,{fighters:inventory.fighters,venues:inventory.venues,ffa:ffaAllowed}) : null;
  const mode = query?.mode ?? "1v1", count = MODES[mode].fighters;
  // The loading poster follows the parsed selection (the viewer repairs a query's missing or repeated fighters).
  if (battle) showMatchLoading(new URLSearchParams([["mode",mode],...query.handles.map((h,i)=>["p"+(i+1),h]),["venue",query.venue]]));
  const selectors = [1,2,3,4].slice(0,count).map(n=>document.querySelector("#player"+n));
  const modeSelect = document.querySelector("#mode");
  if(modeSelect) {
    modeSelect.replaceChildren(...Object.entries(MODES).map(([key,value])=>new Option(value.label,key)));
    modeSelect.hidden = !ffaAllowed;
    modeSelect.value = mode;
  }
  document.querySelectorAll("#player3,#player4").forEach((select,i)=>select.hidden = i+2 >= count);
  document.body.dataset.mode = mode;
  for (const select of [...selectors, document.querySelector("#venue")]) select.replaceChildren();
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
  let lineup, pause, pauseOwner = 0, lastPauseBroadcast = -Infinity;
  const menuHeld = [];
  function handlePadMenus(inputs) {
    let changed = false;
    inputs.forEach(({buttons, x, z}, seat) => {
      const bits = buttons | (x < -.5 ? 0x80 : x > .5 ? 0x20 : 0) | (z > .5 ? 0x10 : z < -.5 ? 0x40 : 0);
      const pressed = bits & ~menuHeld[seat];
      menuHeld[seat] = bits;
      if (!pause || !pressed) return;
      if (!pause.open && (postmatch?.holding(fight?.outcome()) || rematch?.shown)) {
        const key = pressed & 0x4000 ? "Enter" : pressed & 0x80 ? "ArrowLeft" : pressed & 0x20 ? "ArrowRight" : null;
        if (key) changed = (postmatch.key({key}) || rematch.key({key})) || changed;
        return;
      }
      if (!pause.open && (pressed & 8) && !fight.outcome().over) {
        pauseOwner = seat; pause.show(); pause.syncAudio(); changed = true;
      } else if (pause.open && seat === pauseOwner) {
        const action = pressed & 8 ? "start" : pressed & 0x4000 ? "confirm" : pressed & 0xa000 ? "back"
          : pressed & 0x10 ? "up" : pressed & 0x40 ? "down" : pressed & 0x80 ? "left" : pressed & 0x20 ? "right" : null;
        if (action) { pause.press(action); changed = true; }
      }
    });
    return changed;
  }
  function updateLineup() {
    if (selected.length === count) lineup = createBattleLineup(venue.selectedOptions[0].dataset.handle,
      MODES[mode].formation,selected.map(s => s.handle));
  }
  let scheduled = 0, started = performance.now();
  function frame(now) {
    scheduled = 0;
    if (disposed) return;
    if (document.hidden) { previousFrame = undefined; return; }
    let advanced = false;
    if (fight && !paused && !controls.isGuest()) {
      const elapsed = previousFrame === undefined ? 0 : Math.min(100,now-previousFrame);
      const inputs = controls.inputs();
      const changed = handlePadMenus(inputs);
      if (pause?.open || changed) {
        previousFrame = undefined;
        // Canvas capture may drop a single submitted frame as its encoder adapts.
        // A connected or newly joining guest also needs the current panel while play is frozen.
        if (changed || (controls.connection() !== "local" && now - lastPauseBroadcast >= 500)) {
          draw();
          lastPauseBroadcast = now;
        }
        if (!scheduled) scheduled = requestAnimationFrame(frame);
        return;
      }
      carry += elapsed;
      try {
        while (carry >= stepMs) {
          fight.tick(query.teamOrder ? query.teamOrder.map(seat => inputs[seat]) : inputs);
          if (pause?.vibration) vibration.tick(fight.memory);
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
  }, {signal});
  function draw() {
    if (!scene || disposed) return;
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
      if (matchState) {
        hud({...matchState,rematch,pause});
        postmatch?.snapshot(gl.canvas,matchState.outcome);
      }
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
  cutaway.addEventListener("change", draw, {signal});
  const resize = new ResizeObserver(draw);
  resize.observe(canvas);
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
      const actorSelectors = query?.teamOrder ? query.teamOrder.map(seat => selectors[seat]) : selectors;
      for (const [i,select] of actorSelectors.entries()) {
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
  },{signal}));
  modeSelect?.addEventListener("change",()=>{
    const destination=new URL(location.href);
    destination.searchParams.set("mode",modeSelect.value);
    // Seats and the venue list differ by mode; the parser fills in what the new mode needs.
    location.assign(destination);
  },{signal});
  venue.addEventListener("change", () => {
    if (!battle) return select();
    const destination=new URL(location.href);
    destination.searchParams.set("venue",venue.value);
    location.assign(destination);
  }, {signal});
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
      import("../audio/music.mjs").then(async ({createMusic}) => { if (disposed) return; music = createMusic(audio); await music.start(); })
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
    selected.forEach((f,i)=>{ f.cpu = (query.teamOrder?.[i] ?? i) >= count - query.cpu; });
    controls = battleControls(() => { previousFrame=undefined; draw(); },audio,{seats:count,cpu:query.cpu});
    const {matchVibration} = await import("../battle/vibration.mjs");
    fight = await loadFoundationFight(selected,arena,mode,query.rule);
    vibration = matchVibration(fight.actors, (slot, level) => controls.vibration(query.teamOrder?.[slot] ?? slot, level));
    if(voicePlayer)fight.setVoicePlayer(voicePlayer);
    camera = battleCamera(fight.kernel, arena.file);
    const cpuNote = query.cpu ? " · "+query.cpu+(query.cpu>1?" CPU opponents":" CPU opponent") : "";
    const pauseButton = document.querySelector("#pause");
    pauseButton.hidden = false;
    const returnToMatchSelection = () => leave ? leave() : location.assign(location.pathname);
    cleanups.push(() => { music?.stop(); audio.dispose(); pauseButton.hidden = true; pauseButton.onclick = null; document.getElementById("restart").onclick = null; });
    pause = pauseMenu({
      onChange:(kind,percent)=>audio.setVolume(kind,percent),
      onClose:()=>{ audio.setActive(true); pauseButton.textContent="Pause"; previousFrame=undefined; carry=0; },
      onQuit:returnToMatchSelection,
    });
    pause.redraw = draw;
    pause.syncAudio = () => { if (pause.open) vibration.stop(); audio.setActive(!pause.open); pauseButton.textContent = pause.open ? "Resume" : "Pause"; };
    pauseButton.onclick = () => {
      if (paused || controls.isGuest() || fight.outcome().over) return;
      if (pause.open) pause.close(); else { pauseOwner=0; pause.show(); pause.syncAudio(); }
      draw();
    };
    canvas.addEventListener("pointerdown", event => {
      if (!pause.open) return;
      const bounds = canvas.getBoundingClientRect();
      const viewHeight = bounds.height * 448/480;
      const x = (event.clientX-bounds.left)*640/bounds.width;
      const y = (event.clientY-bounds.top-(bounds.height-viewHeight)/2)*448/viewHeight;
      if (pause.confirming) {
        if (y<245 || y>293 || x<180 || x>462) return;
        pause.yes = x<320;
        pause.press("confirm");
      } else {
        const row = pause.hitRow(x,y);
        if (row<0) return;
        pause.row=row;
        if (row<3) {
          if (x>235 && x<475) pause.press(x<355?"left":"right");
        } else pause.press("confirm");
      }
      draw();
    });
    const pauseKeys = {Escape:"back", Enter:"confirm", ArrowUp:"up", ArrowDown:"down", ArrowLeft:"left", ArrowRight:"right",
      w:"up", s:"down", a:"left", d:"right", i:"confirm", j:"back"};
    addEventListener("keydown", event => {
      if (controls.isGuest() || paused || fight.outcome().over || event.target.closest?.("input,select,textarea")) return;
      if (!pause.open && event.key !== "Escape") return;
      const action = pauseKeys[event.key];
      if (!action) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat && (action === "back" || action === "confirm")) return;
      if (pause.open) pause.press(action);
      else { pauseOwner=0; pause.show(); pause.syncAudio(); }
      draw();
    }, {capture:true, signal});
    const hint = (count>2 ? MODES[mode].label+" · WASD, arrows, gamepads and guests · Controls below" : "WASD and arrows to move · Controls below")+cpuNote;
    status.textContent = hint;
    document.getElementById("restart").onclick = () => {
      if (pause.open) pause.close();
      vibration.stop(); postmatch.reset(); rematch.reset(); controls.release(); fight.restart(); camera.reset(); combatAudio?.reset(); environment?.reset(); trainAudio?.reset(); audio?.restart(); paused=false; previousFrame=undefined; carry=stepMs/2; draw();
      status.textContent = hint;
    };
    // Once the result hold is over the retail REMATCH? card takes left/right (or A/D) and Enter: YES restarts the match.
    // The retail score sheet (port/hud/postmatch.mjs) stands between the result hold and that card.
    postmatch = createPostmatch({ session: roomSession(), scores: () => fight.diagnostics().actors.map(a => a.score),
      fighters: () => selected.map((f, slot) => ({ handle: f.handle, name: f.record?.name, cpu: Boolean(f.cpu), seat: query.teamOrder?.[slot] ?? slot })) });
    cleanups.push(() => postmatch.dispose());
    rematch = rematchChoice(() => { const result = fight.outcome(); return result.result && result.ticksSinceOver >= REMATCH_DELAY && !postmatch.holding(result); },
      () => document.getElementById("restart").click(), returnToMatchSelection);
    addEventListener("keydown", event => {
      if (!event.repeat && !controls.isGuest() && (postmatch.key(event) || rematch.key(event))) {
        event.preventDefault(); event.stopImmediatePropagation(); draw();
      }
    }, {capture:true, signal});
    window.nativeBattle = Object.freeze({ setInput:controls.setInput, diagnostics:() => ({
      ...fight.diagnostics(), renderedFrames, paused:paused || pause.open, pause:pause.open ? {row:pause.row,levels:[...pause.levels],vibration:pause.vibration,confirming:pause.confirming} : null, network:controls.connection(), environment:environment?.state(), music:music?.tune }) });
    closeMatchLoading();
    draw();
  }
  return {
    // Ends this run: no frame, listener, audio context, GPU context or media capture of it outlives the call. The page's
    // canvas is replaced by a fresh one (a lost WebGL context cannot be reused), and a hosted room moves to silence.
    dispose() {
      if (disposed) return;
      disposed = true;
      closeMatchLoading();
      lifetime.abort();
      cancelAnimationFrame(scheduled);
      scheduled = 0;
      resize.disconnect();
      request?.abort(); skinRequest?.abort();
      vibration?.stop();
      controls?.use({audio:null});
      cleanups.forEach(cleanup => cleanup());
      scene?.dispose();
      selected.forEach(s => s.body.dispose());
      delete window.nativeBattle;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      const fresh = canvas.cloneNode(false);
      for (const name of fresh.getAttributeNames()) if (name.startsWith("data-")) fresh.removeAttribute(name);
      fresh.removeAttribute("width"); fresh.removeAttribute("height");
      canvas.replaceWith(fresh);
    },
  };
}
// A match that ends (Rematch: NO, or Quit in the pause menu) returns to the match selector. A hosted room keeps its
// invite, seats and connections: this page disposes the match and shows the selector again, then starts the next match;
// otherwise the page reloads to the selector as before.
let running, leaving = false;
async function start() {
  leaving = false;
  running = await display(async () => {
    if (leaving) return;
    leaving = true;
    const { roomSession } = await import("../battle/controls.mjs");
    if (!roomSession().hosted()) return location.assign(location.pathname);
    running.dispose();
    const { chooseMatch } = await import("../menu/launch.mjs");
    // The selector starts from the finished match's picks, on the bare page like a fresh load.
    const previous = new URLSearchParams(location.search);
    history.replaceState(null, "", location.pathname);
    await chooseMatch(previous);
    await start();
  });
}
start().catch(error => { closeMatchLoading(); status.textContent = error.message; });
