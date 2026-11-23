// Host plus up to three guests, each guest in its own isolated browser context (separate renderer, storage, media).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { attachNetplay } from '../server.mjs';

const COLORS = { 1: [230, 30, 30], 2: [30, 200, 40], 3: [30, 60, 230] };
const TONES = { 1: 440, 2: 880, 3: 1320 };

async function startServer(t, signaling) {
  const names = ['client.mjs', 'peerjs.mjs', 'vendor/peerjs-1.5.5.min.js'];
  const sources = new Map(await Promise.all(names.map(async (name) => [`/${name}`, await readFile(new URL(`../${name}`, import.meta.url))])));
  const server = createServer((request, response) => {
    if (sources.has(request.url)) response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(sources.get(request.url));
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>fixture</title><canvas width="64" height="48"></canvas><video></video>');
  });
  if (signaling) attachNetplay(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function startPeerServer(t) {
  const broker = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { PeerServer } from 'peer';
    PeerServer({ host: '127.0.0.1', port: 0, path: '/relay' }, server => console.log(server.address().port));
  `], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    if (broker.exitCode !== null || broker.signalCode !== null) return;
    const exited = once(broker, 'exit');
    broker.kill();
    await exited;
  });
  const port = Number((await once(broker.stdout, 'data'))[0].toString().trim());
  return `http://127.0.0.1:${port}/relay`;
}

async function page(browser, base) {
  const context = await browser.newContext();
  const tab = await context.newPage();
  tab.setDefaultTimeout(12_000);
  await tab.goto(base);
  return tab;
}

const hostSide = async (tab, { entry, signalingUrl, colors, tones }) => tab.evaluate(async ({ entry, signalingUrl, colors, tones }) => {
  const { hostMatch } = await import(entry);
  const audio = new AudioContext();
  const seat = (slot) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
    const drawing = canvas.getContext('2d');
    setInterval(() => { drawing.fillStyle = `rgb(${colors[slot]})`; drawing.fillRect(0, 0, 64, 48); }, 30);
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.frequency.value = tones[slot];
    oscillator.connect(destination);
    oscillator.start();
    return { canvas, audioStream: destination.stream };
  };
  const seats = { 1: seat(1), 2: seat(2), 3: seat(3) };
  const hostCanvas = document.querySelector('canvas');
  const hostDrawing = hostCanvas.getContext('2d');
  setInterval(() => { hostDrawing.fillStyle = '#888'; hostDrawing.fillRect(0, 0, 64, 48); }, 30);
  const log = { inputs: [], peers: [], slots: null, states: [] };
  window.log = log;
  window.room = await hostMatch({
    canvas: hostCanvas, audioStream: null, signalingUrl,
    seatMedia: (slot) => seats[slot],
    onInput: (input, slot) => log.inputs.push({ slot, buttons: input.buttons, x: input.axes[0] }),
    onPeer: (peer) => log.peers.push({ slot: peer.slot, state: peer.state }),
    onSlots: (list) => { log.slots = list; },
    onState: (state) => log.states.push(state),
  });
  return { code: window.room.code, players: window.room.players, slots: window.room.slots() };
}, { entry, signalingUrl, colors, tones });

const guestSide = (tab, { entry, signalingUrl, code, slot }) => tab.evaluate(async ({ entry, signalingUrl, code, slot }) => {
  const { joinMatch } = await import(entry);
  try {
    window.guest = await joinMatch({ code, signalingUrl, slot, video: document.querySelector('video') });
    return { slot: window.guest.slot, players: window.guest.players };
  } catch (error) {
    return { error: error.message };
  }
}, { entry, signalingUrl, code, slot });

// The picture and the strongest tone the guest actually receives.
const observe = (tab) => tab.evaluate(async () => {
  const video = document.querySelector('video');
  for (let i = 0; i < 100 && !(video.videoWidth && video.readyState >= 2); i++) await new Promise((r) => setTimeout(r, 100));
  const scratch = Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
  const drawing = scratch.getContext('2d');
  drawing.drawImage(video, 0, 0, 8, 8);
  const pixel = [...drawing.getImageData(4, 4, 1, 1).data.slice(0, 3)];
  const audio = new AudioContext();
  await audio.resume();
  const source = audio.createMediaStreamSource(new MediaStream(video.srcObject.getAudioTracks()));
  const analyser = audio.createAnalyser();
  analyser.fftSize = 8192;
  source.connect(analyser);
  let hertz = 0;
  for (let i = 0; i < 40 && !hertz; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    const peak = bins.reduce((best, value, index) => value > bins[best] ? index : best, 0);
    if (bins[peak] > -70) hertz = Math.round(peak * audio.sampleRate / analyser.fftSize);
  }
  return { pixel, hertz };
});

const waitFor = async (tab, expression, arg) => {
  await tab.waitForFunction(expression, arg, { timeout: 12_000 });
};

async function run(t, usePeerJS) {
  const base = await startServer(t, !usePeerJS);
  const entry = usePeerJS ? '/peerjs.mjs' : '/client.mjs';
  const signalingUrl = usePeerJS ? await startPeerServer(t) : undefined;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, // headless: no windows
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
  });
  t.after(() => browser.close());
  const [host, g1, g2, g3, g4] = await Promise.all([1, 2, 3, 4, 5].map(() => page(browser, base)));
  const common = { entry, signalingUrl };

  // Default room: two seats, so only one guest is advertised and admitted.
  const hosted = await hostSide(host, { ...common, colors: COLORS, tones: TONES });
  assert.equal(hosted.players, 2);
  assert.deepEqual(hosted.slots.map((s) => s.slot), [0, 1]);
  const { code } = hosted;
  const info = (tab) => tab.evaluate(async ({ entry, signalingUrl, code }) => (await import(entry)).roomInfo({ code, signalingUrl }), { ...common, code });
  assert.deepEqual(await info(g4), { code, players: 2, open: 1 });
  assert.deepEqual(await guestSide(g1, { ...common, code }), { slot: 1, players: 2 });
  assert.match((await guestSide(g2, { ...common, code })).error, /already has a guest/);
  assert.deepEqual(await info(g4), { code, players: 2, open: 0 });

  // The host opens the room to four players; three guests fit, a fourth is turned away.
  await host.evaluate(() => window.room.setPlayers(4));
  await waitFor(host, () => window.log.slots?.length === 4);
  assert.deepEqual(await info(g4), { code, players: 4, open: 2 });
  assert.deepEqual(await guestSide(g2, { ...common, code }), { slot: 2, players: 4 });
  assert.deepEqual(await guestSide(g3, { ...common, code }), { slot: 3, players: 4 });
  assert.match((await guestSide(g4, { ...common, code })).error, /full/);
  await waitFor(host, () => window.log.states.at(-1) === 'connected' && window.log.slots.every((s) => s.state === 'connected' || s.state === 'host'));

  // Distinct picture and sound per seat.
  const guests = { 1: g1, 2: g2, 3: g3 };
  for (const slot of [1, 2, 3]) {
    const { pixel, hertz } = await observe(guests[slot]);
    COLORS[slot].forEach((channel, index) => assert.ok(Math.abs(pixel[index] - channel) < 40, `slot ${slot} picture ${pixel}`));
    assert.ok(Math.abs(hertz - TONES[slot]) < 40, `slot ${slot} tone ${hertz}`);
  }

  // One independent input per seat, tagged with the right slot.
  await Promise.all([1, 2, 3].map((slot) => guests[slot].evaluate((slot) => window.guest.setInput({ buttons: 1 << slot, axes: [slot / 4, 0, 0, 0] }), slot)));
  await waitFor(host, () => [1, 2, 3].every((slot) => window.log.inputs.some((i) => i.slot === slot && i.buttons === 1 << slot)));
  const seen = await host.evaluate(() => window.log.inputs);
  for (const slot of [1, 2, 3]) {
    const mine = seen.filter((i) => i.slot === slot && i.buttons);
    assert.ok(mine.length && mine.every((i) => i.buttons === 1 << slot && Math.abs(i.x - slot / 4) < 0.02), `slot ${slot} input`);
  }

  // Guest 2 leaves: its input goes neutral, the others stay connected; it rejoins the same seat.
  await g2.evaluate(() => window.guest.close());
  await waitFor(host, () => window.log.slots[2].state === 'open');
  const afterLeave = await host.evaluate(() => ({ slots: window.log.slots, inputs: window.log.inputs.filter((i) => i.slot === 2).at(-1) }));
  assert.equal(afterLeave.inputs.buttons, 0, 'neutral input on leave');
  assert.deepEqual(afterLeave.slots.map((s) => s.state), ['host', 'connected', 'open', 'connected']);
  assert.deepEqual(await info(g4), { code, players: 4, open: 1 });
  await guests[1].evaluate(() => window.guest.setInput({ buttons: 0x11, axes: [0, 0, 0, 0] }));
  await waitFor(host, () => window.log.inputs.some((i) => i.slot === 1 && i.buttons === 0x11));

  const rejoined = await guestSide(g4, { ...common, code, slot: 2 });
  assert.deepEqual(rejoined, { slot: 2, players: 4 });
  await waitFor(host, () => window.log.slots[2].state === 'connected');
  const again = await observe(g4);
  COLORS[2].forEach((channel, index) => assert.ok(Math.abs(again.pixel[index] - channel) < 40, 'rejoined picture'));
  assert.ok(Math.abs(again.hertz - TONES[2]) < 40, 'rejoined tone');
  await g4.evaluate(() => window.guest.setInput({ buttons: 0x44, axes: [0, 0, 0, 0] }));
  await waitFor(host, () => window.log.inputs.some((i) => i.slot === 2 && i.buttons === 0x44));
  await g3.evaluate(() => window.guest.setInput({ buttons: 0x33, axes: [0, 0, 0, 0] }));
  await waitFor(host, () => window.log.inputs.some((i) => i.slot === 3 && i.buttons === 0x33));

  // Closing the host ends every guest.
  await host.evaluate(() => window.room.close());
  for (const tab of [g1, g3, g4]) await tab.waitForFunction(() => document.querySelector('video').srcObject === null);
}

