import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createAppServer } from '../server/app.js';

describe('安全边界与前置校验测试', () => {
  let server;
  let port;

  before(async () => {
    const app = createAppServer({ port: 0 }); // 随机可用端口
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
  });

  function rawRequest(rawPayload) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write(rawPayload);
      });
      const chunks = [];
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => {
        const resStr = Buffer.concat(chunks).toString('utf-8');
        const [headerPart, ...bodyParts] = resStr.split('\r\n\r\n');
        const statusLine = headerPart.split('\r\n')[0] || '';
        const match = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
        const statusCode = match ? parseInt(match[1], 10) : 0;
        const body = bodyParts.join('\r\n\r\n');
        let json = null;
        const jsonMatch = body.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            json = JSON.parse(jsonMatch[0]);
          } catch {}
        }
        resolve({ statusCode, raw: resStr, json });
      });
      socket.on('error', reject);
    });
  }

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

  describe('Host 校验', () => {
    test('合法 Host 127.0.0.1:<port> 允许访问', async () => {
      const res = await request('/api/projects');
      assert.equal(res.statusCode, 200);
    });

    test('恶意 Host (如 localhost:<port>) 拒绝 403', async () => {
      const res = await request('/api/projects', {
        headers: { host: `localhost:${port}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'HOST_FORBIDDEN');
    });

    test('错误端口 Host (如 127.0.0.1:9999) 拒绝 403', async () => {
      const res = await request('/api/projects', {
        headers: { host: '127.0.0.1:9999' },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'HOST_FORBIDDEN');
    });

    test('外域 Host (如 attacker.com:<port>) 拒绝 403', async () => {
      const res = await request('/api/projects', {
        headers: { host: `attacker.com:${port}` },
      });
      assert.equal(res.statusCode, 403);
    });

    test('重复 Host 头 (先合法后恶意) 拒绝 403', async () => {
      const raw = `GET /api/projects HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: attacker.test\r\nConnection: close\r\n\r\n`;
      const res = await rawRequest(raw);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'HOST_FORBIDDEN');
    });

    test('缺失 Host 头 (HTTP/1.0) 拒绝 403', async () => {
      const raw = `GET /api/projects HTTP/1.0\r\nConnection: close\r\n\r\n`;
      const res = await rawRequest(raw);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'HOST_FORBIDDEN');
    });

    test('缺失 Host 头 (HTTP/1.1) 协议层拒绝 400', async () => {
      const raw = `GET /api/projects HTTP/1.1\r\nConnection: close\r\n\r\n`;
      const res = await rawRequest(raw);
      assert.equal(res.statusCode, 400);
    });
  });

  describe('Origin 校验', () => {
    test('CLI GET 请求无 Origin 允许访问', async () => {
      const res = await request('/api/projects');
      assert.equal(res.statusCode, 200);
    });

    test('同源 Origin http://127.0.0.1:<port> 允许访问', async () => {
      const res = await request('/api/projects', {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      assert.equal(res.statusCode, 200);
    });

    test('恶意 Origin (如 http://attacker.com) 拒绝 403', async () => {
      const res = await request('/api/projects', {
        headers: { origin: 'http://attacker.com' },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'ORIGIN_FORBIDDEN');
    });

    test('Origin 为 "null" 拒绝 403', async () => {
      const res = await request('/api/projects', {
        headers: { origin: 'null' },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'ORIGIN_FORBIDDEN');
    });

    test('端口不匹配 Origin 拒绝 403', async () => {
      const res = await request('/api/projects', {
        headers: { origin: `http://127.0.0.1:${port + 1}` },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  describe('Sec-Fetch-Site 校验', () => {
    test('Sec-Fetch-Site: cross-site 拒绝 403', async () => {
      const res = await request('/api/projects', {
        headers: {
          'sec-fetch-site': 'cross-site',
        },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'CROSS_SITE_FORBIDDEN');
    });

    test('Sec-Fetch-Site: same-origin 允许', async () => {
      const res = await request('/api/projects', {
        headers: {
          'sec-fetch-site': 'same-origin',
        },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe('POST 前置校验 (/api/projects/inspect 和 /api/projects)', async () => {
    const postEndpoints = ['/api/projects/inspect', '/api/projects'];

    for (const endpoint of postEndpoints) {
      test(`${endpoint} 缺少 Origin 头拒绝 403`, async () => {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-local-intent': 'project-onboarding',
          },
          body: JSON.stringify({ test: 1 }),
        });
        assert.equal(res.statusCode, 403);
      });

      test(`${endpoint} 缺少或不匹配 X-Local-Intent 拒绝 400`, async () => {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            origin: `http://127.0.0.1:${port}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ test: 1 }),
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json?.error?.code, 'INTENT_HEADER_INVALID');
      });

      test(`${endpoint} 非 application/json Content-Type 拒绝 415`, async () => {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            origin: `http://127.0.0.1:${port}`,
            'x-local-intent': 'project-onboarding',
            'content-type': 'text/plain',
          },
          body: 'hello',
        });
        assert.equal(res.statusCode, 415);
      });

      test(`${endpoint} 非法 JSON 语法拒绝 400`, async () => {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            origin: `http://127.0.0.1:${port}`,
            'x-local-intent': 'project-onboarding',
            'content-type': 'application/json',
          },
          body: '{ invalid json }',
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json?.error?.code, 'JSON_SYNTAX_ERROR');
      });

      test(`${endpoint} 请求体超过 8 KiB (8192 字节) 拒绝 413`, async () => {
        const largeObj = { padding: 'x'.repeat(8200) };
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            origin: `http://127.0.0.1:${port}`,
            'x-local-intent': 'project-onboarding',
            'content-type': 'application/json',
          },
          body: JSON.stringify(largeObj),
        });
        assert.equal(res.statusCode, 413);
        assert.equal(res.json?.error?.code, 'PAYLOAD_TOO_LARGE');
      });

      test(`${endpoint} 合法前置参数通过校验`, async () => {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            origin: `http://127.0.0.1:${port}`,
            'x-local-intent': 'project-onboarding',
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ sample: 'valid' }),
        });
        if (endpoint === '/api/projects') {
          // T03 确认端点前置参数通过，进入业务参数校验返回 400
          assert.equal(res.statusCode, 400);
          assert.equal(res.json?.error?.code, 'INVALID_INPUT');
        } else {
          // T02 接入检查端点已实现，传入非预期字段拒绝 400
          assert.equal(res.statusCode, 400);
          assert.equal(res.json?.error?.code, 'PATH_UNAVAILABLE');
        }
      });
    }
  });

  describe('P2-T01: POST 前置校验 (材料目录关联 inspect 和 confirm)', async () => {
    const materialEndpoints = [
      '/api/projects/sample_proj/materials/installer/inspect',
      '/api/projects/sample_proj/materials/installer/confirm',
      '/api/projects/sample_proj/materials/upgrade/inspect',
      '/api/projects/sample_proj/materials/upgrade/confirm',
    ];

    for (const endpoint of materialEndpoints) {
      test(`${endpoint} 缺少 Origin 头拒绝 403`, async () => {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-local-intent': 'material-linking',
          },
          body: JSON.stringify({ rootPath: 'D:\\materials' }),
        });
        assert.equal(res.statusCode, 403);
      });

      test(`${endpoint} 缺少或不匹配 X-Local-Intent (如传 project-onboarding) 拒绝 400`, async () => {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            origin: `http://127.0.0.1:${port}`,
            'x-local-intent': 'project-onboarding', // 错用意图
            'content-type': 'application/json',
          },
          body: JSON.stringify({ rootPath: 'D:\\materials' }),
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json?.error?.code, 'INTENT_HEADER_INVALID');
      });

      test(`${endpoint} 非 application/json Content-Type 拒绝 415`, async () => {
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            origin: `http://127.0.0.1:${port}`,
            'x-local-intent': 'material-linking',
            'content-type': 'text/plain',
          },
          body: 'hello',
        });
        assert.equal(res.statusCode, 415);
      });

      test(`${endpoint} 请求体超过 8 KiB (8192 字节) 拒绝 413，且在读配置/票据前拦截`, async () => {
        const largeObj = { rootPath: 'x'.repeat(8200) };
        const res = await request(endpoint, {
          method: 'POST',
          headers: {
            origin: `http://127.0.0.1:${port}`,
            'x-local-intent': 'material-linking',
            'content-type': 'application/json',
          },
          body: JSON.stringify(largeObj),
        });
        assert.equal(res.statusCode, 413);
        assert.equal(res.json?.error?.code, 'PAYLOAD_TOO_LARGE');
      });
    }
  });

  describe('CORS 检查', () => {
    test('不暴露 Access-Control-Allow-Origin: *', async () => {
      const res = await request('/api/projects');
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });
  });
});
