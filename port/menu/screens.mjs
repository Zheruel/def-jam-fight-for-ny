// Drawing of the retail "Choose Fighter" and "Choose Venue" screens on a 640x480 canvas. Positions are the front-end
// movies' own (SCREENS.VIV chooseF2 / chsVenue, see port/hud/screens/extract.py); art is lazy (art.mjs).
import { have, fighterPictures } from "./art.mjs";
import { ROWS } from "./state.mjs";

export const SIZE = Object.freeze({ width: 640, height: 480 });
const FONT = "BattleNames";

// Geometry of the two retail screens (chooseF2: two cards, chooseF4: four cards), from their front-end movies.
const TWO = {
  bg: ["select-bg-0.png", "select-bg-1.png"], paper: ["thumb-paper.png", 256, 128], ready: ["ready.png", 240, 108], name: [208, 100, 1],
  bar: { width: 53, pitch: 18.6, height: 11 }, labels: [50, 113, 50, 113], cell: { x: 14, y: 8, w: 42, h: 38, size: 36 }, scroller: [238, 8, 4, 112],
  seats: [
    { sticker: [54, 80], window: [61, 134, 249, 278], name: [112, 64], stats: [194, 161], bars: [247, 165], style: [193, 278], box: [60, 304] },
    { sticker: [319, 75], window: [331, 131, 249, 278], name: [386, 61], stats: [464, 157], bars: [517, 161], style: [462, 274], box: [329, 300] },
  ],
};
const THREE = {
  bg: ["select3-bg-0.png", "select3-bg-1.png"], paper: ["thumb-paper3.png", 176, 128], ready: ["ready3.png", 200, 100], name: [208, 100, 0.72],
  bar: { width: 53, pitch: 18, height: 11 }, labels: [48, 112, 50, 112], cell: { x: 6, y: 7, w: 40, h: 38, size: 36 }, scroller: [160, 6, 5, 112],
  seats: [
    { sticker: [39, 77], window: [56, 128, 166, 180], name: [72, 70], stats: [109, 156], bars: [161, 162], style: [106, 272], box: [52, 306] },
    { sticker: [219, 81], window: [236, 128, 166, 180], name: [250, 78], stats: [290, 160], bars: [341, 166], style: [286, 278], box: [232, 313] },
    { sticker: [405, 77], window: [420, 128, 166, 180], name: [437, 70], stats: [475, 156], bars: [526, 162], style: [471, 272], box: [416, 307] },
  ],
};
const FOUR = {
  bg: ["select4-bg-0.png", "select4-bg-1.png"], paper: ["thumb-paper4.png", 136, 128], ready: ["ready4.png", 152, 76], name: [208, 100, 0.6],
  bar: { width: 37, pitch: 16.6, height: 10 }, labels: [48, 112, 45, 102], cell: { x: 8, y: 6, w: 38, h: 38, size: 34 }, scroller: [122, 6, 4, 112],
  seats: [
    { sticker: [38, 76], window: [53, 136, 124, 176], name: [46, 82], stats: [89, 173], bars: [136, 179], style: [79, 277], box: [48, 311] },
    { sticker: [171, 79], window: [189, 140, 124, 176], name: [199, 87], stats: [225, 178], bars: [272, 184], style: [216, 282], box: [184, 316] },
    { sticker: [312, 72], window: [325, 130, 124, 176], name: [337, 78], stats: [362, 167], bars: [409, 173], style: [352, 271], box: [320, 308] },
    { sticker: [446, 77], window: [459, 135, 124, 176], name: [461, 75], stats: [496, 173], bars: [543, 179], style: [486, 277], box: [455, 311] },
  ],
};
const layoutOf = selection => [TWO, TWO, TWO, THREE, FOUR][selection.state.seats.length];
const STAT_KEYS = ["upperPower", "lowerPower", "speed", "toughness", "health", "charisma"];

export const thumbRect = (selection, seat, slot) => {
  const L = layoutOf(selection), { columns } = selection.state, [bx, by] = L.seats[seat].box;
  return [bx + L.cell.x + (slot % columns) * L.cell.w, by + L.cell.y + Math.floor(slot / columns) * L.cell.h, L.cell.size, L.cell.size];
};
export const stickerAt = (selection, x, y) => {
  const L = layoutOf(selection);
  return L.seats.findIndex(g => x >= g.sticker[0] && x < g.sticker[0] + 50 && y >= g.sticker[1] && y < g.sticker[1] + 38);
};
export const seatAt = (selection, x) => Math.min(selection.state.seats.length - 1, Math.floor(x / (SIZE.width / selection.state.seats.length)));

