import weapons from "../port/scenery/weapons/index.json" with {type:"json"};
import scenery from "../port/scenery/index.json" with { type: "json" };
import { audioFiles } from "../port/audio/files.mjs";
import damage from "../port/render/damage/tiles.json" with {type:"json"};
import inventory from "../ps2/content/inventory.json" with { type: "json" };

// Runtime files shared by the local native port and the Pages deployment.
export const portFiles = [
  "port/scenery/scenery.mjs", "port/scenery/irradiance.mjs", "port/scenery/environment.mjs", "port/scenery/events.json", "port/scenery/index.json",
  "port/scenery/weapons/index.json",
  ...Object.values(weapons.models).map(({file}) => "port/scenery/weapons/" + file),
  "port/scenery/foundation/crowd.bin.gz", "port/scenery/crowd/icrowd01.crowd.gz",
  ...Object.values(scenery).flatMap(({dir,props}) => {
    const folder = "port/scenery/" + dir + "/";
    const files = [folder + "scenery.json", folder + "lighting.json"];
    if (props.length) files.push(folder + "props.scene.gz");
    return files;
  }),
  "port/render/shadow.mjs","port/render/damage.mjs","port/render/damage/tiles.json",
  ...new Set(Object.values(damage).flatMap(levels=>Object.values(levels).map(tile=>"port/render/damage/"+tile.file))),
  ...inventory.fighters.map(({ model }) => `port/render/fighters/${model}.skin.gz`),
  ...inventory.venues.map(({ file }) => `port/geometry/venues/${file}.scene.gz`),
  "port/viewer/scene.mjs", "port/viewer/index.html", "port/viewer/viewer.mjs", "port/geometry/foundation.json",
  ...inventory.venues.map(({ file }) => `port/collision/venues/${file}.cli`),
  "port/collision/contact.mjs",
  "port/motion/pose-bank.mjs", "port/motion/poses/V2IP_113A.poses.gz", "port/motion/poses/V2IP_109A.poses.gz",
  "port/motion/clock.mjs", "port/motion/settings.mjs", "port/motion/motion-settings.bin", "port/motion/library.mjs", "port/motion/library.json",
  ...audioFiles, "port/battle/entry.mjs",
  ...new Set(inventory.fighters.map(f=>`port/animation/banks/wres${String(f.fighterXml.coreID).padStart(3,"0")}.gz`)),
  ...Array.from({length:164},(_,i)=>`port/animation/banks/special${709+i}.gz`),
  "port/animation/match.mjs","port/animation/runtime.mjs","port/animation/banks.mjs",
  "port/animation/shared.gz","port/animation/sampler.wasm.gz","port/fighters/pose.mjs",
  "port/battle/roster.mjs", "port/kernel/match-rules.gz",
  "port/battle/arena.mjs", "port/battle/camera.mjs", "port/battle/cameras.json", "port/hud/hud.mjs", "port/hud/result.mjs", "port/hud/layout.json", "port/hud/healthBar.png",
  "port/hud/blazin.png","port/hud/mainBarContainer_1.png", "port/hud/momentumBar.png", "port/hud/names.ttf", "port/hud/numbers.ttf",
  "port/battle/index.html", "port/battle/controls.mjs", "port/battle/outcome.mjs", "port/battle/fight.mjs",
  "port/kernel/runtime.mjs", "port/kernel/battle.wasm.gz", "port/kernel/foundation-start.gz",
  "port/battle/setup.mjs", "port/battle/modes.mjs", "port/battle/lineups.json", "ps2/content/inventory.json",
  "port/assets/combat.mjs", "port/assets/combat-data.mjs", "port/combat/combat.mjs",
];
