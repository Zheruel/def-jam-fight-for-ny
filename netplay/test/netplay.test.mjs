import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { attachNetplay } from '../server.mjs';

async function startServer(t, signaling = true) {
  const filenames = ['client.mjs', 'peerjs.mjs', 'vendor/peerjs-1.5.5.min.js'];
  const sources = new Map(await Promise.all(filenames.map(async (name) => [
    `/${name}`, await readFile(new URL(`../${name}`, import.meta.url)),
  ])));
  const server = createServer((request, response) => {
    if (sources.has(request.url)) {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(sources.get(request.url));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html>
      <title>WebRTC fixture</title><canvas width="160" height="120"></canvas><video></video>`);
  });
  if (signaling) attachNetplay(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function startPeerServer(t) {
  // PeerServer owns interval timers with no public disposal API, so run it in a child process.
  const broker = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { PeerServer } from 'peer';
    PeerServer({ host: '127.0.0.1', port: 0, path: '/relay' }, server => {
      console.log(server.address().port);
    });
  `], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    if (broker.exitCode !== null || broker.signalCode !== null) return;
    const exited = once(broker, 'exit');
    broker.kill();
    await exited;
  });
  const port = await Promise.race([
    once(broker.stdout, 'data').then(([value]) => Number(value.toString().trim())),
    once(broker, 'exit').then(([code]) => { throw new Error(`PeerServer stopped with status ${code}`); }),
  ]);
  assert.ok(port > 0);
  return `http://127.0.0.1:${port}/relay`;
}