function outlined(ctx, text, x, y, size, { align = "left", fill = "#e6dfd0", stroke = "#2b241b", width = 3 } = {}) {
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = align; ctx.textBaseline = "top";
  ctx.lineJoin = "round"; ctx.lineWidth = width; ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}

function barColour(value) {
  return value > 0.75 ? "#3fd13a" : value > 0.5 ? "#a8d63a" : "#e0c92f";
}

function title(ctx, text, hints) {
  outlined(ctx, text, 30, 22, 30, { fill: "#d9cfa0", stroke: "#15130f", width: 5 });
  ctx.save();
  ctx.font = `15px ${FONT}`; ctx.textBaseline = "top";
  hints.forEach(([key, label], i) => {
    const y = 20 + i * 24, x = 500;
    ctx.fillStyle = "#9fb7e6"; ctx.fillText(key, x, y);
    outlined(ctx, label, x + 22, y, 15, { width: 2.5 });
  });
  ctx.restore();
}

export function drawFighters(ctx, selection, { time = 0, tick = 0 } = {}) {
  const { seats, roster, columns } = selection.state, L = layoutOf(selection);
  ctx.clearRect(0, 0, SIZE.width, SIZE.height);
  const [left, right] = L.bg.map(have);
  ctx.fillStyle = "#3a4742"; ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  if (left) ctx.drawImage(left, 0, 0);
  if (right) ctx.drawImage(right, 512, 0);
  title(ctx, selection.state.seats.length > 2 ? "CHOOSE FIGHTERS" : "CHOOSE FIGHTER", [["\u2715", "SELECT"], ["\u25b3", "BACK"]]);

  outlined(ctx, `C  CPU OPPONENTS: ${selection.state.cpu || "OFF"}`, 30, 454, 13, { width: 2.5 });
  const thumbs = have("thumbs.png");
  seats.forEach((seat, i) => {
    const g = L.seats[i], fighter = roster[seat.cursor];
    const sticker = have(`sticker-${i + 1}.png`);
    if (sticker) ctx.drawImage(sticker, g.sticker[0], g.sticker[1], 50, 38);
    const isCpu = i >= seats.length - selection.state.cpu;
    outlined(ctx, isCpu ? "CPU" : `P${i + 1}`, g.sticker[0] + 25, g.sticker[1] + 6, isCpu ? 14 : 17, { align: "center", width: 2 });
    // portrait: the head piece over the chest piece, clipped to the card's window
    const [wx, wy, ww, wh] = g.window;
    const [head, chest, name] = fighterPictures(fighter.id).map(have);
    ctx.save();
    ctx.beginPath(); ctx.rect(wx, wy, ww, wh); ctx.clip();
    if (head) { const k = ww / 256; ctx.drawImage(head, wx, wy, ww, 256 * k); if (chest) ctx.drawImage(chest, wx, wy + 256 * k, ww, 80 * k); }
    ctx.restore();
    if (name) ctx.drawImage(name, g.name[0], g.name[1], L.name[0] * L.name[2], L.name[1] * L.name[2]);
    // stats and fighting style
    const labels = have("stat-labels.png");
    if (labels) ctx.drawImage(labels, 0, 0, L.labels[0], L.labels[1], g.stats[0], g.stats[1], L.labels[2], L.labels[3]);
    STAT_KEYS.forEach((key, row) => {
      const value = Math.max(0, Math.min(1, (fighter.stats?.[key] ?? 0) / 50)), y = g.bars[1] + row * L.bar.pitch;
      ctx.fillStyle = "rgba(10,12,10,.78)"; ctx.fillRect(g.bars[0] - 1, y - 1, L.bar.width + 2, L.bar.height + 2);
      ctx.fillStyle = barColour(value); ctx.fillRect(g.bars[0], y, L.bar.width * value, L.bar.height);
      ctx.fillStyle = "rgba(255,255,255,.22)"; ctx.fillRect(g.bars[0], y, L.bar.width * value, 3);
    });
    const style = have(`style-${fighter.styles[0] ?? "kickboxing"}.png`);
    if (style) ctx.drawImage(style, g.style[0], g.style[1]);
    if (seat.ready) {
      const ready = have(L.ready[0]), pop = Math.min(1, (tick - (seat.readyAt ?? tick)) / 8 + 0.4);
      if (ready) {
        ctx.save();
        ctx.translate(wx + ww / 2, wy + wh - 60); ctx.rotate(-0.06); ctx.scale(pop, pop);
        ctx.drawImage(ready, -L.ready[1] / 2, -L.ready[2] / 2);
        ctx.restore();
      }
      return;
    }
    // face box (hidden once the fighter is locked in, as on the retail screen)
    const paper = have(L.paper[0]);
    if (paper) ctx.drawImage(paper, g.box[0], g.box[1], L.paper[1], L.paper[2]);
    const first = selection.scroll(i) * columns;
    ctx.save();
    ctx.beginPath(); ctx.rect(g.box[0] + 4, g.box[1] + 4, L.paper[1] - 14, L.paper[2] - 10); ctx.clip();
    for (let slot = 0; slot < ROWS * columns; slot++) {
      const index = first + slot;
      if (index >= roster.length) break;
      const [x, y, w, h] = thumbRect(selection, i, slot);
      if (thumbs) ctx.drawImage(thumbs, (index % 8) * 40, Math.floor(index / 8) * 40, 40, 40, x, y, w, h);
      if (index === seat.cursor) {
        const pulse = 0.65 + 0.35 * Math.sin(time / 120);
        ctx.lineWidth = 3; ctx.strokeStyle = `rgba(${["70,120,230", "230,60,50", "70,190,80", "170,90,210"][i]},${pulse})`;
        ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
      }
    }
    ctx.restore();
    // scroller
    const rows = Math.ceil(roster.length / columns), [sx, sy, sw, span] = L.scroller;
    ctx.fillStyle = "rgba(20,18,14,.55)"; ctx.fillRect(g.box[0] + sx, g.box[1] + sy, sw, span);
    ctx.fillStyle = "rgba(235,225,190,.9)";
    ctx.fillRect(g.box[0] + sx, g.box[1] + sy + span * (selection.scroll(i) / rows), sw, span * ROWS / rows);
  });
}

