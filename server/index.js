import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from './app.js';

const DEFAULT_PORT = 4189;
const HOST = '127.0.0.1';
// Resolve installation assets and the existing default data directory from this
// entry point, never from the caller's shell directory.
const toolRoot = fileURLToPath(new URL('../', import.meta.url));
const rawPort = process.env.PORT ?? `${DEFAULT_PORT}`;
const configOverride = process.env.LVM_CONFIG_PATH;

if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
  console.error('服务启动失败：PORT 必须是 1–65535 的整数。请修正或取消 PORT 环境变量（默认 4189）。');
  process.exitCode = 1;
} else if (configOverride !== undefined && (!configOverride || !path.isAbsolute(configOverride))) {
  console.error('服务启动失败：LVM_CONFIG_PATH 必须是配置文件的绝对路径。取消此变量可使用工具目录下 .local/projects.json。');
  process.exitCode = 1;
} else {
  const port = Number(rawPort);
  const configPath = configOverride || path.join(toolRoot, '.local/projects.json');
  const frontendDir = path.join(toolRoot, 'frontend');
  const { server, setListeningPort } = createAppServer({ port, configPath, frontendDir });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`服务启动失败：端口 ${port} 已被占用。请停止已有服务，或设置 PORT 为其他端口后重试。`);
    } else {
      console.error(`服务运行异常: ${err.code || err.message}。请检查端口权限及启动环境。`);
    }
    process.exitCode = 1;
  });

  server.listen(port, HOST, () => {
    setListeningPort(port);
    console.log(`版本管理服务已启动: http://${HOST}:${port}/`);
    console.log(`配置文件: ${configPath}`);
    console.log('按 Ctrl+C 停止服务；正在进行的请求完成后退出。迁移工具不会改写已登记的源码或材料路径，失效时请重新选定关联。');
  });

  let stopping = false;
  function handleShutdown() {
    if (stopping) return;
    stopping = true;
    console.log('正在停止服务，等待当前请求完成…');
    server.close(() => {
      console.log('服务已停止。');
    });
    server.closeIdleConnections();
  }
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}
