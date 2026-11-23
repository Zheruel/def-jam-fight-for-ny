# Def Jam: Fight for NY — browser versus

**[Play on GitHub Pages](https://zheruel.github.io/def-jam-fight-for-ny/)**

Choose two fighters and a venue to start a native match in desktop Chrome or Edge. WASD moves player one and the arrows move player two. Open Controls for attacks, shoulder buttons and gamepad mappings. To play online, choose Host match and share the room invite. The guest controls player two and receives the host’s video and audio.

## Local development

Requires Node.js 22 or newer. Use a single-branch checkout to fetch the player source separately from the published game content.

```sh
git clone --depth 1 --single-branch https://github.com/Zheruel/def-jam-fight-for-ny.git
cd def-jam-fight-for-ny
npm run setup
npm start
```

Open [the local player](http://127.0.0.1:8174). A fresh checkout fetches game content from GitHub as needed. If the compressed blocks are installed in `game-assets/blocks/`, the local server serves them directly. Only the host loads game assets.

## Native port

All 75 fighter records and 24 venues can be selected in a native one-on-one match. The browser runs statically translated Battle and skeletal animation routines. It loads the motion resources for the selected fighters on demand. At The Foundation, the native renderer draws the original speaker stacks, lights, pillars and 60 animated background spectators. A headless Chrome test on an M5 Pro measured 60.0 rendered frames per second at 941 × 705 during a two-hit exchange. A separate gameplay test replayed the inputs with every fighter in both slots. Match endings, special moves, venue interactions, audio and visual parity are still in development. [Native port and verification](port/README.md)

## Playable reference

The [PS2 reference player](https://zheruel.github.io/def-jam-fight-for-ny/reference.html) runs the original game code in a patched Play! WebAssembly runtime. The launcher redirects the retail front end to Battle mode and applies the unlock patch in memory. The asset manifest maps reads to individually verified, compressed blocks. GitHub Pages serves the player, runtime and manifest. A dedicated branch holds the game data. [Runtime and rebuild instructions](runtime/play-build/README.md) · [Content packaging](tools/game-assets.md)

The unlocked retail Battle lists contain **69 distinct fighter names across 74 entries**, including character variants, and **24 venues**. The underlying profile contains 75 fighter records, including the story protagonist. Full-speed combat and scene-by-scene visual parity are still being tested. [Retail inventory](ps2/content/inventory.json)

## Verification

```sh
npm test
cd netplay && npx playwright install chromium && cd ..
npm run test:netplay
npm run test:match
```

The match test uses two headless browsers on macOS with Chrome and the Xcode command-line tools. It records inputs, screenshots, emulated VBlanks and decoded guest frames under `private/verification/ps2-match/`. In a packaged-game run, Blaze and Doc each scored 250 points at Foundation. That test measured 22.3 emulated VBlanks and 23.1 guest video frames per second during combat. A separate test on the live GitHub Pages URL also scored hits for both players. The earlier public run measured 16.1 decoded guest frames per second over 20.2 seconds. After the browser runtime optimization, the same public fight measured 27.7 host VBlanks and 28.3 decoded guest frames per second over 10.6 seconds of movement and attacks on an M5 Pro. In both runs the guest fetched zero game blocks. A separate loading benchmark reduced the wait for Foundation's first 3D frame from 79.5 seconds to 25.6–32.8 seconds. [Match verification](verification/README.md) · [Loading benchmark](ps2/diagnostics/README.md)

To reproduce the content package or rederive the patches from a source copy, the reference disc is the US PS2 release `SLUS-21004`, SHA-1 `5eda39dfd703804c8734b91bd23039f642317837`. The web player does not require a disc image at build, launch or play time. [Battle patch](ps2/battle/README.md)
