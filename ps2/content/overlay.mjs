// Read-time unlock patch for the US PS2 disc (SLUS-21004).
//
// withUnlocks(source, manifest) wraps a disc source { size, read(offset, length) } so reads of
// SLUS_210.04 return the patched executable from unlock-disc-patch.json. The ISO on disk is
// never modified. Every range is checked against the retail SHA-256 first, so a different
// disc or an already patched image is refused. The manifest uses the same range format as
// ps2/battle/battle-patch.json, so the two can also be concatenated into one overlay.

export const UNLOCK_FORMAT = 'def-jam-ps2-battle-patch/1';

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function fromHex(text) {
  if (typeof text !== 'string' || !text.length || text.length % 2 || /[^0-9a-f]/i.test(text))
    throw new Error('Invalid hex in unlock patch manifest.');
  return Uint8Array.from(text.match(/../g), byte => parseInt(byte, 16));
}

export function unlockRanges(manifest) {
  if (manifest?.format !== UNLOCK_FORMAT) throw new Error('Unknown unlock patch manifest format.');
  const ranges = manifest.patches.map(patch => {
    if (!Number.isSafeInteger(patch.isoOffset) || patch.isoOffset < 0) throw new Error('Invalid unlock patch range.');
    const bytes = fromHex(patch.replacement);
    return { id: patch.id, start: patch.isoOffset, end: patch.isoOffset + bytes.length, bytes,
      originalSha256: patch.originalSha256 };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start < ranges[i - 1].end) throw new Error('Overlapping unlock patch ranges.');
  return ranges;
}

export async function withUnlocks(source, manifest, { onPatchedRead } = {}) {
  const ranges = unlockRanges(manifest);
  if (source.size !== manifest.disc.size) throw new Error('The unlock patch needs the US PS2 disc (SLUS-21004).');
  for (const range of ranges) {
    const original = await source.read(range.start, range.end - range.start);
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', original)));
    if (digest !== range.originalSha256)
      throw new Error(hex(original) === hex(range.bytes)
        ? 'This disc image already contains the unlock patch.'
        : 'Disc bytes for unlock range ' + range.id + ' do not match retail SLUS-21004.');
  }
  return {
    size: source.size,
    async read(offset, length) {
      const data = new Uint8Array(await source.read(offset, length));
      const end = offset + data.length;
      let touched = false;
      for (const range of ranges) {
        if (range.end <= offset) continue;
        if (range.start >= end) break;
        const from = Math.max(offset, range.start), to = Math.min(end, range.end);
        data.set(range.bytes.subarray(from - range.start, to - range.start), from - offset);
        touched = true;
      }
      if (touched) onPatchedRead?.(offset, length);
      return data;
    }
  };
}
