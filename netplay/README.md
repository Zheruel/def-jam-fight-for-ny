# Online versus

One player runs the emulator and creates an eight-character room code. The invited guest receives the emulator’s video and audio over WebRTC and sends controller state back to player 2. Both players share the host's running match. The guest only needs the browser page.

## Start signaling

Run these commands from the repository root with Node 22 or newer.

```sh
npm --prefix netplay ci
npm --prefix netplay start
```

The standalone endpoint is `ws://127.0.0.1:8081/netplay`. Pass it as `signalingUrl` when the game page uses a separate local server. `NETPLAY_HOST` and `NETPLAY_PORT` configure the listen address. `NETPLAY_ALLOWED_ORIGINS` accepts a comma-separated list of page origins. The server accepts same-host origins and loopback-to-loopback connections by default.

To share the game's origin when using a Node HTTP or HTTPS server, attach signaling before listening.

```js
import { attachNetplay } from './netplay/server.mjs';

attachNetplay(server);
```

For remote games, serve the game over HTTPS and route `/netplay` through the same hostname with WebSocket upgrades enabled. If the game and signaling use different hostnames, add the game page origin to `NETPLAY_ALLOWED_ORIGINS` and use an explicit `wss:` URL. The signaling server relays connection setup messages. The browser peers exchange media and controller states directly when a route is available. Configure appropriate STUN and TURN servers on both clients for networks where a direct connection cannot be established. Use short-lived TURN credentials for a public deployment.

## Browser integration

```js
import { hostMatch, joinMatch } from './netplay/client.mjs';

const host = await hostMatch({
  canvas: emulatorCanvas,
  audioStream: emulatorAudioDestination.stream,
  onInput: ({ buttons, axes }) => setPlayerTwoInput(buttons, axes),
  onState: showConnectionState,
});
showRoomCode(host.code);

// In the invited guest's browser after they enter the code.
const guest = await joinMatch({
  code: enteredCode,
  video: guestVideo,
  onState: showConnectionState,
  onPlaybackBlocked: () => showPlayButton(),
});
```

- Pass the active emulator canvas to `hostMatch`. It captures at up to 60 fps by default. Provide the emulator audio as a `MediaStream`, such as the `.stream` from a Web Audio `MediaStreamAudioDestinationNode`. Leave the emulator routed to the host speakers as well.
- Both methods accept `signalingUrl` and `iceServers`. `signalingUrl` defaults to `/netplay` on the page's origin. `iceServers` defaults to Google’s public STUN server and accepts standard `RTCIceServer` entries. Pass `[]` for isolated loopback testing.
- The returned promise resolves once signaling creates or joins the room. `onState(state, error)` reports `waiting`, `connecting`, `connected`, `closed`, or `error`. A host returns to `waiting` when its guest leaves and can reuse the code. An initial signaling or room failure also rejects the returned promise.
- Call `guest.setInput({ buttons, axes })` when the guest controller changes. `buttons` is a 16-bit mask with the browser Standard Gamepad indices. `axes` is `[leftX, leftY, rightX, rightY]`, with signed values from `-1` to `1`. The client sends changes immediately and refreshes the current state periodically. The host releases inputs when updates time out or the guest leaves.
- Use `host.close()` to end the room or `guest.close()` to leave. If playback needs a gesture, call `guestVideo.play()` from the play button's click handler.

| Button index | PlayStation control |
| --- | --- |
| 0–3 | Cross, Circle, Square, Triangle |
| 4–7 | L1, R1, L2, R2 |
| 8–11 | Select, Start, L3, R3 |
| 12–15 | D-pad Up, Down, Left, Right |

## Smoke tests

```sh
npm --prefix netplay ci
cd netplay
npx playwright install chromium
npm test
```

The tests cover private-room signaling, rejecting an extra guest, decoded video and audio, host input, neutral input on disconnect or guest blur, rejoining and room closure. The media test uses an animated canvas and oscillator in two Chromium browser contexts. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium binary.
