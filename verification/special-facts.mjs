// Distils the retail special-format captures (verification/capture-special.mjs) into port/battle/special-retail.json, the
// small fixture the native tests compare against: what the retail game had at the first active frame of each format.
//   node verification/special-facts.mjs [captureDir]     (default private/verification/special)
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const dir = path.resolve(process.argv[2] ?? "private/verification/special");
const out = new URL("../port/battle/special-retail.json", import.meta.url);
const modes = { single: "standard 1v1 at 125th Street Station", demolition: "", inferno: "", subway: "", window: "", cage: "", ringout: "" };
const A = [0x4bc170, 0x4bd468], G = 0x4bbf90;
const facts = {}, stageObjectDigest = {};
for (const mode of Object.keys(modes)) {
  const start = new DataView(readFileSync(path.join(dir, mode, "fight-start.bin")).buffer.slice(0));
  const later = new DataView(readFileSync(path.join(dir, mode, "fight-later.bin")).buffer.slice(0));
  const w = (d, a) => d.getUint32(a, true), f = (d, a) => d.getFloat32(a, true);
  const backend = w(start, 0x3fdaa0 + 0x18 * 4);
  // Digest of the stage-object records (0x48 bytes each) with the definition pointer at +0x44 cleared: natively that pointer
  // sits in the relocated arena image, everything else is equal.
  const hash = createHash("sha256"), objects = w(start, 0x4c1ae0);
  for (let i = 0; i < w(start, 0x4c1adc); i++) {
    const record = Buffer.from(start.buffer.slice(objects + i * 0x48, objects + i * 0x48 + 0x48));
    record.fill(0, 0x44, 0x48);
    hash.update(record);
  }
  stageObjectDigest[mode] = hash.digest("hex");
  facts[mode] = {
    matchType: w(start, backend + 0xb8),
    venue: w(start, 0x4bbd34),
    rules: w(start, 0x4bbd2c),
    seats: [0, 1, 2, 3].map(i => w(start, 0x4bbd38 + 4 * i)),
    phase: w(start, G + 8),
    stageObjects: { definitions: w(start, 0x4c1ad4), objects: w(start, 0x4c1adc) },
    player1: [0x44, 0x48, 0x4c].map(o => +f(start, A[0] + o).toFixed(1)),
    // The venue clock the Red Hook fire runs on (0x4c1930, +1.2 a frame) at the two capture moments.
    fireClock: [f(start, 0x4c1930), f(later, 0x4c1930)].map(v => +v.toFixed(2)),
  };
}
writeFileSync(out, JSON.stringify({ source: "verification/capture-special.mjs, merged Battle + unlock overlay, Method Man (Blaze) v Fat Joe (Crack), CPU seat 2", facts, stageObjectDigest }) + "\n");
console.log("wrote", out.pathname);
