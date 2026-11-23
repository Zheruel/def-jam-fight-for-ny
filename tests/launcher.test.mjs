import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { parseManifest } from '../ps2/battle/overlay.mjs';
import { gameServer } from '../tools/serve.mjs';

test('the launcher serves compatible Battle and unlock patches for the same disc', async t => {
  const server = gameServer().listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(url + '/disc/reference.iso', { method: 'HEAD' })).status, 404);
  const paths = ['/ps2/battle/battle-patch.json', '/ps2/content/unlock-disc-patch.json'];
  const [battle, unlock] = await Promise.all(paths.map(async path => {
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path);
    return response.json();
  }));
  assert.deepEqual(battle.disc, unlock.disc);
  assert.equal(battle.serial, 'SLUS-21004');
  assert.equal(unlock.serial, battle.serial);
  assert.equal(unlock.format, battle.format);
  assert.ok(battle.patches.some(p => p.file === '/SCREENS/FEFLOW.XML'));
  assert.ok(unlock.patches.some(p => p.file === '/SLUS_210.04'));
  const ranges = parseManifest({ ...battle, patches: [...battle.patches, ...unlock.patches] });
  for (const range of ranges) assert.match(range.originalSha256, /^[0-9a-f]{64}$/);
  assert.equal((await fetch(url + '/ps2/battle/overlay.mjs')).status, 200);
});
