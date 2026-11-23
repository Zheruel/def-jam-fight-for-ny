// The original pause background, controls and row rectangles come from pause.ssh and SLUS_210.04.
import layout from "./pause.json" with { type: "json" };

const rows = ["MUSIC", "SOUND EFFECTS", "ANNOUNCER", "VIBRATION", "QUIT", "ACCEPT CHANGES"];
const kinds = ["music", "effects", "announcer"];
export function pauseMenu({onChange, onClose, onQuit}) {
  return {
    open: false, row: 0, confirming: false, yes: false,
    levels: [86,86,86], vibration: true,
    hitRow(x,y) { return layout.rows.findIndex(([left,top,w,h])=>x>=left && x<=left+w && y>=top && y<=top+h); },
    show() { this.open = true; this.row = 0; this.confirming = false; },
    close() { this.open = false; this.confirming = false; onClose(); },
    press(action) {
      if (!this.open) return;
      if (this.confirming) {
        if (action === "left" || action === "right") this.yes = !this.yes;
        if (action === "back" || (action === "confirm" && !this.yes)) this.confirming = false;
        else if (action === "confirm" && this.yes) onQuit();
        return;
      }
      if (action === "back" || action === "start") { this.close(); return; }
      if (action === "up" || action === "down") {
        this.row = (this.row + (action === "up" ? -1 : 1) + rows.length) % rows.length;
      } else if (action === "left" || action === "right") {
        if (this.row < 3) {
          // Retail's input handler 0x1d8280 adds or subtracts two percentage points per step.
          const value = Math.max(0, Math.min(100, this.levels[this.row] + (action === "right" ? 2 : -2)));
          this.levels[this.row] = value;
          onChange(kinds[this.row], value);
        } else if (this.row === 3) this.vibration = !this.vibration;
      } else if (action === "confirm") {
        if (this.row === 5) this.close();
        if (this.row === 4) { this.confirming = true; this.yes = false; }
        if (this.row === 3) this.vibration = !this.vibration;
      }
    },
  };
}

export function drawPause(ctx, state, atlas) {
  ctx.clearRect(0,0,640,448);
  ctx.fillStyle = "rgba(0,0,0,.54)"; ctx.fillRect(0,0,640,448);
  function sprite(name,x,y,w,h) {
    if (!atlas) return;
    const rect = layout.sprites[name];
    ctx.drawImage(atlas,...rect,x,y,w,h);
  }
  function text(value,x,y,size,colour,align="left") {
    ctx.font = `${size}px BattleNumbers`;
    ctx.fillStyle = colour; ctx.textAlign = align; ctx.textBaseline = "middle";
    ctx.fillText(value,x,y);
  }
  const cream = "#f3e4bd", dark = "#201b15", red = "#760e09";
  if (state.confirming) {
    sprite("quitback",168,102,304,228);
    text("QUIT MATCH?",320,198,28,cream,"center");
    text("YES",252,265,21,state.yes ? red : dark,"center");
    text("NO",390,265,21,state.yes ? dark : red,"center");
    return;
  }
  sprite("menuback",94,88,448,304);
  text("GAME PAUSED",320,128,32,cream,"center");
  for (const [i,[x,y,w,h]] of layout.rows.entries()) {
    const selected = i === state.row, ink = selected ? cream : dark;
    if (selected) { ctx.fillStyle = red; ctx.fillRect(x,y,w,h); }
    text(rows[i], i < 4 ? x+9 : x+w/2, y+h/2,16,ink,i<4?"left":"center");
    if (i < 3) {
      sprite(selected ? "bars" : "baru",255,y+4,200,16);
      ctx.fillStyle = selected ? red : "#746f67";
      ctx.fillRect(260,y+8,190*state.levels[i]/100,7);
      const arrow=selected?"arrowsu":"arrowuu";
      sprite(arrow,237,y+3,16,30);
      ctx.save(); ctx.translate(476,0); ctx.scale(-1,1); sprite(arrow,0,y+3,16,30); ctx.restore();
      text(state.levels[i]+"%",482,y+h/2,16,ink);
    } else if (i === 3) {
      for (const [index, label] of ["ON","OFF"].entries()) {
        const chosen = state.vibration === (index === 0), bx = 300 + index*70;
        sprite(chosen ? "boxuh" : "boxuu", bx,y+2,51,20);
        text(label,bx+25,y+h/2,14,chosen?cream:dark,"center");
      }
    }
  }
}
