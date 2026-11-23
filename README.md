# Def Jam: Fight for NY — browser versus

**[Play on GitHub Pages](https://zheruel.github.io/def-jam-fight-for-ny/)**

Open the page in desktop Chrome or Edge. The US PlayStation 2 game starts automatically and streams its assets as needed. Press **Enter** or controller **Start** at the title for Battle mode. Each player presses Start on the participant screen before choosing a fighter.

For two-player versus, select **Host a match**, then **Copy invite**. The guest opens that link and controls the second DualShock 2. Both players see the host's match and hear its audio over WebRTC. An invite opens directly in guest mode.

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

The native build runs Blaze versus Doc at The Foundation using the original Battle routines translated to WebAssembly. It supports a limited set of moves and two-player rooms. In a 460-tick comparison, both fighters matched every retail action and state. The first headless Chrome combat benchmark averaged 60.0 rendered FPS at 960 × 491. The complete roster and venues are viewable, and the main player provides the wider retail Battle mode. [Play the native match](https://zheruel.github.io/def-jam-fight-for-ny/port/battle/index.html) · [Browse fighters and venues](https://zheruel.github.io/def-jam-fight-for-ny/port/viewer/index.html) · [Native verification and limitations](port/README.md)

## Playable reference

The host browser runs the original game code in a patched Play! WebAssembly runtime. The launcher redirects the retail front end to Battle mode and applies the unlock patch in memory. The asset manifest maps reads to individually verified, compressed blocks. GitHub Pages serves the player, runtime and manifest. A dedicated branch holds the game data. [Runtime and rebuild instructions](runtime/play-build/README.md) · [Content packaging](tools/game-assets.md)

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
