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

import { exposeReferenceMemory, startRetailTrace } from "./retail-combat-trace.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const artifactRoot = join(root, 'private/verification/ps2-match');
const assetManifestPath = 'game-assets/manifest.json';
const battleManifestPath = 'ps2/battle/battle-patch.json';
const unlockManifestPath = 'ps2/content/unlock-disc-patch.json';
const wasmPath = 'runtime/play-build/Play.wasm';
const buttons = { cross: 1, circle: 2, square: 4, triangle: 8, start: 512, down: 8192, left: 16384, right: 32768 };
const neutralAxes = [0, 0, 0, 0];
const fighterNameRegions = [[0.17, 0.67, 0.32, 0.15], [0.55, 0.68, 0.38, 0.14]];
const fighterName = text => text.normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]/gu, '');
const isBlaze = text => /B[LI]AZE|METHODMAN/u.test(fighterName(text));
const isDoc = text => /D[O0]C|REDMAN/u.test(fighterName(text));
const isMatchCard = text => isBlaze(text) && isDoc(text) && /FOUN[DU][A-Z]{0,5}[O0]N/u.test(fighterName(text));

async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) digest.update(bytes);
  return digest.digest('hex');
}

const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');

async function publicAsset(entry, path) {
  const url = new URL(path, entry);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `HTTP ${response.status} for ${url.href}`);
  return Buffer.from(await response.arrayBuffer());
}

