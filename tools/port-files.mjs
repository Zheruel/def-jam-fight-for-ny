import inventory from "../ps2/content/inventory.json" with { type: "json" };

// Runtime files shared by the local native port and the Pages deployment.
export const portFiles = [
  ...inventory.venues.map(({ file }) => `port/geometry/venues/${file}.scene.gz`),
  "port/viewer/scene.mjs", "port/viewer/index.html", "port/viewer/viewer.mjs", "port/geometry/foundation.json",
  ...inventory.venues.map(({ file }) => `port/collision/venues/${file}.cli`),
  "port/collision/contact.mjs",
  "port/motion/library.mjs", "port/motion/library.json",
  "port/battle/setup.mjs", "port/battle/lineups.json", "ps2/content/inventory.json",
  "port/assets/combat.mjs", "port/assets/combat-data.mjs", "port/combat/combat.mjs",
];
