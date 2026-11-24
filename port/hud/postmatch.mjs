// The retail versus score sheet shown after a Battle match, between the result word and the REMATCH? card.
//
// Retail (SLUS 0x178440, called from the match state function 0x1785f0 once the match is over) picks the screen by the
// number N of fighters in the match (session+0x3ac, CPU fighters included: the reference capture of a person against a CPU
// shows matchSm2 with a "CPU" panel): screens/battle/matchSm<N>.big. Only a lone fighter who did not win skips it (0x160390
// ranks them against N) and goes straight to the rematch card. Each panel has the colour label, "P<n>" / "CPU" sticker, the
// fighter's thumbnail and "NAME as ALIAS" logo, SCORE, the list of the match's point counters, TOTAL POINTS, $ FROM POINTS
// and TOTAL EARNINGS, over the dimmed match scene under a MATCH SUMMARY heading and a CONTINUE hint.
//
// postmatch_art.py exports the settled layouts (port/hud/postmatch/sheet-<N>.json) and the fighter art, postmatch_stats.py
// the counters' names. The counters are the retail per-player stats (session+0x3c8+0x10+0xa0*p, filled by the end-of-match
// finaliser 0x15fae8): until the kernel runs it the list, totals and cash stay blank and no value is invented. SCORE is the
// kernel's real per-actor score (actor+0x480). TOTAL POINTS = SCORE + the counters, $ FROM POINTS = TOTAL / 100.
import { LABELS } from "./screen.mjs";
import { REMATCH_DELAY } from "./result.mjs";

const BASE = new URL("./postmatch/", import.meta.url);
const SCALE = 2;                                   // drawn at twice the 640 x 480 frame, in the match canvas's 448-row band
const SHEET_LABELS = { ...LABELS, "~MTCH_TOTAL": "TOTAL POINTS", "~MTCH_CASH": "$ FROM POINTS", "~MTCH_PURSE": "PURSE" };
const ROWS = { left: 13, right: 18, top: 0, pitch: 20.5, size: 18, rule: "rgba(30,20,10,.55)" };
// Where the retail glyphs sit against their field's box (measured from the reference frame): a drop in rows, and the
// TOTAL EARNINGS amount's own size, shift and see-through cream.
const TEXT_DY = { sticker1: 8, sticker2: 8, sticker3: 8, label: 4, score: 5, "value-points": 6, "value-cash": 6, "value-earnings": 7 };
const EARNINGS = { scale: 0.9, dx: -11, alpha: 0.65 };
const DIM = 0.45;                                  // how far the match scene behind the sheet is darkened
const FACES = ["TradeCon", "Schwartz_Hand_Bold2"];

const load = url => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("could not load " + url));
  image.src = url;
});

const thousands = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Who is on the sheet, or null when retail skips it. `fighters` are in actor-slot order: {handle, name, cpu, seat}.
// `outcome` is the referee's read (port/battle/outcome.mjs); `scores` the actors' kernel scores; `stats` (optional) each
// slot's 37 retail counters and `names` their labels (stats.json).
export function planPostmatch(fighters, outcome, scores = [], stats = null, names = []) {
  if (!outcome?.result || !fighters.length || fighters.length > 4) return null;
  const winners = outcome.draw ? [] : outcome.winners ?? [];
  const panels = fighters.map((f, slot) => {
    const score = Math.max(0, Math.round(scores[slot] ?? 0));
    const counters = stats?.[slot];
    const rows = counters ? counters.map((value, index) => ({ label: names[index], value })).filter(row => row.label && row.value > 0) : null;
    const total = rows ? score + rows.reduce((sum, row) => sum + row.value, 0) : null;
    return { slot, seat: f.seat ?? slot, cpu: Boolean(f.cpu), handle: f.handle, name: String(f.name ?? "").toUpperCase(), score,
      winner: winners.includes(slot), rows, total, cash: total === null ? null : Math.floor(total / 100) };
  });
  // A lone fighter only sees the sheet after winning; a draw is no win.
  if (panels.length === 1 && !panels[0].winner) return null;
  return { sheet: panels.length, panels };
}

let artRequest;
export const loadPostmatchArt = (base = BASE) => artRequest ??= (async () => {
  const get = async name => { const r = await fetch(new URL(name, base)); if (!r.ok) throw new Error(name + " " + r.status); return r.json(); };
  const [sheets, fighters, stats] = await Promise.all([Promise.all([1, 2, 3, 4].map(n => get(`sheet-${n}.json`))), get("fighters.json"), get("stats.json")]);
  await Promise.all(FACES.map(async face => {
    const font = new FontFace(face, `url(${new URL(face + ".ttf", base)})`);
    document.fonts.add(await font.load());
  })).catch(error => console.warn("postmatch fonts:", error.message));
  return { sheets, fighters, stats, base, images: new Map() };
})().catch(error => { artRequest = undefined; throw error; });

const image = (art, name) => {
  if (!art.images.has(name)) art.images.set(name, load(new URL(name, art.base).href).catch(() => null));
  return art.images.get(name);
};

