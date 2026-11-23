// Headless Chrome check of the venue audio module against the shipped files: for every selectable
// venue, cold boot fetches nothing, starting fetches only that venue's bed, the decoded buffer has
// the recorded length, the host stream carries signal, and a cue plays through the same stream.
//   node port/audio/browser-check.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "../../netplay/node_modules/playwright/index.mjs";

const here = new URL("./", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("venues.json", here)));
const types = { ".mjs": "text/javascript", ".json": "application/json", ".ogg": "audio/ogg", ".gz": "application/gzip" };
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (name === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>audio</title>");
  if (!/^\/port\/audio\/[\w./-]+$/.test(name) || name.includes("..")) return res.writeHead(404).end();
  try {
    const data = readFileSync(new URL("../../" + name.slice(1), here));
    res.writeHead(200, { "Content-Type": types[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream" }).end(data);
  } catch { res.writeHead(404).end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({ ...(process.platform === "darwin" && { channel: "chrome" }), headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"] });
  const results = [];
  for (const venue of manifest.venues) {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", r => { const p = new URL(r.url()).pathname; if (p.startsWith("/port/audio/")) requests.push(p.slice(12)); });
    await page.goto(origin);
    await page.evaluate(() => {
      window.decoded = [];
      const decode = AudioContext.prototype.decodeAudioData;
      AudioContext.prototype.decodeAudioData = async function (...args) {
        const buffer = await decode.apply(this, args);
        window.decoded.push({ length: buffer.length, rate: buffer.sampleRate, channels: buffer.numberOfChannels });
        return buffer;
      };
    });
    const info = await page.evaluate(async (file) => {
      const { venueAudio } = await import("/port/audio/venue.mjs");
      const audio = venueAudio(file);
      await new Promise(r => setTimeout(r, 300));
      const before = performance.getEntriesByType("resource").map(e => new URL(e.name).pathname).filter(p => p.startsWith("/port/audio/"));
      const stream = audio.stream();
      const context = new AudioContext();
      const tap = context.createMediaStreamSource(stream), analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      tap.connect(analyser);
      await context.resume();
      let peak = 0;
      const samples = new Float32Array(analyser.fftSize);
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 120));
        analyser.getFloatTimeDomainData(samples);
        peak = Math.max(peak, ...samples.map(Math.abs));
      }
      return { before, peak, decoded: window.decoded, tracks: stream.getAudioTracks().length };
    }, venue.file);
    assert.deepEqual(info.before, ["/port/audio/venue.mjs"], venue.file + ": only the module itself loaded before start");
    const bed = manifest.beds[venue.bedBank];
    assert.deepEqual(requests, ["venue.mjs", "venues.json", bed.file], venue.file + " requests " + requests);
    assert.equal(info.tracks, 1);
    assert.equal(info.decoded.length, 1);
    assert.equal(info.decoded[0].channels, 2);
    assert.ok(Math.abs(info.decoded[0].length - bed.frames) <= 1 && info.decoded[0].rate === 48000, `${venue.file} decoded ${info.decoded[0].length} vs ${bed.frames}`);
    assert.ok(info.peak > 0.001, `${venue.file} stream is silent (peak ${info.peak})`);
    results.push(`${venue.file} ${bed.file} frames=${info.decoded[0].length} peak=${info.peak.toFixed(3)}`);
    await page.close();
  }
  // A cue reaches the same broadcast stream.
  const page = await browser.newPage();
  await page.goto(origin);
  const cue = await page.evaluate(async () => {
    const { venueAudio } = await import("/port/audio/venue.mjs");
    const audio = venueAudio("V2BG_11A");
    const stream = audio.stream();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(stream).connect(analyser);
    await context.resume();
    await audio.cue("Fighter_Big_Hits_Ring", 1);
    return { tracks: stream.getAudioTracks().length };
  });
  assert.equal(cue.tracks, 1);
  // Match music: nothing but music.json and one track is fetched on start, the track decodes to the recorded
  // length, loops on the retail loop point, is audible in the host stream and reaches a WebRTC guest.
  const musicManifest = JSON.parse(readFileSync(new URL("music.json", here)));
  for (const tune of ["hitem", "nwa"]) {
    const track = musicManifest.tracks[tune];
    const tab = await browser.newPage();
    const fetched = [];
    tab.on("request", r => { const p = new URL(r.url()).pathname; if (p.startsWith("/port/audio/")) fetched.push(p.slice(12)); });
    await tab.goto(origin);
    const heard = await tab.evaluate(async ({ tune, introSeconds }) => {
      const loops = [], decoded = [];
      const create = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function () {
        const node = create.call(this);
        const start = node.start;
        node.start = function (...a) { if (node.buffer?.duration > 60) loops.push({ loop: node.loop, loopStart: node.loopStart, loopEnd: node.loopEnd, duration: node.buffer.duration }); return start.apply(this, a); };
        return node;
      };
      const decode = AudioContext.prototype.decodeAudioData;
      AudioContext.prototype.decodeAudioData = async function (...args) {
        const buffer = await decode.apply(this, args);
        decoded.push(buffer.length);
        return buffer;
      };
      const { venueAudio } = await import("/port/audio/venue.mjs");
      const { createMusic } = await import("/port/audio/music.mjs");
      const audio = venueAudio("V2BG_02A");
      const stream = audio.stream();
      const rms = async (source, context, ms) => {
        const analyser = context.createAnalyser(); analyser.fftSize = 2048;
        source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize); let sum = 0, count = 0, peak = 0;
        for (let t = 0; t < ms; t += 100) {
          await new Promise(r => setTimeout(r, 100));
          analyser.getFloatTimeDomainData(samples);
          for (const v of samples) { sum += v * v; count++; peak = Math.max(peak, Math.abs(v)); }
        }
        return { rms: Math.sqrt(sum / count), peak };
      };
      const context = new AudioContext();
      await context.resume();
      const host = context.createMediaStreamSource(stream);
      await new Promise(r => setTimeout(r, 1500));          // bed settles
      const before = await rms(host, context, 1000);
      const music = createMusic(audio, { tune });
      await music.start();
      // a guest: the host's stream over a loopback peer connection
      const a = new RTCPeerConnection(), b = new RTCPeerConnection();
      a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
      b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
      stream.getTracks().forEach(t => a.addTrack(t, stream));
      const remote = new Promise(resolve => { b.ontrack = e => resolve(e.streams[0]); });
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
      const remoteStream = await remote;
      const element = new Audio();                       // Chrome only feeds a remote stream to Web Audio while a media element holds it
      element.srcObject = remoteStream; element.muted = true;
      await element.play().catch(() => {});
      const guest = context.createMediaStreamSource(remoteStream);
      const after = await rms(host, context, 1500);
      const guestHeard = await rms(guest, context, 1500);
      music.stop();
      return { before, after, guestHeard, loops, decoded, current: tune, introSeconds };
    }, { tune, introSeconds: track.introSeconds });
    assert.deepEqual(fetched.filter(p => p.startsWith("music")), ["music.mjs", "music.json", track.file], tune + " fetches only the module, its manifest and its track");
    const long = heard.loops.at(-1);
    assert.ok(long, tune + " track source started");
    assert.equal(long.loop, track.loops);
    if (track.loops) assert.ok(Math.abs(long.loopStart - track.introSeconds) < 1e-9 && Math.abs(long.loopEnd - long.duration) < 1e-9);
    assert.ok(heard.decoded.some(n => Math.abs(n - Math.round(track.seconds * 48000)) <= 2), `${tune} decoded length ${heard.decoded}`);
    assert.ok(heard.after.rms > heard.before.rms * 1.2, `${tune} host mix rises ${heard.before.rms} -> ${heard.after.rms}`);
    assert.ok(heard.guestHeard.rms > 0.005, `${tune} reaches a WebRTC guest (rms ${heard.guestHeard.rms})`);
    console.log(`music ${tune}: host rms ${heard.before.rms.toFixed(3)} -> ${heard.after.rms.toFixed(3)}, guest rms ${heard.guestHeard.rms.toFixed(3)}, ${track.loops ? "loops at " + track.introSeconds.toFixed(2) + "s" : "plays once"}`);
    await tab.close();
  }
  console.log(results.join("\n"));
  console.log(`ok: ${results.length} venues`);
} finally {
  await browser?.close();
  server.close();
}
