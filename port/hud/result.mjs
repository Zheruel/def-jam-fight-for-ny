// Result banner shown once the retail referee (port/battle/outcome.mjs) has called the match.
// Pure layout in the banner's own 640x128 pixel space, so the drawing code stays a thin canvas loop.
export const BANNER = Object.freeze({ width: 640, height: 128, top: 160 });
// Frames after the finish before a rematch prompt is offered (matches retail's two second hold at 60 Hz).
export const REMATCH_DELAY = 120;

export function resultLines(outcome, names) {
  if (!outcome?.over) return null;
  const lines = [{ text: outcome.method === "ko" ? "K.O." : "TIME", x: 320, y: 4, size: 64, family: "names", align: "center" }];
  if (outcome.result) {
    const { minutes, seconds } = outcome.clock;
    lines.push({ text: outcome.draw ? "DRAW" : `${String(names[outcome.winner] ?? "").toUpperCase()} WINS`, x: 320, y: 72, size: 22, family: "names", align: "center" });
    lines.push({ text: [minutes, seconds].map(n => String(n).padStart(2, "0")).join(":"), x: 320, y: 100, size: 16, family: "numbers", align: "center" });
    if (outcome.ticksSinceOver >= REMATCH_DELAY)
      lines.push({ text: "ENTER  REMATCH", x: 630, y: 106, size: 12, family: "names", align: "right" });
  }
  return lines;
}
