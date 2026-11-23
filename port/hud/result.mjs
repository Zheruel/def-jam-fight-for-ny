// Result banner shown once the retail referee (port/battle/outcome.mjs) has called the match.
// Pure layout in the banner's own 640x128 pixel space, so the drawing code stays a thin canvas loop.
export const BANNER = Object.freeze({ width: 640, height: 128, top: 160 });
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
  const title = {time: "TIME OVER", submission: "SUBMISSION"}[outcome.method] ?? "K.O.";
  const lines = [{ text: title, x: 320, y: 4, size: 64, family: "names", align: "center" }];
  if (outcome.result) {
    const { minutes, seconds } = outcome.clock;
    lines.push({ text: outcome.draw ? "DRAW" : winnerText(outcome, names), x: 320, y: 72, size: 22, family: "names", align: "center" });
    lines.push({ text: [minutes, seconds].map(n => String(n).padStart(2, "0")).join(":"), x: 320, y: 100, size: 16, family: "numbers", align: "center" });
    if (outcome.ticksSinceOver >= REMATCH_DELAY)
      lines.push({ text: "ENTER  REMATCH", x: 630, y: 106, size: 12, family: "names", align: "right" });
  }
  return lines;
}
