// node --test ps2/content/tests/overlay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unlockRanges, withUnlocks } from '../overlay.mjs';

const manifest = JSON.parse(readFileSync(new URL('../unlock-disc-patch.json', import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// A fake disc whose bytes inside every patched range hash to the manifest's originals is not
// constructible, so the retail check is exercised with a stub manifest of the same shape.
function stub(size = 4096) {
  const disc = new Uint8Array(size).map((_, i) => i & 0xff);
  const original = disc.slice(100, 108);
  return {
    disc,
    source: { size, read: async (o, n) => disc.slice(o, o + n) },
    manifest: { format: manifest.format, disc: { size }, patches: [
      { id: 'a', isoOffset: 100, replacement: '0011223344556677', originalSha256: sha(original) }] }
  };
}

test('checked-in manifest parses into sorted, non-overlapping ELF ranges', () => {
  const ranges = unlockRanges(manifest);
  assert.equal(ranges.length, manifest.patches.length);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i].start >= ranges[i - 1].end);
  assert.equal(manifest.disc.sha1, '5eda39dfd703804c8734b91bd23039f642317837');
});

test('reads crossing a patched range return the replacement bytes', async () => {
  const { source, manifest: m } = stub();
  const patched = await withUnlocks(source, m);
  const data = await patched.read(96, 16);
  assert.deepEqual([...data.slice(4, 12)], [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  assert.deepEqual([...data.slice(0, 4)], [96, 97, 98, 99]);
  assert.deepEqual([...data.slice(12)], [108, 109, 110, 111]);
});

test('refuses non-retail bytes and already patched images', async () => {
  const { source, disc, manifest: m } = stub();
  disc[101] ^= 1;
  await assert.rejects(withUnlocks(source, m), /do not match retail/);
  disc.set([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77], 100);
  await assert.rejects(withUnlocks(source, m), /already contains/);
});
