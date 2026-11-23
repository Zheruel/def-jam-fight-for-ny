// The default playable menu: retail Choose Match Type -> Choose Fighter -> Choose Venue (port/menu/screens.mjs) in the
// battle page's own frame. Resolves with the finished selection ({ mode, handles, venue }); keyboard, gamepads and pointer
// all drive it. The match-type step only appears when more than one type is offered (Free For All is local-only for now).
import { createSelection, ROWS } from "./state.mjs";
import { SIZE, drawFighters, drawVenue, drawType, typeRect, thumbRect, seatAt, pinAt } from "./screens.mjs";
import { onArrive } from "./art.mjs";
import { venueSupports } from "../battle/modes.mjs";

const json = async name => (await fetch(new URL(name, import.meta.url))).json();
const SEATS = { "1v1": 2, ffa: 4 };

// Keyboard: player 1 WASD + I (cross) / J (triangle) / Q E; player 2 arrows + [ / L / , . ; players 3 and 4 (Free For All)
// TFGH + Y / R and numpad 8456 + 5 / 7; Enter confirms for whoever is not ready, Escape steps back.
const KEYS = [
  { a: "left", d: "right", w: "up", s: "down", i: "confirm", j: "back", q: "previous", e: "next" },
  { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", "[": "confirm", l: "back", ",": "previous", ".": "next" },
  { f: "left", h: "right", t: "up", g: "down", y: "confirm", r: "back" },
  { 4: "left", 6: "right", 8: "up", 2: "down", 5: "confirm", 7: "back" },
];
const PAD = { 12: "up", 13: "down", 14: "left", 15: "right", 0: "confirm", 1: "back", 3: "back", 4: "previous", 5: "next" };

export async function runMenu({ mount, types = ["1v1"], picks = [], venue = null }) {
  const [roster, venues] = await Promise.all([json("art/roster.json"), json("art/venues.json")]);
  const face = new FontFace("BattleNames", await (await fetch(new URL("../hud/names.ttf", import.meta.url))).arrayBuffer());
  document.fonts.add(await face.load());

  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Choose fighter and venue");
  canvas.width = SIZE.width * 2; canvas.height = SIZE.height * 2;
  const ctx = canvas.getContext("2d");
  mount.append(canvas);
  canvas.focus();

  let selection = null, pick = { types, index: 0 };
  if (types.length === 1) start(types[0]);
  function start(mode) {
    selection = createSelection({ roster, venues, seats: SEATS[mode], mode, picks, venue, venueOk: v => venueSupports(v.file, mode) });
  }
  const screen = () => selection ? selection.state.screen : "type";

  let tick = 0, camera = null, frame = 0, stopped = false;
  const readyAt = new Map();
  const draw = () => {
    frame = 0;
    if (stopped) return;
    tick++;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    if (!selection) drawType(ctx, pick, { time: performance.now() });
    else {
      selection.state.seats.forEach((s, i) => { if (s.ready && !readyAt.has(i)) readyAt.set(i, tick); if (!s.ready) readyAt.delete(i); s.readyAt = readyAt.get(i); });
      if (screen() === "venue") {
        const pin = selection.state.spots[selection.state.venue].pin;
        camera ??= { x: pin[0], y: pin[1] };
        camera.x += (pin[0] - camera.x) * 0.18; camera.y += (pin[1] - camera.y) * 0.18;
        drawVenue(ctx, selection, { time: performance.now(), camera });
      } else drawFighters(ctx, selection, { time: performance.now(), tick });
    }
    if (screen() !== "done") frame = requestAnimationFrame(draw);   // animation (cursor pulse, map scroll) keeps it running
  };
  const redraw = () => { if (!frame && !stopped) frame = requestAnimationFrame(draw); };
  onArrive(redraw);

  return new Promise(resolve => {
    // One entry point for every device: (seat, action) like a controller press.
    const send = (seat, action) => {
      let used = false;
      if (!selection) {
        if (action === "left" || action === "right") { pick.index = (pick.index + (action === "left" ? -1 : 1) + types.length) % types.length; used = true; }
        else if (action === "confirm") { start(types[pick.index]); used = true; }
      } else if (action === "back" && screen() === "fighters" && !selection.state.seats.some(s => s.ready) && types.length > 1) {
        selection = null; used = true;   // back to the match type
      } else used = selection.press(seat, action);
      if (used) { redraw(); if (screen() === "done") { stopped = true; cleanup(); resolve(selection.result()); } }
      return used;
    };
    const seatCount = () => selection?.state.seats.length ?? 1;
    const onKey = event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.("input,select,textarea")) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      let handled = false;
      for (let seat = 0; seat < Math.max(2, seatCount()); seat++) {
        const action = KEYS[seat]?.[key];
        if (!action) continue;
        handled = true;
        if (selection && seat >= seatCount()) continue;
        send(seat, action);
        if (screen() === "venue" || !selection) break;   // one cursor there: either player's keys work
      }
      if (key === "Enter" || key === " ") {
        handled = true;
        const waiting = screen() === "fighters" ? selection.state.seats.findIndex(s => !s.ready) : 0;
        send(Math.max(0, waiting), "confirm");
      }
      if (key === "Escape" || key === "Backspace") {
        handled = true;
        const last = selection ? selection.state.seats.map(s => s.ready).lastIndexOf(true) : 0;
        send(Math.max(0, last), "back");
      }
      if (handled) event.preventDefault();
    };
    const point = event => {
      const box = canvas.getBoundingClientRect();
      return [(event.clientX - box.left) / box.width * SIZE.width, (event.clientY - box.top) / box.height * SIZE.height];
    };
    const onPointer = event => {
      const [x, y] = point(event);
      if (!selection) {
        types.forEach((_, i) => {
          const [rx, ry, rw, rh] = typeRect(types.length, i);
          if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) { if (pick.index === i) send(0, "confirm"); else { pick.index = i; redraw(); } }
        });
      } else if (screen() === "fighters") {
        const seat = seatAt(selection, x), s = selection.state.seats[seat], { columns } = selection.state;
        if (s.ready) { send(seat, "back"); return; }
        const first = selection.scroll(seat) * columns;
        for (let slot = 0; slot < ROWS * columns; slot++) {
          const [rx, ry, rw, rh] = thumbRect(selection, seat, slot);
          if (x >= rx && x < rx + rw && y >= ry && y < ry + rh && first + slot < roster.length) {
            if (s.cursor === first + slot) send(seat, "confirm");
            else { selection.pickFighter(seat, first + slot); redraw(); }
            return;
          }
        }
        if (y > 120 && y < 300) send(seat, "confirm");   // the portrait locks the fighter in
      } else if (screen() === "venue") {
        const index = pinAt(selection, x, y, camera);
        if (index >= 0) {
          if (index === selection.state.venue) send(0, "confirm");
          else { selection.pickVenue(index); redraw(); }
        } else if (x > 340 && y > 380) send(0, "confirm");
      }
    };
    const held = new Map();
    let padLoop = 0;
    const padFrame = () => {
      [...(navigator.getGamepads?.() ?? [])].forEach((pad, seat) => {
        if (!pad || seat >= Math.max(1, seatCount())) return;
        const now = new Set(Object.keys(PAD).filter(b => pad.buttons[b]?.pressed));
        const [ax = 0, ay = 0] = pad.axes;
        if (ax < -0.6) now.add("14"); if (ax > 0.6) now.add("15"); if (ay < -0.6) now.add("12"); if (ay > 0.6) now.add("13");
        const before = held.get(seat) ?? new Set();
        for (const b of now) if (!before.has(b)) send(seat, PAD[b]);
        held.set(seat, now);
      });
      if (!stopped) padLoop = requestAnimationFrame(padFrame);
    };
    padLoop = requestAnimationFrame(padFrame);
    addEventListener("keydown", onKey);
    canvas.addEventListener("pointerdown", onPointer);
    function cleanup() {
      removeEventListener("keydown", onKey); canvas.removeEventListener("pointerdown", onPointer);
      cancelAnimationFrame(padLoop); canvas.remove(); onArrive(() => {});
    }
    redraw();
  });
}
