# Def Jam: Fight for NY — PS2 browser versus

The host runs the US retail PlayStation 2 game in a locally built Play! WebAssembly runtime. The guest receives live game video and audio over WebRTC and controls the second DualShock 2 port. The title screen opens Battle mode. The launcher patches the PS2 executable and front-end resources as the game reads them.

## Run

Requires desktop Chrome or Edge, Node.js 22 or newer, and an uncompressed US PS2 DVD image (SLUS-21004). Python 3.11 or newer is used for disc verification.

```sh
npm run setup
npm start
```

Open [the local player](http://127.0.0.1:8174). With the ISO installed at `private/ps2/reference.iso`, click **Play**. On another installation, the host can choose their ISO in the browser. Both paths apply the same Battle patches. The 4.7 GB image stays out of Git.

Click **Host a match** after boot. The other player opens the same server and enters the room code. On the retail participant screen each player presses Start before choosing their fighter. The guest only needs the URL and room code.

For remote players, run the Node server behind HTTPS with same-origin WebSocket upgrades on `/netplay`. Both players need the same reachable origin. The default listen address is loopback. Set `HOST` and `PORT` for your deployment. For NATs that require a relay, set `TURN_URL` and `TURN_SECRET` to your coturn REST configuration. Peers receive credentials valid for two hours. See [netplay](netplay/README.md).

## Verify

```sh
npm run disc
npm test
cd netplay && npx playwright install chromium && cd ..
npm run test:netplay
```

Disc verification checks SHA-1 against Redump, indexes all 127 files and locates the PS2 executable. The original ELF entry is `0x100008`. Browser tests run headless. On macOS with Chrome and the Xcode command-line tools, `npm run test:match` boots the installed disc, joins two browsers and drives both players through a retail fight. It saves screenshots and timing data under `private/verification/ps2-match/`. [Match verification](verification/README.md)

Two browsers on one Mac played Blaze versus Doc at the Foundation. Both players landed hits. One headless retail-menu run measured 25.1 emulated VBlanks and 26.0 guest video frames per second during combat. An isolated loading test reduced time to the first 3D Foundation frame from 79.5 seconds to 25.6–32.8 seconds. Public-internet latency, sustained full-speed combat and visual parity across the entire roster and venue set still need measurement. [Loading benchmark](ps2/diagnostics/README.md)

The unlock patch populates the retail profile from 75 fighter records and 24 venue records in the US disc database. Those totals include internal records. Full menu and match coverage is being verified. To rederive the inventory and verify the unlock patch against the installed disc, run `python3 ps2/content/unlocks.py verify private/ps2/reference.iso`. [Disc inventory](ps2/content/inventory.json)

The [runtime directory](runtime/play-build/README.md) contains the pinned source revision, patch and rebuild command. The earlier GameCube prototype is archived on the [reference/gamecube branch](https://github.com/Zheruel/def-jam-fight-for-ny/tree/reference/gamecube).
