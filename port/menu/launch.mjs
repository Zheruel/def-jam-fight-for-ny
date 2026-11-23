// Shows the retail selector in the battle page and resolves once a match is chosen. The page's own header selectors and
// footer join box stay reachable: joining a room from the menu opens ?room=CODE, and the choice is written to the URL
// (?mode=&p1=&p2=&venue=) so a reload or a shared link starts the same match directly.
import { runMenu } from "./menu.mjs";
import { selectionQuery } from "./state.mjs";
import { DEFAULT_FIGHTERS, DEFAULT_VENUE, MODES, freeForAllAvailable } from "../battle/modes.mjs";
import { roomSession } from "../battle/controls.mjs";

// The match types to offer: whatever MODES advertises, in the retail order. Free For All stays behind its availability switch.
export function matchTypes(modes = MODES, ffa = freeForAllAvailable()) {
  return ["1v1", "team", "ffa3", "ffa"].filter(mode => Object.hasOwn(modes, mode) && (ffa || !mode.startsWith("ffa")));
}

export async function chooseMatch(params) {
  const $ = selector => document.querySelector(selector);
  const main = $("main"), stage = main.querySelector("canvas"), status = $("#status");
  const hidden = ["#player1", "#player2", "#venue", "#mode", "#player3", "#player4", "header span", "#restart", "#sound"]
    .map($).filter(Boolean);
  const before = hidden.map(node => node.hidden);
  hidden.forEach(node => { node.hidden = true; });
  stage.hidden = true;
  status.textContent = "Choose your fighters · WASD + I / arrows + [ · Enter confirms · Esc goes back · Host match opens a room for online players";
  // The room a host opens here lasts into the match: guests choose their own fighters and keep their seats (controls.mjs).
  const session = roomSession();
  session.bind();
  const join = $("#join"), code = $("#code");
  const joinRoom = () => { if (code.value.trim()) location.assign(`${location.pathname}?room=${encodeURIComponent(code.value.trim().toUpperCase())}`); else code.focus(); };
  join.onclick = joinRoom;
  code.onkeydown = event => { if (event.key === "Enter") joinRoom(); };
  try {
    const choice = await runMenu({ mount: main, session, types: matchTypes(), picks: DEFAULT_FIGHTERS.map((handle, i) => params.get("p" + (i + 1)) ?? handle), venue: params.get("venue") ?? DEFAULT_VENUE });
    history.replaceState(null, "", `${location.pathname}?${selectionQuery(choice)}`);
    return choice;
  } finally {
    code.onkeydown = null; session.bind();   // the footer's Join button goes back to joining in place
    hidden.forEach((node, i) => { node.hidden = before[i]; });
    stage.hidden = false;
    // the battle viewer re-hides what it does not use (#mode, #player3, #player4)
    ["#player1", "#player2", "#venue", "header span", "#restart", "#sound"].forEach(selector => { const node = $(selector); if (node) node.hidden = false; });
    status.textContent = "Loading native Battle…";
  }
}
