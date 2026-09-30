import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAppServer } from '../server/app.js';

describe('P1-T04: 前端服务与模式隔离测试', () => {
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

  async function request(pathname) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: pathname,
          method: 'GET',
          headers: {
            host: `127.0.0.1:${port}`,
          },
        },
        (res) => {
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
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  test('真实服务返回 HTML 时注入固定真实模式标记 (content="real")', async () => {
    const res = await request('/');
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('<meta name="app-mode" content="real">'), '返回的 HTML 必须包含 real 模式标记');
    assert.ok(!res.body.includes('<meta name="app-mode" content="preview">'), '真实服务不应返回 preview 标记');
  });

  test('磁盘源文件保持默认演示模式标记 (content="preview")', async () => {
    const diskContent = await fs.readFile(path.resolve('frontend/index.html'), 'utf-8');
    assert.ok(diskContent.includes('<meta name="app-mode" content="preview">'), '源文件必须保留默认 preview 标记');
    assert.ok(!diskContent.includes('<meta name="app-mode" content="real">'), '源文件绝不被改写为 real 标记');
  });

  test('CSP 头与 meta 标签允许同源连接 (connect-src "self")', async () => {
    const res = await request('/index.html');
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-security-policy']?.includes("connect-src 'self'"));
    assert.ok(res.body.includes("connect-src 'self'"));
    assert.ok(!res.body.includes("connect-src 'none'"));
  });

  test('页面包含 PC 接入向导与项目切换核心 DOM 元素', async () => {
    const res = await request('/index.html');
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('id="project-select"'), '必须包含项目选择下拉框');
    assert.ok(res.body.includes('id="btn-open-onboard"'), '必须包含接入新项目按钮');
    assert.ok(res.body.includes('id="onboard-dialog"'), '必须包含接入向导弹窗');
    assert.ok(res.body.includes('id="btn-refresh-real"'), '必须包含真实模式刷新按钮');
    assert.ok(res.body.includes('id="page"'), '必须包含工作台挂载容器');
  });

  test('静态资源安全返回，无外部 CDN 依赖与无未经转义模板', async () => {
    const htmlRes = await request('/index.html');
    assert.ok(!htmlRes.body.includes('http://'), '不应引入外部非安全网络协议');
    assert.ok(!htmlRes.body.includes('https://'), '不应依赖外部公网 CDN');

    const jsRes = await request('/app.js');
    assert.equal(jsRes.statusCode, 200);
    assert.equal(jsRes.headers['content-type'], 'text/javascript; charset=utf-8');

    const cssRes = await request('/styles.css');
    assert.equal(cssRes.statusCode, 200);
    assert.equal(cssRes.headers['content-type'], 'text/css; charset=utf-8');
  });

  test('R1/R2: 真实工作台采用中性上游术语且具备按错误来源重试机制', async () => {
    const jsRes = await request('/app.js');
    assert.equal(jsRes.statusCode, 200);
    const code = jsRes.body;

    // R1: 验证中性上游术语
    assert.ok(code.includes('本地 / 上游跟踪状态'), '真实工作台应使用中性上游跟踪状态标题');
    assert.ok(code.includes('<strong>上游分支</strong>'), '流水线第三阶段应为上游分支，不假定为远端');
    assert.ok(code.includes('<b>领先提交</b>'), '可用上游应表述为领先提交，不假定为待推送');

    // R2: 验证按错误来源重试逻辑
    assert.ok(code.includes('data-retry-source='), '错误展示必须暴露重试来源标记');
    assert.ok(code.includes('lastRealError'), '必须记录并跟踪错误发生来源（list 或 project）');
    assert.ok(code.includes('reloadProjectsList('), '列表错误必须能够重载项目列表');
  });

  test('P2-T03: 静态页面结构包含材料向导 dialog 与相关挂载结构', async () => {
    const res = await request('/index.html');
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('id="material-dialog"'), '必须包含材料关联向导弹窗容器');
    assert.ok(res.body.includes('id="material-dialog-title"'), '必须包含材料向导弹窗标题');
    assert.ok(res.body.includes('id="material-dialog-body"'), '必须包含材料向导弹窗正文容器');
    assert.ok(res.body.includes('id="close-material-dialog"'), '必须包含材料向导弹窗关闭按钮');
  });

  test('P2-T03: 前端脚本中包含事实分层、只读提示及严格的防旧响应覆盖序列号', async () => {
    const jsRes = await request('/app.js');
    assert.equal(jsRes.statusCode, 200);
    const code = jsRes.body;

    // 事实分层文案审查
    assert.ok(
      code.includes('记录称通过，本次未核验当前文件'),
      '安装包详情必须明确展示“记录称通过，本次未核验当前文件”警示'
    );
    assert.ok(
      code.includes('本工具仅执行有界只读扫描，不执行可执行程序、不计算包哈希，不改变材料文件'),
      '必须明确只读工具说明'
    );

    // 升级包最低值审查：采用 API 的 minimumDirectSource，不自算排序
    assert.ok(
      code.includes('compat.minimumDirectSource'),
      '必须使用 API 计算给出的 minimumDirectSource 字段'
    );

    // 并发与序列号审查
    assert.ok(
      code.includes('realActiveMaterialSerial'),
      '必须使用材料请求序列号 realActiveMaterialSerial 防并发漂移'
    );

    // 向导 API 审查：confirm 不发送 rootPath，仅发送 inspectionId
    assert.ok(
      code.includes('inspectionId: res.inspectionId'),
      '向导 confirm 请求体仅传递 inspectionId 与 replaceExisting'
    );
    assert.ok(
      code.includes("replaceExisting: Boolean(res.hasExistingAssociation)"),
      '向导 confirm 请求体应显式指定 replaceExisting'
    );

    // 错误恢复与重新关联引导审查
    assert.ok(
      code.includes('MATERIAL_ROOT_UNAVAILABLE'),
      '必须显式处理材料根目录不可用错误码'
    );
    assert.ok(
      code.includes('更换关联目录'),
      '材料根不可用或详情中必须提供更换关联目录按钮'
    );
  });

  test('P2-T04: 前端脚本中包含候选包/已发布状态、证据来源展示与历史登记摘要提示', async () => {
    const jsRes = await request('/app.js');
    assert.equal(jsRes.statusCode, 200);
    const code = jsRes.body;

    // 候选包与发布状态审查
    assert.ok(
      code.includes('候选包 (candidate)'),
      '必须包含候选包 releaseStatus 中文展示'
    );
    assert.ok(
      code.includes('已发布 (released)'),
      '必须包含已发布 releaseStatus 中文展示'
    );

    // 证据来源审查
    assert.ok(
      code.includes('证据来源:'),
      '必须支持展示证据来源 evidenceSource'
    );

    // 历史登记摘要审查
    assert.ok(
      code.includes('历史登记摘要，本次未核验当前文件'),
      '历史登记 sha256 必须显式标注“历史登记摘要，本次未核验当前文件”'
    );

    // 兼容声明文本审查
    assert.ok(
      code.includes('未在记录中找到 directFrom 字段或声明为空，直接升级兼容范围未知'),
      'directFrom 缺失或为 null 时应提示直接升级兼容范围未知'
    );
  });
});




