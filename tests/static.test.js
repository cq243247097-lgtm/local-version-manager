import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from '../server/app.js';

describe('静态资源白名单与安全响应测试', () => {
  let server;
  let port;

  before(async () => {
    const app = createAppServer({ port: 0 });
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
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  test('白名单资源正常返回 200 及正确 Content-Type 与安全头', async () => {
    const cases = [
      { path: '/', contentType: 'text/html; charset=utf-8' },
      { path: '/index.html', contentType: 'text/html; charset=utf-8' },
      { path: '/styles.css', contentType: 'text/css; charset=utf-8' },
      { path: '/app.js', contentType: 'text/javascript; charset=utf-8' },
    ];

    for (const item of cases) {
      const res = await request(item.path);
      assert.equal(res.statusCode, 200, `${item.path} 应当返回 200`);
      assert.equal(res.headers['content-type'], item.contentType);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.ok(res.headers['content-security-policy'], '应包含 Content-Security-Policy 头');
      assert.ok(res.headers['content-security-policy'].includes("connect-src 'self'"));
      assert.ok(res.headers['content-security-policy'].includes("style-src 'self'"), 'CSP 样式必须且仅同源');
      assert.ok(!res.headers['content-security-policy'].includes('unsafe-inline'), 'CSP 严格禁止 unsafe-inline');
      assert.ok(res.body.length > 0, `${item.path} 应有内容`);
    }
  });

  test('HEAD 请求白名单资源返回 200 且不带正文', async () => {
    const res = await request('/index.html', { method: 'HEAD' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.body, '');
  });

  test('静态资源使用非 GET/HEAD 方法返回 405 Method Not Allowed', async () => {
    const res = await request('/index.html', { method: 'POST' });
    assert.equal(res.statusCode, 405);
  });

  test('非白名单文件（如 package.json, preview.mjs）返回 404', async () => {
    const res1 = await request('/package.json');
    assert.equal(res1.statusCode, 404);

    const res2 = await request('/preview.mjs');
    assert.equal(res2.statusCode, 404);
  });

  test('禁止访问 .local 目录及内部文件', async () => {
    const res1 = await request('/.local/projects.json');
    assert.equal(res1.statusCode, 404);

    const res2 = await request('/.local/');
    assert.equal(res2.statusCode, 404);
  });

  test('目录遍历与 URL 编码变体防御', async () => {
    const traversePaths = [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/package.json',
      '/%2e%2e%2fpackage.json',
      '/frontend/../package.json',
    ];

    for (const p of traversePaths) {
      const res = await request(p);
      assert.ok([400, 404].includes(res.statusCode), `路径 ${p} 应返回 400 或 404，实际是 ${res.statusCode}`);
    }
  });
});
