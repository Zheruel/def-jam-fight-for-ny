// The retail "REMATCH?" card (SCREENS.VIV screens/battle/rematch.big, exported by port/hud/screens/extract.py):
// YES / NO, moved with left/right (or A/D) and confirmed with Enter, once the referee's result hold is over.
import { drawScreen } from "./screen.mjs";

export const CARD = Object.freeze({ width: 640, height: 160, top: 284, scale: 0.8, source: { x: 184, y: 233, width: 281, height: 193 } });

const CREAM = 0xfffcf0d6, BLACK = 0xff000000;

// Draws the card into `ctx` (CARD.width x CARD.height pixels). `selected` is 0 for YES, 1 for NO.
export function drawRematch(ctx, screen, selected) {
  const { scale, source } = CARD;
  ctx.clearRect(0, 0, CARD.width, CARD.height);
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, CARD.width / 2 - scale * (source.x + source.width / 2), 3 - scale * source.y);
  // The exported frame shows NO selected: its red highlight sits behind NO, whose text is cream; YES is black on the card.
  // Selecting YES slides the highlight over to YES's slot and swaps the two text colours.
  const shift = 333.5 - 211.5;
  drawScreen(ctx, screen, {
    family: "Battlenames",
    adjust: element => {
      if (selected === 0 && element.path === "/rematchHighlight/5/4") return { dx: -shift };
      if (element.path === "/rematchYes") return { color: selected === 0 ? CREAM : BLACK };
      if (element.path === "/rematchNo") return { color: selected === 1 ? CREAM : BLACK };
    },
  });
  ctx.restore();
}

export function rematchChoice(offered, restart, leave) {
  let selected = 0;
  return {
    get selected() { return selected; },
    get shown() { return offered(); },
    reset() { selected = 0; },
    key(event) {
      if (!offered()) return false;
      if (["ArrowLeft", "ArrowRight", "a", "d", "A", "D"].includes(event.key)) {
        selected = 1 - selected;
        return true;
      }
      if (event.key !== "Enter") return false;
      if (selected === 0) restart();
      else leave();
      return true;
    },
  };
}
