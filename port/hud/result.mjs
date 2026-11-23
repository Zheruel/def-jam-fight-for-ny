// Result banner shown once the retail referee (port/battle/outcome.mjs) has called the match.
// Pure layout in the banner's own 640x144 pixel space, so the drawing code stays a thin canvas loop.
export const BANNER = Object.freeze({ width: 640, height: 144, top: 158 });
// Frames after the finish before a rematch prompt is offered (matches retail's two second hold at 60 Hz).
export const REMATCH_DELAY = 120;

// "BLAZE WINS", or for a winning team "BLAZE & DOC WIN" (both teammates, in slot order).
export function winnerText(outcome, names) {
  const team = outcome.winners?.length > 1 ? outcome.winners : [outcome.winner];
  const text = team.map(slot => String(names[slot] ?? "").toUpperCase()).join(" & ");
  return text + (team.length > 1 ? " WIN" : " WINS");
}

export function resultLines(outcome, names) {
  if (!outcome?.over) return null;
  const title = outcome.method === "time" ? "TIME OVER"
    : outcome.finishFlags & 0x7800 ? "RING OUT"
    : outcome.finishFlags & 0x400 ? "TOTALED"
    : outcome.method === "submission" ? "SUBMIT" : outcome.draw ? "DOUBLE KO" : "KO";
  const lines = [{ text: title, x: 320, y: 4, size: 64, family: "names", align: "center" }];
  if (outcome.result && outcome.ticksSinceOver >= REMATCH_DELAY) {
    const { minutes, seconds } = outcome.clock;
    lines.push({ text: outcome.draw ? "DRAW" : winnerText(outcome, names), x: 320, y: 94, size: 22, family: "names", align: "center" });
    lines.push({ text: [minutes, seconds].map(n => String(n).padStart(2, "0")).join(":"), x: 320, y: 117, size: 16, family: "numbers", align: "center" });
    lines.push({ text: "ENTER  REMATCH", x: 630, y: 106, size: 12, family: "names", align: "right" });
  }
  return lines;
}

// The PS2 end-of-fight words are individual regions in hud.ssh's Overlays texture.
// Each pair of UV markers bounds a word. Its position marker is in the 640×448 playfield.
const words = {
  "TIME OVER": ["time", "over"], SUBMIT: ["submit"], "DOUBLE KO": ["double", "dko"],
  "RING OUT": ["ring", "out"], TOTALED: ["totalled"], KO: ["ko"], FIGHT: ["fight"],
};
export function drawResultTitle(context, atlas, markers, title) {
  for (const word of words[title]) {
    const [left, top] = markers["uv_over_" + word + "1"];
    const [right, bottom] = markers["uv_over_" + word + "2"];
    const [x, y] = markers["pos_over_" + word];
    context.drawImage(atlas, left, top, right-left, bottom-top, x, y-BANNER.top, right-left, bottom-top);
  }
}
