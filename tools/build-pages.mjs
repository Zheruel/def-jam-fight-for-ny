import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { portFiles } from "./port-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "build/pages");

const files = new Map([
  ["index.html", "web/launch.html"],
  ["reference.html", "web/index.html"],
  ["coi-serviceworker.js", "web/coi-serviceworker.js"],
  ...[
    ...portFiles,
    "web/app.mjs",
    "web/controls.mjs",
    "web/game-assets.mjs",
    "web/runtime.mjs",
    "web/start.mjs",
    "web/style.css",
    "runtime/play-build/LICENSE",
    "runtime/play-build/Play.js",
    "runtime/play-build/Play.wasm",
    "ps2/battle/battle-patch.json",
    "ps2/battle/overlay.mjs",
    "ps2/content/unlock-disc-patch.json",
    "netplay/client.mjs",
    "netplay/peerjs.mjs",
    "netplay/vendor/peerjs-1.5.5.min.js",
    "netplay/vendor/peerjs-LICENSE.txt",
    "game-assets/manifest.json"
  ].map((name) => [name, name])
]);

await rm(output, { recursive: true, force: true });
await Promise.all([...files].map(async ([target, source]) => {
  const destination = join(output, target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, source), destination);
}));
await writeFile(join(output, ".nojekyll"), "");
console.log("GitHub Pages player built in " + output);
