import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gameServer } from '../tools/serve.mjs';

test('local disc supports HEAD and bounded random reads, other private data stays private', async t => {
  const root = await mkdtemp(join(tmpdir(), 'def-jam-'));
  await mkdir(join(root, 'private'));
  await writeFile(join(root, 'private/reference.iso'), 'GNWE69');
  const server = gameServer(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true });
  });
  const get = (path, options) => fetch('http://127.0.0.1:' + server.address().port + path, options);
  const route = '/disc/reference.iso';
  const head = await get(route, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '6');
  assert.equal(head.headers.get('cross-origin-embedder-policy'), 'require-corp');
  for (const [range, data] of [['1-3', 'NWE'], ['4-', '69'], ['-3', 'E69']]) {
    const r = await get(route, { headers: { Range: 'bytes=' + range } });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), data);
  }
  assert.equal((await get(route, { headers: { Range: 'bytes=9-' } })).status, 416);
  assert.equal((await get('/private/reference.iso')).status, 404);
  assert.equal((await get('/.git/config')).status, 404);
});