describe('P3-T04: 真实本地提交入口与模式边界', () => {
  test('独立提交 dialog、主动选择、服务器预览及结果查询齐备', async () => {
    const code = await fs.readFile(path.resolve('frontend/app.js'), 'utf8');
    const html = await fs.readFile(path.resolve('frontend/index.html'), 'utf8');
    assert.ok(html.includes('id="commit-dialog"'));
    for (const marker of ['open-real-commit', 'data-commit-candidate', 'preview-real-commit', 'confirm-real-commit', 'query-real-commit', 'refresh-commit-source']) assert.ok(code.includes(marker), marker);
    assert.ok(code.includes('selected: new Set()'));
    assert.ok(code.includes("'X-Local-Intent': 'git-commit'"));
    assert.ok(code.includes('localStorage.setItem(commitOperationKey(view.projectId), operationId)'));
    assert.ok(code.includes('await queryRealCommit(view, response.data)'));
    assert.ok(code.includes('view.projectId === currentProjectId'));
    assert.ok(code.includes('结果未知，需要核对'));
    assert.ok(code.includes('只有选择文件、核对预览并明确确认后才会本地提交'));
    assert.ok(code.includes('if (isRealMode) return; // 真实模式严禁触发模拟提交'));
  });
});

// Execute the real commit state machine with transport/DOM boundaries stubbed.
// These are unit tests, not browser or repository-write evidence.
import vm from 'node:vm';
async function commitHarness(responder) {
  const source = await fs.readFile(path.resolve('frontend/app.js'), 'utf8');
  const fragment = source.slice(source.indexOf('// Selected-files local commit.'), source.indexOf('function realSourcePage()'));
  const controls = new Map();
  const storage = new Map();
  const calls = [];
  const context = vm.createContext({
    isRealMode: true, currentProjectId: 'one', realProjects: [{ id: 'one', name: 'One' }],
    escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])), currentProjectData: {},
    $: (selector) => { if (!controls.has(selector)) controls.set(selector, { open: true, innerHTML: '', addEventListener() {}, close() { this.open = false; }, showModal() { this.open = true; } }); return controls.get(selector); },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    crypto: { randomUUID: () => 'fixed-test-operation' }, AbortController, setTimeout, clearTimeout,
    loadRealProject: async () => true,
    apiFetch: async (url, options) => { calls.push({ url, options }); return responder(url, options); },
  });
  vm.runInContext(fragment, context);
  vm.runInContext("commitView = { serial: commitSerial, projectId: 'one', phase: 'preview', preview: { ticketId: 'a'.repeat(64), projectId: 'one', branch: 'main', message: 'one', summary: { fileCount: 1, operations: [] }, expiresInSeconds: 300 }, selected: new Set(), busy: false };", context);
  return { run: (code) => vm.runInContext(code, context), calls, storage, controls };
}

