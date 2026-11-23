# Def Jam: Fight for NY — PS2 browser versus

The host runs the US retail PlayStation 2 game in a locally built Play! WebAssembly runtime. The guest receives live game video and audio over WebRTC and controls the second DualShock 2 port. The project aims to expose the retail Battle mode with all fighters and venues.

## Run

Requires desktop Chrome or Edge, Node.js 22 or newer, and an uncompressed US PS2 DVD image (SLUS-21004). Python 3.11 or newer is used for disc verification.

```sh
npm run setup
npm start
```

Open [the local player](http://127.0.0.1:8174). Choose the ISO, or place it at `private/ps2/reference.iso` to use the Play button. The latter reads the DVD in ranges. The 4.7 GB image stays out of Git.

Click **Host a match** after boot. The other player opens the same server and enters the room code. On the retail participant screen each player presses Start before choosing their fighter. The guest only needs the URL and room code.

For remote players, run the Node server behind HTTPS with same-origin WebSocket upgrades on `/netplay`. Both players need the same reachable origin. The default listen address is loopback. Set `HOST` and `PORT` for your deployment. See [netplay](netplay/README.md).

## Verify

```sh
npm run disc
npm test
cd netplay && npx playwright install chromium && cd ..
npm run test:netplay
```

Disc verification checks SHA-1 against Redump, indexes all 127 files and locates the PS2 executable. The original ELF entry is `0x100008`. Browser tests run headless. Private dumps, recordings, and screenshots belong under `private/`.

The browser has rendered Blaze fighting Doc at the Foundation. Separate two-browser checks verified live game video, audible game audio, and guest button press and release at the emulated controller port. Arena loading, match timing, roster coverage and the experience across the public Internet require further testing.

The [runtime directory](runtime/play-build/README.md) contains the pinned source revision, patch and rebuild command. The earlier GameCube prototype is archived on the [reference/gamecube branch](https://github.com/Zheruel/def-jam-fight-for-ny/tree/reference/gamecube).
