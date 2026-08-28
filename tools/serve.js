'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requestedPort = Number(process.env.CUELAB_PORT || 8080);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 8080;
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((request, response) => {
  // Malformed percent-encodings and null bytes must yield a response, not an
  // uncaught throw that kills the process for every later visitor.
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request'); return;
  }
  if (pathname.includes('\0')) {
    response.writeHead(400).end('Bad request'); return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filename = path.resolve(root, `.${requested}`);
  if (!filename.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden'); return;
  }
  fs.readFile(filename, (error, data) => {
    if (error) {
      const missing = error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR';
      response.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Server error');
      return;
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(data);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use; set CUELAB_PORT to pick another.`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`CueLab is running at http://localhost:${port}`);
});
