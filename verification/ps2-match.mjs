import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { chromium } from '../netplay/node_modules/playwright/index.mjs';
import { attachNetplay } from '../netplay/server.mjs';
import { gameServer } from '../tools/serve.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const discSha256 = '676ec0c5a313184b0cd476fc2d322cb0b02d6a7cec7d883743a92f3ffbdeca46';
const artifactRoot = join(root, 'private/verification/ps2-match');
const buttons = { cross: 1, circle: 2, square: 4, triangle: 8, start: 512, down: 8192, right: 32768 };
const neutralAxes = [0, 0, 0, 0];

async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) digest.update(bytes);
  return digest.digest('hex');
}

async function rtcStats(page) {
  return page.evaluate(async () => {
    const peer = window.matchVerificationPeers.at(-1);
    const reports = Array.from((await peer.getStats()).values());
    const video = reports.find(row => row.type === 'inbound-rtp' && row.kind === 'video');
    const audio = reports.find(row => row.type === 'inbound-rtp' && row.kind === 'audio');
    const input = reports.find(row => row.type === 'data-channel' && row.state === 'open');
    return {
      timeMs: performance.now(),
      decodedVideoFrames: video?.framesDecoded ?? 0,
      droppedVideoFrames: video?.framesDropped ?? 0,
      receivedVideoBytes: video?.bytesReceived ?? 0,
      receivedAudioBytes: audio?.bytesReceived ?? 0,
      inputMessagesSent: input?.messagesSent ?? 0,
    };
  });
}

async function openStandardBattle({ input, waitScreen }) {
  const matchType = /CHOOSE MATCH TYPE|NO EXCUSES/iu;
  const opening = await waitScreen('opening', /AUTOSAVE WARNING|MAIN MENU|CHOOSE MATCH TYPE|NO EXCUSES/iu, { timeout: 120_000 });
  if (/AUTOSAVE WARNING/iu.test(opening.text)) {
    await input(1, 'cross');
    await waitScreen('autosave-choice', /ENABLE THE AUTOSAVE FEATURE/iu);
    await input(1, 'cross');
    await waitScreen('memory-card-slot', /WHICH MEMORY CARD SLOT/iu);
    await input(1, 'cross');
  }

  if (!matchType.test(opening.text)) {
    const main = await waitScreen('main-menu', /FIGHT FOR MONEY|CHOOSE MATCH TYPE|NO EXCUSES/iu, {
      timeout: 120_000, between: () => input(1, 'start', { after: 35 }),
    });
    if (!matchType.test(main.text)) {
      await input(1, 'right');
      await waitScreen('battle-highlighted', /BRING YOUR CREW|UP TO 4 PLAYERS/iu);
      await input(1, 'cross');
    }
  }

  await waitScreen('one-on-one', /NO EXCUSES/iu);
  await input(1, 'cross');
  await waitScreen('standard-rules', /STANDARD RULES/iu);
  await input(1, 'cross');
}

async function joinControllers({ input, waitScreen }) {
  const slots = await waitScreen('profile-entry', /PICK MEMORY CARD SLOT|SELECT USER ID.*PRESS START BUTTON/iu);
  if (/PICK MEMORY CARD SLOT/iu.test(slots.text)) await input(1, 'cross');
  await waitScreen('controller-slots', /SELECT USER ID.*PRESS START BUTTON/iu);
  await input(2, 'start');
  await waitScreen('guest-profile-prompt', /ENTER USER ID/iu);
  await input(2, 'cross');
  await waitScreen('guest-profile-accepted', /NO USER ID SELECTED/iu);
  await input(1, 'start');
  await waitScreen('host-profile-prompt', /ENTER USER ID/iu);
  await input(1, 'cross');
  await waitScreen('two-human-controllers', /NO USER ID SELECTED.*NO USER ID SELECTED/iu);
  await input(2, 'cross');
  await input(1, 'cross');
}

async function selectFightersAndVenue({ input, waitScreen }) {
  await waitScreen('fighter-selection', /CHOOSE FIGHTER.*WRESTLING/iu);
  await input(1, 'cross', { after: 35 });
  await input(1, 'cross');
  await waitScreen('host-fighter-blaze', /CHOOSE FIGHTER.*READY/iu);
  await input(2, 'right');
  await waitScreen('guest-fighter-doc', /CHOOSE FIGHTER.*MARTIAL ARTS/iu);
  await input(2, 'cross');
  await waitScreen('two-fighters-ready', /READY!?.*READY/iu);
  await input(2, 'cross');
  await waitScreen('venue-foundation', /CHOOSE VENUE.*FOUNDATION/iu);
  await input(1, 'cross');
  await waitScreen('match-card', /ONE ON ONE.*LOADING|AS B[LI]AZE.*AS ?DOC/iu);
}

