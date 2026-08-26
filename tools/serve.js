'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.CUELAB_PORT || 8080);
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filename = path.resolve(root, `.${requested}`);
  if (!filename.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden'); return;
  }
  fs.readFile(filename, (error, data) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`CueLab is running at http://localhost:${port}`);
});
