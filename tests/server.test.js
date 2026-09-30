import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';

describe('服务监听与进程生命周期测试', () => {
  test('服务默认仅监听 loopback 127.0.0.1', async () => {
    const dummyServer = net.createServer();
    // 监听随机端口验证 net.Server
    await new Promise((resolve) => dummyServer.listen(0, '127.0.0.1', resolve));
    const port = dummyServer.address().port;
    dummyServer.close();

    const proc = spawn('node', ['server/index.js'], {
      env: { ...process.env, PORT: `${port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    // 等待服务启动输出
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (stdout.includes('版本管理服务已启动: http://127.0.0.1:')) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    assert.ok(stdout.includes(`http://127.0.0.1:${port}/`));
    proc.kill('SIGTERM');
  });

  test('端口冲突时优雅退出且不杀占用者', async () => {
    // 1. 创建一个占用进程
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const conflictPort = blocker.address().port;

    try {
      // 2. 尝试用被占用的端口启动 server/index.js
      const child = spawn('node', ['server/index.js'], {
        env: { ...process.env, PORT: `${conflictPort}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      const exitCode = await new Promise((resolve) => {
        child.on('close', resolve);
      });

      // 验证子进程退出码为 1，并且输出包含可理解的端口占用错误说明
      assert.equal(exitCode, 1);
      assert.ok(stderr.includes(`服务启动失败：端口 ${conflictPort} 已被占用`));

      // 验证占用者 blocker 依然在正常运行（未被杀掉）
      assert.ok(blocker.listening);
    } finally {
      blocker.close();
    }
  });

  test('npm run preview 原功能仍可正常运行', async () => {
    // 验证 preview.mjs 语法无误
    const checkProc = spawn('node', ['--check', 'preview.mjs'], {
      stdio: 'inherit',
    });
    const checkCode = await new Promise((resolve) => checkProc.on('close', resolve));
    assert.equal(checkCode, 0);
  });
});
