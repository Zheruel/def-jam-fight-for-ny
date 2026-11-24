// The retail match-loading poster: the match type's title, the venue's name and every selected fighter's portrait and
// "NAME as ALIAS" logo, drawn over the page while the match loads (loading_art.py exports the art and layout.json).
//
// It fetches only what the selection needs (one paper, the front chevron and the vignette, the title, the venue banner and
// each fighter's portrait and logo), shows as soon as the selection is known (from the selector or a direct link) and goes
// when the match is ready: no minimum time. A hosted room's guests see the poster too: the session sends this canvas
// instead of the (hidden) match canvas until closeMatchLoading() hands the picture back.
import { parseBattleQuery, freeForAllAvailable } from "../battle/modes.mjs";
import inventory from "../../ps2/content/inventory.json" with {type:"json"};
import { roomSession } from "../battle/controls.mjs";

const ART = new URL("./art/loading/", import.meta.url);
const SCALE = 2;                          // the poster is drawn at twice the 640 x 480 frame
const formationOf = mode => mode === "ffa3" ? "ffa3" : mode === "ffa" ? "ffa4" : mode === "team" ? "team" : "1v1";
const titleOf = mode => mode === "ffa3" ? "ffa" : mode;

let layoutRequest;
const layout = () => layoutRequest ??= fetch(new URL("layout.json", ART)).then(r => { if (!r.ok) throw new Error("loading layout " + r.status); return r.json(); });

// What the poster shows for a query: the match type, its fighters in poster order (the query's order) and the venue.
// Fighters the query leaves out, repeats or does not know are replaced like the viewer's parser does (defaults first).
export function loadingSelection(params, art) {
  const {mode, handles, venue} = parseBattleQuery(params, {...inventory, ffa:freeForAllAvailable()});
  return { mode, formation: formationOf(mode), title: titleOf(mode),
    ids: handles.map(handle=>art.fighters[handle]), venue: art.venueFiles[venue] };
}
const signature = s => [s.mode, s.venue, ...s.ids].join(".");

const load = url => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("could not load " + url));
  image.src = url;
});
const fetchImage = name => load(new URL(name, ART).href);
// The badge's word is set in the battle HUD's font; a failed load only changes the face.
let fontRequest;
const badgeFont = () => fontRequest ??= (async () => {
  const face = new FontFace("LoadingNames", `url(${new URL("../hud/names.ttf", import.meta.url)})`);
  document.fonts.add(await face.load());
})().catch(error => console.warn("loading font:", error.message));

// Places one piece: `rect` is the art's [left, top, right] around its anchor; a mirrored slot flips it about the anchor.
function place(context, image, [x, y], rect, flip = false) {
  const left = Math.round(flip ? x - rect[2] : x + rect[0]), top = Math.round(y + (rect[1] ?? 0));
  if (!flip) return context.drawImage(image, left, top);
  context.save(); context.translate(left + image.naturalWidth, 0); context.scale(-1, 1);
  context.drawImage(image, 0, top); context.restore();
}

async function fetchPieces(selection, art) {
  const { formation, title, ids, venue } = selection;
  const slots = art.formations[formation], count = slots.count;
  const wanted = { paper: `paper-${slots.paper}.webp`, front: "front.webp", vignette: "vignette.webp", crest: "crest.webp", title: `title-${title}.webp`, venue: `venue-${venue}.webp` };
  ids.forEach((id, i) => {
    if (art.portraits[id]?.[count]) wanted["portrait" + i] = `portrait-${id}-${count}p.webp`;
    if (art.logos[id]?.[count]) wanted["logo" + i] = `logo-${id}-${count}p.webp`;
  });
  await badgeFont();
  const entries = await Promise.all(Object.entries(wanted).map(async ([key, name]) => [key, await fetchImage(name).catch(error => { console.warn(error.message); return null; })]));
  return Object.fromEntries(entries);
}

