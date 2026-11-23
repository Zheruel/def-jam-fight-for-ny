// Selection state of the retail "Choose Fighter" -> "Choose Venue" flow. Pure: input arrives as actions, drawing and
// the DOM live elsewhere, so the whole flow can be driven headlessly.
//
//   seats[i] = { cursor, ready }       one fighter cursor per player (index into `roster`)
//   screen   = "fighters" | "venue" | "done"
//   result() = { mode, handles, venue } in the shape of the battle page's query (?mode=&p1=..&venue=)

export const ROWS = 3;   // the thumbnail box shows 3 rows of faces: 5 columns on the two-player screen, 3 on the four-player one
export const COLUMNS = 5;   // two-player default

export const ACTIONS = ["left", "right", "up", "down", "confirm", "back", "next", "previous", "cpu"];

export function createSelection({ roster, venues, seats = 2, cpuSeats = 0, mode = seats > 3 ? "ffa" : seats > 2 ? "ffa3" : "1v1", picks = [], venue = null, venueOk = () => true }) {
  // Venues that share a pin on the retail map (a venue and its "intense" remix) are one spot; next/previous cycle them.
  const spots = [];
  for (const v of venues.filter(v => v.pin && venueOk(v))) {
    const spot = spots.find(s => s.pin[0] === v.pin[0] && s.pin[1] === v.pin[1]);
    if (spot) spot.variants.push(v); else spots.push({ pin: v.pin, variants: [v] });
  }
  const found = spots.findIndex(s => s.variants.some(v => v.file === venue));
  const columns = seats > 3 ? 3 : seats > 2 ? 4 : COLUMNS;   // faces per row of the paper box: 5, 4 or 3 on the two, three and four card screens
  const state = {
    teamOrder: [], teamCursor: 0,
    columns, mode, cpu: Math.max(0, Math.min(seats - 1, cpuSeats)), screen: "fighters", roster, spots, variant: Math.max(0, found < 0 ? 0 : spots[found].variants.findIndex(v => v.file === venue)),
    seats: Array.from({ length: seats }, (_, i) => ({ cursor: Math.max(0, roster.findIndex(f => f.handle === picks[i])), ready: false })),
    venue: Math.max(0, found),
  };
  // With more than two fighters every fighter is distinct (the kernel profiles a fighter by its id), so a repeated pick moves on.
  const taken = (seat, index) => seats > 2 && state.seats.some((s, i) => i !== seat && roster[s.cursor].name === roster[index].name);
  state.seats.forEach((s, i) => { while (taken(i, s.cursor)) s.cursor = (s.cursor + 1) % roster.length; });

  const columnOf = i => i % columns, rowOf = i => Math.floor(i / columns);
  function moveFighter(seat, dx, dy) {
    const s = state.seats[seat], last = roster.length - 1;
    let next = s.cursor;
    if (dx) next = (s.cursor + dx + roster.length) % roster.length;   // left/right walk the list and wrap
    if (dy) next = Math.min(last, Math.max(0, s.cursor + dy * columns));
    while (dx && taken(seat, next)) next = (next + dx + roster.length) % roster.length;
    if (!taken(seat, next)) s.cursor = next;
  }

  // The venue cursor jumps to the nearest pin in the pressed direction (the retail screen's yellow arrows).
  function moveVenue(dx, dy) {
    const from = state.spots[state.venue].pin;
    let best = null;
    state.spots.forEach((v, i) => {
      if (i === state.venue) return;
      const vx = v.pin[0] - from[0], vy = v.pin[1] - from[1];
      const along = dx * vx + dy * vy;
      if (along <= 0) return;
      const across = Math.abs(dx * vy - dy * vx);
      const cost = across * 1.6 + along;   // prefer pins straight ahead
      if (!best || cost < best.cost) best = { cost, i };
    });
    if (best) { state.venue = best.i; state.variant = 0; }
  }

  const api = {
    state,
    // The retail CPU plays the last `count` seats (?cpu=N, port/battle/cpu.mjs): at least one person always stays.
    setCpu(count) { state.cpu = ((count % seats) + seats) % seats; return true; },
    // Clicking seat i's sticker makes seat i and every later seat CPU, or hands seat i back to a person if it already was the first CPU.
    toggleCpuFrom(seat) { if (seat < 1) return false; state.cpu = state.cpu === seats - seat ? seats - seat - 1 : seats - seat; return true; },
    // Seat actions on the fighter screen; any seat on the venue screen (the host chooses the venue).
    press(seat, action) {
      if (action === "cpu" && state.screen === "fighters") return api.setCpu(state.cpu + 1);
      if (state.screen === "fighters") {
        const s = state.seats[seat];
        if (!s) return false;
        if (action === "confirm") { s.ready = true; if (state.seats.every(x => x.ready)) state.screen = mode === "team" ? "teams" : "venue"; return true; }
        if (action === "back") { if (s.ready) { s.ready = false; return true; } return false; }
        if (s.ready) return false;
        if (action === "left") moveFighter(seat, -1, 0);
        else if (action === "right") moveFighter(seat, 1, 0);
        else if (action === "up") moveFighter(seat, 0, -1);
        else if (action === "down") moveFighter(seat, 0, 1);
        else return false;
        return true;
      }
      if (state.screen === "teams") {
        const order = state.teamOrder;
        if (action === "back") {
          if (order.length) state.teamCursor = order.pop();
          else { state.screen = "fighters"; state.seats[0].ready = false; }
          return true;
        }
        if (action === "confirm") {
          order.push(state.teamCursor);
          if (order.length === seats) state.screen = "venue";
          else state.teamCursor = state.seats.findIndex((_, i) => !order.includes(i));
          return true;
        }
        if (action !== "left" && action !== "right") return false;
        const direction = action === "left" ? -1 : 1;
        do { state.teamCursor = (state.teamCursor + direction + seats) % seats; }
        while (order.includes(state.teamCursor));
        return true;
      }
      if (state.screen === "venue") {
        if (action === "back" && mode === "team") {
          state.screen = "teams"; state.teamCursor = state.teamOrder.pop();
          return true;
        }
        if (action === "confirm") { state.screen = "done"; return true; }
        if (action === "back") { state.screen = "fighters"; state.seats.at(seat >= 0 ? Math.min(seat, state.seats.length - 1) : 0).ready = false; return true; }
        if (action === "next" || action === "previous") {
          const count = state.spots[state.venue].variants.length;
          state.variant = (state.variant + (action === "next" ? 1 : count - 1)) % count;
          return count > 1;
        }
        const step = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[action];
        if (!step) return false;
        moveVenue(...step);
        return true;
      }
      return false;
    },
    // A pointer picked a face or a pin directly.
    pickFighter(seat, index) { const s = state.seats[seat]; if (s && !s.ready && !taken(seat, index)) { s.cursor = index; return true; } return false; },
    pickTeammate(index) {
      if (state.screen !== "teams" || !state.seats[index] || state.teamOrder.includes(index)) return false;
      state.teamCursor = index;
      return api.press(0, "confirm");
    },
    pickVenue(index) { if (state.spots[index]) { state.venue = index; state.variant = 0; return true; } return false; },
    result() {
      return {
        ...(mode === "team" && {teamOrder: state.teamOrder.slice()}),
        mode: state.mode, cpu: state.cpu, handles: state.seats.map(s => roster[s.cursor].handle), venue: state.spots[state.venue].variants[state.variant].file,
      };
    },
    // Scroll offset (first visible row) that keeps a seat's cursor on screen.
    scroll(seat) {
      const row = rowOf(state.seats[seat].cursor), rows = Math.ceil(roster.length / columns);
      return Math.max(0, Math.min(rows - ROWS, row - 1));
    },
    columnOf, rowOf,
  };
  return api;
}

// Query string of a finished selection, matching port/battle/modes.mjs.
export function selectionQuery({ mode, handles, venue, cpu = 0, teamOrder }) {
  const params = new URLSearchParams();
  if (mode !== "1v1") params.set("mode", mode);
  handles.forEach((handle, i) => params.set("p" + (i + 1), handle));
  params.set("venue", venue);
  if (teamOrder?.length === 4 && teamOrder.some((seat, i) => seat !== i)) params.set("teams", teamOrder.map(i => i + 1).join(""));
  if (cpu > 0) params.set("cpu", String(cpu));
  return params;
}
