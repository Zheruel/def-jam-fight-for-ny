// Read-time Battle-only patch for the US PS2 disc (SLUS-21004).
//
// A disc source is { size, read(offset, length) -> Promise<Uint8Array> }, the shape
// web/disc.mjs already produces. withBattlePatch wraps one so that every read returns the
// patched bytes from battle-patch.json, leaving the ISO on disk untouched. Before it
// returns, it reads each patched range from the source and checks its SHA-256 against
// the retail bytes, so a different disc or an already patched image is refused.

export const PATCH_FORMAT = 'def-jam-ps2-battle-patch/1';

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function fromHex(text) {
  if (typeof text !== 'string' || text.length % 2 || /[^0-9a-f]/i.test(text))
    throw new Error('Invalid hex in Battle patch manifest.');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
  return out;
}

async function sha256(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

// Validates the manifest and returns its ranges, sorted and non-overlapping.
export function parseManifest(manifest) {
  if (manifest?.format !== PATCH_FORMAT) throw new Error('Unknown Battle patch manifest format.');
  const ranges = manifest.patches.map(patch => {
    const bytes = fromHex(patch.replacement);
    if (!Number.isSafeInteger(patch.isoOffset) || patch.isoOffset < 0 || !bytes.length)
      throw new Error('Invalid range in Battle patch ' + patch.id + '.');
    return { id: patch.id, start: patch.isoOffset, end: patch.isoOffset + bytes.length, bytes,
      originalSha256: patch.originalSha256 };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start < ranges[i - 1].end) throw new Error('Overlapping Battle patches.');
  if (ranges.length && ranges.at(-1).end > manifest.disc.size) throw new Error('Battle patch is outside the disc.');
  return ranges;
}

// Copies the patched bytes that fall inside [offset, offset + data.length) into data.
export function applyRanges(ranges, offset, data) {
  const end = offset + data.length;
  let touched = false;
  for (const range of ranges) {
    if (range.end <= offset) continue;
    if (range.start >= end) break;
    const from = Math.max(offset, range.start);
    const to = Math.min(end, range.end);
    data.set(range.bytes.subarray(from - range.start, to - range.start), from - offset);
    touched = true;
  }
  return touched;
}

export async function withBattlePatch(source, manifest, { onPatchedRead } = {}) {
  const ranges = parseManifest(manifest);
  if (source.size !== manifest.disc.size)
    throw new Error('The Battle patch needs the US PS2 disc (SLUS-21004) as a raw ISO.');
  for (const range of ranges) {
    const original = await source.read(range.start, range.end - range.start);
    const digest = await sha256(original);
    if (digest !== range.originalSha256) {
      const alreadyPatched = hex(original) === hex(range.bytes);
      throw new Error(alreadyPatched
        ? 'This disc image already has the Battle patch; boot it without the overlay.'
        : 'Disc bytes for Battle patch ' + range.id + ' do not match retail SLUS-21004.');
    }
  }
  return {
    size: source.size,
    battlePatch: manifest.version,
    async read(offset, length) {
      const data = await source.read(offset, length);
      const copy = new Uint8Array(data); // never mutate a buffer the source may cache
      if (applyRanges(ranges, offset, copy)) onPatchedRead?.(offset, length);
      return copy;
    }
  };
}

// Byte-range reader over HTTP with a small LRU block cache (for tests and tools).
export async function httpDisc(url, { blockSize = 512 * 1024, maxBlocks = 64 } = {}) {
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error('Disc not found at ' + url);
  const size = Number(head.headers.get('content-length'));
  const blocks = new Map();
  async function block(index) {
    const cached = blocks.get(index);
    if (cached) { blocks.delete(index); blocks.set(index, cached); return cached; }
    const start = index * blockSize;
    const end = Math.min(size, start + blockSize) - 1;
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (response.status !== 206) throw new Error('Disc server must support byte ranges.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - start + 1) throw new Error('Incomplete disc read.');
    if (blocks.size >= maxBlocks) blocks.delete(blocks.keys().next().value);
    blocks.set(index, bytes);
    return bytes;
  }
  return {
    size,
    async read(offset, length) {
      const result = new Uint8Array(length);
      for (let copied = 0; copied < length;) {
        const pos = offset + copied;
        const data = await block(Math.floor(pos / blockSize));
        const start = pos % blockSize;
        const count = Math.min(length - copied, data.length - start);
        if (count <= 0) throw new Error('Disc read outside image.');
        result.set(data.subarray(start, start + count), copied);
        copied += count;
      }
      return result;
    }
  };
}
