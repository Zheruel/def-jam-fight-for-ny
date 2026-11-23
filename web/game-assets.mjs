// The PS2 accesses a logical byte address. Serve the corresponding game data on demand.
export const publishedBlocks = 'https://raw.githubusercontent.com/Zheruel/def-jam-fight-for-ny/b7c9189f26f826178e725116652f5a0e363e158f/blocks/';
const manifestUrl = new URL('../game-assets/manifest.json', import.meta.url);
const hashPattern = /^[0-9a-f]{64}$/;

export async function openGameAssets() {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error('The game content manifest is unavailable. Reload to retry.');
  const manifest = await response.json();
  const base = location.hostname.endsWith('.github.io') ? publishedBlocks : new URL('blocks/', manifestUrl);
  return packageReader(manifest, base);
}

export function packageReader(manifest, base, fetchAsset = fetch) {
  const { size, blockSize, blocks } = manifest;
  if (manifest.format !== 'def-jam-game-assets-v1' || manifest.serial !== 'SLUS-21004' ||
      manifest.compression !== 'gzip' || !Number.isSafeInteger(size) || size < 1 ||
      !Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 8 * 1024 * 1024 ||
      !Array.isArray(blocks) || blocks.length !== Math.ceil(size / blockSize) ||
      !blocks.every(id => id === null || (typeof id === 'string' && hashPattern.test(id)))) {
    throw new Error('The game content manifest is invalid.');
  }
  const cache = new Map();
  async function load(id, length) {
    const url = new URL(id + '.gz', base);
    let response = await fetchAsset(url);
    if (response.status === 404 && !url.href.startsWith(publishedBlocks)) {
      response = await fetchAsset(new URL(id + '.gz', publishedBlocks));
    }
    if (!response.ok) throw new Error('Game data could not be loaded. Reload to retry.');
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    if (data.length !== length) throw new Error('A game data block is incomplete.');
    const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const hex = Array.from(sum, n => n.toString(16).padStart(2, '0')).join('');
    if (hex !== id) throw new Error('A game data block failed its integrity check.');
    return data;
  }
  function block(id, length) {
    let pending = cache.get(id);
    cache.delete(id);
    if (!pending) {
      pending = load(id, length);
      pending.catch(() => { if (cache.get(id) === pending) cache.delete(id); });
    }
    cache.set(id, pending);
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    return pending;
  }
  return { size, async read(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || length > size - offset || offset > size) {
      throw new RangeError('Game read lies outside the content package.');
    }
    const result = new Uint8Array(length);
    for (let copied = 0; copied < length;) {
      const pos = offset + copied;
      const index = Math.floor(pos / blockSize);
      const start = pos % blockSize;
      const count = Math.min(length - copied, blockSize - start);
      const id = blocks[index];
      if (id !== null) {
        const data = await block(id, Math.min(size - index * blockSize, blockSize));
        result.set(data.subarray(start, start + count), copied);
      }
      copied += count;
    }
    return result;
  } };
}