// Original chsTeam4 panels. The four large slots are ordered by team. The small
// portraits stay in controller order while the player fills the team slots.
const TEAM_COLUMNS = [83, 199, 325, 441];
export const teamThumbX = seat => 179 + seat * 72;

export function drawTeams(ctx, {state}) {
  const tile = (tag, x, y) => { const pic = have(`team-${tag}.png`); if (pic) ctx.drawImage(pic, x, y); };
  ctx.clearRect(0, 0, SIZE.width, SIZE.height);
  tile(2, 0, 0); tile(1, 512, 0);
  title(ctx, "CHOOSE TEAMS", [["✕", "SELECT"], ["△", "BACK"]]);
  tile(18, 115, 96); tile(17, 371, 96);
  for (const [slot, x] of TEAM_COLUMNS.entries()) {
    const selected = state.teamOrder[slot] ?? (slot === state.teamOrder.length ? state.teamCursor : undefined);
    if (selected === undefined) { outlined(ctx, "?", x + 52, 228, 49, {align:"center"}); continue; }
    const fighter = state.roster[state.seats[selected].cursor];
    const [head, chest] = fighterPictures(fighter.id).slice(0, 2).map(have);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, 171, 105, 194); ctx.clip();
    if (head) ctx.drawImage(head, x - 30, 171, 165, 165);
    if (chest) ctx.drawImage(chest, x - 30, 336, 165, 52);
    ctx.restore();
    if (slot === state.teamOrder.length) tile(22, x - 2, 168);
  }
  tile(25, 291, 231);
  outlined(ctx, "TEAM 1", 71, 392, 18); outlined(ctx, "TEAM 2", 505, 392, 18);
  tile(31, 154, 318); tile(30, 410, 318);
  const thumbs = have("thumbs.png");
  state.seats.forEach(({cursor}, i) => {
    const x = teamThumbX(i);
    if (thumbs) ctx.drawImage(thumbs, cursor % 8 * 40, Math.floor(cursor / 8) * 40, 40, 40, x + 4, 344, 54, 51);
    if (state.teamOrder.includes(i)) {
      ctx.fillStyle = "rgba(41,32,21,.68)"; ctx.fillRect(x + 4, 344, 54, 51);
    } else if (i === state.teamCursor) tile(33, x, 339);
  });
}

// -- match type screen --------------------------------------------------------------------------------------------------
const TYPE_ART = { "1v1": ["type-1v1.png", "ONE ON ONE"], team: ["type-team.png", "TAG TEAM"], ffa3: ["type-ffa.png", "FREE FOR ALL 3"],
  ffa: ["type-ffa.png", "FREE FOR ALL"] };
