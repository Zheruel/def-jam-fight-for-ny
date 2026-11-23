import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyHitChannelDelta, tickFighterMomentum } from './combat.mjs';

const baseFighter = {
  momentum: 83,
  blazinTimer: 0.5,
  fighterFlags: 0,
  hitFlags: 0,
  blazinFlags: 0,
};
const baseTick = { matchFlags: 0, elapsedTicks: 0.75, expiryRate: 0.9 };

test('the hit delta modifies one channel and floors it at zero', () => {
  const channels = [15, 20, 25, 30, 35];
  applyHitChannelDelta(channels, 2, -5);
  applyHitChannelDelta(channels, 1, -23);
  assert.deepEqual(channels, [15, 0, 20, 30, 35]);
});

test('momentum expiry resets the timer, and each gate follows its own branch', () => {
  assert.deepEqual(tickFighterMomentum(baseFighter, baseTick), {
    momentum: 82.4937515258789,
    blazinTimer: 30,
  });
  assert.deepEqual(tickFighterMomentum(baseFighter, { ...baseTick, elapsedTicks: 0.25 }), {
    momentum: 83,
    blazinTimer: 0.25,
  });
  assert.deepEqual(tickFighterMomentum({ ...baseFighter, blazinFlags: 2 }, baseTick), {
    momentum: 83,
    blazinTimer: 0.5,
  });
  assert.deepEqual(tickFighterMomentum({ ...baseFighter, hitFlags: 0x20 }, baseTick), {
    momentum: 83,
    blazinTimer: 0.5,
  });
  assert.deepEqual(tickFighterMomentum(
    { ...baseFighter, momentum: 40, fighterFlags: 0x4000 },
    { ...baseTick, elapsedTicks: 12, expiryRate: 1 },
  ), { momentum: 39.5, blazinTimer: 0.5 });
  assert.equal(tickFighterMomentum({ ...baseFighter, momentum: 20 }, baseTick).momentum, 20);
  assert.deepEqual(tickFighterMomentum(
    { ...baseFighter, momentum: 18 },
    { ...baseTick, matchFlags: 4 },
  ), { momentum: 18, blazinTimer: 0.5 });
});

function floatBits(values) {
  return Array.from(new Uint32Array(Float32Array.from(values).buffer));
}

const retailElf = process.env.DEFJAM_RETAIL_ELF;
test('combat outputs match the retail machine code bit for bit', {
  skip: !retailElf && 'Set DEFJAM_RETAIL_ELF to a verified local SLUS_210.04 file.',
}, () => {
  const cases = { hit: [], momentum: [] };
  for (let index = 0; index < 5; index++) {
    for (const delta of [-35, -0.1, 0, 1.25, 300]) {
      cases.hit.push({ channels: [0, 0.1, 20, 35, 100], index, delta });
    }
  }
  for (const matchFlags of [0, 2, 4]) {
    for (const fighterFlags of [0, 0x4000, 0x8000, 0xc001]) {
      for (const hitFlags of [0, 0x20]) {
        for (const blazinFlags of [0, 1, 2, 3, 4]) {
          for (const blazinTimer of [0.25, 0.75, 1]) {
            cases.momentum.push({
              fighter: { ...baseFighter, blazinTimer, fighterFlags, hitFlags, blazinFlags },
              tick: { ...baseTick, matchFlags },
            });
          }
        }
      }
    }
  }

  let seed = 0x8bca9c23;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < 256; i++) {
    cases.hit.push({
      channels: Array.from({ length: 5 }, () => random() * 120),
      index: i % 5,
      delta: random() * 60 - 50,
    });
    cases.momentum.push({
      fighter: { ...baseFighter, momentum: random() * 101, blazinTimer: random() * 30 },
      tick: { ...baseTick, elapsedTicks: random() * 50, expiryRate: random() * 2 },
    });
  }

  const oracle = spawnSync(
    process.env.DEFJAM_UNICORN_PYTHON ?? 'python3',
    [fileURLToPath(new URL('./retail-oracle.py', import.meta.url)), retailElf],
    { input: JSON.stringify(cases), encoding: 'utf8' },
  );
  assert.ifError(oracle.error);
  assert.equal(oracle.status, 0, oracle.stderr);
  const expected = JSON.parse(oracle.stdout);
  assert.equal(expected.hit.length, cases.hit.length);
  assert.equal(expected.momentum.length, cases.momentum.length);

  cases.hit.forEach(({ channels, index, delta }, i) => {
    applyHitChannelDelta(channels, index, delta);
    assert.deepEqual(floatBits(channels), expected.hit[i], `hit case ${i}`);
  });
  cases.momentum.forEach(({ fighter, tick }, i) => {
    const { momentum, blazinTimer } = tickFighterMomentum(fighter, tick);
    assert.deepEqual(floatBits([momentum, blazinTimer]), expected.momentum[i], `momentum case ${i}`);
  });
});