// What a plan needs from disk: the sheet's pictures, the winner stamp, each panel's thumbnail and name logo.
export async function fetchSheet(art, plan) {
  const sheet = art.sheets[plan.sheet - 1], count = art.fighters.art[plan.sheet];
  const pieces = new Map();
  const want = async name => pieces.set(name, await image(art, name));
  const jobs = new Set(sheet.elements.filter(e => e.kind === "image").map(e => e.file));
  plan.panels.forEach(panel => {
    const id = art.fighters.handles[panel.handle], have = art.fighters.fighters[id] ?? {};
    panel.id = id;
    if (have["thumb-" + count]) jobs.add(`thumb-${id}-${count}p.webp`);
    if (plan.sheet > 1 && have["name-" + count]) jobs.add(`name-${id}-${count}p.webp`);
  });
  jobs.add("heading.png").add("continue.png");
  await Promise.all([...jobs].map(want));
  return { sheet, count, pieces, names: art.stats.names };
}

const argb = value => `rgba(${(value >>> 16) & 255},${(value >>> 8) & 255},${value & 255},${((value >>> 24) & 255) / 255})`;
const sorted = (anchors, prefix) => Object.entries(anchors).filter(([key]) => key.startsWith(prefix)).sort((a, b) => a[1][0] - b[1][0]).map(([, at]) => at);

function wrap(context, text, width) {
  const lines = [""];
  for (const word of text.split(" ")) {
    const next = lines[lines.length - 1] ? lines[lines.length - 1] + " " + word : word;
    if (lines[lines.length - 1] && context.measureText(next).width > width) lines.push(word); else lines[lines.length - 1] = next;
  }
  return lines;
}

// The player's list window: the movie's clip mask over the paper between the SCORE and TOTAL POINTS bars.
const listArea = (sheet, number) => sheet.elements.find(e => e.kind === "list" && e.panel === number)?.rect;

// Draws the sheet into a 640 x 480 design space on `context` (already transformed).
export function drawSheet(context, { sheet, count, pieces }, plan) {
  const photos = sorted(sheet.anchors, "playerPhoto"), logos = sorted(sheet.anchors, "logoLoader");
  const panelOf = number => plan.panels[number - 1];
  context.save();
  const heading = pieces.get("heading.png"), hint = pieces.get("continue.png");
  if (heading) context.drawImage(heading, 1, -1);
  if (hint) context.drawImage(hint, 493, 19);
  for (const element of sheet.elements) {
    const panel = element.panel === null ? null : panelOf(element.panel);
    if (element.panel !== null && !panel) continue;
    const [l, t, r, b] = element.rect;
    if (element.kind === "list") continue;
    if (element.kind === "image") {
      const picture = pieces.get(element.file);
      if (picture) context.drawImage(picture, l, t, r - l, b - t);
      continue;
    }
    let text, lines;
    const known = panel.rows !== null;
    switch (element.role) {
      case "name": {
        if (logos[element.panel - 1] && pieces.get(`name-${panel.id}-${count}p.webp`)) continue;   // the logo carries the name
        text = panel.name; break;
      }
      case "score": text = thousands(panel.score); break;
      case "sticker1": text = panel.cpu ? "C" : "P"; break;
      case "sticker2": text = panel.cpu ? "P" : String(panel.seat + 1); break;
      case "sticker3": text = panel.cpu ? "U" : ""; break;
      case "label": text = SHEET_LABELS[element.text] ?? ""; break;
      case "value-points": text = known ? thousands(panel.total) : ""; break;
      case "value-cash": text = known ? "$" + thousands(panel.cash) : ""; break;
      case "value-earnings": text = known ? "$" + thousands(panel.cash) : ""; break;
      default: continue;                          // the purse stays empty: it is a story-mode amount
    }
    if (!text) continue;
    context.font = `${element.size}px ${element.face ?? "TradeCon"}, sans-serif`;
    context.fillStyle = argb(element.color);
    context.textBaseline = "top";
    context.textAlign = ["left", "right", "center"][element.align] ?? "left";
    let x = element.align === 2 ? (l + r) / 2 : element.align === 1 ? r - 2 : l;
    const earnings = element.role === "value-earnings";
    if (earnings) { context.font = `${element.size * EARNINGS.scale}px ${element.face ?? "TradeCon"}, sans-serif`; context.globalAlpha = EARNINGS.alpha; x += EARNINGS.dx; }
    if (element.role === "label") lines = wrap(context, text, Math.min(r - l, 112)); else lines = [text];
    context.save(); context.translate(0, TEXT_DY[element.role] ?? 0);
    lines.forEach((line, i) => {
      const wide = context.measureText(line).width;
      if (element.role === "name" && wide > r - l) { context.save(); context.translate(x, t); context.scale((r - l) / wide, 1); context.fillText(line, 0, 0); context.restore(); }
      else context.fillText(line, x, t + i * element.size * 1.04);
    });
    context.restore(); context.globalAlpha = 1;
  }
  plan.panels.forEach((panel, index) => {
    const thumb = pieces.get(`thumb-${panel.id}-${count}p.webp`), photo = photos[index];
    if (thumb && photo) context.drawImage(thumb, photo[0], photo[1]);
    const logo = pieces.get(`name-${panel.id}-${count}p.webp`);
    if (logo && logos[index]) context.drawImage(logo, logos[index][0], logos[index][1]);
    const area = panel.rows && listArea(sheet, index + 1);
    if (area) {
      context.font = `${ROWS.size}px TradeCon, sans-serif`;
      context.textBaseline = "middle"; context.fillStyle = "#000"; context.strokeStyle = ROWS.rule; context.lineWidth = 1;
      panel.rows.slice(0, Math.floor((area[3] - area[1] - ROWS.top) / ROWS.pitch)).forEach((row, i) => {
        const y = area[1] + ROWS.top + ROWS.pitch * (i + 0.5);
        context.textAlign = "left"; context.fillText(row.label, area[0] + ROWS.left, y);
        context.textAlign = "right"; context.fillText(thousands(row.value), area[2] - ROWS.right, y);
        context.beginPath(); context.moveTo(area[0] + ROWS.left - 2, y + ROWS.pitch / 2 - 1.5); context.lineTo(area[2] - ROWS.right + 2, y + ROWS.pitch / 2 - 1.5); context.stroke();
      });
    }
  });
  context.restore();
}