test('host and three isolated guests: capacity, per-seat media and input, reconnect (WebSocket signaling)', { timeout: 90_000 }, (t) => run(t, false));
test('host and three isolated guests over PeerJS signaling', { timeout: 90_000 }, (t) => run(t, true));

// The room outlives the screen it was opened on: the selector's picture and sound are replaced by the match's with
// RTCRtpSender.replaceTrack, so the guest keeps its seat, its connection and its input channel.
async function mediaSwitch(t, usePeerJS) {
  const base = await startServer(t, !usePeerJS);
  const entry = usePeerJS ? '/peerjs.mjs' : '/client.mjs';
  const signalingUrl = usePeerJS ? await startPeerServer(t) : undefined;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
  });
  t.after(() => browser.close());
  const [host, guest] = await Promise.all([1, 2].map(() => page(browser, base)));
  const hosted = await host.evaluate(async ({ entry, signalingUrl }) => {
    const { hostMatch } = await import(entry);
    const audio = new AudioContext();
    const screen = (color, tone) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
      const drawing = canvas.getContext('2d');
      setInterval(() => { drawing.fillStyle = color; drawing.fillRect(0, 0, 64, 48); }, 30);
      const oscillator = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      oscillator.frequency.value = tone;
      oscillator.connect(destination);
      oscillator.start();
      return { canvas, audioStream: destination.stream };
    };
    window.screens = { menu: screen('rgb(230,30,30)', 440), match: screen('rgb(30,60,230)', 1320) };
    window.log = { inputs: [], states: [] };
    window.room = await hostMatch({
      ...window.screens.menu, signalingUrl,
      onInput: (input, slot) => window.log.inputs.push({ slot, buttons: input.buttons }),
      onState: (state) => window.log.states.push(state),
    });
    return window.room.code;
  }, { entry, signalingUrl });
  const joined = await guestSide(guest, { entry, signalingUrl, code: hosted });
  assert.deepEqual(joined, { slot: 1, players: 2 });
  await waitFor(host, () => window.log.states.at(-1) === 'connected');
  const before = await observe(guest);
  [230, 30, 30].forEach((channel, index) => assert.ok(Math.abs(before.pixel[index] - channel) < 40, `menu picture ${before.pixel}`));
  assert.ok(Math.abs(before.hertz - 440) < 40, `menu tone ${before.hertz}`);

  await host.evaluate(() => window.room.setMedia(window.screens.match));
  await guest.waitForFunction(() => {
    const video = document.querySelector('video');
    const scratch = Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
    const drawing = scratch.getContext('2d');
    drawing.drawImage(video, 0, 0, 8, 8);
    return drawing.getImageData(4, 4, 1, 1).data[2] > 150;
  }, undefined, { timeout: 12_000 });
  // The replaced audio track takes a moment longer than the picture to reach the guest's analyser.
  let after = await observe(guest);
  for (let attempt = 0; attempt < 20 && Math.abs(after.hertz - 1320) >= 60; attempt += 1) after = await observe(guest);
  [30, 60, 230].forEach((channel, index) => assert.ok(Math.abs(after.pixel[index] - channel) < 40, `match picture ${after.pixel}`));
  assert.ok(Math.abs(after.hertz - 1320) < 60, `match tone ${after.hertz}`);

  // Same guest object, same seat, same input channel, no state change on the host.
  assert.equal(await guest.evaluate(() => window.guest.slot), 1);
  await guest.evaluate(() => window.guest.setInput({ buttons: 0x4000, axes: [0.5, 0, 0, 0] }));
  await waitFor(host, () => window.log.inputs.some((i) => i.slot === 1 && i.buttons === 0x4000));
  assert.deepEqual(await host.evaluate(() => window.log.states), ['waiting', 'connecting', 'connected']);
  assert.deepEqual(await host.evaluate(() => window.room.slots().map((s) => s.state)), ['host', 'connected']);
}

test('setMedia switches a connected guest to a new picture and sound without rejoining (WebSocket signaling)', { timeout: 60_000 }, (t) => mediaSwitch(t, false));
test('setMedia switches a connected guest to a new picture and sound without rejoining (PeerJS signaling)', { timeout: 60_000 }, (t) => mediaSwitch(t, true));