describe('P3-T04: 提交状态机单元验证（不代替浏览器）', () => {
  test('确认响应本身不证明成功，必须查询同一个原操作 ID', async () => {
    const h = await commitHarness(async (url) => url.endsWith('/confirm')
      ? { ok: true, data: { status: 'completed', commitOid: 'a'.repeat(40) } }
      : { ok: false, data: { error: { code: 'NETWORK_ERROR' } } });
    await h.run('confirmRealCommit()');
    assert.equal(h.run('commitView.result.status'), 'unknown');
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[1].url.endsWith('/operations/op_fixed-test-operation'));
    assert.equal(h.storage.get('lvm_commit_operation_v1:one'), 'op_fixed-test-operation');
  });
  test('双击确认仅发出一次写请求，查询已核实结果', async () => {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const h = await commitHarness(async (url) => url.endsWith('/confirm') ? pending : { ok: true, data: { projectId: 'one', operationId: 'op_fixed-test-operation', status: 'completed', commitOid: 'a'.repeat(40), branch: 'main' } });
    const first = h.run('confirmRealCommit()');
    await h.run('confirmRealCommit()');
    assert.equal(h.calls.length, 1);
    resolve({ ok: true, data: { status: 'completed' } }); await first;
    assert.equal(h.run('commitView.result.status'), 'completed');
    assert.equal(h.calls.filter(c => c.url.endsWith('/confirm')).length, 1);
  });
  test('PREVIEW_STALE 加原操作不存在才释放旧票据，不自动再提交', async () => {
    const h = await commitHarness(async url => url.endsWith('/confirm')
      ? { ok: false, data: { status: 'stale', operationId: 'op_fixed-test-operation' } }
      : { ok: false, data: { error: { code: 'OPERATION_NOT_FOUND' } } });
    await h.run('confirmRealCommit()');
    assert.equal(h.run('commitView.result.status'), 'stale');
    assert.equal(h.run('commitView.preview'), null);
    assert.equal(h.storage.has('lvm_commit_operation_v1:one'), false);
    assert.equal(h.calls.length, 2);
  });
  test('切换项目后晚到响应不能覆盖新页面，原 ID 保留', async () => {
    let resolve;
    const h = await commitHarness(() => new Promise(r => { resolve = r; }));
    const promise = h.run('confirmRealCommit()');
    h.run("closeCommitDialog(); currentProjectId = 'two';");
    resolve({ ok: true, data: { status: 'completed' } }); await promise;
    assert.equal(h.run('commitView'), null);
    assert.equal(h.calls.length, 1);
    assert.equal(h.storage.get('lvm_commit_operation_v1:one'), 'op_fixed-test-operation');
  });
  test('结果刷新失败保留已核实 OID，后续查询断线不改成失败', async () => {
    let count = 0;
    const h = await commitHarness(async () => ++count <= 2
      ? { ok: true, data: { projectId: 'one', operationId: 'op_fixed-test-operation', status: 'completed', commitOid: 'a'.repeat(40), branch: 'main' } }
      : { ok: false, data: { error: { code: 'NETWORK_ERROR' } } });
    h.run('loadRealProject = async () => false');
    await h.run('confirmRealCommit()');
    assert.equal(h.run('commitView.refreshError'), true);
    await h.run('queryRealCommit(commitView)');
    assert.equal(h.run('commitView.result.commitOid'), 'a'.repeat(40));
    assert.equal(h.run('commitView.result.status'), 'completed');
  });
});


