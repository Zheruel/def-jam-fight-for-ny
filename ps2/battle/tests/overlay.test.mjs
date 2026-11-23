// node --test ps2/battle/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, openSync, readSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PATCH_FORMAT, applyRanges, parseManifest, withBattlePatch } from '../overlay.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = bytes => Buffer.from(bytes).toString('hex');

function memorySource(bytes) {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}

function fixture() {
  const disc = new Uint8Array(4096).map((_, i) => i & 0xff);
  const patches = [
    { id: 'b', isoOffset: 2000, replacement: 'aabbccdd' },
    { id: 'a', isoOffset: 100, replacement: '0102' }
  ].map(p => ({ ...p, originalSha256: sha(disc.subarray(p.isoOffset, p.isoOffset + p.replacement.length / 2)) }));
  return { disc, manifest: { format: PATCH_FORMAT, version: 1, disc: { size: disc.length }, patches } };
}

test('parseManifest sorts ranges and rejects bad input', () => {
  const { manifest } = fixture();
  assert.deepEqual(parseManifest(manifest).map(r => [r.id, r.start, r.end]), [['a', 100, 102], ['b', 2000, 2004]]);
  assert.throws(() => parseManifest({ ...manifest, format: 'x' }), /format/);
  const overlap = structuredClone(manifest);
  overlap.patches[1].isoOffset = 2002;
  assert.throws(() => parseManifest(overlap), /Overlapping/);
  const badHex = structuredClone(manifest);
  badHex.patches[0].replacement = 'zz';
  assert.throws(() => parseManifest(badHex), /hex/);
  const outside = structuredClone(manifest);
  outside.patches[0].isoOffset = 4095;
  assert.throws(() => parseManifest(outside), /outside/);
});

test('applyRanges handles reads that cut through a patch', () => {
  const ranges = parseManifest(fixture().manifest);
  const data = new Uint8Array(4);
  assert.equal(applyRanges(ranges, 1998, data), true);
  assert.deepEqual([...data], [0, 0, 0xaa, 0xbb]);
  const tail = new Uint8Array(3);
  applyRanges(ranges, 2002, tail);
  assert.deepEqual([...tail], [0xcc, 0xdd, 0]);
  assert.equal(applyRanges(ranges, 500, new Uint8Array(100)), false);
});

test('withBattlePatch patches reads without touching the source', async () => {
  const { disc, manifest } = fixture();
  const before = hex(disc);
  let patchedReads = 0;
  const source = await withBattlePatch(memorySource(disc), manifest, { onPatchedRead: () => patchedReads++ });
  const all = await source.read(0, disc.length);
  assert.equal(hex(all.subarray(100, 102)), '0102');
  assert.equal(hex(all.subarray(2000, 2004)), 'aabbccdd');
  assert.equal(hex(all.subarray(102, 2000)), hex(disc.subarray(102, 2000)));
  assert.equal(hex(disc), before);
  assert.equal(patchedReads, 1);
  assert.equal(hex(await source.read(3000, 16)), hex(disc.subarray(3000, 3016)));
  assert.equal(patchedReads, 1);
});

test('withBattlePatch refuses other discs and already patched images', async () => {
  const { disc, manifest } = fixture();
  await assert.rejects(withBattlePatch(memorySource(disc.subarray(0, 4000)), manifest), /US PS2 disc/);
  const other = disc.slice();
  other[101] ^= 1;
  await assert.rejects(withBattlePatch(memorySource(other), manifest), /do not match retail/);
  const patched = disc.slice();
  for (const range of parseManifest(manifest)) applyRanges([range], 0, patched);
  await assert.rejects(withBattlePatch(memorySource(patched), manifest), /already has the Battle patch/);
});

const ISO = path.join(REPO, 'private/ps2/reference.iso');
const MANIFEST = path.join(REPO, 'ps2/battle/battle-patch.json');
const retail = existsSync(ISO) && existsSync(MANIFEST);

test('overlay over the retail disc', { skip: !retail && 'needs private/ps2/reference.iso and battle-patch.json' }, async () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const fd = openSync(ISO, 'r');
  const file = {
    size: statSync(ISO).size,
    async read(offset, length) {
      const buffer = new Uint8Array(length);
      readSync(fd, buffer, 0, length, offset);
      return buffer;
    }
  };
  const source = await withBattlePatch(file, manifest);
  assert.equal(source.size, 4694573056);
  for (const patch of manifest.patches) {
    const length = patch.replacement.length / 2;
    // Read a window around the range, misaligned on purpose.
    const data = await source.read(patch.isoOffset - 3, length + 7);
    assert.equal(hex(data.subarray(3, 3 + length)), patch.replacement, patch.id);
    assert.equal(hex(data.subarray(0, 3)), hex(await file.read(patch.isoOffset - 3, 3)));
  }
  const pvd = await source.read(16 * 2048, 2048);
  assert.equal(Buffer.from(pvd.subarray(1, 6)).toString(), 'CD001');
});
