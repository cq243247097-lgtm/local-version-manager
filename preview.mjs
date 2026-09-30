import http from 'node:http';
import { readFile } from 'node:fs/promises';

// Read-only UI preview. No repository access or release operations.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const server = http.createServer(async (request, response) => {
  const asset = assets.get(request.url?.split('?')[0]);
  if (!asset || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(new URL(`./frontend/${asset[0]}`, import.meta.url));
    response.writeHead(200, {
      'Content-Type': asset[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    response.writeHead(500).end('Preview unavailable');
  }
});
server.on('error', (error) => {
  console.error(`Preview failed: ${error.code || 'unknown error'}`);
  process.exitCode = 1;
});
server.listen(4189, '127.0.0.1', () => {
  console.log('Version manager preview: http://127.0.0.1:4189/');
});