export const typeRect = (count, slot) => { const width = Math.min(190, Math.floor((SIZE.width - 60) / count) - 30), gap = 30, x0 = (SIZE.width - count * width - (count - 1) * gap) / 2; return [x0 + slot * (width + gap), 130, width, 240]; };

export function drawType(ctx, { types, index }, { time = 0 } = {}) {
  ctx.clearRect(0, 0, SIZE.width, SIZE.height);
  const grad = ctx.createRadialGradient(320, 250, 40, 320, 250, 420);
  grad.addColorStop(0, "#4a5a54"); grad.addColorStop(1, "#1c2422");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  title(ctx, "CHOOSE MATCH TYPE", [["\u2715", "SELECT"]]);
  types.forEach((type, i) => {
    const [x, y, w, h] = typeRect(types.length, i), [file, label] = TYPE_ART[type], card = have(file), chosen = i === index;
    if (chosen) {
      const bracket = have("type-bracket.png");
      ctx.save(); ctx.globalAlpha = 0.7 + 0.3 * Math.sin(time / 140);
      if (bracket) ctx.drawImage(bracket, 13, 12, 69, 112, x + w / 2 - 95 * w / 190, y + h / 2 - 17 - 131 * w / 190, w, 262 * w / 190);
      ctx.restore();
    }
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2); ctx.rotate(chosen ? 0 : (i % 2 ? 0.03 : -0.03)); ctx.scale((chosen ? 1.06 : 1) * w / 190, (chosen ? 1.06 : 1) * w / 190);
    if (card) ctx.drawImage(card, 0, 0, 60, 84, -75, -122, 150, 210);   // the 128x128 picture holds one 58x82 card
    ctx.restore();
    outlined(ctx, label, x + w / 2, y + h - 38, Math.round(20 * Math.max(0.6, w / 190)), { align: "center", fill: chosen ? "#f1e8c8" : "#a8a290", width: 3 });
  });
}

// -- venue screen ------------------------------------------------------------------------------------------------------
// battle/map.big: 3 x 3 pieces (columns 512, 512, 336 wide; rows 512, 512, 92 high), in map space from (0, 0). The order,
// 9 7 6 / 5 4 3 / 2 1 8, was recovered by matching piece edges and agrees with the geography (Bronx above Brooklyn,
// Staten Island west, the Long Island shore east).
const TILES = [[9, 0, 0, 512, 512], [7, 512, 0, 512, 512], [6, 1024, 0, 336, 512],
  [5, 0, 512, 512, 512], [4, 512, 512, 512, 512], [3, 1024, 512, 336, 512],
  [2, 0, 1024, 512, 92], [1, 512, 1024, 512, 92], [8, 1024, 1024, 336, 92]];
const FOCUS = [165, 235];   // where the selected pin sits on screen

