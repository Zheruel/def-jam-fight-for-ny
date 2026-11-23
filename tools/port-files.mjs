import damage from "../port/render/damage/tiles.json" with {type:"json"};
import inventory from "../ps2/content/inventory.json" with { type: "json" };

// Runtime files shared by the local native port and the Pages deployment.
export const portFiles = [
  "port/scenery/scenery.mjs","port/scenery/foundation/scenery.json","port/scenery/foundation/props.scene.gz","port/scenery/foundation/crowd.bin.gz",
  "port/render/damage.mjs","port/render/damage/tiles.json",
  ...new Set(Object.values(damage).flatMap(levels=>Object.values(levels).map(tile=>"port/render/damage/"+tile.file))),
  ...inventory.fighters.map(({ model }) => `port/render/fighters/${model}.skin.gz`),
  ...inventory.venues.map(({ file }) => `port/geometry/venues/${file}.scene.gz`),
  "port/viewer/scene.mjs", "port/viewer/index.html", "port/viewer/viewer.mjs", "port/geometry/foundation.json",
  ...inventory.venues.map(({ file }) => `port/collision/venues/${file}.cli`),
  "port/collision/contact.mjs",
  "port/motion/pose-bank.mjs", "port/motion/poses/V2IP_113A.poses.gz", "port/motion/poses/V2IP_109A.poses.gz",
  "port/motion/clock.mjs", "port/motion/settings.mjs", "port/motion/motion-settings.bin", "port/motion/library.mjs", "port/motion/library.json",
  "port/audio/foundation.mjs", "port/audio/foundation-loop.ogg", "port/battle/entry.mjs",
  ...new Set(inventory.fighters.map(f=>`port/animation/banks/wres${String(f.fighterXml.coreID).padStart(3,"0")}.gz`)),
  "port/animation/match.mjs","port/animation/runtime.mjs","port/animation/banks.mjs",
  "port/animation/shared.gz","port/animation/sampler.wasm.gz","port/fighters/pose.mjs",
  "port/battle/roster.mjs", "port/kernel/match-rules.gz",
  "port/battle/arena.mjs", "port/battle/camera.mjs", "port/hud/hud.mjs", "port/hud/layout.json", "port/hud/healthBar.png",
  "port/hud/mainBarContainer_1.png", "port/hud/momentumBar.png", "port/hud/names.ttf", "port/hud/numbers.ttf",
  "port/battle/index.html", "port/battle/controls.mjs", "port/battle/fight.mjs",
  "port/kernel/runtime.mjs", "port/kernel/battle.wasm.gz", "port/kernel/foundation-start.gz",
  "port/battle/setup.mjs", "port/battle/lineups.json", "ps2/content/inventory.json",
  "port/assets/combat.mjs", "port/assets/combat-data.mjs", "port/combat/combat.mjs",
];
