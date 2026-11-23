// Build GPU pose samples from the reference harness's opt-in two-player pose capture.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { composePose } from "../port/fighters/pose.mjs";

const raw = readFileSync(process.argv[2]);
const trace = JSON.parse(raw);
const manifest = { sourceSha256: createHash("sha256").update(raw).digest("hex"), match: trace.match, models: {} };
for (const [slot,modelName] of ["V2IP_113A","V2IP_109A"].entries()) {
  const model = JSON.parse(readFileSync(new URL(`../port/fighters/models/${modelName}.json`,import.meta.url)));
  const groups = new Map();
  for (const sample of trace.samples) {
    const actor = sample.actors[slot];
    if (actor.slot !== slot || actor.modelIndex !== [4,9][slot]) throw new Error("Unexpected reference actor");
    const group = groups.get(actor.action) ?? new Map();
    const previous = group.get(actor.frame);
    if (!previous || previous.blendCounters[0] > actor.blendCounters[0]) group.set(actor.frame,actor);
    groups.set(actor.action,group);
  }
  const payload = [];
  const clips = {};
  let offset = 0;
  for (const [action,times] of groups) {
    const frames = [...times.keys()].sort((a,b) => a-b);
    const actors = frames.map(f => times.get(f));
    const count = frames.length;
    const end = actors[0].end;
    const roots = [];
    for (const actor of actors) {
      if (actor.end !== end) throw new Error("Inconsistent retail clip duration");
      const locals = Buffer.from(actor.pose,"base64");
      if (locals.length !== 94*48) throw new Error("Invalid pose size");
      const data = Uint8Array.from(locals);
      const {skin} = composePose(model,new Float32Array(data.buffer));
      if (!skin.every(Number.isFinite)) throw new Error("Non-finite skin transform");
      payload.push(Buffer.from(skin.buffer));
      if (actor.rootOffset) {
        const angle = actor.facing * Math.PI/180;
        const [x,y,z] = actor.rootOffset;
        roots.push([Math.cos(angle)*x-Math.sin(angle)*z, y, Math.sin(angle)*x+Math.cos(angle)*z, actor.rootYaw]);
      }
    }
    clips[action] = { offset, frames, end, roots, firstRate: actors[0].rate };
    offset += count * model.bones.length*64;
  }
  const header = Buffer.from(JSON.stringify({model:modelName, boneCount:model.bones.length, clips}));
  const padded = Buffer.alloc(Math.ceil(header.length/4)*4,0x20);
  header.copy(padded);
  const size = Buffer.alloc(8);
  size.write("DJP1"); size.writeUInt32LE(padded.length,4);
  const path = new URL(`../port/motion/poses/${modelName}.poses.gz`,import.meta.url);
  writeFileSync(path,gzipSync(Buffer.concat([size,padded,...payload]),{level:6}));
  manifest.models[modelName] = Object.fromEntries(Object.entries(clips).map(([id,c]) => [id,c.frames.length]));
}
writeFileSync(new URL("../port/motion/poses/source.json",import.meta.url),JSON.stringify(manifest,null,2)+"\n");
