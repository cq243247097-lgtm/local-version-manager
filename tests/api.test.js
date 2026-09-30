import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server/app.js';

describe('API 接口与错误处理测试', () => {
  let server;
  let port;
  let tempDir;
  let configPath;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-test-'));
    configPath = path.join(tempDir, 'projects.json');

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
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function request(pathname, options = {}) {
    return new Promise((resolve, reject) => {
      const headers = { ...options.headers };
      if (!('host' in headers)) {
        headers['host'] = `127.0.0.1:${port}`;
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

  test('GET /api/projects 无配置文件时返回空列表与 configured:false', async () => {
    const res = await request('/api/projects');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { projects: [], configured: false });
  });

  test('GET /api/projects 有合法配置时返回脱敏列表与 configured:true', async () => {
    const validConfig = {
      projects: [
        {
          id: 'test_project',
          name: '测试项目',
          repositoryPath: path.resolve('dummy/path'),
        },
      ],
    };
    await fs.writeFile(configPath, JSON.stringify(validConfig));

    const res = await request('/api/projects');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.configured, true);
    assert.equal(res.json.projects.length, 1);
    assert.equal(res.json.projects[0].id, 'test_project');
    assert.equal(res.json.projects[0].name, '测试项目');
    assert.equal(res.json.projects[0].repositoryPath, undefined);
  });

  test('GET /api/projects 配置文件损坏时返回 500 CONFIG_INVALID，且不泄露路径或堆栈', async () => {
    await fs.writeFile(configPath, '{ corrupt json');

    const res = await request('/api/projects');
    assert.equal(res.statusCode, 500);
    assert.ok(res.json?.error);
    assert.equal(res.json.error.code, 'CONFIG_INVALID');
    assert.ok(res.json.error.message);
    assert.equal(res.body.includes('at '), false); // 无堆栈
    assert.equal(res.body.includes(configPath), false); // 无绝对路径

    // 恢复合法配置供后续测试使用
    await fs.writeFile(configPath, JSON.stringify({
      projects: [{ id: 'test_project', name: '测试项目', repositoryPath: path.resolve('dummy/path') }],
    }));
  });

  test('GET /api/projects/:id/source 路径不存在或非 Git 时返回 400 错误', async () => {
    const res = await request('/api/projects/test_project/source');
    assert.equal(res.statusCode, 400);
    assert.ok(['PATH_UNAVAILABLE', 'NOT_REPOSITORY'].includes(res.json?.error?.code));
  });

  test('POST /api/projects/:id/source 非 GET 方法返回 405 METHOD_NOT_ALLOWED', async () => {
    const res = await request('/api/projects/test_project/source', { method: 'POST' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.json?.error?.code, 'METHOD_NOT_ALLOWED');
  });

  test('GET /api/projects/:id/history 路径不存在或非 Git 时返回 400 错误', async () => {
    const res = await request('/api/projects/test_project/history');
    assert.equal(res.statusCode, 400);
    assert.ok(['PATH_UNAVAILABLE', 'NOT_REPOSITORY'].includes(res.json?.error?.code));
  });

  test('PUT /api/projects/:id/history 非 GET 方法返回 405 METHOD_NOT_ALLOWED', async () => {
    const res = await request('/api/projects/test_project/history', { method: 'PUT' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.json?.error?.code, 'METHOD_NOT_ALLOWED');
  });

  test('未知项目子路径或非法 ID 路由返回 404 NOT_FOUND', async () => {
    const cases = [
      { path: '/api/projects/unknown', method: 'GET' },
      { path: '/api/projects/unknown', method: 'POST' },
      { path: '/api/projects/INVALID_ID/source', method: 'GET' },
      { path: '/api/projects/test_project/other', method: 'GET' },
      { path: '/api/projects/test_project/source/extra', method: 'GET' },
      { path: '/api/unknown', method: 'GET' },
    ];

    for (const item of cases) {
      const res = await request(item.path, { method: item.method });
      assert.equal(res.statusCode, 404, `${item.method} ${item.path} 应返回 404`);
      assert.equal(res.json?.error?.code, 'NOT_FOUND');
    }
  });

  test('非法方法返回 405 METHOD_NOT_ALLOWED', async () => {
    const res = await request('/api/projects', { method: 'DELETE' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.json?.error?.code, 'METHOD_NOT_ALLOWED');
  });

  describe('P2-T01: 材料目录关联接口路由与方法限制测试', () => {
    test('T02 的 GET 接口：未关联时返回 200 state: unlinked', async () => {
      const res = await request('/api/projects/test_project/materials/installer', { method: 'GET' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.state, 'unlinked');
    });

    test('已定义材料接口使用错误方法返回 405 METHOD_NOT_ALLOWED', async () => {
      const endpoints = [
        '/api/projects/test_project/materials/installer/inspect',
        '/api/projects/test_project/materials/installer/confirm',
        '/api/projects/test_project/materials/upgrade/inspect',
        '/api/projects/test_project/materials/upgrade/confirm',
      ];
      for (const endpoint of endpoints) {
        const getRes = await request(endpoint, { method: 'GET' });
        assert.equal(getRes.statusCode, 405);
        assert.equal(getRes.json?.error?.code, 'METHOD_NOT_ALLOWED');

        const putRes = await request(endpoint, { method: 'PUT' });
        assert.equal(putRes.statusCode, 405);
        assert.equal(putRes.json?.error?.code, 'METHOD_NOT_ALLOWED');
      }
    });

    test('非法材料类型 (非 installer/upgrade) 返回 400 INVALID_INPUT', async () => {
      const res = await request('/api/projects/test_project/materials/invalid_kind/inspect', {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'x-local-intent': 'material-linking',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ rootPath: 'D:\\dummy' }),
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json?.error?.code, 'INVALID_INPUT');
    });

    test('对未登记项目执行材料检查返回 404 PROJECT_NOT_FOUND', async () => {
      const res = await request('/api/projects/non_existent/materials/installer/inspect', {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'x-local-intent': 'material-linking',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ rootPath: 'D:\\dummy' }),
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json?.error?.code, 'PROJECT_NOT_FOUND');
    });
  });
});