// The retail frame is 640 x 480 with the 640 x 448 picture in its middle: the poster art, laid out for 480 rows, is
// squeezed into that band exactly as the match canvas shows its picture.
function draw(canvas, selection, art, pieces) {
  const context = canvas.getContext("2d"), { formation, ids, venue, title } = selection;
  const slots = art.formations[formation], count = slots.count;
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.imageSmoothingQuality = "high";
  context.translate(0, 16 * SCALE); context.scale(SCALE, SCALE * 448 / 480);
  if (pieces.paper) context.drawImage(pieces.paper, 0, 0);
  ids.forEach((id, i) => {
    const image = pieces["portrait" + i], [x, y, flip] = slots.portraits[i];
    if (!image) return;
    const [from, to] = slots.panels[slots.panelOf[i]];
    context.save();
    context.beginPath(); context.rect(from, 0, to - from, 480); context.clip();
    place(context, image, [x, y], art.portraits[id][count], Boolean(flip));
    context.restore();
  });
  if (pieces.front) context.drawImage(pieces.front, art.front[0], art.front[1]);
  if (pieces.title) context.drawImage(pieces.title, ...(art.title[title] ?? art.title.default));
  if (pieces.venue) place(context, pieces.venue, slots.venue, art.venues[venue]);
  ids.forEach((id, i) => { if (pieces["logo" + i]) place(context, pieces["logo" + i], slots.logos[i], art.logos[id][count]); });
  if (pieces.vignette) { context.globalAlpha = art.vignette; context.drawImage(pieces.vignette, 0, 0, 640, 480); context.globalAlpha = 1; }
  // The retail "LOADING" badge: the crest's opaque black square with the crest faint on it and the word across its middle.
  if (pieces.crest) {
    const { at, crest, alpha, label } = art.crest;
    context.fillStyle = "#000"; context.fillRect(at[0], at[1], 128, 128);
    context.globalAlpha = alpha; context.drawImage(pieces.crest, at[0] + crest[0], at[1] + crest[1], crest[2], crest[2]); context.globalAlpha = 1;
    context.font = `${label.size}px LoadingNames`; context.textAlign = "center"; context.textBaseline = "middle";
    context.lineJoin = "round"; context.lineWidth = 2; context.strokeStyle = "#2a1c0e"; context.strokeText("LOADING", label.x, label.y);
    context.fillStyle = "#f0dcb8"; context.fillText("LOADING", label.x, label.y);
  }
  context.restore();
}

let current;

// Shows the poster for the page's query (or `params`); while one is showing it only follows a changed selection.
export function showMatchLoading(params = new URLSearchParams(location.search), mount = document.querySelector("main")) {
  if (current) { current.set(params); return current; }
  const stage = mount.querySelector("canvas");
  const canvas = document.createElement("canvas");
  canvas.width = 640 * SCALE; canvas.height = 480 * SCALE;
  canvas.setAttribute("aria-label", "Match loading");
  canvas.style.gridArea = "1 / 1";
  canvas.dataset.state = "loading";
  const hidden = stage?.hidden;
  if (stage) stage.hidden = true;
  mount.append(canvas);
  const session = roomSession();
  session.cover(canvas);
  let shown, closed = false, serial = 0, selection;
  // A hosted room's picture capture only emits frames when the canvas changes; a still poster is redrawn (one pixel) so a
  // guest who joins mid-load still gets a frame.
  const keepalive = setInterval(() => { try { canvas.getContext("2d").drawImage(canvas, 0, 0, 1, 1, 0, 0, 1, 1); } catch {} }, 500);
  async function set(next) {
    const art = await layout();
    if (closed) return;
    const chosen = loadingSelection(next, art);
    if (shown === signature(chosen)) return;
    shown = signature(chosen);
    const mine = ++serial;
    const pieces = await fetchPieces(chosen, art);
    if (closed || mine !== serial) return;
    draw(canvas, chosen, art, pieces);
    selection = chosen;
    canvas.dataset.state = "shown";
    canvas.dataset.selection = signature(chosen);
  }
  const controller = {
    canvas,
    set: next => set(next).catch(error => console.warn("Match loading poster:", error.message)),
    selection: () => selection,
    close() {
      if (closed) return;
      closed = true; current = undefined;
      clearInterval(keepalive);
      canvas.remove();
      if (stage?.isConnected && stage.hidden) stage.hidden = hidden ?? false;
      session.cover(null);
      if (window.nativeLoading === diagnostics) delete window.nativeLoading;
    },
  };
  const diagnostics = () => ({ state: canvas.dataset.state, ...selection, size: [canvas.width, canvas.height] });
  window.nativeLoading = diagnostics;
  current = controller;
  controller.set(params);
  return controller;
}

// Removes the poster once the match picture is ready (or the match failed): a no-op when none is showing.
export const closeMatchLoading = () => current?.close();
export const matchLoadingCanvas = () => current?.canvas ?? null;
