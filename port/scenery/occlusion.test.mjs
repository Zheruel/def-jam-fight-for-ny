import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { foundationCamera } from "../battle/camera.mjs";
import { createFader, eyeOf, segmentDistance, visibility } from "./occlusion.mjs";

const here = new URL("./", import.meta.url);
const spectators = venue => JSON.parse(readFileSync(new URL(`${venue}/people.json`, here), "utf8")).spectators.map(s => s.translate);

test("the eye comes back out of the retail Foundation camera matrix", () => {
  const eye = eyeOf(foundationCamera().matrix());
  // Retail target (0,10,0), radius 133.75, pitch 0.227, four-unit offset (camera.mjs)
  assert.ok(Math.abs(eye[0]) < 1e-3 && Math.abs(eye[1] - 43.9986) < 1e-3 && Math.abs(eye[2] - 129.4185) < 1e-3, eye.join());
});

test("segment distance", () => {
  assert.equal(segmentDistance([0, 0, 0], [10, 0, 0], [5, 3, 0], [5, 3, 9]), 3);
  assert.equal(segmentDistance([0, 0, 0], [0, 0, 0], [3, 4, 0], [3, 4, 9]), 5);
  assert.equal(segmentDistance([0, 0, 0], [1, 0, 0], [5, 0, 0], [5, 9, 0]), 4);   // beyond the end of the sight line
});

test("the fight start keeps every Foundation spectator (retail shows the front row's backs)", () => {
  const eye = [0, 44, 129.4], fighters = [[-13, 0, 0], [13, 0, 0]];
  for (const position of spectators("foundation")) assert.equal(visibility(eye, fighters, position), 1, position.join());
});

test("a spectator standing on the sight line to a fighter fades out, one beside him does not", () => {
  // The Foundation result shot of a fight that ended at the crowd's edge (captured with the native page).
  const eye = [47.2, 20.6, 74.2], fighters = [[47, 0, 13], [52, 0, 19.9]];
  assert.equal(visibility(eye, fighters, [48.5, 0, 47]), 0);            // between the camera and a fighter
  assert.equal(visibility(eye, fighters, [48.5, 0, 6]), 1);             // behind a fighter: not between
  assert.equal(visibility(eye, fighters, [10, 0, 47]), 1);              // far to the side
  const partial = visibility(eye, fighters, [47 + 5.2, 0, 47]);
  assert.ok(partial > 0 && partial < 1, String(partial));               // the fade ramp
});

test("anything at the lens is hidden (the Gun Hill camera, retail 052-fight-later, is 1.6 units from a spectator)", () => {
  const eye = [-61.4, 20.9, 36.2], fighters = [[-61.4, 0, 0.1]];
  assert.equal(visibility(eye, fighters, [-66.7, 12, 34.6]), 0);        // within the lens radius
  assert.equal(visibility(eye, fighters, [-61.4, 20.9 - 3, 36.2 - 5]), 0);
  const stand = spectators("V2BG_17A");
  // Spectators well to the side of the camera keep full visibility.
  assert.equal(visibility(eye, fighters, stand.find(p => p[0] < -85 || p[2] < 10)), 1);
});

test("fades move gradually and recover", () => {
  const stand = [[0, 0, 40]], fader = createFader(stand), eye = [0, 20, 80], fighters = [[0, 0, 0]];
  const seen = [];
  for (let i = 0; i < 10; i++) seen.push(fader.update(eye, fighters)[0]);
  assert.ok(seen[0] < 1 && seen[0] > 0.8, "starts fading, not blinking");
  assert.equal(seen.at(-1), 0);
  for (let i = 0; i < 10; i++) fader.update(eye, [[40, 0, 0]]);
  assert.equal(fader.values[0], 1);
  assert.equal(createFader(stand).update(null, fighters)[0], 1, "no camera, no fade");
});
