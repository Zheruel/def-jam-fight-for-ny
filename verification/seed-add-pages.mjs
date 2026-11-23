// Append RAM pages from the reference capture to the Native Battle start data (idempotent).
//   node verification/seed-add-pages.mjs CAPTURE/fighter-ram-0.bin 0x1e86000 0x1e87000 [--out file.gz]
// The seed only holds pages the 460 tick combat trace touched. Retail UI widgets that the long fights reach later (the
// danger/combo HUD objects 0x1e86000 and 0x1e87000, coloured by 0x1b4c88 -> 0x15c970 -> 0x118d28) live on others; unseeded
// they read as zero, the sprite pointer is null and 0x11ef48 writes through address 0x80004474.
import {readFileSync,writeFileSync} from "node:fs";
import {gunzipSync,gzipSync} from "node:zlib";
const [ram,...rest]=process.argv.slice(2);
const out=rest.includes("--out")?rest[rest.indexOf("--out")+1]:new URL("../port/kernel/foundation-start.gz",import.meta.url).pathname;
const addresses=rest.filter(a=>/^0x/i.test(a)).map(Number);
const capture=readFileSync(ram), seed=gunzipSync(readFileSync(new URL("../port/kernel/foundation-start.gz",import.meta.url)));
const have=new Set();for(let at=0;at<seed.length;at+=4100)have.add(seed.readUInt32LE(at));
const added=[], blocks=[seed];
for(const address of addresses) {
  const page=address>>>12;
  if(have.has(page)) continue;
  const block=Buffer.alloc(4100);block.writeUInt32LE(page,0);capture.copy(block,4,page*4096,page*4096+4096);
  blocks.push(block);have.add(page);added.push("0x"+(page*4096).toString(16));
}
writeFileSync(out,gzipSync(Buffer.concat(blocks),{level:9}));
console.log(added.length?`Added ${added.join(", ")} to ${out}`:"All pages already present.");