describe('P3-T04 R01: partial 精确暂存清单', () => {
  test('混合选择只展示服务器证实的 new.txt，不从选择推断 base.txt', async () => {
    const h = await commitHarness(async () => ({ ok: false, data: { projectId: 'one', operationId: 'op_fixed-test-operation', status: 'partial', stagedFiles: ['new.txt'], indexChange: 'selected_only' } }));
    h.run("commitView.selected = new Set(['base.txt', 'new.txt']);");
    await h.run('confirmRealCommit()');
    const html = h.controls.get('#commit-dialog-body').innerHTML;
    assert.ok(html.includes('id="proven-staged-files"'));
    assert.ok(html.includes('<code>new.txt</code>'));
    assert.ok(!html.includes('base.txt'));
    assert.ok(!html.includes('本地提交已完成（服务器已核实）'));
  });
  test('证实路径必须转义；unknown 后不显示历史 partial 清单', async () => {
    let query = 0;
    const h = await commitHarness(async url => ({ ok: false, data: url.endsWith('/confirm') || ++query === 1
      ? { projectId: 'one', operationId: 'op_fixed-test-operation', status: 'partial', stagedFiles: ['<img src=x onerror=alert(1)>.txt'], indexChange: 'selected_only' }
      : { projectId: 'one', operationId: 'op_fixed-test-operation', status: 'unknown' } }));
    await h.run('confirmRealCommit()');
    let html = h.controls.get('#commit-dialog-body').innerHTML;
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.txt'));
    assert.ok(!html.includes('<img'));
    await h.run('queryRealCommit(commitView)');
    html = h.controls.get('#commit-dialog-body').innerHTML;
    assert.ok(html.includes('结果未知'));
    assert.ok(!html.includes('proven-staged-files'));
    assert.ok(!html.includes('onerror'));
  });
  test('重新查询断线不把旧 partial 文件当成当前已核实清单', async () => {
    let query = 0;
    const h = await commitHarness(async url => url.endsWith('/confirm') || ++query === 1
      ? { ok: false, data: { projectId: 'one', operationId: 'op_fixed-test-operation', status: 'partial', stagedFiles: ['new.txt'] } }
      : { ok: false, data: { error: { code: 'NETWORK_ERROR' } } });
    await h.run('confirmRealCommit()');
    await h.run('queryRealCommit(commitView)');
    assert.equal(h.run('commitView.result.status'), 'unknown');
    assert.ok(!h.controls.get('#commit-dialog-body').innerHTML.includes('proven-staged-files'));
  });
});