// The page is 640 x 448 in a 640 x 480 frame: the sheet, laid out for 480 rows, is squeezed into the band like the match picture.
export function renderSheet(canvas, loaded, plan, scene = null) {
  const context = canvas.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.imageSmoothingQuality = "high";
  context.translate(0, 16 * SCALE); context.scale(SCALE, SCALE * 448 / 480);
  if (scene) { context.drawImage(scene, 0, 0, 640, 480); context.fillStyle = `rgba(0,0,0,${DIM})`; context.fillRect(0, 0, 640, 480); }
  drawSheet(context, loaded, plan);
  context.restore();
}

// The sheet's lifecycle in a running match. `holding(outcome)` is true from the end of the result hold until a player
// dismisses it (Enter or the pad's confirm) or retail would have skipped it; the REMATCH? card waits for that. A hosted room
// sends the sheet to its guests through session.cover, like the loading poster. `snapshot(canvas)` keeps the last match picture
// for the sheet's backdrop.
export function createPostmatch({ fighters, scores, stats = () => null, session, mount = document.querySelector("main"), art = loadPostmatchArt }) {
  let state = "idle", canvas, plan, loaded, keepalive, scene;      // idle -> loading -> shown -> done (or skipped)
  const diagnostics = () => ({ state, sheet: plan?.sheet ?? null, panels: plan?.panels.map(({ slot, seat, cpu, name, score, winner, rows, total, cash }) => ({ slot, seat, cpu, name, score, winner, rows, total, cash })) ?? [] });
  window.nativePostmatch = diagnostics;

  function close() {
    clearInterval(keepalive); keepalive = undefined;
    canvas?.remove(); canvas = undefined;
    session?.cover(null);
  }
  function start(outcome) {
    state = "loading";
    art().then(async a => {
      plan = planPostmatch(fighters(), outcome, scores(), stats(), a.stats.names);
      if (!plan) { state = "skipped"; return; }
      loaded = await fetchSheet(a, plan);
      if (state !== "loading") return;
      canvas = document.createElement("canvas");
      canvas.width = 640 * SCALE; canvas.height = 480 * SCALE;
      canvas.setAttribute("aria-label", "Match score sheet");
      canvas.style.gridArea = "1 / 1";
      canvas.dataset.state = "shown";
      mount.append(canvas);
      renderSheet(canvas, loaded, plan, scene);
      session?.cover(canvas);
      keepalive = setInterval(() => { try { canvas.getContext("2d").drawImage(canvas, 0, 0, 1, 1, 0, 0, 1, 1); } catch {} }, 500);
      state = "shown";
    }).catch(error => { console.warn("Match score sheet:", error.message); state = "skipped"; });
  }
  return {
    get state() { return state; },
    diagnostics,
    // True while the sheet stands between the result word and the rematch card.
    holding(outcome) {
      if (state === "idle" && outcome?.result && outcome.ticksSinceOver >= REMATCH_DELAY) start(outcome);
      return state === "loading" || state === "shown";
    },
    // Called after each frame is drawn: keeps the match picture (the retail sheet is laid over the dimmed scene).
    snapshot(source, outcome) {
      if (!outcome?.result || (state !== "idle" && state !== "loading")) return;
      scene ??= document.createElement("canvas");
      scene.width = 640; scene.height = 480;
      const context = scene.getContext("2d");
      context.drawImage(source, 0, 0, 640, 480);
    },
    key(event) {
      if (state !== "shown" || event.key !== "Enter") return false;
      close(); state = "done";
      return true;
    },
    reset() { close(); state = "idle"; plan = loaded = scene = undefined; },
    dispose() { close(); if (window.nativePostmatch === diagnostics) delete window.nativePostmatch; },
  };
}
