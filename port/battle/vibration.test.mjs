import assert from "node:assert/strict";
import test from "node:test";
import { buildTracks } from "./extract-vibration.mjs";
import { clipVibration, matchVibration } from "./vibration.mjs";
import tracks from "./vibration.json" with {type:"json"};

test("every published controller track reproduces the original animation tags", () => {
  assert.deepEqual(tracks, buildTracks());
  assert.equal(Object.keys(tracks.common).length, 307);
  assert.equal(Object.keys(tracks.global).length, 375);
});

test("a clip frame selects its motor level across skips, interrupts, rewinds and restarts", () => {
  const ram = new DataView(new ArrayBuffer(512)), actor = 32;
  const sample = (bank, clip, frame) => {
    ram.setUint32(actor+0x84, bank, true);
    ram.setUint32(actor+(bank ? 0x8c : 0x88), clip, true);
    ram.setFloat32(actor+0x9c, frame, true);
    return clipVibration(ram, actor);
  };
  for (const [frame, level] of [[0,0], [6.9,0], [7,2], [12.9,2], [13,0], [39,2], [46,0], [8,2]]) {
    assert.equal(sample(3,3,frame), level);
  }
  assert.equal(sample(0,119,14),0);
  assert.equal(sample(0,119,15),1);
  assert.equal(sample(0,0,15),0);
  // The original tag list contains two commands at frame 24. The last one wins.
  assert.equal(sample(1,5,24),0);
});

test("sustained effects renew for their own seat and stop immediately on pause or clip change", () => {
  const ram = new DataView(new ArrayBuffer(512)), actors = [0,256], sent = [];
  const output = matchVibration(actors, (slot,level) => sent.push([slot,level]));
  ram.setUint32(256+0x88, 121, true);
  output.tick(ram);
  for (let tick=0; tick<6; tick++) output.tick(ram);
  output.stop();
  output.stop();
  assert.deepEqual(sent, [[1,2],[1,2],[1,0]]);
  output.tick(ram);
  ram.setUint32(256+0x88, 0, true);
  output.tick(ram);
  assert.deepEqual(sent.slice(-2), [[1,2],[1,0]]);
});
