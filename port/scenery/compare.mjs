// Headless render of retail Foundation scenery with the retail Battle camera, written next to
// the saved original frame for comparison. Uses existing captures only; no emulator is run.
//
//   node port/scenery/compare.mjs [--run private/verification/ps2-match/run-BjNMn0]
//        [--blank 4863] [--out private/verification/scenery]
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../netplay/node_modules/playwright/index.mjs";
import { foundationCamera } from "../battle/camera.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf("--" + name); return i < 0 ? fallback : process.argv[i + 1]; };
const run = path.resolve(root, arg("run", "private/verification/ps2-match/run-BjNMn0"));
const blank = Number(arg("blank", 4863));
const out = path.resolve(root, arg("out", "private/verification/scenery"));
const types = { ".html": "text/html", ".mjs": "text/javascript", ".json": "application/json", ".gz": "application/octet-stream" };

// Replay the retail camera over the traced fighter positions up to the capture's VBlank.
const trace = JSON.parse(await readFile(path.join(run, "combat-trace.json"), "utf8"));
const camera = foundationCamera();
for (const sample of trace.samples) {
  if (sample.blank > blank) break;
  camera.step(sample.actors.map(a => ({ position: a.renderedPosition })));
}
const matrix = [...camera.matrix()];
// The retail frame is 848x636 with letterbox bars; --viewport x,y,w,h (GL origin bottom-left) maps the 4:3 camera into it.
const viewport = arg("viewport", "2,16,840,588").split(",").map(Number);
const fighters = trace.samples.findLast(s => s.blank <= blank).actors.map(a => a.renderedPosition);

