// Draws an exported retail front-end screen (port/hud/screens/<name>.json, see apt.py) onto a 2D canvas.
// Layout space is the movie's 640x480; `bind` supplies live text by variable or path, `labels` the localized strings.
export const LABELS = Object.freeze({
  "~MTCH_REMATCH": "REMATCH?", "~CMN_YES": "YES", "~CMN_NO": "NO", "~CMN_SELECT": "SELECT",
  "~MTCH_SCRE": "SCORE", "~MTCH_TOTAL": "TOTAL", "~MTCH_CASH": "CASH", "~MTCH_TOTEARN": "TOTAL EARNINGS",
});

export async function loadScreen(name, base = new URL("./screens/", import.meta.url)) {
  const layout = await (await fetch(new URL(`${name}.json`, base))).json();
  const pictures = await Promise.all(layout.pictures.map(async p =>
    createImageBitmap(await (await fetch(new URL(p.file, base))).blob())));
  return { layout, pictures };
}

const argb = value => `rgba(${(value >>> 16) & 255},${(value >>> 8) & 255},${value & 255},${((value >>> 24) & 255) / 255})`;

// `state`: {bind(path, variable) -> string|undefined, hidden(path) -> bool, adjust(element) -> {dx, dy, color}|undefined, labels, family}
export function drawScreen(ctx, { layout, pictures }, state = {}) {
  const labels = { ...LABELS, ...state.labels }, family = state.family ?? "BattleNames";
  for (const element of layout.elements) {
    if (state.hidden?.(element.path)) continue;
    const move = state.adjust?.(element) ?? {};
    const dx = move.dx ?? 0, dy = move.dy ?? 0;
    const [l, t, r, b] = [element.rect[0] + dx, element.rect[1] + dy, element.rect[2] + dx, element.rect[3] + dy];
    if (element.kind === "image") {
      ctx.drawImage(pictures[element.picture], l, t, r - l, b - t);
      continue;
    }
    const raw = state.bind?.(element.path, element.variable) ?? labels[element.text] ?? element.text;
    if (!raw || !raw.trim()) continue;
    ctx.save();
    ctx.font = `${element.size}px ${family}`;
    ctx.fillStyle = argb(move.color ?? element.color);
    ctx.textBaseline = "top";
    ctx.textAlign = ["left", "right", "center"][element.align] ?? "left";
    const x = element.align === 2 ? (l + r) / 2 : element.align === 1 ? r : l;
    ctx.fillText(raw, x, t);
    ctx.restore();
  }
}