async function connect(t, baseUrl, options) {
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/netplay`, options);
  t.after(() => socket.terminate());
  const queued = [];
  let waiting;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (!waiting) queued.push(message);
    else {
      waiting(message);
      waiting = undefined;
    }
  });
  await once(socket, 'open');
  return {
    send: (message) => socket.send(JSON.stringify(message)),
    receive: () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => { waiting = resolve; }),
    close: () => socket.close(),
  };
}

test('signaling scopes traffic to one invited guest and supports a fresh round', { timeout: 8_000 }, async (t) => {
  const base = await startServer(t);
  const host = await connect(t, base);
  host.send({ type: 'host' });
  const { type, code } = await host.receive();
  assert.equal(type, 'room');
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);

  const guest = await connect(t, base);
  guest.send({ type: 'join', code: code.toLowerCase() });
  const { round } = await guest.receive();
  assert.deepEqual(await host.receive(), { type: 'peer-joined', round, slot: 1 });

  const extra = await connect(t, base);
  extra.send({ type: 'join', code });
  assert.match((await extra.receive()).message, /already has a guest/);

  const offer = { type: 'offer', round, description: { type: 'offer', sdp: 'example' } };
  guest.send(offer);
  host.send({ ...offer, round: round + 1 });
  host.send(offer);
  assert.deepEqual(await guest.receive(), offer);
  const answer = { type: 'answer', round, description: { type: 'answer', sdp: 'example' } };
  guest.send(answer);
  assert.deepEqual(await host.receive(), { ...answer, slot: 1 });

  guest.close();
  assert.deepEqual(await host.receive(), { type: 'peer-left', round, slot: 1 });
  const replacement = await connect(t, base);
  replacement.send({ type: 'join', code });
  assert.deepEqual(await replacement.receive(), { type: 'room', code, round: round + 1, slot: 1, players: 2 });
  assert.deepEqual(await host.receive(), { type: 'peer-joined', round: round + 1, slot: 1 });

  host.close();
  assert.deepEqual(await replacement.receive(), { type: 'room-closed' });
  const late = await connect(t, base);
  late.send({ type: 'join', code });
  assert.match((await late.receive()).message, /Room unavailable/);

  const foreign = new WebSocket(`${base.replace('http:', 'ws:')}/netplay`, { origin: 'https://example.com' });
  t.after(() => foreign.terminate());
  const [error] = await once(foreign, 'error');
  assert.match(error.message, /403/);
});

async function testBrowserMatch(t, usePeerJS) {
  const base = await startServer(t, !usePeerJS);
  const entry = usePeerJS ? '/peerjs.mjs' : '/client.mjs';
  const signalingUrl = usePeerJS ? await startPeerServer(t) : undefined;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  t.after(() => browser.close());
  const host = await browser.newPage();
  const guest = await browser.newPage();
  host.setDefaultTimeout(10_000);
  guest.setDefaultTimeout(10_000);
  await Promise.all([host.goto(base), guest.goto(base)]);
  const code = await host.evaluate(async ({ entry, signalingUrl }) => {
    const { hostMatch } = await import(entry);
    const canvas = document.querySelector('canvas');
    const drawing = canvas.getContext('2d');
    let frame = 0;
    setInterval(() => {
      drawing.fillStyle = '#f5692d';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = '#0e344a';
      drawing.fillRect(40 + (frame++ % 40), 40, 12, 12);
    }, 16);
    window.emulatorAudio = new AudioContext();
    const destination = window.emulatorAudio.createMediaStreamDestination();
    const tone = window.emulatorAudio.createOscillator();
    tone.connect(destination);
    tone.start();
    await window.emulatorAudio.resume();
    window.hostStates = [];
    window.inputs = [];
    window.room = await hostMatch({
      canvas, audioStream: destination.stream, iceServers: [], signalingUrl,
      onInput: (input) => window.inputs.push(input),
      onState: (state) => window.hostStates.push(state),
    });
    window.hostAudioTrack = destination.stream.getAudioTracks()[0];
    return window.room.code;
  }, { entry, signalingUrl });

  async function join() {
    await guest.evaluate(async ({ code, entry, signalingUrl }) => {
      const { joinMatch } = await import(entry);
      window.guestStates = [];
      window.match = await joinMatch({
        code, video: document.querySelector('video'), iceServers: [], signalingUrl,
        onState: (state) => window.guestStates.push(state),
      });
    }, { code, entry, signalingUrl });
    await Promise.all([
      host.waitForFunction(() => window.hostStates.at(-1) === 'connected'),
      guest.waitForFunction(() => window.guestStates.at(-1) === 'connected'),
    ]);
  }
  await join();

  if (usePeerJS) {
    await assert.rejects(guest.evaluate(async ({ code, entry, signalingUrl }) => {
      const { joinMatch } = await import(entry);
      const unexpected = await joinMatch({ code, video: document.createElement('video'), iceServers: [], signalingUrl });
      unexpected.close();
    }, { code, entry, signalingUrl }), /already has a guest/);
  }

  const media = await guest.evaluate(async () => {
    const video = document.querySelector('video');
    await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
    const frame = document.createElement('canvas');
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    const drawing = frame.getContext('2d');
    drawing.drawImage(video, 0, 0);
    const [red, green, blue] = drawing.getImageData(0, 0, 1, 1).data;
    const audio = new AudioContext();
    const source = audio.createMediaStreamSource(video.srcObject);
    const analyzer = audio.createAnalyser();
    source.connect(analyzer);
    // Keep the analyzer processing on Chromium when headless playback has no physical output.
    const silent = audio.createGain();
    silent.gain.value = 0;
    analyzer.connect(silent).connect(audio.destination);
    await audio.resume();
    const samples = new Float32Array(analyzer.fftSize);
    let peak = 0;
    for (let attempt = 0; attempt < 50 && peak < 0.1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      analyzer.getFloatTimeDomainData(samples);
      peak = Math.max(...samples);
    }
    await audio.close();
    return { red, green, blue, peak, width: frame.width, height: frame.height };
  });
  assert.equal(media.width, 160);
  assert.equal(media.height, 120);
  assert.ok(media.red > 200 && media.green > 70 && media.blue < 80, JSON.stringify(media));
  assert.ok(media.peak > 0.1, JSON.stringify(media));

  const pressed = { buttons: (1 << 0) | (1 << 15), axes: [1, -1, 0.5, 0] };
  await guest.evaluate((input) => window.match.setInput(input), pressed);
  await host.waitForFunction(() => window.inputs.at(-1)?.buttons === 32769);
  const received = await host.evaluate(() => window.inputs.at(-1));
  assert.deepEqual(received, { buttons: pressed.buttons, axes: [1, -1, 64 / 127, 0] });
  await guest.evaluate(() => window.match.close());
  await host.waitForFunction(() => window.hostStates.at(-1) === 'waiting' && window.inputs.at(-1)?.buttons === 0);

  await join();
  await guest.evaluate(() => window.match.setInput({ buttons: 2, axes: [0, 0, 0, 0] }));
  await host.waitForFunction(() => window.inputs.at(-1)?.buttons === 2);
  await guest.evaluate(() => window.dispatchEvent(new Event('blur')));
  await host.waitForFunction(() => window.inputs.at(-1)?.buttons === 0);
  assert.equal(await host.evaluate(() => window.hostAudioTrack.readyState), 'live');
  await host.evaluate(() => window.room.close());
  await guest.waitForFunction(() => window.guestStates.at(-1) === 'closed');
  assert.equal(await guest.evaluate(() => document.querySelector('video').srcObject), null);
}

test('two Chromium clients exchange live media and second-player controls', { timeout: 35_000 }, (t) => testBrowserMatch(t, false));
test('two Chromium clients play through PeerJS signaling on a static host', { timeout: 40_000 }, (t) => testBrowserMatch(t, true));
