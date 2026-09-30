import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createAppServer } from '../server/app.js';

function gitCmd(cwd, args) {
  const res = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C.UTF-8',
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr.toString()}`);
  }
  return res.stdout;
}

async function getDirSnapshot(dir) {
  const snapshot = new Map();
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(dir, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const content = await fs.readFile(fullPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        snapshot.set(relPath, hash);
      }
    }
  }
  await walk(dir);
  return snapshot;
}

describe('Git HTTP API 端到端测试', () => {
  let server;
  let port;
  let tempBaseDir;
  let configPath;
  let testRepoDir;

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-api-suite-'));
    configPath = path.join(tempBaseDir, 'projects.json');
    testRepoDir = path.join(tempBaseDir, 'test-project');

    await fs.mkdir(testRepoDir);
    gitCmd(testRepoDir, ['init', '-b', 'main']);
    gitCmd(testRepoDir, ['config', 'user.name', 'Tester']);
    gitCmd(testRepoDir, ['config', 'user.email', 'tester@test.com']);

    await fs.writeFile(path.join(testRepoDir, 'hello.txt'), 'hello git api');
    gitCmd(testRepoDir, ['add', '.']);
    gitCmd(testRepoDir, ['commit', '-m', 'first commit']);

    // 写入合法配置
    const configData = {
      projects: [
        {
          id: 'test_project',
          name: '测试项目',
          repositoryPath: testRepoDir,
        },
      ],
    };
    await fs.writeFile(configPath, JSON.stringify(configData));

    const app = createAppServer({ port: 0, configPath });
    server = app.server;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        app.setListeningPort(port);
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempBaseDir, { recursive: true, force: true });
  });

  async function request(pathname, options = {}) {
    return new Promise((resolve, reject) => {
      const headers = { ...options.headers };
      if (!('host' in headers)) {
        headers['host'] = `127.0.0.1:${port}`;
      }
      if (options.body !== undefined && !headers['content-length'] && !headers['transfer-encoding']) {
        const buf = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, 'utf-8');
        headers['content-length'] = buf.length;
      }

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: options.method || 'GET',
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            json,
          });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  describe('GET /api/projects/:id/source', () => {
    test('读取成功且操作前后仓库工作区、索引、引用与配置零变更', async () => {
      // 制造一个工作区变更
      await fs.writeFile(path.join(testRepoDir, 'modified.txt'), 'mod');

      const beforeSnapshot = await getDirSnapshot(testRepoDir);

      const res = await request('/api/projects/test_project/source');
      assert.equal(res.statusCode, 200);
      assert.equal(res.json.branch, 'main');
      assert.equal(res.json.headState, 'attached');
      assert.equal(res.json.changedCount, 1);
      assert.ok(res.json.scannedAt);

      const afterSnapshot = await getDirSnapshot(testRepoDir);

      // 验证快照 100% 一致（证明无写入、无 fetch、无 side-effect）
      assert.equal(beforeSnapshot.size, afterSnapshot.size);
      for (const [filePath, hash] of beforeSnapshot.entries()) {
        assert.equal(afterSnapshot.get(filePath), hash, `文件 ${filePath} 在读取后不应被修改`);
      }
    });

    test('S1: 仓库配置 core.fsmonitor 时，读取源码成功且绝不执行监控脚本，前后字节摘要一致', async () => {
      const hookPath = path.join(testRepoDir, '.git', 'hooks', 'test-source-monitor');
      await fs.mkdir(path.dirname(hookPath), { recursive: true });
      await fs.writeFile(hookPath, '#!/bin/sh\nprintf executed > .git/source-monitor-ran\nexit 1\n');
      gitCmd(testRepoDir, ['config', 'core.fsmonitor', hookPath.replaceAll('\\', '/')]);

      const markerFile = path.join(testRepoDir, '.git', 'source-monitor-ran');
      try {
        const beforeSnapshot = await getDirSnapshot(testRepoDir);

        const res = await request('/api/projects/test_project/source');
        assert.equal(res.statusCode, 200);
        assert.equal(res.json.branch, 'main');
        assert.ok(res.json.changedCount >= 1);

        // 验证监控脚本绝对未被触发
        const markerExists = await fs.access(markerFile).then(() => true, () => false);
        assert.equal(markerExists, false, 'core.fsmonitor 脚本绝不应被执行');

        const afterSnapshot = await getDirSnapshot(testRepoDir);
        assert.equal(beforeSnapshot.size, afterSnapshot.size);
        for (const [filePath, hash] of beforeSnapshot.entries()) {
          assert.equal(afterSnapshot.get(filePath), hash, `文件 ${filePath} 在读取后不应被修改`);
        }
      } finally {
        gitCmd(testRepoDir, ['config', '--unset', 'core.fsmonitor']);
        await fs.rm(hookPath, { force: true });
        await fs.rm(markerFile, { force: true });
      }
    });

    test('未知项目 ID 返回 404 PROJECT_NOT_FOUND', async () => {
      const res = await request('/api/projects/non_existent/source');
      assert.equal(res.statusCode, 404);
      assert.equal(res.json?.error?.code, 'PROJECT_NOT_FOUND');
    });

    test('非法方法返回 405 METHOD_NOT_ALLOWED', async () => {
      const res = await request('/api/projects/test_project/source', { method: 'POST' });
      assert.equal(res.statusCode, 405);
      assert.equal(res.json?.error?.code, 'METHOD_NOT_ALLOWED');
    });
  });

  describe('GET /api/projects/:id/history', () => {
    test('读取成功返回提交列表与 refs', async () => {
      const res = await request('/api/projects/test_project/history');
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(res.json.commits));
      assert.ok(res.json.commits.length >= 1);
      assert.equal(res.json.commits[0].subject, 'first commit');
      assert.equal(res.json.truncated, false);
      assert.ok(Array.isArray(res.json.refs));
      assert.ok(res.json.refs.some((r) => r.kind === 'head'));
    });

    test('未知项目 ID 返回 404', async () => {
      const res = await request('/api/projects/non_existent/history');
      assert.equal(res.statusCode, 404);
      assert.equal(res.json?.error?.code, 'PROJECT_NOT_FOUND');
    });
  });

  describe('POST /api/projects/inspect', () => {
    test('合法输入返回 200 及规范化 repositoryRoot 与高熵票据', async () => {
      const res = await request('/api/projects/inspect', {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'x-local-intent': 'project-onboarding',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ repositoryPath: testRepoDir }),
      });

      assert.equal(res.statusCode, 200);
      assert.ok(res.json.inspectionId);
      assert.equal(res.json.inspectionId.length, 48);
      assert.ok(res.json.repositoryRoot);
      assert.equal(res.json.branch, 'main');
      assert.equal(res.json.hasHistory, true);
      assert.ok(res.json.latestCommit);
    });

    test('请求体包含未知命令字段被拒绝 400', async () => {
      const res = await request('/api/projects/inspect', {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'x-local-intent': 'project-onboarding',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryPath: testRepoDir,
          command: 'rm -rf /',
        }),
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.json?.error?.code, 'PATH_UNAVAILABLE');
    });

    test('非目录或不存在路径拒绝 400', async () => {
      const badPath = path.join(testRepoDir, 'hello.txt'); // 传入了文件
      const res = await request('/api/projects/inspect', {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'x-local-intent': 'project-onboarding',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ repositoryPath: badPath }),
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.json?.error?.code, 'PATH_UNAVAILABLE');
    });

    test('非允许方法（如 GET /api/projects/inspect）返回 405', async () => {
      const res = await request('/api/projects/inspect', { method: 'GET' });
      assert.equal(res.statusCode, 405);
      assert.equal(res.json?.error?.code, 'METHOD_NOT_ALLOWED');
    });
  });
});
