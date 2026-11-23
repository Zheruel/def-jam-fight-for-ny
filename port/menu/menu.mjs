// The default playable menu: retail Choose Fighter -> Choose Venue (port/menu/screens.mjs) in the battle page's own frame.
// Resolves with the finished selection ({ mode, handles, venue }); keyboard, gamepads and pointer all drive it.
import { createSelection } from "./state.mjs";
import { SIZE, drawFighters, drawVenue, thumbRect, seatAt, pinAt } from "./screens.mjs";
import { onArrive } from "./art.mjs";
import { COLUMNS, ROWS } from "./state.mjs";
import { venueSupports } from "../battle/modes.mjs";

const json = async name => (await fetch(new URL(name, import.meta.url))).json();

// Keyboard: player 1 WASD + I (cross) / J (triangle) / Q E; player 2 arrows + [ / L / , . ; Enter confirms for whoever is not ready.
const KEYS = {
  0: { a: "left", d: "right", w: "up", s: "down", i: "confirm", j: "back", q: "previous", e: "next" },
  1: { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", "[": "confirm", l: "back", ",": "previous", ".": "next" },
};
const PAD = { 12: "up", 13: "down", 14: "left", 15: "right", 0: "confirm", 1: "back", 3: "back", 4: "previous", 5: "next" };

export async function runMenu({ mount, params, mode = "1v1", seats = mode === "ffa" ? 4 : 2, picks = [], venue = null }) {
  const [roster, venues] = await Promise.all([json("art/roster.json"), json("art/venues.json")]);
  const face = new FontFace("BattleNames", await (await fetch(new URL("../hud/names.ttf", import.meta.url))).arrayBuffer());
  document.fonts.add(await face.load());
  const selection = createSelection({ roster, venues, seats, mode, picks, venue, venueOk: v => venueSupports(v.file, mode) });

  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Choose fighter and venue");
  canvas.width = SIZE.width * 2; canvas.height = SIZE.height * 2;
  const ctx = canvas.getContext("2d");
  mount.append(canvas);
  canvas.focus();

  let tick = 0, camera = null, frame = 0, stopped = false;
  const readyAt = new Map();
  const draw = () => {
    frame = 0;
    if (stopped) return;
    tick++;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    selection.state.seats.forEach((s, i) => { if (s.ready && !readyAt.has(i)) readyAt.set(i, tick); if (!s.ready) readyAt.delete(i); s.readyAt = readyAt.get(i); });
    if (selection.state.screen === "venue") {
      const pin = selection.state.spots[selection.state.venue].pin;
      camera ??= { x: pin[0], y: pin[1] };
      camera.x += (pin[0] - camera.x) * 0.18; camera.y += (pin[1] - camera.y) * 0.18;
      drawVenue(ctx, selection, { time: performance.now(), camera });
    } else {
      drawFighters(ctx, selection, { time: performance.now(), tick });
    }
    // keep animating while something moves; otherwise wait for input or a picture to arrive
    if (selection.state.screen !== "done") frame = requestAnimationFrame(draw);
  };
  const redraw = () => { if (!frame && !stopped) frame = requestAnimationFrame(draw); };
  onArrive(redraw);

  const held = new Map();
  const padFrame = () => {
    if (stopped) return;
    [...(navigator.getGamepads?.() ?? [])].forEach((pad, seat) => {
      if (!pad || seat >= selection.state.seats.length) return;
      const now = new Set(Object.keys(PAD).filter(b => pad.buttons[b]?.pressed));
      const [ax, ay] = pad.axes;
      if (ax < -0.6) now.add("14"); if (ax > 0.6) now.add("15"); if (ay < -0.6) now.add("12"); if (ay > 0.6) now.add("13");
      const before = held.get(seat) ?? new Set();
      for (const b of now) if (!before.has(b)) selection.press(seat, PAD[b]);
      held.set(seat, now);
    });
    requestAnimationFrame(padFrame);
  };
  requestAnimationFrame(padFrame);

  const finished = new Promise(resolve => {
    const done = () => { if (selection.state.screen === "done") { stopped = true; cleanup(); resolve(selection.result()); } };
    const send = (seat, action) => { if (selection.press(seat, action)) { redraw(); done(); return true; } return false; };
    const onKey = event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.("input,select,textarea")) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      let handled = false;
      for (const seat of selection.state.seats.keys()) {
        const action = KEYS[seat]?.[key];
        if (action && send(seat, action)) handled = true; else if (action) handled = true;
        // venue screen: either player's movement keys work for the cursor
        if (action && selection.state.screen === "venue") break;
      }
      if (key === "Enter" || key === " ") {
        if (selection.state.screen === "fighters") {
          const waiting = selection.state.seats.findIndex(s => !s.ready);
          if (waiting >= 0) send(waiting, "confirm");
        } else send(0, "confirm");
        handled = true;
      }
      if (key === "Escape" || key === "Backspace") {
        const last = selection.state.seats.map(s => s.ready).lastIndexOf(true);
        send(Math.max(0, last), "back"); handled = true;
      }
      if (handled) event.preventDefault();
    };
    const point = event => {
      const box = canvas.getBoundingClientRect();
      return [(event.clientX - box.left) / box.width * SIZE.width, (event.clientY - box.top) / box.height * SIZE.height];
    };
    const onPointer = event => {
      const [x, y] = point(event);
      if (selection.state.screen === "fighters") {
        const seat = seatAt(x);
        if (seat >= selection.state.seats.length) return;
        const s = selection.state.seats[seat];
        if (s.ready) { send(seat, "back"); return; }
        const first = selection.scroll(seat) * COLUMNS;
        for (let slot = 0; slot < ROWS * COLUMNS; slot++) {
          const [rx, ry, rw, rh] = thumbRect(seat, slot);
          if (x >= rx && x < rx + rw && y >= ry && y < ry + rh && first + slot < roster.length) {
            if (s.cursor === first + slot) send(seat, "confirm");
            else { selection.pickFighter(seat, first + slot); redraw(); }
            return;
          }
        }
        if (y > 120 && y < 300) send(seat, "confirm");   // the portrait locks the fighter in
      } else if (selection.state.screen === "venue") {
        const index = pinAt(selection, x, y, camera);
        if (index >= 0) {
          if (index === selection.state.venue) send(0, "confirm");
          else { selection.pickVenue(index); redraw(); }
        } else if (x > 340 && y > 380) send(0, "confirm");
      }
    };
    addEventListener("keydown", onKey);
    canvas.addEventListener("pointerdown", onPointer);
    function cleanup() { removeEventListener("keydown", onKey); canvas.removeEventListener("pointerdown", onPointer); canvas.remove(); onArrive(() => {}); }
    runMenu.state = selection;   // for tests
  });
  redraw();
  return finished;
}