export function drawVenue(ctx, selection, { time = 0, camera } = {}) {
  const { spots, venue, variant } = selection.state;
  const spot = spots[venue], current = spot.variants[variant];
  ctx.clearRect(0, 0, SIZE.width, SIZE.height);
  ctx.fillStyle = "#26333a"; ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  const cx = camera?.x ?? spot.pin[0], cy = camera?.y ?? spot.pin[1];
  ctx.save();
  ctx.translate(FOCUS[0] - cx, FOCUS[1] - cy);
  for (const [n, x, y, w, h] of TILES) {
    const tile = have(`map-${n}.png`);
    if (tile) ctx.drawImage(tile, x, y, w + 0.5, h + 0.5);
  }
  const pinRed = have("pin-red.png");
  spots.forEach((s, i) => {
    const chosen = i === venue, [px, py] = s.pin, v = s.variants[chosen ? variant : 0];
    const note = have(`notes/${v.feID}.png`), paper = have(`${chosen ? "red" : "paper"}-${v.feID % 4}.png`);
    ctx.save();
    ctx.translate(px, py);
    if (chosen) ctx.scale(1.18, 1.18);
    ctx.rotate(((v.feID * 7) % 9 - 4) * 0.012);
    if (paper) ctx.drawImage(paper, -paper.width / 2, -12);
    if (note) ctx.drawImage(note, -note.width / 2, -4 + (paper ? (paper.height - 12 - note.height) / 2 : 0));
    if (pinRed) ctx.drawImage(pinRed, -16, -22, 32, 32);   // every pin is red on the retail map
    ctx.restore();
  });
  ctx.restore();
  // yellow arrows towards the neighbouring pins
  const arrow = have("arrow.png");
  if (arrow) {
    [[0, -1, 0], [1, 0, Math.PI / 2], [0, 1, Math.PI], [-1, 0, -Math.PI / 2]].forEach(([dx, dy, angle]) => {
      ctx.save();
      ctx.translate(FOCUS[0] + dx * 62, FOCUS[1] + 12 + dy * 52); ctx.rotate(angle);
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin(time / 160);
      ctx.drawImage(arrow, -20, -14);
      ctx.restore();
    });
  }

  // the retail map darkens towards the top and bottom edges
  const dark = ctx.createLinearGradient(0, 0, 0, SIZE.height);
  dark.addColorStop(0, "rgba(0,0,0,.82)"); dark.addColorStop(0.16, "rgba(0,0,0,0)"); dark.addColorStop(0.9, "rgba(0,0,0,0)"); dark.addColorStop(1, "rgba(0,0,0,.8)");
  ctx.fillStyle = dark; ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  title(ctx, "CHOOSE VENUE", [["\u25b3", "BACK"]]);

  // two polaroids behind, the front one holding the photograph and the venue's name; the description on taped notepaper
  const [back, middle, frame, tape] = ["polaroid-a.png", "polaroid-b.png", "polaroid-c.png", "tape.png"].map(have);
  const tilted = (image, x, y, angle) => {
    if (!image) return;
    ctx.save(); ctx.translate(x + 128, y + 128); ctx.rotate(angle); ctx.drawImage(image, -128, -128); ctx.restore();
  };
  if (tape) ctx.drawImage(tape, 335, 233, 320, 192);
  tilted(back, 385, 72, 0.045); tilted(middle, 345, 82, -0.04); tilted(frame, 365, 82, 0.01);
  const photo = have(`venues/${current.file}.png`);
  if (photo) ctx.drawImage(photo, 365 + 21, 82 + 17, 192, 152);
  let size = 24;
  ctx.font = `${size}px ${FONT}`;
  const wide = ctx.measureText(current.name.toUpperCase()).width;
  if (wide > 200) size = Math.floor(size * 200 / wide);
  outlined(ctx, current.name.toUpperCase(), 493, 82 + 178, size, { align: "center", fill: "#15130f", stroke: "#f2eee4", width: 3 });
  const lines = wrap(ctx, current.description ?? "", 196, 13);
  ctx.save();
  ctx.font = `13px ${FONT}`; ctx.fillStyle = "#26335c"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, 483, 318 + i * 17));
  ctx.restore();
  // variants (a venue and its remix share a pin)
  if (spot.variants.length > 1) {
    spot.variants.forEach((v, i) => {
      ctx.fillStyle = i === variant ? "#e6dfd0" : "rgba(230,223,208,.35)";
      ctx.beginPath(); ctx.arc(480 + (i - (spot.variants.length - 1) / 2) * 14, 352, 4, 0, 7); ctx.fill();
    });
    outlined(ctx, "Q / E  OTHER LIGHTING", 480, 360, 11, { align: "center", width: 2 });
  }
  const select = have("label-strip.png");
  if (select) ctx.drawImage(select, 498, 386, 90, 30);
  ctx.save(); ctx.font = `13px ${FONT}`; ctx.fillStyle = "#9fb7e6"; ctx.textBaseline = "top"; ctx.fillText("\u2715", 507, 392); ctx.restore();
  outlined(ctx, "SELECT", 524, 392, 13, { width: 2 });
}

function wrap(ctx, text, width, size) {
  ctx.font = `${size}px ${FONT}`;
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? line + " " + word : word;
    if (line && ctx.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Venue pointer hit-test in screen space: the index of the pin under (x, y) for the current camera.
export function pinAt(selection, x, y, camera) {
  const { spots, venue } = selection.state;
  const cx = camera?.x ?? spots[venue].pin[0], cy = camera?.y ?? spots[venue].pin[1];
  const mx = x - FOCUS[0] + cx, my = y - FOCUS[1] + cy;
  let best = -1, distance = 40;
  spots.forEach((s, i) => { const d = Math.hypot(s.pin[0] - mx, s.pin[1] + 22 - my); if (d < distance) { distance = d; best = i; } });
  return best;
}
export const FOCUS_POINT = FOCUS;
