// Compares the stage tables of a retail special capture (private/verification/special/<mode>/fight-later.bin, see capture-special.mjs)
// with the native start of the same venue after 60 ticks: the health table (0x3994e0, stride 0x38), the stage definitions
// (0x4c1ad0, stride 0x30) and the stage objects (0x4c1ae0, stride 0x48, definition pointer skipped).
//   node verification/special-stage-compare.mjs [mode]      (default ringout)
import { readFileSync } from "node:fs";
import { SPECIAL } from "../port/battle/special.mjs";
import { nativeMatch } from "./special-traces.mjs";

const mode = process.argv[2] ?? "ringout";
const retail = new DataView(readFileSync(new URL(`../private/verification/special/${mode}/fight-later.bin`, import.meta.url)).buffer.slice(0));
const fight = await nativeMatch(SPECIAL[mode].venue), m = fight.memory;
for (let t = 0; t < 60; t++) fight.tick([{ buttons: 0, x: 0, z: 0 }, { buttons: 0, x: 0, z: 0 }]);
const r = a => retail.getUint32(a, true), n = a => m.getUint32(a, true);
const diffs = { health: 0, definitions: 0, objects: 0 };
for (let a = 0x3994e0; a < 0x3994e0 + 0xd0 * 0x38; a += 4) if (r(a) !== n(a)) diffs.health++;
for (let i = 0; i < n(0x4c1ad4); i++) for (let k = 0; k < 0x30; k += 4) if (r(r(0x4c1ad0) + i * 0x30 + k) !== n(n(0x4c1ad0) + i * 0x30 + k)) diffs.definitions++;
for (let i = 0; i < n(0x4c1adc); i++) for (let k = 0; k < 0x48; k += 4) if (k !== 0x44 && r(r(0x4c1ae0) + i * 0x48 + k) !== n(n(0x4c1ae0) + i * 0x48 + k)) diffs.objects++;
console.log(mode, "objects", n(0x4c1adc), "definitions", n(0x4c1ad4), "word differences", JSON.stringify(diffs));