const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (name === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end(page);
  if (name === "/favicon.ico") return res.writeHead(204).end();
  if (name.startsWith("/retail/") && /^\/retail\/[\w.-]+\.png$/.test(name)) {
    return res.writeHead(200, { "Content-Type": "image/png" }).end(await readFile(path.join(run, name.slice(8))));
  }
  if (!/^\/(port|ps2)\//.test(name) || name.includes("..")) return res.writeHead(404).end();
  try {
    res.writeHead(200, { "Content-Type": types[path.extname(name)] ?? "application/octet-stream" });
    res.end(await readFile(path.join(root, name)));
  } catch { res.writeHead(404).end(); }
});
const page = `<!doctype html><body style="margin:0"><canvas id=c width=848 height=636></canvas><script type=module>
import { loadScene, uploadScene } from "/port/viewer/scene.mjs";
import { loadScenery, createSceneryRenderer } from "/port/scenery/scenery.mjs";
const gl = c.getContext("webgl2", { alpha: false, preserveDrawingBuffer: true });
const vs = \`#version 300 es
in vec3 position; in vec2 uv; in vec4 rgba; uniform mat4 viewProjection; out vec2 t; out vec3 tint;
void main(){ t=uv; tint=rgba.rgb*(255.0/128.0); gl_Position=viewProjection*vec4(position,1.0);} \`;
const fs = \`#version 300 es
precision highp float; in vec2 t; in vec3 tint; uniform sampler2D diffuse; out vec4 o;
void main(){ vec4 x=texture(diffuse,t); if(x.a<0.01) discard; o=vec4(x.rgb*tint,1.0);} \`;
const p = gl.createProgram();
for (const [k, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const h = gl.createShader(k); gl.shaderSource(h, s); gl.compileShader(h); if(!gl.getShaderParameter(h, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(h)); gl.attachShader(p, h); }
gl.linkProgram(p);
window.draw = async (matrix, options) => {
  const base = uploadScene(gl, p, await loadScene("V2BG_02A", new AbortController().signal));
  const scenery = await createSceneryRenderer(gl, await loadScenery("V2BG_02A"));
  gl.viewport(...(options.viewport ?? [0, 0, c.width, c.height]));
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.10, 0.115, 0.12, 1);
  gl.disable(gl.SCISSOR_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(p);
  gl.uniformMatrix4fv(gl.getUniformLocation(p, "viewProjection"), false, new Float32Array(matrix));
  if (options.base) base.draw();
  scenery.render({ viewProjection: new Float32Array(matrix), ...options.scenery });
  if (gl.getError()) throw Error("GL error");
  return c.toDataURL("image/png");
};
// Normalised cross-correlation of grayscale pixels inside a box, with the render shifted by (dx, dy).
window.compare = async (renderUrl, retailUrl, box, search = 0) => {
  const load = url => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
  const grab = async url => { const i = await load(url); const k = document.createElement("canvas"); k.width = i.width; k.height = i.height;
    const x = k.getContext("2d", { willReadFrequently: true }); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height); };
  const [a, b] = [await grab(renderUrl), await grab(retailUrl)];
  const luma = (d, x, y) => { const k = (y * d.width + x) * 4; return 0.299 * d.data[k] + 0.587 * d.data[k + 1] + 0.114 * d.data[k + 2]; };
  const gray = (d, x, y) => { let t = 0; for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) t += luma(d, x + i, y + j); return t / 25; };
  const ncc = (dx, dy) => {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
      const u = gray(a, x + dx, y + dy), v = gray(b, x, y);
      n++; sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v;
    }
    return (sab - sa * sb / n) / Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n) || 1);
  };
  let best = { dx: 0, dy: 0, ncc: -2 };
  for (let dy = -search; dy <= search; dy++) for (let dx = -search; dx <= search; dx++) {
    const v = ncc(dx, dy); if (v > best.ncc) best = { dx, dy, ncc: v };
  }
  return { zero: ncc(0, 0), best };
};
window.sideBySide = async (retailUrl, ourUrl) => {
  const load = url => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
  const k = document.createElement("canvas"); k.width = 1696; k.height = 636;
  const x = k.getContext("2d");
  x.drawImage(await load(retailUrl), 0, 0);
  x.drawImage(await load(ourUrl), 848, 0);
  return k.toDataURL("image/png");
};
window.ready = true;
</script>`;
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({ ...(process.platform === "darwin" && { channel: "chrome" }), headless: true });
try {
  const tab = await browser.newPage({ viewport: { width: 848, height: 636 } });
  const errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  tab.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  await tab.waitForFunction(() => window.ready || false, null, { timeout: 15000 }).catch(() => { throw new Error(errors.join("\n") || "page did not load"); });
  await mkdir(out, { recursive: true });
  const variants = {
    "base-only": { base: true, scenery: { props: Object.fromEntries(["A","B","C","D","E","F","H","I"].map(k => ["V2BG_02A_" + k, false])), crowd: false } },
    "props": { base: true, scenery: { crowd: false } },
    "props-crowd": { base: true, scenery: { tick: 0 } },
    "props-crowd-excited": { base: true, scenery: { tick: 30, excited: true } },
  };
  for (const [name, options] of Object.entries(variants)) {
    const url = await tab.evaluate(([m, o]) => draw(m, o), [matrix, { ...options, viewport }]);
    await writeFile(path.join(out, `foundation-${name}.png`), Buffer.from(url.split(",")[1], "base64"));
  }
  const frame = arg("frame", "21-fight-ready-host.png");
  // Static, unoccluded landmarks in the retail frame: both speaker stacks and the work light.
  const regions = JSON.parse(arg("regions", JSON.stringify({ speakerLeft: [240, 225, 302, 345],
    speakerRight: [546, 225, 606, 345], light: [462, 300, 506, 345] })));
  const scores = {};
  for (const [name, box] of Object.entries(regions)) {
    const url = await tab.evaluate(([m, o]) => draw(m, o), [matrix, { base: true, viewport, scenery: { crowd: false } }]);
    scores[name] = await tab.evaluate(([u, f, b]) => compare(u, f, b, 20), [url, `/retail/${frame}`, box]);
  }
  await writeFile(path.join(out, "foundation-score.json"), JSON.stringify({ frame, blank, regions, scores }, null, 1));
  console.log(JSON.stringify(scores));
  const shot = await tab.evaluate(([m, o]) => draw(m, o), [matrix, { base: true, viewport, scenery: { tick: 30, excited: true } }]);
  const both = await tab.evaluate(([a, b]) => sideBySide(a, b), [`/retail/${frame}`, shot]);
  await writeFile(path.join(out, "foundation-retail-vs-native.png"), Buffer.from(both.split(",")[1], "base64"));
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(path.join(out, "foundation-camera.json"), JSON.stringify({ blank, matrix, fighters }, null, 1));
  console.log(JSON.stringify({ out, blank, fighters }));
} finally {
  await browser.close();
  server.close();
}
