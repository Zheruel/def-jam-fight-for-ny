// Drawing of the retail "Choose Fighter" and "Choose Venue" screens on a 640x480 canvas. Positions are the front-end
// movies' own (SCREENS.VIV chooseF2 / chsVenue, see port/hud/screens/extract.py); art is lazy (art.mjs).
import { have, fighterPictures } from "./art.mjs";
import { COLUMNS, ROWS } from "./state.mjs";

export const SIZE = Object.freeze({ width: 640, height: 480 });
const FONT = "BattleNames";

// Per-seat geometry of chooseF2 (two players): player 1 left card, player 2 right card.
const SEATS = [
  { sticker: [54, 80], window: [61, 134, 249, 278], name: [112, 64], stats: [194, 161], bars: [247, 165], style: [193, 278], box: [60, 304], tint: 1 },
  { sticker: [319, 75], window: [331, 131, 249, 278], name: [386, 61], stats: [464, 157], bars: [517, 161], style: [462, 274], box: [329, 300], tint: 2 },
];
const BAR = { width: 53, pitch: 18.6, height: 11 };
const STAT_KEYS = ["upperPower", "lowerPower", "speed", "toughness", "health", "charisma"];
const CELL = { x: 14, y: 8, w: 42, h: 38, size: 36 };   // thumbnail pitch inside the paper box

export const thumbRect = (seat, slot) => {
  const [bx, by] = SEATS[seat].box;
  return [bx + CELL.x + (slot % COLUMNS) * CELL.w, by + CELL.y + Math.floor(slot / COLUMNS) * CELL.h, CELL.size, CELL.size];
};
export const seatAt = x => x < 320 ? 0 : 1;

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
  const { seats, roster } = selection.state;
  ctx.clearRect(0, 0, SIZE.width, SIZE.height);
  const [left, right] = [have("select-bg-0.png"), have("select-bg-1.png")];
  ctx.fillStyle = "#3a4742"; ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  if (left) ctx.drawImage(left, 0, 0);
  if (right) ctx.drawImage(right, 512, 0);
  title(ctx, "CHOOSE FIGHTER", [["✕", "SELECT"], ["△", "BACK"]]);

  const thumbs = have("thumbs.png");
  seats.forEach((seat, i) => {
    const g = SEATS[i], fighter = roster[seat.cursor];
    // sticker
    const sticker = have(`sticker-${g.tint}.png`);
    if (sticker) ctx.drawImage(sticker, g.sticker[0], g.sticker[1], 50, 38);
    outlined(ctx, `P${i + 1}`, g.sticker[0] + 25, g.sticker[1] + 6, 17, { align: "center", width: 2 });
    // portrait: the head piece over the chest piece, clipped to the card's window
    const [wx, wy, ww, wh] = g.window;
    const [head, chest, name] = fighterPictures(fighter.id).map(have);
    ctx.save();
    ctx.beginPath(); ctx.rect(wx, wy, ww, wh); ctx.clip();
    if (head) { const k = ww / 256; ctx.drawImage(head, wx, wy, ww, 256 * k); if (chest) ctx.drawImage(chest, wx, wy + 256 * k, ww, 80 * k); }
    ctx.restore();
    if (name) ctx.drawImage(name, g.name[0], g.name[1], 208, 100);
    // stats and fighting style
    const labels = have("stat-labels.png");
    if (labels) ctx.drawImage(labels, 0, 0, 50, 113, g.stats[0], g.stats[1], 50, 113);
    STAT_KEYS.forEach((key, row) => {
      const value = Math.max(0, Math.min(1, (fighter.stats?.[key] ?? 0) / 50)), y = g.bars[1] + row * BAR.pitch;
      ctx.fillStyle = "rgba(10,12,10,.78)"; ctx.fillRect(g.bars[0] - 1, y - 1, BAR.width + 2, BAR.height + 2);
      ctx.fillStyle = barColour(value); ctx.fillRect(g.bars[0], y, BAR.width * value, BAR.height);
      ctx.fillStyle = "rgba(255,255,255,.22)"; ctx.fillRect(g.bars[0], y, BAR.width * value, 3);
    });
    const style = have(`style-${fighter.styles[0] ?? "kickboxing"}.png`);
    if (style) ctx.drawImage(style, g.style[0], g.style[1]);
    if (seat.ready) {
      const ready = have("ready.png"), pop = Math.min(1, (tick - (seat.readyAt ?? tick)) / 8 + 0.4);
      if (ready) {
        ctx.save();
        ctx.translate(wx + ww / 2, wy + wh - 60); ctx.rotate(-0.06); ctx.scale(pop, pop);
        ctx.drawImage(ready, -120, -54);
        ctx.restore();
      }
      return;
    }
    // face box (hidden once the fighter is locked in, as on the retail screen)
    const paper = have("thumb-paper.png");
    if (paper) ctx.drawImage(paper, g.box[0], g.box[1], 256, 128);
    const first = selection.scroll(i) * COLUMNS;
    ctx.save();
    ctx.beginPath(); ctx.rect(g.box[0] + 8, g.box[1] + 4, 236, 118); ctx.clip();
    for (let slot = 0; slot < ROWS * COLUMNS; slot++) {
      const index = first + slot;
      if (index >= roster.length) break;
      const [x, y, w, h] = thumbRect(i, slot);
      if (thumbs) ctx.drawImage(thumbs, (index % 8) * 40, Math.floor(index / 8) * 40, 40, 40, x, y, w, h);
      if (index === seat.cursor) {
        const pulse = 0.65 + 0.35 * Math.sin(time / 120);
        ctx.lineWidth = 3; ctx.strokeStyle = i ? `rgba(230,60,50,${pulse})` : `rgba(70,120,230,${pulse})`;
        ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
      }
    }
    ctx.restore();
    // scroller
    const rows = Math.ceil(roster.length / COLUMNS), span = 112;
    ctx.fillStyle = "rgba(20,18,14,.55)"; ctx.fillRect(g.box[0] + 238, g.box[1] + 8, 4, span);
    ctx.fillStyle = "rgba(235,225,190,.9)";
    ctx.fillRect(g.box[0] + 238, g.box[1] + 8 + span * (selection.scroll(i) / rows), 4, span * ROWS / rows);
  });
}