async function playBattle(controls) {
  const { input, capture, waitScreen, waitVblanks, diagnostics, rtc, report } = controls;
  await openStandardBattle(controls);
  await joinControllers(controls);
  const venueStart = performance.now();
  await selectFightersAndVenue(controls);
  report.match = { type: 'One on One', rules: 'Standard', venue: 'Foundation', host: 'Blaze', guest: 'Doc' };
  await waitScreen('guest-match-card', /ONE ON ONE.*LOADING|(?:AS B[LI]AZE.*AS ?DOC|AS ?DOC.*AS B[LI]AZE)/iu, { side: 'guest' });

  const card = /ONE ON ONE|AS B[LI]AZE|LOADING/iu;
  const activeFight = text => !card.test(text) && /B[LI]AZE/iu.test(text) && /\bDOC\b/iu.test(text) &&
    /\b\d{2}:\d{2}\b/u.test(text);
  await waitScreen('fight-ready', activeFight, {
    timeout: 480_000, interval: 850,
    between: text => {
      // Cross skips a fighter introduction and dismisses the optional tutorial.
      if (!card.test(text)) return input(1, 'cross', { after: 32 });
    },
  });
  const firstGuestFrame = await waitScreen('guest-fight-ready', activeFight, { side: 'guest', timeout: 45_000 });
  report.secondsFromFighterSelectionToFight = (performance.now() - venueStart) / 1000;

  const startHost = await diagnostics();
  const startRtc = await rtc();
  await input(1, 'circle', { hold: 28, axes: [1, 0, 0, 0], during: () => capture('host-movement') });
  await input(2, 'circle', { hold: 28, axes: [-1, 0, 0, 0], during: () => capture('guest-movement') });
  await input(1, 'triangle', { hold: 5, after: 24, during: () => capture('host-punch') });
  await input(2, 'square', { hold: 5, after: 24, during: () => capture('guest-kick') });
  await waitVblanks(90);
  const finalGuestFrame = await waitScreen('after-actions', activeFight, { side: 'guest', timeout: 15_000 });
  const endRtc = await rtc();
  const endHost = await diagnostics();

  const elapsedSeconds = (endRtc.timeMs - startRtc.timeMs) / 1000;
  const emulatedVblanks = endHost.vblanks - startHost.vblanks;
  const decodedVideoFrames = endRtc.decodedVideoFrames - startRtc.decodedVideoFrames;
  const sourceGsFrames = endHost.coreFrame - startHost.coreFrame;
  assert.ok(emulatedVblanks > 0 && sourceGsFrames > 0, 'Host emulation must advance during live inputs');
  assert.ok(decodedVideoFrames > 0, 'The guest must decode new video frames during the fight');
  assert.ok(endRtc.receivedAudioBytes > startRtc.receivedAudioBytes, 'The guest must receive live fight audio');
  assert.ok(endRtc.inputMessagesSent > startRtc.inputMessagesSent, 'The guest must send match inputs via its data channel');
  const fightClock = frame => {
    const [minutes, seconds] = frame.text.match(/\b\d{2}:\d{2}\b/u)[0].split(':').map(Number);
    return minutes * 60 + seconds;
  };
  assert.ok(fightClock(finalGuestFrame) > fightClock(firstGuestFrame), 'The fight clock must advance on the guest');
  report.timing = {
    elapsedSeconds, emulatedVblanks, decodedVideoFrames, sourceGsFrames,
    emulatedVblanksPerSecond: emulatedVblanks / elapsedSeconds,
    decodedVideoFramesPerSecond: decodedVideoFrames / elapsedSeconds,
    guestVideoBytes: endRtc.receivedVideoBytes - startRtc.receivedVideoBytes,
    guestAudioBytes: endRtc.receivedAudioBytes - startRtc.receivedAudioBytes,
    guestInputMessages: endRtc.inputMessagesSent - startRtc.inputMessagesSent,
  };
  console.log('Match timing', report.timing);
}

