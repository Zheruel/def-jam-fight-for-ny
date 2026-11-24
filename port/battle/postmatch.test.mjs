import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { planPostmatch } from "../hud/postmatch.mjs";
import { postmatchFiles } from "../hud/postmatch-files.mjs";

const root = new URL("../../", import.meta.url);
const stats = JSON.parse(readFileSync(new URL("port/hud/postmatch/stats.json", root)));
const fighters = [{ handle: "0x07000030", name: "Blaze", cpu: false, seat: 0 }, { handle: "0x07000034", name: "Crack", cpu: true, seat: 1 }];
const won = { result: true, draw: false, winners: [0] };

test("every fighter gets a panel, CPU ones marked, and the winner is flagged", () => {
  const plan = planPostmatch(fighters, won, [500, 1000]);
  assert.equal(plan.sheet, 2);
  assert.deepEqual(plan.panels.map(p => [p.name, p.cpu, p.winner, p.score]), [["BLAZE", false, true, 500], ["CRACK", true, false, 1000]]);
});

test("the reference capture's counters give its TOTAL POINTS and $ FROM POINTS", () => {
  const counters = [Array(37).fill(0), Array(37).fill(0)];
  counters[0][15] = 6500; counters[0][19] = 1000; counters[0][20] = 5000; counters[1][27] = 1000;
  const plan = planPostmatch(fighters, won, [500, 1000], counters, stats.names);
  assert.deepEqual(plan.panels[0].rows, [{ label: "BILL OF HEALTH", value: 6500 }, { label: "CROWD FAVORITE", value: 1000 }, { label: "TIME FACTOR", value: 5000 }]);
  assert.deepEqual(plan.panels.map(p => [p.total, p.cash]), [[13000, 130], [2000, 20]]);
  assert.deepEqual(plan.panels[1].rows, [{ label: "FIRST ATTACK", value: 1000 }]);
});

test("without the retail counters the list and totals stay blank rather than invented", () => {
  const [mine] = planPostmatch(fighters, won, [500, 1000]).panels;
  assert.equal(mine.rows, null);
  assert.equal(mine.total, null);
  assert.equal(mine.cash, null);
});

test("sheet size follows the fighter count; a draw flags no winner; a lone loser skips", () => {
  const four = Array.from({ length: 4 }, (_, i) => ({ handle: "0x07000030", name: "Blaze", cpu: i > 0, seat: i }));
  assert.equal(planPostmatch(four, won, []).sheet, 4);
  assert.equal(planPostmatch(four.slice(0, 3), won, []).sheet, 3);
  assert.ok(planPostmatch(fighters, { result: true, draw: true, winners: [] }, []).panels.every(p => !p.winner));
  assert.equal(planPostmatch(four.slice(0, 1), { result: true, winners: [1] }, []), null);
  assert.equal(planPostmatch(four.slice(0, 1), won, []).sheet, 1);
  assert.equal(planPostmatch(fighters, { result: false }, []), null);
  assert.equal(planPostmatch([...four, four[0]], won, []), null);
});

test("every file the sheet can request exists", () => {
  const missing = postmatchFiles.filter(file => !existsSync(new URL(file, root)));
  assert.deepEqual(missing, []);
});