// -- venue screen ------------------------------------------------------------------------------------------------------
const MAP = { x: -289, y: -224, width: 1602, height: 1672 };   // the map shape in the movie's map space
// Tile order found by matching tile edges: the top row runs 4, 3, 2, 1 and the bottom row 7, 6, 5 (venueMap.big sizes).
const TILES = [[4, 0, 0, 216, 584], [3, 216, 0, 376, 584], [2, 592, 0, 376, 584], [1, 968, 0, 368, 584],
  [7, 0, 584, 368, 560], [6, 368, 584, 368, 560], [5, 736, 584, 368, 560]];
const FOCUS = [165, 235];   // where the selected pin sits on screen

export function drawVenue(ctx, selection, { time = 0, camera } = {}) {
  const { spots, venue, variant } = selection.state;
  const spot = spots[venue], current = spot.variants[variant];
  ctx.clearRect(0, 0, SIZE.width, SIZE.height);
  ctx.fillStyle = "#26333a"; ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  const cx = camera?.x ?? spot.pin[0], cy = camera?.y ?? spot.pin[1];
  ctx.save();
  ctx.translate(FOCUS[0] - cx, FOCUS[1] - cy);
  const sx = MAP.width / 1336, sy = MAP.height / 1144;
  for (const [n, x, y, w, h] of TILES) {
    const tile = have(`map-${n}.png`);
    if (tile) ctx.drawImage(tile, MAP.x + x * sx, MAP.y + y * sy, w * sx + 1, h * sy + 1);
  }
  const pinGrey = have("pin-grey.png"), pinRed = have("pin-red.png");
  spots.forEach((s, i) => {
    const chosen = i === venue, [px, py] = s.pin, v = s.variants[chosen ? variant : 0];
    const note = have(`notes/${v.feID}.png`), paper = have(`${chosen ? "red" : "paper"}-${v.feID % 4}.png`);
    ctx.save();
    ctx.translate(px, py);
    if (chosen) ctx.scale(1.18, 1.18);
    ctx.rotate(((v.feID * 7) % 9 - 4) * 0.012);
    if (paper) ctx.drawImage(paper, -paper.width / 2, -8);
    if (note) ctx.drawImage(note, -note.width / 2, 4 + (paper ? (paper.height - 12 - note.height) / 2 : 0));
    const pin = chosen ? pinRed : pinGrey;
    if (pin) ctx.drawImage(pin, -16, -26, 32, 32);
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
  title(ctx, "CHOOSE VENUE", [["△", "BACK"]]);

  // polaroid with the venue's photograph and name
  const frame = have("polaroid-c.png"), back = have("polaroid-a.png");
  ctx.save();
  ctx.translate(480, 200);
  ctx.rotate(0.035);
  if (back) ctx.drawImage(back, -118, -128, 236, 236);
  ctx.rotate(-0.07);
  const photo = have(`venues/${current.file}.png`);
  if (frame) ctx.drawImage(frame, -128, -128);
  if (photo) ctx.drawImage(photo, -100, -108, 200, 158);
  ctx.restore();
  ctx.save();
  ctx.translate(480, 200); ctx.rotate(-0.035);
  let size = 22;
  ctx.font = `${size}px ${FONT}`;
  const wide = ctx.measureText(current.name.toUpperCase()).width;
  if (wide > 200) size = Math.floor(size * 200 / wide);
  outlined(ctx, current.name.toUpperCase(), 0, 58, size, { align: "center", fill: "#1a1814", stroke: "#e9e5da", width: 3 });
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
  if (select) ctx.drawImage(select, 520, 404, 90, 30);
  outlined(ctx, "SELECT", 568, 409, 14, { align: "center", width: 2 });
}

// Venue pointer hit-test in screen space: the index of the pin under (x, y) for the current camera.
export function pinAt(selection, x, y, camera) {
  const { spots, venue } = selection.state;
  const cx = camera?.x ?? spots[venue].pin[0], cy = camera?.y ?? spots[venue].pin[1];
  const mx = x - FOCUS[0] + cx, my = y - FOCUS[1] + cy;
  let best = -1, distance = 40;
  spots.forEach((s, i) => { const d = Math.hypot(s.pin[0] - mx, s.pin[1] + 26 - my); if (d < distance) { distance = d; best = i; } });
  return best;
}
export const FOCUS_POINT = FOCUS;
