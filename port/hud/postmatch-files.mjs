// Every file the versus score sheet can request, for the static-host allowlist (tools/port-files.mjs).
import fighters from "./postmatch/fighters.json" with { type: "json" };
import one from "./postmatch/sheet-1.json" with { type: "json" };
import two from "./postmatch/sheet-2.json" with { type: "json" };
import three from "./postmatch/sheet-3.json" with { type: "json" };
import four from "./postmatch/sheet-4.json" with { type: "json" };

const sheets = [one, two, three, four];

const folder = "port/hud/postmatch/";
const names = ["fighters.json", "stats.json", "heading.png", "continue.png", "TradeCon.ttf", "Schwartz_Hand_Bold2.ttf",
  ...sheets.flatMap(sheet => [`sheet-${sheet.panels}.json`, ...sheet.elements.filter(e => e.kind === "image").map(e => e.file)]),
  ...Object.entries(fighters.fighters).flatMap(([id, have]) => Object.keys(have).filter(key => !key.startsWith("name-cf")).map(key => `${key.replace(/-(\d)$/, "-" + id + "-$1p")}.webp`)),
];
export const postmatchFiles = ["port/hud/postmatch.mjs", ...new Set(names.map(name => folder + name))];
