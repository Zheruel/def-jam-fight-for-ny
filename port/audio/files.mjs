// Runtime audio files for publication lists (Node side). Beds are the only files a match needs at
// start; cue banks, mix levels and animation tags load on first use.
import { readFileSync } from "node:fs";

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const venues = read("venues.json");
const cues = read("cues.json");

export const audioCore = ["venue.mjs", "match.mjs", "venues.json", "mix.json"].map(name => "port/audio/" + name);
export const audioBeds = [...new Set(venues.venues.map(venue => venue.bed))].map(file => "port/audio/" + file);
export const audioCues = ["cues.json", "combat.json", "animtags.json.gz",
  ...Object.values(cues.banks).filter(bank => bank.file).map(bank => bank.file)].map(name => name.startsWith("port/") ? name : "port/audio/" + name);
export const audioFiles = [...audioCore, ...audioBeds, ...audioCues];