async function rtcStats(page) {
  return page.evaluate(async () => {
    const sessions = await Promise.all(window.matchVerificationPeers.map(async peer =>
      Array.from((await peer.getStats()).values())));
    // PeerJS has another connection for signaling. Only the match carries inbound video.
    const reports = sessions.find(session => session.some(row => row.type === 'inbound-rtp' && row.kind === 'video')) ?? [];
    const video = reports.find(row => row.type === 'inbound-rtp' && row.kind === 'video');
    const audio = reports.find(row => row.type === 'inbound-rtp' && row.kind === 'audio');
    const input = reports.find(row => row.type === 'data-channel' && row.label === 'controller-v1' && row.state === 'open');
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

async function openStandardBattle({ input, waitScreen, retailMenus, report }) {
  const matchType = /CHOOSE MATCH TYPE|NO EXCUSES/iu;
  const opening = await waitScreen('opening', /AUTOSAVE WARNING|MAIN MENU|CHOOSE MATCH TYPE|NO EXCUSES/iu, { timeout: 120_000 });
  if (/AUTOSAVE WARNING/iu.test(opening.text)) {
    await input(1, 'cross');
    await waitScreen('autosave-choice', /ENABLE THE AUTOSAVE FEATURE/iu);
    await input(1, 'cross');
    await waitScreen('memory-card-slot', /WHICH MEMORY CARD SLOT/iu);
    await input(1, 'cross');
  }

  const menu = matchType.test(opening.text) ? opening : await waitScreen(
    'post-title-menu', /FIGHT FOR MONEY|CHOOSE MATCH TYPE|NO EXCUSES/iu,
    { timeout: 120_000, between: () => input(1, 'start', { after: 35 }) },
  );
  report.titleDestination = matchType.test(menu.text) ? 'battle' : 'main-menu';
  if (report.titleDestination === 'main-menu') {
    assert.ok(retailMenus, 'The launcher must open Battle directly from the title screen');
    await input(1, 'right');
    await waitScreen('battle-highlighted', /BRING YOUR CREW|UP TO 4 PLAYERS/iu);
    await input(1, 'cross');
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

async function findFighter({ input, sample, capture, waitVblanks, report }, port, name, recognizes) {
  // Each portrait row is six columns. Sweep successive rows with the same controller.
  const visited = [];
  for (let index = 0; index < 75; index++) {
    const region = fighterNameRegions[port - 1];
    let image = await sample('host', region);
    if (!recognizes(image.text)) {
      await waitVblanks(8);
      image = await sample('host', region);
    }
    visited.push(image.text);
    if (recognizes(image.text)) {
      report.fighterSearch ??= {};
      report.fighterSearch[name] = visited;
      await capture(`${port === 1 ? 'host' : 'guest'}-fighter-${name.toLowerCase()}`, 'host', image);
      return;
    }
    const row = Math.floor(index / 6);
    const direction = index % 6 === 5 ? 'down' : row % 2 ? 'left' : 'right';
    await input(port, direction, { after: 24 });
  }
  throw new Error(`Could not identify ${name} on port ${port}. Read ${visited.join(' | ')}`);
}

async function selectFightersAndVenue(controls) {
  const { input, waitScreen } = controls;
  await waitScreen('fighter-selection', /CHOOSE FIGHTER.*(?:WRESTLING|MARTIAL ARTS|STREETFIGHTING)/iu);
  await findFighter(controls, 1, 'Blaze', isBlaze);
  await input(1, 'cross', { after: 35 });
  await input(1, 'cross');
  await waitScreen('host-fighter-ready', /CHOOSE FIGHTER.*READY/iu);
  await findFighter(controls, 2, 'Doc', isDoc);
  await input(2, 'cross');
  const ready = await waitScreen('two-fighters-ready', /READY!?.*READY|CHOOSE VENUE/iu);
  if (!/CHOOSE VENUE/iu.test(ready.text)) await input(2, 'cross');
  await waitScreen('venue-foundation', /CHOOSE VENUE.*FOUNDATION/iu);
  await input(1, 'cross');
  await waitScreen('match-card', isMatchCard);
}

async function playBattle(controls) {
  const { input, capture, waitScreen, waitVblanks, diagnostics, rtc, report } = controls;
  await openStandardBattle(controls);
  await joinControllers(controls);
  const venueStart = performance.now();
  await selectFightersAndVenue(controls);
  report.match = { type: 'One on One', rules: 'Standard', venue: 'Foundation', host: 'Blaze', guest: 'Doc' };
  await waitScreen('guest-match-card', isMatchCard, { side: 'guest' });

  const card = /ONE ON ONE|AS B[LI]AZE|LOADING/iu;
  const activeFight = text => !card.test(text) && /B[LI]AZE/iu.test(text) && /\bDOC\b/iu.test(text) &&
    /\b\d{2}:\d{2}\b/u.test(text);
  await waitScreen('fight-ready', activeFight, {
    timeout: 480_000, interval: 850,
    between: async (text, image) => {
      if (/PRESS START BUTTON.*(?:ELECTRONIC ARTS|AKI CORPORATION)/iu.test(text)) {
        await capture('unexpected-title', 'host', image);
        throw new Error('The game returned to the title screen after the match card');
      }
      // Cross skips a fighter introduction and dismisses the optional tutorial.
      if (!card.test(text)) await input(1, 'cross', { after: 32 });
    },
  });
  const firstGuestFrame = await waitScreen('guest-fight-ready', activeFight, { side: 'guest', timeout: 45_000 });
  report.secondsFromFighterSelectionToFight = (performance.now() - venueStart) / 1000;

  if (controls.beginTrace) await controls.beginTrace();
  if (controls.measurePerformance) {
    report.steadyCombat = [];
    console.log('Starting steady combat measurement');
    let previousHost = await diagnostics();
    let previousRtc = await rtc();
    for (let window = 0; window < 3; window++) {
      await delay(5000);
      const host = await diagnostics();
      const guest = await rtc();
      const seconds = (guest.timeMs - previousRtc.timeMs) / 1000;
      report.steadyCombat.push({
        seconds, hostVblanksPerSecond: (host.vblanks - previousHost.vblanks) / seconds,
        guestFramesPerSecond: (guest.decodedVideoFrames - previousRtc.decodedVideoFrames) / seconds,
      });
      previousHost = host;
      previousRtc = guest;
    }
    console.log('Steady combat', report.steadyCombat);
  }
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
  const { values } = parseArgs({ options: { trace: { type: "boolean", default: false }, url: { type: 'string' }, performance: { type: 'boolean', default: false }, 'retail-menus': { type: 'boolean', default: false } } });
  const publicEntry = values.url && new URL(values.url);
  if (publicEntry) {
    assert.ok(['http:', 'https:'].includes(publicEntry.protocol), 'The player URL must use HTTP or HTTPS');
    assert.ok(!values['retail-menus'], 'Use --retail-menus with the local player so its overlays can be intercepted');
    if (!publicEntry.pathname.endsWith('/') && !publicEntry.pathname.endsWith('.html')) publicEntry.pathname += '/';
    publicEntry.searchParams.delete('join');
    publicEntry.hash = '';
  }
  const loadAsset = path => publicEntry ? publicAsset(publicEntry, path) : readFile(join(root, path));
  const [manifest, wasm] = await Promise.all([loadAsset(assetManifestPath), loadAsset(wasmPath)]);
  const assetsManifestSha256 = hashBytes(manifest);
  assert.equal(JSON.parse(manifest).serial, 'SLUS-21004', 'The package must be the USA PS2 game');
  const wasmSha256 = hashBytes(wasm);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const out = await mkdtemp(join(artifactRoot, 'run-'));
  const recognizeText = join(out, 'recognize-text');
  await run('xcode-select', ['-p']);
  await run('swiftc', ['-O', fileURLToPath(new URL('recognize-text.swift', import.meta.url)), '-o', recognizeText]);
  console.log('Captures in', out);

  const server = publicEntry ? null : gameServer(root, { reference: false });
  if (server) {
    attachNetplay(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  let browser;
  const entry = publicEntry ?? new URL(`http://127.0.0.1:${server.address().port}/`);
  const guestEntry = new URL(entry);
  guestEntry.searchParams.set('join', '1');
  const manifestUrl = new URL(assetManifestPath, entry);
  const assetRoot = new URL('./', manifestUrl);
  const discRoot = new URL('disc/', entry);
  const isIsoRequest = url => url.href.startsWith(discRoot.href) || /\.iso(?:$|\/)/iu.test(url.pathname);
  const report = { gameId: 'SLUS-21004', target: publicEntry ? entry.href : 'loopback', assetsManifestSha256, wasmSha256,
    menuMode: values['retail-menus'] ? 'retail' : 'launcher', captures: [], inputs: [] };
  const browserMessages = [];
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
    if (values.trace) await exposeReferenceMemory(host);
    const errors = [];
    const boot = report.boot = {
      host: { automatic: true, packageRequests: 0 },
      guest: { mode: 'join', packageRequests: 0 },
      isoRequests: [], fileChoosers: [], dialogs: [],
    };
    for (const [name, page] of [['host', host], ['guest', guest]]) {
      page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.href.startsWith(assetRoot.href) || /\/blocks\/[a-f0-9]{64}\.gz$/u.test(url.pathname)) {
          boot[name].packageRequests++;
        }
        if (isIsoRequest(url)) boot.isoRequests.push({ page: name, url: url.href });
      });
      page.on('filechooser', () => boot.fileChoosers.push(name));
      page.on('dialog', async dialog => {
        boot.dialogs.push({ page: name, type: dialog.type() });
        await dialog.dismiss();
      });
      page.on('console', message => {
        if (!['error', 'warning'].includes(message.type())) return;
        browserMessages.push({ page: name, type: message.type(), text: message.text() });
        if (browserMessages.length > 120) browserMessages.shift();
      });
      await page.addInitScript(local => {
        const Peer = RTCPeerConnection;
        window.matchVerificationPeers = [];
        // Loopback host candidates suffice for these two local browser contexts.
        window.RTCPeerConnection = class extends Peer {
          constructor(options) {
            super(local ? { ...options, iceServers: [] } : options);
            window.matchVerificationPeers.push(this);
          }
        };
      }, !publicEntry);
      await page.route(isIsoRequest, route => route.abort());
    }

    if (values['retail-menus']) {
      for (const manifest of [battleManifestPath, unlockManifestPath]) {
        const original = JSON.parse(await readFile(join(root, manifest), 'utf8'));
        await host.route(`**/${manifest}`, route => route.fulfill({ json: { ...original, patches: [] } }));
      }
    } else {
      const [battle, unlocks] = await Promise.all([loadAsset(battleManifestPath), loadAsset(unlockManifestPath)]);
      report.battleManifestSha256 = hashBytes(battle);
      report.unlockManifestSha256 = hashBytes(unlocks);
    }

    const [servedManifest, hostPage, guestPage] = await Promise.all([
      host.waitForResponse(response => response.url() === manifestUrl.href, { timeout: 90_000 }),
      host.goto(entry.href, { waitUntil: 'commit' }),
      guest.goto(guestEntry.href, { waitUntil: 'commit' }),
    ]);
    assert.ok(hostPage?.ok() && guestPage?.ok(), 'The player and room pages must serve successfully');
    assert.ok(servedManifest.ok(), 'The host must load the package manifest automatically');
    assert.equal(hashBytes(await servedManifest.body()), assetsManifestSha256);
    await host.waitForFunction(() => crossOriginIsolated && window.defJam?.diagnostics().discId === 'SLUS-21004' &&
      window.defJam.diagnostics().vblanks > 0, null, { timeout: 90_000 });
    await guest.waitForFunction(() => crossOriginIsolated && Boolean(window.defJam), null, { timeout: 45_000 });
    assert.ok(boot.host.packageRequests > 1, 'The host must load game blocks from the package');
    assert.equal(await host.locator('input[type="file"]').count(), 0, 'The host must have no file picker');
    assert.equal(await guest.locator('input[type="file"]').count(), 0, 'The guest must have no file picker');
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
    async function sample(side, region) {
      const file = join(out, `current-${side}.png`);
      const before = await diagnostics();
      await surfaces[side].screenshot({ path: file, timeout: 10_000 });
      const after = await diagnostics();
      const args = region ? ['--region', ...region.map(String), file] : [file];
      const { stdout } = await run(recognizeText, args, { timeout: 10_000 });
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
        if (between) await between(image.text, image);
        await delay(interval);
      } while (performance.now() < deadline);
      await capture(`failed-${name}`, side, image);
      throw new Error(`Timed out waiting for ${name}. Last screen text: ${image.text}`);
    }

    await playBattle({ beginTrace: values.trace ? () => host.evaluate(startRetailTrace) : null, measurePerformance: values.performance, input, sample, capture, waitScreen, waitVblanks, diagnostics, retailMenus: values['retail-menus'],
      rtc: () => rtcStats(guest), report });
    if (values.trace) {
      const samples = await host.evaluate(() => window.finishRetailTrace());
      assert.ok(samples.length > 30, "Too few reference samples");
      await writeFile(join(out, "combat-trace.json"), JSON.stringify({ match: report.match, samples }));
    }
    assert.equal(boot.guest.packageRequests, 0, 'The guest must receive the stream without fetching game data');
    assert.deepEqual(boot.isoRequests, [], 'Neither player may request an ISO');
    assert.deepEqual(boot.fileChoosers, [], 'Neither player may open a file chooser');
    assert.deepEqual(boot.dialogs, [], 'The launcher must not open a dialog');
    assert.deepEqual(errors, [], 'Unexpected page errors');
    report.complete = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    try {
      await browser?.close();
    } finally {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (browserMessages.length) report.browserMessages = browserMessages;
      await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
}

await main();
