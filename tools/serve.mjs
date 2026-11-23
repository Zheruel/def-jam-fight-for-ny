import { createServer } from 'node:http';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { portFiles } from './port-files.mjs';
import { peerConfiguration } from './ice.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeRoutes = new Set(portFiles.map(file => '/' + file));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function byteRange(header, size) {
  if (!header) return [0, size - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || !(match[1] || match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return start <= end && Number.isSafeInteger(start) ? [start, end] : null;
}

export function gameServer(directory = root, { reference = false } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const fail = status => res.writeHead(status).end();
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405);
    let name;
    try { name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return fail(400); }
    if (name === '/netplay/config') {
      try {
        const config = JSON.stringify(peerConfiguration());
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : config);
      } catch { fail(503); }
      return;
    }
    if (name === '/' || name === '/index.html') name = '/web/launch.html';
    if (name === '/reference.html') name = '/web/index.html';
    if (reference && name === '/disc/reference.iso') name = '/private/ps2/reference.iso';
    else if (!nativeRoutes.has(name) && !/^\/(game-assets\/(manifest\.json|blocks\/[0-9a-f]{64}\.gz)$|web\/|runtime\/play-build\/|netplay\/(client\.mjs|peerjs\.mjs|vendor\/[a-zA-Z0-9._-]+)$|ps2\/battle\/(overlay\.mjs|battle-patch\.json)$|ps2\/content\/unlock-disc-patch\.json$)/.test(name)) return fail(404);
    if (name.split('/').some(part => part.startsWith('.')) || /[\\\0]/.test(name)) return fail(404);
    let file;
    try {
      const filename = path.join(directory, name);
      if (await realpath(filename) !== path.join(await realpath(directory), name)) return fail(404);
      file = await open(filename);
      const stat = await file.stat();
      if (!stat.isFile()) { await file.close(); return fail(404); }
      const range = byteRange(req.headers.range, stat.size);
      res.setHeader('Accept-Ranges', 'bytes');
      if (!range) {
        await file.close();
        res.setHeader('Content-Range', 'bytes */' + stat.size);
        return fail(416);
      }
      const [start, end] = range;
      res.setHeader('Content-Type', types[path.extname(name)] || 'application/octet-stream');
      res.setHeader('Content-Length', end - start + 1);
      if (req.headers.range) res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
      res.writeHead(req.headers.range ? 206 : 200);
      if (req.method === 'HEAD' || !stat.size) { await file.close(); res.end(); return; }
      const body = file.createReadStream({ start, end });
      res.on('close', () => body.destroy());
      body.on('error', () => res.destroy());
      body.pipe(res);
    } catch {
      await file?.close().catch(() => {});
      if (!res.headersSent) fail(404);
      else res.destroy();
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  peerConfiguration(); // Fail before listening if relay configuration is incomplete.
  const server = gameServer();
  const { attachNetplay } = await import('../netplay/server.mjs');
  attachNetplay(server);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(Number(process.env.PORT || 8174), host, () => {
    console.log('Def Jam development server at http://' + host + ':' + server.address().port);
  });
}
