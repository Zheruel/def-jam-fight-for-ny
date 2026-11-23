// Export live local poses from EE RAM snapshots as small native examples (def-jam-fny-fighter-pose/1).
//   node port/fighters/export-poses.mjs <ram.bin> <name> <slot> <model> [--clip A112 --frame 16 --action 10011 ...]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { characterAddress, readLocalPose } from "./pose.mjs";

const [ram, name, slot, model, ...rest] = process.argv.slice(2);
if (!ram || !name || slot === undefined || !model) {
  console.error("usage: export-poses.mjs <ram.bin> <name> <slot> <model> [--key value ...]");
  process.exit(2);
}
const meta = {};
for (let i = 0; i < rest.length; i += 2) meta[rest[i].replace(/^--/, "")] = Number.isNaN(Number(rest[i + 1])) ? rest[i + 1] : Number(rest[i + 1]);
const bytes = readFileSync(ram);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const character = characterAddress(view, Number(slot));
const pointerOffset = meta.pointer ? Number(meta.pointer) : 0x17c;
const entries = readLocalPose(view, character, 94, pointerOffset);
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "poses"), { recursive: true });
const document = {
  format: "def-jam-fny-fighter-pose/1", name, model, bones: 94,
  layout: "per bone: scale xyz1, quaternion xyzw, translation xyz1 (local to parent, actor-relative root)",
  source: { characterAddress: character, poseArray: view.getUint32(character + pointerOffset, true), pointerOffset, snapshot: ram.split("/").slice(-2).join("/") },
  ...meta,
  entries: Array.from(entries, (v) => Math.round(v * 1e6) / 1e6),
};
writeFileSync(join(here, "poses", `${name}.json`), JSON.stringify(document) + "\n");
console.log(`${name}: character 0x${character.toString(16)}`);
