// kagemai — 開発/テスト用の簡易静的サーバ(依存パッケージなし)
// 使い方: node scripts/server.mjs [--port 4173] [--host 0.0.0.0] [--cert cert.pem --key key.pem]
// LAN のスマホ実機で確認する場合は HTTPS が必要(README 参照)。

import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const port = Number(opt('port', 4173));
const host = opt('host', '127.0.0.1');
const certPath = opt('cert', null);
const keyPath = opt('key', null);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.md': 'text/plain; charset=utf-8',
};

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

let server;
let scheme = 'http';
if (certPath && keyPath) {
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  server = https.createServer({ cert, key }, handler);
  scheme = 'https';
} else {
  server = http.createServer(handler);
}

server.listen(port, host, () => {
  console.log(`kagemai: ${scheme}://${host}:${port}/`);
});
