// Every file the match-loading poster can request, for the static-host allowlist (tools/port-files.mjs).
import art from "./art/loading/layout.json" with { type: "json" };

const folder = "port/menu/art/loading/";
const names = ["layout.json", "front.webp", "vignette.webp",
  ...new Set(Object.values(art.formations).map(f => `paper-${f.paper}.webp`)),
  ...Object.keys(art.titles).map(mode => `title-${mode}.webp`),
  ...Object.keys(art.venues).map(number => `venue-${number}.webp`),
  ...Object.entries(art.logos).flatMap(([id, counts]) => Object.keys(counts).map(count => `logo-${id}-${count}p.webp`)),
  ...Object.entries(art.portraits).flatMap(([id, counts]) => Object.keys(counts).map(count => `portrait-${id}-${count}p.webp`)),
];
export const loadingFiles = ["port/menu/loading.mjs", ...names.map(name => folder + name)];
