import path from 'node:path';
import { createAppServer } from './app.js';

const DEFAULT_PORT = 4189;
const HOST = '127.0.0.1';

const port = parseInt(process.env.PORT || `${DEFAULT_PORT}`, 10) || DEFAULT_PORT;
const configPath = path.resolve('.local/projects.json');
const frontendDir = path.resolve('frontend');

const { server, setListeningPort } = createAppServer({
  port,
  configPath,
  frontendDir,
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`服务启动失败：端口 ${port} 已被占用。请检查是否已有服务正在运行。`);
  } else {
    console.error(`服务运行异常: ${err.code || err.message}`);
  }
  process.exitCode = 1;
});

server.listen(port, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  setListeningPort(actualPort);
  console.log(`版本管理服务已启动: http://${HOST}:${actualPort}/`);
});

function handleShutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
