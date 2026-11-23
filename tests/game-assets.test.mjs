import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { packageReader } from '../web/game-assets.mjs';

function manifest(blocks) {
  return { format: 'def-jam-game-assets-v1', serial: 'SLUS-21004', compression: 'gzip',
    blockSize: 3, size: 8, blocks };
}
const sha = data => createHash('sha256').update(data).digest('hex');

test('reads and verifies compressed game blocks across gaps and the short final block', async () => {
  const first = Buffer.from('abc'), last = Buffer.from('xy');
  const assets = new Map([first, last].map(data => [sha(data), gzipSync(data)]));
  const calls = [];
  const reader = packageReader(manifest([sha(first), null, sha(last)]), 'https://assets.test/', async url => {
    calls.push(url.href);
    return new Response(assets.get(url.pathname.slice(1, -3)));
  });
  const [a,b] = await Promise.all([reader.read(1, 7), reader.read(6, 2)]);
  assert.deepEqual([...a], [...Buffer.from('bc\0\0\0xy')]);
  assert.deepEqual([...b], [...last]);
  assert.equal(calls.length, 2);
  await assert.rejects(reader.read(7, 2), RangeError);
});

test('a corrupt game block fails and a retry can fetch it again', async () => {
  let count = 0;
  const id = sha('abc');
  const reader = packageReader(manifest([id, null, null]), 'https://assets.test/', async () =>
    new Response(gzipSync(count++ ? 'abc' : 'bad')));
  await assert.rejects(reader.read(1, 1), /integrity/);
  assert.equal((await reader.read(1, 1))[0], 98);
});
