import assert from 'node:assert/strict';
import test from 'node:test';
import { localDisc, verifyTitle } from '../web/disc.mjs';

test('installed disc reads across 4 GiB and reuses cached blocks', async t => {
  const size = 4694573056;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_, request) => {
    if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': size } });
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.Range).map(Number);
    calls.push(start);
    const data = new Uint8Array(end - start + 1).fill(start >= 2 ** 32 ? 2 : 1);
    return new Response(data, { status: 206 });
  });
  const disc = await localDisc();
  assert.deepEqual([...await disc.read(2 ** 32 - 1, 3)], [1, 2, 2]);
  assert.deepEqual([...await disc.read(2 ** 32 + 1, 1)], [2]);
  assert.equal(calls.length, 2);
});

test('title check rejects a non-ISO file', async () => {
  await assert.rejects(verifyTitle({ read: async () => new Uint8Array(2048) }), /raw ISO/);
});
