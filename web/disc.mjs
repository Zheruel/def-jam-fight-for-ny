// Play! calls these reads asynchronously, including offsets above 4 GiB.
export async function localDisc() {
  const url = '/disc/reference.iso';
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error('The PS2 disc is missing from private/ps2/reference.iso.');
  const size = Number(head.headers.get('content-length'));
  const blockSize = 512 * 1024;
  const blocks = new Map();
  async function block(index) {
    if (blocks.has(index)) {
      const cached = blocks.get(index);
      blocks.delete(index);
      blocks.set(index, cached);
      return cached;
    }
    const start = index * blockSize;
    const end = Math.min(size, start + blockSize) - 1;
    const response = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } });
    if (response.status !== 206) throw new Error('Disc server must support byte ranges.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - start + 1) throw new Error('Incomplete disc read.');
    if (blocks.size >= 64) blocks.delete(blocks.keys().next().value);
    blocks.set(index, bytes);
    return bytes;
  }
  return {
    size,
    async read(offset, length) {
      const result = new Uint8Array(length);
      let copied = 0;
      while (copied < length) {
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

export const fileDisc = file => ({
  size: file.size,
  read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
});

export async function verifyTitle(source) {
  const decoder = new TextDecoder();
  const pvd = await source.read(32768, 2048);
  if (pvd.length !== 2048 || decoder.decode(pvd.subarray(1, 6)) !== 'CD001')
    throw new Error('Choose the US PS2 DVD in raw ISO format.');
  const view = new DataView(pvd.buffer, pvd.byteOffset);
  const size = view.getUint32(166, true);
  if (!size || size > 4 * 1024 * 1024) throw new Error('Invalid ISO root directory.');
  const root = await source.read(view.getUint32(158, true) * 2048, size);
  if (!decoder.decode(root).includes('SLUS_210.04;1'))
    throw new Error('Expected the US PlayStation 2 release, SLUS-21004.');
}