async function main() {
  const { values } = parseArgs({ options: { 'retail-menus': { type: 'boolean', default: false } } });
  const disc = join(root, 'private/ps2/reference.iso');
  const wasm = join(root, 'runtime/play-build/Play.wasm');
  const [actualDisc, wasmSha256] = await Promise.all([hash(disc), hash(wasm)]);
  assert.equal(actualDisc, discSha256, 'The installed disc must be the USA retail SLUS-21004 ISO');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const out = await mkdtemp(join(artifactRoot, 'run-'));
  const recognizeText = join(out, 'recognize-text');
  await run('swiftc', ['-O', fileURLToPath(new URL('recognize-text.swift', import.meta.url)), '-o', recognizeText]);
  console.log('Captures in', out);

  const server = gameServer();
  attachNetplay(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  const report = { discId: 'SLUS-21004', discSha256, wasmSha256,
    menuMode: values['retail-menus'] ? 'retail' : 'launcher', captures: [], inputs: [] };
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ] });
    report.browser = browser.version();
    const context = { viewport: { width: 1280, height: 960 } };
    const host = await browser.newPage(context);
    const guest = await browser.newPage(context);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    for (const [name, page] of [['host', host], ['guest', guest]]) {
      page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
      await page.addInitScript(() => {
        const Peer = RTCPeerConnection;
        window.matchVerificationPeers = [];
        // Loopback host candidates suffice for these two local browser contexts.
        window.RTCPeerConnection = class extends Peer {
          constructor(options) {
            super({ ...options, iceServers: [] });
            window.matchVerificationPeers.push(this);
          }
        };
      });
      await page.goto(origin);
    }

    if (values['retail-menus']) {
      for (const manifest of ['ps2/battle/battle-patch.json', 'ps2/content/unlock-disc-patch.json']) {
        const original = JSON.parse(await readFile(join(root, manifest), 'utf8'));
        await host.route(`**/${manifest}`, route => route.fulfill({ json: { ...original, patches: [] } }));
      }
    } else {
      report.battleManifestSha256 = await hash(join(root, 'ps2/battle/battle-patch.json'));
      report.unlockManifestSha256 = await hash(join(root, 'ps2/content/unlock-disc-patch.json'));
    }

    await host.getByRole('button', { name: 'Play', exact: true }).click();
    await host.getByRole('button', { name: 'Host a match' }).click({ timeout: 90_000 });
    await host.locator('#room').waitFor({ state: 'visible' });
    const code = await host.locator('#room-code').textContent();
    assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/u);
    await guest.getByRole('textbox', { name: 'Room code' }).fill(code);
    await guest.getByRole('button', { name: 'Join', exact: true }).click();
    await guest.getByText('Connected', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    await guest.waitForFunction(() => {
      const video = document.querySelector('#remote');
      return video.readyState >= 2 && video.videoWidth > 0 &&
        video.srcObject?.getVideoTracks().length === 1 && video.srcObject?.getAudioTracks().length === 1;
    }, null, { timeout: 30_000 });
    assert.equal(await guest.evaluate(() => defJam.diagnostics().discId), null, 'Only the host should run the disc');
    const diagnostics = () => host.evaluate(() => defJam.diagnostics());
    assert.ok(Number.isInteger((await diagnostics()).vblanks), 'Play! must expose the VM VBlank counter');

    async function waitVblanks(count) {
      const target = (await diagnostics()).vblanks + count;
      await host.waitForFunction(value => defJam.diagnostics().vblanks >= value, target, {
        timeout: 15_000, polling: 25,
      });
    }
    async function input(port, name, { hold = 7, after = 12, axes = neutralAxes, during } = {}) {
      const page = port === 1 ? host : guest;
      const mask = buttons[name] ?? 0;
      const started = performance.now();
      const startVblanks = (await diagnostics()).vblanks;
      await page.evaluate(({ port, mask, axes }) => defJam.setPad(port, { buttons: mask, axes }), { port, mask, axes });
      let readbackMs = null;
      try {
        if (mask) {
          await host.waitForFunction(({ port, mask }) => defJam.getInputReadback(port) === mask,
            { port, mask }, { timeout: 10_000, polling: 20 });
          readbackMs = performance.now() - started;
        }
        await waitVblanks(hold);
        if (during) await during();
      } finally {
        await page.evaluate(port => defJam.setPad(port, null), port);
      }
      await host.waitForFunction(port => defJam.getInputReadback(port) === 0, port, {
        timeout: 10_000, polling: 20,
      });
      const endVblanks = (await diagnostics()).vblanks;
      report.inputs.push({ port, name, mask, axes, startVblanks, endVblanks,
        readbackMs, elapsedMs: performance.now() - started });
      if (after) await waitVblanks(after);
    }

    const surfaces = { host: host.locator('#outputCanvas'), guest: guest.locator('#remote') };
    async function sample(side) {
      const file = join(out, `current-${side}.png`);
      const before = await diagnostics();
      await surfaces[side].screenshot({ path: file, timeout: 10_000 });
      const after = await diagnostics();
      const { stdout } = await run(recognizeText, [file], { timeout: 10_000 });
      return { file, text: JSON.parse(stdout).join(' '),
        emulatedVblankRange: [before.vblanks, after.vblanks], gsFrameCountSample: after.coreFrame };
    }
    async function capture(name, side = 'host', frame) {
      const image = frame ?? await sample(side);
      const file = `${String(report.captures.length + 1).padStart(2, '0')}-${name}-${side}.png`;
      await copyFile(image.file, join(out, file));
      report.captures.push({ name, side, file, sha256: await hash(join(out, file)),
        emulatedVblankRange: image.emulatedVblankRange, gsFrameCountSample: image.gsFrameCountSample,
        recognizedText: image.text });
      console.log(name, side, image.text);
    }
    async function waitScreen(name, pattern, { side = 'host', timeout = 60_000, interval = 350, between } = {}) {
      const deadline = performance.now() + timeout;
      const matches = typeof pattern === 'function' ? pattern : text => pattern.test(text);
      let image;
      do {
        image = await sample(side);
        if (matches(image.text)) {
          await capture(name, side, image);
          return image;
        }
        if (between) await between(image.text);
        await delay(interval);
      } while (performance.now() < deadline);
      await capture(`failed-${name}`, side, image);
      throw new Error(`Timed out waiting for ${name}. Last screen text: ${image.text}`);
    }

    await playBattle({ input, capture, waitScreen, waitVblanks, diagnostics,
      rtc: () => rtcStats(guest), report });
    assert.deepEqual(errors, [], 'Unexpected page errors');
    report.complete = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
}

await main();
