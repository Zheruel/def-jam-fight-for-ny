// The default playable menu: retail Choose Match Type -> Choose Fighter -> Choose Venue (port/menu/screens.mjs) in the
// battle page's own frame. Resolves with the finished selection ({ mode, handles, venue }); keyboard, gamepads and pointer
// all drive it. The match-type step only appears when more than one type is offered (Free For All is local-only for now).
import { createSelection, ROWS } from "./state.mjs";
import { SIZE, drawFighters, drawVenue, drawTeams, teamThumbX, drawType, thumbRect, seatAt, stickerAt, pinAt } from "./screens.mjs";
import { matchTypeSelection } from "./match-types.mjs";
import { onArrive } from "./art.mjs";
import { MODES, venueSupports } from "../battle/modes.mjs";

const json = async name => (await fetch(new URL(name, import.meta.url))).json();

// Keyboard: player 1 WASD + I (cross) / J (triangle) / Q E; player 2 arrows + [ / L / , . ; players 3 and 4 (Free For All)
// TFGH + Y / R and numpad 8456 + 5 / 7; C (player 2: K, pad Square) cycles how many of the last seats the retail CPU plays; Enter confirms for whoever is not ready, Escape steps back.
const KEYS = [
  { a: "left", d: "right", w: "up", s: "down", i: "confirm", j: "back", q: "previous", e: "next", c: "cpu" },
  { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", "[": "confirm", l: "back", ",": "previous", ".": "next", k: "cpu" },
  { f: "left", h: "right", t: "up", g: "down", y: "confirm", r: "back" },
  { 4: "left", 6: "right", 8: "up", 2: "down", 5: "confirm", 7: "back" },
];
const PAD = { 2: "cpu", 12: "up", 13: "down", 14: "left", 15: "right", 0: "confirm", 1: "back", 3: "back", 4: "previous", 5: "next" };

// Remote controller bits (the Standard Gamepad mapping netplay guests send) to the menu's actions.
const REMOTE = [[0x4000, "confirm"], [0x2000, "back"], [0x1000, "back"]];

// session (port/battle/controls.mjs roomSession): the online room, if any. A host opens it from the Choose Fighter screen;
// each guest then holds the seat of its own slot: its keyboard or pad moves, confirms and releases that seat's fighter,
// and the host's own keys and pads leave that seat alone. The host still chooses the match type, CPU seats and venue.
export async function runMenu({ mount, types = ["1v1"], picks = [], venue = null, session = null }) {
  const [roster, venues] = await Promise.all([json("art/roster.json"), json("art/venues.json")]);
  const face = new FontFace("BattleNames", await (await fetch(new URL("../hud/names.ttf", import.meta.url))).arrayBuffer());
  document.fonts.add(await face.load());

  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Choose fighter and venue");
  canvas.width = SIZE.width * 2; canvas.height = SIZE.height * 2;
  const ctx = canvas.getContext("2d");
  mount.append(canvas);
  canvas.focus();

  let selection = null;
  const pick = matchTypeSelection(types);
  session?.use({ canvas, seats: 0, cpu: 0 });
  if (types.length === 1) start(types[0]);
  function start(mode) {
    selection = createSelection({ roster, venues, seats: MODES[mode].fighters, mode, rule: pick.state.rule, picks, venue, venueOk: v => venueSupports(v.file, mode) });
    session?.use({ canvas, seats: selection.state.seats.length, cpu: 0 });
  }
  // A match type with fewer seats than a guest's slot would leave that guest without one: the type wall stays.
  const begin = mode => { if (!session || session.fits(MODES[mode].fighters)) start(mode); };
  // A seat a guest holds answers only to that guest.
  const remote = seat => Boolean(session?.occupied(seat));
  // The CPU takes the last seats; an online room refuses a count that would take a seat a guest holds.
  const cpuChange = change => {
    const before = selection.state.cpu, used = change();
    if (session && selection.state.cpu !== before && !session.setCpu(selection.state.cpu)) selection.setCpu(before);
    return used;
  };
  // The CPU key steps through the counts the room allows (it skips one that would take a guest's seat).
  const cpuCycle = () => {
    const { seats } = selection.state, before = selection.state.cpu;
    for (let n = 1; n < seats.length; n++) {
      const count = (before + n) % seats.length;
      if (session && !session.setCpu(count)) continue;
      return selection.setCpu(count);
    }
    return false;
  };
  Object.defineProperty(window, "nativeMenu", { configurable: true, get: () => ({
    screen: screen(), rule: pick.state.rule, popup: pick.state.choosingRules ? "rules" : pick.state.size ? "size" : null, type: pick.state.mode, size: pick.state.size, cpu: selection?.state.cpu ?? 0,
    seats: selection?.state.seats.map((s, i) => ({ handle: roster[s.cursor].handle, ready: s.ready, remote: remote(i) })) ?? [],
  }) });
  const screen = () => selection ? selection.state.screen : "type";

  let tick = 0, camera = null, frame = 0, stopped = false;
  const readyAt = new Map();
  const frameMs = 1000 / 60;
  let nextPaint = 0;
  const draw = now => {
    frame = 0;
    if (stopped) return;
    if (now + 0.1 < nextPaint) { frame = requestAnimationFrame(draw); return; }
    nextPaint = now - nextPaint > frameMs ? now + frameMs : nextPaint + frameMs;
    tick++;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    if (!selection) drawType(ctx, pick.state);
    else {
      selection.state.seats.forEach((s, i) => { if (s.ready && !readyAt.has(i)) readyAt.set(i, tick); if (!s.ready) readyAt.delete(i); s.readyAt = readyAt.get(i); });
      if (screen() === "venue") {
        const pin = selection.state.spots[selection.state.venue].pin;
        camera ??= { x: pin[0], y: pin[1] };
        camera.x += (pin[0] - camera.x) * 0.18; camera.y += (pin[1] - camera.y) * 0.18;
        drawVenue(ctx, selection, { time: performance.now(), camera });
      } else if (screen() === "teams") drawTeams(ctx, selection);
      else drawFighters(ctx, selection, { time: performance.now(), tick });
    }
    if (selection && screen() !== "done" && screen() !== "teams") frame = requestAnimationFrame(draw);
  };
  const redraw = () => { if (!frame && !stopped) frame = requestAnimationFrame(draw); };
  onArrive(redraw);

  return new Promise(resolve => {
    // One entry point for every device: (seat, action) like a controller press.
    const send = (seat, action) => {
      let used = false;
      if (!selection) {
        const mode = pick.press(action);
        if (mode) begin(mode);
        used = true;
      } else if (action === "back" && screen() === "fighters" && !selection.state.seats.some(s => s.ready) && types.length > 1) {
        // back to the match type, unless a guest holds a seat the other types may not have
        if (!selection.state.seats.some((_, i) => remote(i))) { selection = null; used = true; }
      } else used = action === "cpu" && screen() === "fighters" ? cpuCycle() : selection.press(seat, action);
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
        if (screen() === "fighters" && remote(seat)) continue;   // only the fighter screen has seats of its own
        send(seat, action);
        if (screen() === "venue" || !selection) break;   // one cursor there: either player's keys work
      }
      if (key === "Enter" || key === " ") {
        handled = true;
        const waiting = screen() === "fighters" ? selection.state.seats.findIndex((s, i) => !s.ready && !remote(i)) : 0;
        if (waiting >= 0) send(Math.max(0, waiting), "confirm");
      }
      if (key === "Escape" || key === "Backspace") {
        handled = true;
        const last = selection ? selection.state.seats.map((s, i) => s.ready && !remote(i)).lastIndexOf(true) : 0;
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
        const mode = pick.point(x, y);
        if (mode) begin(mode);
        redraw();
      } else if (screen() === "fighters") {
        const sticker = stickerAt(selection, x, y);
        if (sticker >= 0) { cpuChange(() => selection.toggleCpuFrom(sticker)); redraw(); return; }   // a sticker turns that seat (and the later ones) over to the CPU
        const seat = seatAt(selection, x), s = selection.state.seats[seat], { columns } = selection.state;
        if (remote(seat)) return;
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
      } else if (screen() === "teams") {
        const seat = selection.state.seats.findIndex((_, i) => x >= teamThumbX(i) && x < teamThumbX(i) + 64);
        if (y >= 339 && y <= 403 && selection.pickTeammate(seat)) redraw();
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
        if (!pad || seat >= Math.max(1, seatCount()) || (screen() === "fighters" && remote(seat))) return;
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
    // A guest's controller states arrive as (slot, pad); a new press of a direction or a button is that seat's action.
    // Only the fighter screen answers: the host chooses the match type, the CPU seats and the venue.
    const heldRemote = new Map();
    const unsubscribe = session?.onPad((slot, pad) => {
      const now = new Set();
      if (pad) {
        for (const [bit, action] of REMOTE) if (pad.buttons & bit) now.add(action);
        if (pad.x < -0.6) now.add("left"); if (pad.x > 0.6) now.add("right"); if (pad.z > 0.6) now.add("up"); if (pad.z < -0.6) now.add("down");
      }
      const before = heldRemote.get(slot) ?? new Set();
      heldRemote.set(slot, now);
      if (!selection || screen() !== "fighters" || slot < 1 || !remote(slot)) return;
      for (const action of now) if (!before.has(action)) send(slot, action);
    });
    addEventListener("keydown", onKey);
    canvas.addEventListener("pointerdown", onPointer);
    function cleanup() {
      removeEventListener("keydown", onKey); canvas.removeEventListener("pointerdown", onPointer);
      cancelAnimationFrame(padLoop); unsubscribe?.(); delete window.nativeMenu; canvas.remove(); onArrive(() => {});
    }
    redraw();
  });
}
