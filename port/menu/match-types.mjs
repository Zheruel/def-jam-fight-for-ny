import layout from "./art/match-type/layout.json" with { type: "json" };

const rows = [
  ["1v1", "team", "ffa"],
  ["window", "subway", "demolition", "inferno"],
  ["cage", "ringout"],
];

// The PS2 poster wall has four columns. Cage and Ring Out sit under Subway and Demolition.
const below = { "1v1": "window", team: "subway", ffa: "demolition", subway: "cage", demolition: "ringout" };
const above = Object.fromEntries(Object.entries(below).map(([top, bottom]) => [bottom, top]));
const rules = ["standard", "votes", "no-submissions"];

export function matchTypeSelection(types) {
  const available = new Set(types);
  const sizes = ["ffa3", "ffa"].filter(mode => available.has(mode));
  const state = {
    mode: rows.flat().find(mode => available.has(mode) || (mode === "ffa" && sizes.length)),
    size: null,
    choosingRules: false,
    rule: "standard",
    enabled: mode => mode === "ffa" ? sizes.length > 0 : available.has(mode),
  };

  function chooseMode() {
    if (state.mode !== "ffa") return state.mode;
    if (sizes.length === 1) return sizes[0];
    state.size = "ffa";
  }

  function press(action) {
    if (state.size) {
      if (action === "back") { state.size = null; state.choosingRules = true; }
      else if (action === "left" || action === "right") state.size = state.size === "ffa" ? "ffa3" : "ffa";
      else if (action === "confirm") {
        const mode = state.size;
        state.size = null;
        return mode;
      }
    } else if (state.choosingRules) {
      if (action === "back") state.choosingRules = false;
      if (action === "left" || action === "right") {
        const direction = action === "right" ? 1 : -1;
        state.rule = rules[(rules.indexOf(state.rule) + direction + rules.length) % rules.length];
      }
      if (action === "confirm") {
        state.choosingRules = false;
        return chooseMode();
      }
    } else if (action === "confirm") {
      if (!state.enabled(state.mode)) return;
      state.rule = "standard";
      if (rows[0].includes(state.mode)) state.choosingRules = true;
      else return chooseMode();
    } else {
      const row = rows.findIndex(modes => modes.includes(state.mode));
      const modes = rows[row], column = modes.indexOf(state.mode);
      if (action === "left" || action === "right") {
        state.mode = modes[(column + (action === "right" ? 1 : -1) + modes.length) % modes.length];
      } else if (action === "up" || action === "down") {
        state.mode = (action === "down" ? below : above)[state.mode] ?? state.mode;
      }
    }
  }

  function point(x, y) {
    if (state.choosingRules) {
      if (y >= 378 && y < 414 && x >= 247 && x < 325) return press("confirm");
      if (y < 210 || y > 284) return;
      for (const [index, center] of [137, 218, 293].entries()) {
        if (Math.abs(x - center) > 34) continue;
        if (state.rule === rules[index]) return press("confirm");
        state.rule = rules[index];
        return;
      }
      return;
    }
    if (state.size) {
      if (x < 84 || x >= 328 || y < 201 || y >= 295) return;
      const size = x < 206 ? "ffa3" : "ffa";
      if (state.size === size) return press("confirm");
      state.size = size;
    } else {
      for (const [mode, [left, top, width, height]] of Object.entries(layout.cards)) {
        if (x < left || x >= left+width || y < top || y >= top+height) continue;
        if (state.mode === mode) return press("confirm");
        state.mode = mode;
        return;
      }
    }
  }
  return { state, press, point };
}
