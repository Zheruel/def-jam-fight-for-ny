// Every file the menu can request, for the static-host allowlist (tools/port-files.mjs).
import roster from "./art/roster.json" with { type: "json" };
import venues from "./art/venues.json" with { type: "json" };

export const menuFiles = [
  "port/menu/state.mjs", "port/menu/art.mjs", "port/menu/screens.mjs", "port/menu/menu.mjs", "port/menu/launch.mjs", "port/menu/art/roster.json",
  "port/menu/art/venues.json", "port/menu/art/thumbs.png",
  ...["select-bg-0", "select-bg-1", "select4-bg-0", "select4-bg-1", "ready4", "select3-bg-0", "select3-bg-1", "ready3", "thumb-paper3", "type-team", "type-1v1", "type-ffa", "type-bracket", "thumb-paper4", "ready", "thumb-paper", "stat-labels", "arrow", "sticker-1", "sticker-2", "sticker-3", "sticker-4",
    "style-kickboxing", "style-martialArts", "style-streetfighting", "style-submissions", "style-wrestling",
    "polaroid-a", "polaroid-b", "polaroid-c", "tape", "paper-0", "paper-1", "paper-2", "paper-3", "red-0", "red-1", "red-2", "red-3", "pin-red", "pin-blue", "pin-grey", "label-strip",
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `map-${n}`)].map(name => `port/menu/art/${name}.png`),
  ...[1, 2, 17, 18, 22, 25, 30, 31, 33].map(tag => `port/menu/art/team-${tag}.png`),
  ...roster.flatMap(f => ["n", "h", "c"].map(part => `port/menu/art/fighters/${f.id}-${part}.png`)),
  ...venues.map(v => `port/menu/art/venues/${v.file}.png`),
  ...venues.filter(v => v.pin).map(v => `port/menu/art/notes/${v.feID}.png`),
];
