// Rebuild the controller commands from the exported retail animation tags and motion tables.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export function buildTracks() {
  const tags = JSON.parse(gunzipSync(readFileSync(new URL("../audio/animtags.json.gz", import.meta.url))));
  const library = JSON.parse(readFileSync(new URL("../motion/library.json", import.meta.url)));
  const byName = new Map(tags.anims.map(([name, events]) => [
    name, events.filter(e => e[2] === 58).flatMap(([frame, , , level]) => [frame, level]),
  ]));
  const index = names => Object.fromEntries(names.flatMap((name, id) => byName.get(name)?.length ? [[id, byName.get(name)]] : []));
  return {common: index(library.common), global: index(library.global)};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  writeFileSync(new URL("./vibration.json", import.meta.url), JSON.stringify(buildTracks()) + "\n");
}
