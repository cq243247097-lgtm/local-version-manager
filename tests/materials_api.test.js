import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createAppServer } from '../server/app.js';

describe('P2-T02: 材料端点 HTTP API 端到端测试 (materials_api.test.js)', () => {
  let server;
  let port;
  let tempBaseDir;
  let configPath;
  let repoDir;
  let installerDir;
  let upgradeDir;
  const PROJECT_ID = 'test_proj_api';

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2t02-api-'));
    configPath = path.join(tempBaseDir, 'projects.json');
    repoDir = path.join(tempBaseDir, 'dummy_repo');
    installerDir = path.join(tempBaseDir, 'materials_installer');
    upgradeDir = path.join(tempBaseDir, 'materials_upgrade');

    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(installerDir, { recursive: true });
    await fs.mkdir(upgradeDir, { recursive: true });

    // 准备升级包根内容与记录
    await fs.writeFile(path.join(upgradeDir, 'update-v1.4.0-r1.zip'), 'dummy pkg content');
    const recordsUpgrade = {
      schemaVersion: 1,
      records: [
        {
          kind: 'upgrade',
          file: 'update-v1.4.0-r1.zip',
          targetVersion: 'v1.4.0',
          revision: 'r1',
          directFrom: ['v1.2.0', 'v1.3.0'],
          recordedFile: { sizeBytes: 17, mtimeMs: 1790000000000 },
          integrityRecord: { result: 'passed', recordedAt: '2026-09-25T10:00:00Z' },
        },
      ],
    };
    await fs.writeFile(path.join(upgradeDir, 'material-records.json'), JSON.stringify(recordsUpgrade, null, 2), 'utf-8');

    // 初始配置：installer 未关联，upgrade 已关联
    const initialConfig = {
      projects: [
        {
          id: PROJECT_ID,
          name: 'API测试项目',
          repositoryPath: repoDir,
          materials: {
            upgrade: { root: upgradeDir },
          },
        },
      ],
    };
    await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), 'utf-8');

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
    await fs.rm(tempBaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  function postJson(pathname, bodyObj, extraHeaders = {}) {
    return request(pathname, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'x-local-intent': 'material-linking',
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(bodyObj),
    });
  }

  test('GET /api/projects/:id/materials/:kind 未关联时返回 200 state: unlinked', async () => {
    const res = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.projectId, PROJECT_ID);
    assert.equal(res.json.kind, 'installer');
    assert.equal(res.json.state, 'unlinked');
    assert.equal(res.json.scan, null);
    assert.deepEqual(res.json.tree, []);
    assert.deepEqual(res.json.items, []);
  });

  test('GET /api/projects/:id/materials/:kind 已关联时返回完整扫描清单，无绝对路径泄漏', async () => {
    const res = await request(`/api/projects/${PROJECT_ID}/materials/upgrade`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.projectId, PROJECT_ID);
    assert.equal(res.json.kind, 'upgrade');
    assert.equal(res.json.state, 'linked');
    assert.ok(res.json.scan);
    assert.equal(res.json.scan.status, 'complete');
    assert.equal(res.json.scan.truncated, false);

    // 验证 items 包含物理包与升级兼容性计算
    assert.equal(res.json.items.length, 1);
    const item = res.json.items[0];
    assert.equal(item.id, 'upgrade:update-v1.4.0-r1.zip');
    assert.equal(item.relativePath, 'update-v1.4.0-r1.zip');
    assert.equal(item.declaration.targetVersion, 'v1.4.0');
    assert.equal(item.declaration.revision, 'r1');
    assert.equal(item.compatibility.state, 'available');
    assert.equal(item.compatibility.minimumDirectSource, 'v1.2.0');

    // 关键安全校验：响应正文中绝对不包含主机物理绝对根或源码/包正文
    assert.equal(res.body.includes(upgradeDir), false, 'API 响应不能泄漏绝对根路径');
    assert.equal(res.body.includes('dummy pkg content'), false, 'API 响应不能输出包文件正文');
  });

  test('GET 关联根在磁盘上失效（被删除）时返回 409 MATERIAL_ROOT_UNAVAILABLE', async () => {
    const deadDir = path.join(tempBaseDir, 'dead_root');
    await fs.mkdir(deadDir, { recursive: true });

    // 先关联该目录
    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: deadDir });
    assert.equal(inspectRes.statusCode, 200);
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: false,
    });
    assert.equal(confirmRes.statusCode, 200);

    // 物理删除该目录
    await fs.rm(deadDir, { recursive: true, force: true });

    // 此时调用 GET 应检测到根失效并返回 409
    const getRes = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
    assert.equal(getRes.statusCode, 409);
    assert.equal(getRes.json?.error?.code, 'MATERIAL_ROOT_UNAVAILABLE');
  });

  test('POST inspect 接口返回同一扫描器的 preview 摘要', async () => {
    const res = await postJson(`/api/projects/${PROJECT_ID}/materials/upgrade/inspect`, {
      rootPath: upgradeDir,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json.preview, 'inspect 响应必须包含同一扫描器的 preview 摘要');
    assert.equal(res.json.preview.status, 'complete');
    assert.equal(res.json.preview.truncated, false);
    assert.equal(res.json.preview.summary.totalFiles, 1);
    assert.equal(res.json.preview.summary.recognizedRecords, 1);
    assert.equal(res.json.preview.summary.unrecognizedFiles, 0);
  });

  test('Spec 1 [高]: 根路径或上级被替换为指向外部 junction 时，GET 请求拦截越界并返回 409 MATERIAL_ROOT_UNAVAILABLE', async () => {
    // 创建一个合法结构的目录树: parent_orig/installer_root
    const parentOrig = path.join(tempBaseDir, 'parent_orig');
    const installerRoot = path.join(parentOrig, 'installer_root');
    await fs.mkdir(installerRoot, { recursive: true });
    await fs.writeFile(path.join(installerRoot, 'legit.bin'), 'legitimate');

    // 关联 installerRoot
    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: installerRoot });
    assert.equal(inspectRes.statusCode, 200);
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmRes.statusCode, 200);

    // 验证正常情况下 GET 成功
    const okRes = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
    assert.equal(okRes.statusCode, 200);
    assert.equal(okRes.json.items.length, 1);
    assert.equal(okRes.json.items[0].relativePath, 'legit.bin');

    // 现在制造外部越界：准备外部目录 outside_dir，里面有敏感文件 sensitive.key
    const outsideDir = path.join(tempBaseDir, 'outside_dir');
    const outsideTarget = path.join(outsideDir, 'installer_root');
    await fs.mkdir(outsideTarget, { recursive: true });
    await fs.writeFile(path.join(outsideTarget, 'sensitive.key'), 'VERY_SECRET_KEY_123');

    // 将 parentOrig 移除，并建立同名 junction 指向 outsideDir
    await fs.rm(parentOrig, { recursive: true, force: true });
    await fs.symlink(outsideDir, parentOrig, 'junction');

    // 此时 installerRoot 在路径上依然存在 (parent_orig/installer_root -> outside_dir/installer_root)
    // 但 realpath 漂移到 outside_dir
    const getRes = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
    assert.equal(getRes.statusCode, 409, '被越界替换后必须返回 409');
    assert.equal(getRes.json?.error?.code, 'MATERIAL_ROOT_UNAVAILABLE');
    assert.equal(getRes.body.includes('VERY_SECRET_KEY_123'), false, '响应正文绝对不能输出外部敏感文件内容');
    assert.equal(getRes.body.includes('sensitive.key'), false, '响应正文绝对不能泄漏外部目录文件名');
  });

  test('Spec 1 [阻断修复]: 扫描期间（根校验完成后、目录读取前）根上级被替换为外部 junction 时，GET 请求拦截越界并返回 409 MATERIAL_ROOT_UNAVAILABLE', async () => {
    // 1. 创建一个合法结构的目录树: parent_during/installer_root
    const parentDir = path.join(tempBaseDir, 'parent_during');
    const installerRoot = path.join(parentDir, 'installer_root');
    await fs.mkdir(installerRoot, { recursive: true });
    await fs.writeFile(path.join(installerRoot, 'legit.bin'), 'legitimate');

    // 2. 关联 installerRoot
    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: installerRoot });
    assert.equal(inspectRes.statusCode, 200);
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmRes.statusCode, 200);

    // 3. 准备外部目录 outside_dir，里面有敏感文件 sensitive.key
    const outsideDir = path.join(tempBaseDir, 'outside_during');
    const outsideTarget = path.join(outsideDir, 'installer_root');
    await fs.mkdir(outsideTarget, { recursive: true });
    await fs.writeFile(path.join(outsideTarget, 'sensitive.key'), 'VERY_SECRET_KEY_999');

    // 4. 确定性模拟：在首次 opendir 触发时（即根校验完成、即将遍历目录时）将 parentDir 替换为指向 outsideDir 的 junction
    const fsPromises = await import('node:fs/promises');
    const origOpendir = fsPromises.default.opendir;
    let swapped = false;

    fsPromises.default.opendir = async function (p, ...args) {
      if (!swapped && typeof p === 'string' && p.includes('parent_during')) {
        swapped = true;
        // 移走 parentDir 并建立同名 junction 指向 outsideDir
        await fs.rm(parentDir, { recursive: true, force: true });
        await fs.symlink(outsideDir, parentDir, 'junction');
      }
      return origOpendir.apply(this, [p, ...args]);
    };

    try {
      const getRes = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
      assert.equal(getRes.statusCode, 409, '扫描期间被越界替换后必须返回 409');
      assert.equal(getRes.json?.error?.code, 'MATERIAL_ROOT_UNAVAILABLE');
      assert.equal(getRes.body.includes('VERY_SECRET_KEY_999'), false, '响应正文绝对不能输出外部敏感文件内容');
      assert.equal(getRes.body.includes('sensitive.key'), false, '响应正文绝对不能泄漏外部目录文件名');
    } finally {
      fsPromises.default.opendir = origOpendir;
    }
  });

  test('Spec 2 [高]: material-records.json 包含私有未知字段与越界绝对/父级路径时，API 响应脱敏且丢弃越界项', async () => {
    // 准备一个干净的材料目录
    const sanitizedDir = path.join(tempBaseDir, 'materials_sanitized');
    await fs.mkdir(sanitizedDir, { recursive: true });
    await fs.writeFile(path.join(sanitizedDir, 'public.zip'), 'public content');

    // 写入含有私有字段、越界绝对路径、父级相对路径的 material-records.json
    const dirtyRecords = {
      schemaVersion: 1,
      records: [
        {
          kind: 'upgrade',
          file: 'public.zip',
          targetVersion: 'v2.0.0',
          revision: 'r1',
          privatePath: 'C:/sensitive/private/dir/secret.doc',
          internalToken: 'TOP_SECRET_TOKEN_XYZ',
          arbitraryEvilData: { nested: 'leak_me' },
        },
        {
          kind: 'upgrade',
          file: 'C:/sensitive/private/dir/target.zip', // 绝对路径
          targetVersion: 'v2.0.1',
          revision: 'r1',
        },
        {
          kind: 'upgrade',
          file: '../escape.zip', // 父级穿越路径
          targetVersion: 'v2.0.2',
          revision: 'r1',
        },
      ],
    };
    await fs.writeFile(path.join(sanitizedDir, 'material-records.json'), JSON.stringify(dirtyRecords, null, 2), 'utf-8');

    // 关联 sanitizedDir 为 upgrade 根
    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/upgrade/inspect`, { rootPath: sanitizedDir });
    assert.equal(inspectRes.statusCode, 200);
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/upgrade/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmRes.statusCode, 200);

    // 请求 GET 接口
    const res = await request(`/api/projects/${PROJECT_ID}/materials/upgrade`);
    assert.equal(res.statusCode, 200);

    // 1. 响应正文中绝对不得包含私有字段名及敏感字符串
    assert.equal(res.body.includes('privatePath'), false, '不得泄露 privatePath 字段');
    assert.equal(res.body.includes('internalToken'), false, '不得泄露 internalToken 字段');
    assert.equal(res.body.includes('TOP_SECRET_TOKEN_XYZ'), false, '不得泄露 internalToken 值');
    assert.equal(res.body.includes('arbitraryEvilData'), false, '不得泄露未知私有字段');
    assert.equal(res.body.includes('C:/sensitive/private'), false, '不得泄露绝对路径字串');
    assert.equal(res.body.includes('rawRecord'), false, '不得泄露 rawRecord');

    // 2. 非法路径绝不进入 items
    assert.equal(res.json.items.length, 1, '仅保留合法声明的 public.zip');
    assert.equal(res.json.items[0].relativePath, 'public.zip');
    assert.equal(res.json.items.find((it) => it.relativePath.includes('target.zip')), undefined);
    assert.equal(res.json.items.find((it) => it.relativePath.includes('escape.zip')), undefined);

    // 3. 验证非法路径仅作为警告，使 scan 标为 partial，绝对不标为 complete
    assert.equal(res.json.scan.status, 'partial');
    assert.equal(res.json.scan.truncated, true);
    assert.ok(res.json.scan.reasons.includes('record_invalid_file_path'));
  });

  test('路由与非法请求限制：拒绝未知项目、非法类型与错误方法', async () => {
    // 1. 未知项目返回 404
    const resUnknown = await request('/api/projects/non_exist_p/materials/installer');
    assert.equal(resUnknown.statusCode, 404);
    assert.equal(resUnknown.json?.error?.code, 'PROJECT_NOT_FOUND');

    // 2. 非法材料类型返回 400
    const resBadKind = await request(`/api/projects/${PROJECT_ID}/materials/invalid_kind`);
    assert.equal(resBadKind.statusCode, 400);
    assert.equal(resBadKind.json?.error?.code, 'INVALID_INPUT');

    // 3. 非 GET 方法返回 405
    const resPost = await request(`/api/projects/${PROJECT_ID}/materials/installer`, { method: 'POST' });
    assert.equal(resPost.statusCode, 405);
    assert.equal(resPost.json?.error?.code, 'METHOD_NOT_ALLOWED');
  });

  test('S1 [高]: 根不变时子目录被替换为外部 junction，GET 与 inspect 预览均不泄露外部文件或元数据', async () => {
    const s1Root = path.join(tempBaseDir, 's1_root');
    const subDir = path.join(s1Root, 'sub');
    const outsideDir = path.join(tempBaseDir, 's1_outside');

    await fs.mkdir(s1Root, { recursive: true });
    await fs.mkdir(subDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    await fs.writeFile(path.join(s1Root, 'root.txt'), 'root normal');
    await fs.writeFile(path.join(outsideDir, 'outside-only.key'), 'SECRET_OUTSIDE_KEY_HTTP_9999');

    // 关联 s1Root 为 installer
    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: s1Root });
    assert.equal(inspectRes.statusCode, 200);
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmRes.statusCode, 200);

    const fsPromises = await import('node:fs/promises');
    const origOpendir = fsPromises.default.opendir;
    let swapped = false;

    fsPromises.default.opendir = async function (p, ...args) {
      if (!swapped && typeof p === 'string' && p.endsWith(path.sep + 'sub')) {
        swapped = true;
        await fs.rm(subDir, { recursive: true, force: true });
        await fs.symlink(outsideDir, subDir, 'junction');
      }
      return origOpendir.apply(this, [p, ...args]);
    };

    try {
      // 1. GET 请求
      const getRes = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.body.includes('outside-only.key'), false, 'GET 响应体绝不能包含外部文件名');
      assert.equal(getRes.body.includes('SECRET_OUTSIDE_KEY_HTTP_9999'), false, 'GET 响应体绝不能包含外部文件内容');
      assert.equal(getRes.json.scan.status, 'partial');
      assert.ok(getRes.json.scan.reasons.includes('link_or_drift_detected'));

      // 2. inspect 检查预览请求
      const previewRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: s1Root });
      assert.equal(previewRes.statusCode, 200);
      assert.equal(previewRes.body.includes('outside-only.key'), false, 'inspect 预览响应体绝不能包含外部文件名');
      assert.equal(previewRes.body.includes('SECRET_OUTSIDE_KEY_HTTP_9999'), false, 'inspect 预览响应体绝不能包含外部文件内容');
      assert.ok(previewRes.json.preview.summary.skippedLinks >= 1);
    } finally {
      fsPromises.default.opendir = origOpendir;
    }
  });

  test('S1 [短暂替换]: GET 与 inspect 不输出已恢复路径下外部目录句柄的名称', async () => {
    const root = path.join(tempBaseDir, 'transient_root');
    const sub = path.join(root, 'sub');
    const saved = path.join(root, 'sub-saved');
    const outside = path.join(tempBaseDir, 'transient_outside');
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(sub, 'inside.bin'), 'inside');
    await fs.writeFile(path.join(outside, 'outside-only.key'), 'fixture secret');

    const inspect = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: root });
    assert.equal(inspect.statusCode, 200);
    const confirm = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspect.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirm.statusCode, 200);

    const originalOpendir = fs.opendir;
    try {
      fs.opendir = async function (p, ...args) {
        if (p !== sub) return originalOpendir.call(this, p, ...args);
        await fs.rename(sub, saved);
        try {
          await fs.symlink(outside, sub, 'junction');
          return await originalOpendir.call(this, p, ...args);
        } finally {
          await fs.unlink(sub);
          await fs.rename(saved, sub);
        }
      };

      const getResult = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
      assert.equal(getResult.statusCode, 200);
      assert.equal(getResult.json.scan.status, 'partial');
      assert.equal(getResult.body.includes('outside-only.key'), false);
      assert.equal(getResult.body.includes('fixture secret'), false);

      const preview = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: root });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json.preview.status, 'partial');
      assert.equal(preview.body.includes('outside-only.key'), false);
    } finally {
      fs.opendir = originalOpendir;
    }
  });

  test('R1 [中]: 根目录 opendir 抛出 EACCES 时 GET 返回 409 MATERIAL_ROOT_UNAVAILABLE，子目录 EACCES 对照返回 200 partial', async () => {
    const r1Root = path.join(tempBaseDir, 'r1_root');
    const subDir = path.join(r1Root, 'sub');
    await fs.mkdir(r1Root, { recursive: true });
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(r1Root, 'root_file.bin'), 'root data');
    await fs.writeFile(path.join(subDir, 'sub_file.bin'), 'sub data');

    // 关联 r1Root 为 installer
    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: r1Root });
    assert.equal(inspectRes.statusCode, 200);
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmRes.statusCode, 200);

    const fsPromises = await import('node:fs/promises');
    const origOpendir = fsPromises.default.opendir;
    let mode = 'root_error';

    fsPromises.default.opendir = async function (p, ...args) {
      if (mode === 'root_error' && typeof p === 'string' && p.endsWith('r1_root')) {
        const err = new Error('Permission denied on root');
        err.code = 'EACCES';
        throw err;
      }
      if (mode === 'sub_error' && typeof p === 'string' && p.endsWith(path.sep + 'sub')) {
        const err = new Error('Permission denied on sub');
        err.code = 'EACCES';
        throw err;
      }
      return origOpendir.apply(this, [p, ...args]);
    };

    try {
      // 1. 根目录 opendir EACCES：必须返回 409 MATERIAL_ROOT_UNAVAILABLE，绝不返回 200
      const resRootErr = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
      assert.equal(resRootErr.statusCode, 409, '根目录无法列举必须返回 409');
      assert.equal(resRootErr.json?.error?.code, 'MATERIAL_ROOT_UNAVAILABLE');
      assert.equal(resRootErr.body.includes('r1_root'), false, '错误信息不得泄露绝对路径');
      assert.equal(resRootErr.body.includes('Permission denied'), false, '错误信息不得泄露系统底层错误信息');

      // 2. 对照：子目录 opendir EACCES：返回 200 partial，且保留根级文件
      mode = 'sub_error';
      const resSubErr = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
      assert.equal(resSubErr.statusCode, 200, '子目录无法列举正常返回 200 partial');
      assert.equal(resSubErr.json.scan.status, 'partial');
      assert.ok(resSubErr.json.scan.reasons.includes('directory_unreadable'));
      assert.ok(resSubErr.json.items.some((it) => it.relativePath === 'root_file.bin'));

      // 3. 移除故障注入后，重试恢复正常 200 complete
      mode = 'normal';
      const resNormal = await request(`/api/projects/${PROJECT_ID}/materials/installer`);
      assert.equal(resNormal.statusCode, 200);
      assert.equal(resNormal.json.scan.status, 'complete');
      assert.equal(resNormal.json.items.length, 2);
    } finally {
      fsPromises.default.opendir = origOpendir;
    }
  });
});
