import layout from "./art/match-type/layout.json" with { type: "json" };

const rows = [
  ["1v1", "team", "ffa"],
  ["window", "subway", "demolition", "inferno"],
  ["cage", "ringout"],
];

export function matchTypeSelection(types) {
  const available = new Set(types);
  const sizes = ["ffa3", "ffa"].filter(mode => available.has(mode));
  const state = {
    mode: rows.flat().find(mode => available.has(mode) || (mode === "ffa" && sizes.length)),
    size: null,
    enabled: mode => mode === "ffa" ? sizes.length > 0 : available.has(mode),
  };

  function press(action) {
    if (state.size) {
      if (action === "back") state.size = null;
      else if (action === "left" || action === "right") state.size = state.size === "ffa" ? "ffa3" : "ffa";
      else if (action === "confirm") {
        const mode = state.size;
        state.size = null;
        return mode;
      }
    } else if (action === "confirm") {
      if (!state.enabled(state.mode)) return;
      if (state.mode !== "ffa") return state.mode;
      if (sizes.length === 1) return sizes[0];
      state.size = "ffa";
    } else {
      const row = rows.findIndex(modes => modes.includes(state.mode));
      const modes = rows[row], column = modes.indexOf(state.mode);
      if (action === "left" || action === "right") {
        state.mode = modes[(column + (action === "right" ? 1 : -1) + modes.length) % modes.length];
      } else if (action === "up" || action === "down") {
        state.mode = rows[(row + (action === "down" ? 1 : -1) + rows.length) % rows.length][0];
      }
    }
  }

  function point(x, y) {
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
