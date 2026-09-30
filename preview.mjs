import http from 'node:http';
import { readFile } from 'node:fs/promises';

const DEFAULT_PORT = 4191;
const rawPort = process.env.PORT ?? `${DEFAULT_PORT}`;
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
  console.error('演示启动失败：PORT 必须是 1–65535 的整数。请修正或取消 PORT 环境变量（默认 4191）。');
  process.exit(1);
}
const port = Number(rawPort);

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
  console.error(error.code === 'EADDRINUSE'
    ? `演示启动失败：端口 ${port} 已被占用。请停止已有服务，或设置 PORT 为其他端口后重试。`
    : `演示启动失败：${error.code || 'unknown error'}。请检查端口权限及启动环境。`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Version manager preview: http://127.0.0.1:${port}/`);
  console.log('只读演示：不访问仓库或真实数据。按 Ctrl+C 停止。真实服务默认端口为 4189。');
});
let stopping = false;
function handleShutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => console.log('演示已停止。'));
  server.closeIdleConnections();
}
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
