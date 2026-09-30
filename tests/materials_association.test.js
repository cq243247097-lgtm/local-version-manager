import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createAppServer } from '../server/app.js';
import { clearMaterialInspectionTickets } from '../server/materials/association.js';

describe('P2-T01: 材料目录关联检查与配置保存端到端测试', () => {
  let server;
  let port;
  let tempBaseDir;
  let configPath;
  let repoDir;
  let installerDir;
  let upgradeDir;
  const PROJECT_ID = 'test_proj';

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2t01-test-'));
    configPath = path.join(tempBaseDir, 'projects.json');
    repoDir = path.join(tempBaseDir, 'dummy_repo');
    installerDir = path.join(tempBaseDir, 'materials_installer');
    upgradeDir = path.join(tempBaseDir, 'materials_upgrade');

    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(installerDir, { recursive: true });
    await fs.mkdir(upgradeDir, { recursive: true });

    // 在材料目录中放置一些文件，用于验证检查与保存前后材料内容绝对零变更
    await fs.writeFile(path.join(installerDir, 'package.zip'), 'dummy installer content');
    await fs.writeFile(path.join(upgradeDir, 'patch.pkg'), 'dummy upgrade content');
    await fs.writeFile(path.join(repoDir, 'README.md'), '# Dummy Repo');

    // 初始配置：符合 P1 规范的已登记项目
    const initialConfig = {
      projects: [
        {
          id: PROJECT_ID,
          name: '主测试项目',
          repositoryPath: repoDir,
          unknownOriginalKey: 'should_be_preserved',
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
    clearMaterialInspectionTickets();
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

  async function snapshotDirectory(dirPath) {
    const snapshot = {};
    async function walk(current) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(current, ent.name);
        const rel = path.relative(dirPath, full);
        if (ent.isDirectory()) {
          snapshot[rel] = { type: 'dir' };
          await walk(full);
        } else if (ent.isFile()) {
          const content = await fs.readFile(full);
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          snapshot[rel] = { type: 'file', size: content.length, hash };
        }
      }
    }
    await walk(dirPath);
    return snapshot;
  }

  test('未关联状态：GET /api/projects 项目列表中不暴露 materials 路径', async () => {
    const res = await request('/api/projects');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.configured, true);
    assert.equal(res.json.projects.length, 1);
    assert.equal(res.json.projects[0].id, PROJECT_ID);
    assert.equal(res.json.projects[0].name, '主测试项目');
    assert.equal(res.json.projects[0].materials, undefined);
    assert.equal(res.json.projects[0].repositoryPath, undefined);
  });

  test('inspect 请求体参数严格校验：拒绝多余字段、相对路径、URL、非目录或不可达路径', async () => {
    const invalidInputs = [
      { body: { rootPath: installerDir, extra: 'not_allowed' }, desc: '多余字段' },
      { body: { rootPath: 'relative/path' }, desc: '相对路径' },
      { body: { rootPath: 'file://C:/some/path' }, desc: 'URL 格式' },
      { body: { rootPath: 'http://localhost/path' }, desc: 'HTTP URL' },
      { body: { rootPath: path.join(installerDir, 'package.zip') }, desc: '非目录（文件路径）' },
      { body: { rootPath: path.join(tempBaseDir, 'non_existent_folder') }, desc: '不存在目录' },
      { body: { notRootPath: installerDir }, desc: '缺少 rootPath 字段' },
      { body: { rootPath: '' }, desc: '空路径' },
      { body: { rootPath: 12345 }, desc: '非字符串路径' },
    ];

    for (const { body, desc } of invalidInputs) {
      const res = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, body);
      assert.equal(res.statusCode, 400, `${desc} 应当返回 400`);
      assert.equal(res.json?.error?.code, 'INVALID_INPUT');
    }
  });

  test('inspect 只读浅检查：材料目录与被管理仓库零写入，且返回高熵票据与核对信息', async () => {
    const snapRepoBefore = await snapshotDirectory(repoDir);
    const snapMatBefore = await snapshotDirectory(installerDir);

    const res = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: installerDir,
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.json.inspectionId);
    assert.equal(typeof res.json.inspectionId, 'string');
    assert.equal(res.json.inspectionId.length, 64); // 32 字节高熵 hex
    assert.equal(res.json.projectId, PROJECT_ID);
    assert.equal(res.json.kind, 'installer');
    assert.equal(res.json.hasExistingAssociation, false);
    assert.equal(res.json.existingRoot, null);
    assert.equal(path.normalize(res.json.normalizedRoot).toLowerCase(), path.normalize(installerDir).toLowerCase());

    // 检查前后快照绝对一致
    const snapRepoAfter = await snapshotDirectory(repoDir);
    const snapMatAfter = await snapshotDirectory(installerDir);
    assert.deepEqual(snapRepoAfter, snapRepoBefore, '仓库目录不得有任何变更');
    assert.deepEqual(snapMatAfter, snapMatBefore, '材料目录不得有任何变更');
  });

  test('子目录输入：只按用户选择根保存，绝不自动上提到任意父目录', async () => {
    const subDir = path.join(installerDir, 'sub_release', 'v1');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'sub_file.bin'), 'sub data');

    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: subDir,
    });
    assert.equal(inspectRes.statusCode, 200);
    assert.equal(path.normalize(inspectRes.json.normalizedRoot).toLowerCase(), path.normalize(subDir).toLowerCase());

    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: false,
    });
    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.json.alreadyAssociated, false);
    assert.deepEqual(confirmRes.json.association, { projectId: PROJECT_ID, kind: 'installer', linked: true });
    assert.equal(confirmRes.json.root, undefined, 'confirm 响应绝对不回显根路径');

    // 验证磁盘配置：确实保存的是子目录，未向上归一到父目录
    const configData = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    assert.equal(
      path.normalize(configData.projects[0].materials.installer.root).toLowerCase(),
      path.normalize(subDir).toLowerCase()
    );
  });

  test('真实路径规范化提示：遇到 junction/symlink 时识别并返回真实物理根', async () => {
    const targetDir = path.join(tempBaseDir, 'real_upgrade_target');
    const linkDir = path.join(tempBaseDir, 'junction_upgrade_link');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(targetDir, linkDir, 'junction');

    const res = await postJson(`/api/projects/${PROJECT_ID}/materials/upgrade/inspect`, {
      rootPath: linkDir,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.isSymlink, true);
    assert.equal(
      path.normalize(res.json.normalizedRoot).toLowerCase(),
      path.normalize(targetDir).toLowerCase()
    );

    // 确认后保存的是规范化物理根
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/upgrade/confirm`, {
      inspectionId: res.json.inspectionId,
      replaceExisting: false,
    });
    assert.equal(confirmRes.statusCode, 200);

    const configData = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    assert.equal(
      path.normalize(configData.projects[0].materials.upgrade.root).toLowerCase(),
      path.normalize(targetDir).toLowerCase()
    );
  });

  test('confirm 请求体严格校验：不接受路径，必须且仅包含 inspectionId 与 replaceExisting', async () => {
    const invalidConfirmBodies = [
      { body: { inspectionId: 'some_id', replaceExisting: true, path: 'C:/fake' }, desc: '包含路径字段' },
      { body: { inspectionId: 'some_id' }, desc: '缺少 replaceExisting' },
      { body: { replaceExisting: true }, desc: '缺少 inspectionId' },
      { body: { inspectionId: 'some_id', replaceExisting: 'true' }, desc: 'replaceExisting 非布尔' },
      { body: { inspectionId: '', replaceExisting: false }, desc: 'inspectionId 为空' },
      { body: {}, desc: '空对象' },
    ];

    for (const { body, desc } of invalidConfirmBodies) {
      const res = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, body);
      assert.equal(res.statusCode, 400, `${desc} 应当返回 400`);
      assert.equal(res.json?.error?.code, 'INVALID_INPUT');
    }
  });

  test('两次确认同一根幂等返回 alreadyAssociated:true，不重复写入', async () => {
    // 重新对 installer 做一次已关联根的 inspect
    const configData = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const currentRoot = configData.projects[0].materials.installer.root;

    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: currentRoot,
    });
    assert.equal(inspectRes.statusCode, 200);
    assert.equal(inspectRes.json.hasExistingAssociation, true);

    const statBefore = await fs.stat(configPath);
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: false,
    });
    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.json.alreadyAssociated, true);
    assert.deepEqual(confirmRes.json.association, { projectId: PROJECT_ID, kind: 'installer', linked: true });

    const statAfter = await fs.stat(configPath);
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, '幂等确认不应重新写盘');
  });

  test('更换关联根未显式 replaceExisting:true 拒绝 409 MATERIAL_CONFLICT，显式后成功', async () => {
    const newInstallerDir = path.join(tempBaseDir, 'new_installer_v2');
    await fs.mkdir(newInstallerDir, { recursive: true });

    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: newInstallerDir,
    });
    assert.equal(inspectRes.statusCode, 200);
    assert.equal(inspectRes.json.hasExistingAssociation, true);

    // 1. replaceExisting: false 拒绝
    const rejectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: false,
    });
    assert.equal(rejectRes.statusCode, 409);
    assert.equal(rejectRes.json?.error?.code, 'MATERIAL_CONFLICT');

    // 2. replaceExisting: true 成功
    const acceptRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(acceptRes.statusCode, 200);
    assert.equal(acceptRes.json.alreadyAssociated, false);

    const configData = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    assert.equal(
      path.normalize(configData.projects[0].materials.installer.root).toLowerCase(),
      path.normalize(newInstallerDir).toLowerCase()
    );
  });

  test('并发冲突保护：检查后被其他实例修改了关联，拒绝 409 MATERIAL_CONFLICT 而非凭旧票据覆盖', async () => {
    const dirA = path.join(tempBaseDir, 'conflict_dir_a');
    const dirB = path.join(tempBaseDir, 'conflict_dir_b');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    // 实例 1 检查 dirA
    const inspectA = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: dirA });
    // 实例 2 检查 dirB
    const inspectB = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, { rootPath: dirB });

    // 实例 1 先确认 dirA
    const confirmA = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectA.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmA.statusCode, 200);

    // 实例 2 再尝试确认 dirB：其检查时关联已过时，必须拒绝 409
    const confirmB = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectB.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmB.statusCode, 409);
    assert.equal(confirmB.json?.error?.code, 'MATERIAL_CONFLICT');
  });

  test('票据无效/过期/目录被替换或删除时拒绝 400 INSPECTION_STALE', async () => {
    // 1. 不存在的伪造票据
    const fakeRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: 'deadbeef'.repeat(8),
      replaceExisting: true,
    });
    assert.equal(fakeRes.statusCode, 400);
    assert.equal(fakeRes.json?.error?.code, 'INSPECTION_STALE');

    // 2. 检查后目录被删除
    const willBeDeletedDir = path.join(tempBaseDir, 'to_be_deleted');
    await fs.mkdir(willBeDeletedDir, { recursive: true });

    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: willBeDeletedDir,
    });
    assert.equal(inspectRes.statusCode, 200);

    // 删除该目录
    await fs.rm(willBeDeletedDir, { recursive: true, force: true });

    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmRes.statusCode, 400);
    assert.equal(confirmRes.json?.error?.code, 'INSPECTION_STALE');
  });

  test('并发操作安全：新项目登记 (P1) 与材料确认交错并发，双方数据均不丢失', async () => {
    // 准备一个新项目待登记
    const newRepo = path.join(tempBaseDir, 'concurrent_new_repo');
    await fs.mkdir(newRepo, { recursive: true });
    // 初始化 git 仓库
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', newRepo]);
    await execFileAsync('git', ['-C', newRepo, 'config', 'user.name', 'Tester']);
    await execFileAsync('git', ['-C', newRepo, 'config', 'user.email', 'test@example.com']);
    await fs.writeFile(path.join(newRepo, 'file.txt'), 'content');
    await execFileAsync('git', ['-C', newRepo, 'add', '.']);
    await execFileAsync('git', ['-C', newRepo, 'commit', '-m', 'init']);

    // 预检新项目
    const inspectProjRes = await request('/api/projects/inspect', {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'x-local-intent': 'project-onboarding',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ repositoryPath: newRepo }),
    });
    assert.equal(inspectProjRes.statusCode, 200);
    const projTicket = inspectProjRes.json.inspectionId;

    // 准备材料确认
    const concurrentMatDir = path.join(tempBaseDir, 'concurrent_mat');
    await fs.mkdir(concurrentMatDir, { recursive: true });
    const matInspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: concurrentMatDir,
    });
    const matTicket = matInspectRes.json.inspectionId;

    // 并发发起新项目确认登记与现有项目材料关联确认
    const [projConfirmRes, matConfirmRes] = await Promise.all([
      request('/api/projects', {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'x-local-intent': 'project-onboarding',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          inspectionId: projTicket,
          id: 'proj_concurrent',
          name: '并发登记项目',
        }),
      }),
      postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
        inspectionId: matTicket,
        replaceExisting: true,
      }),
    ]);

    assert.equal(projConfirmRes.statusCode, 200);
    assert.equal(matConfirmRes.statusCode, 200);

    // 验证磁盘配置：新项目存在，老项目的材料关联也存在，老项目的未知配置键仍然保留
    const latestConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    assert.equal(latestConfig.projects.length, 2);

    const oldP = latestConfig.projects.find((p) => p.id === PROJECT_ID);
    const newP = latestConfig.projects.find((p) => p.id === 'proj_concurrent');

    assert.ok(oldP);
    assert.ok(newP);
    assert.equal(oldP.unknownOriginalKey, 'should_be_preserved');
    assert.equal(
      path.normalize(oldP.materials.installer.root).toLowerCase(),
      path.normalize(concurrentMatDir).toLowerCase()
    );
    assert.equal(newP.name, '并发登记项目');
  });

  test('Spec 1 [高]: 链接改指向后使用旧票据确认，必须拒绝 400 INSPECTION_STALE 且配置字节不变', async () => {
    const dirA = path.join(tempBaseDir, 'spec1_target_a');
    const dirB = path.join(tempBaseDir, 'spec1_target_b');
    const linkPath = path.join(tempBaseDir, 'spec1_link');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    // 1. 创建 link -> dirA 并 inspect
    await fs.symlink(dirA, linkPath, 'junction');
    const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: linkPath,
    });
    assert.equal(inspectRes.statusCode, 200);
    const ticketId = inspectRes.json.inspectionId;

    // 记录当前配置文件的精确字节
    const configBytesBefore = await fs.readFile(configPath);

    // 2. 将同一个 link 改指向 dirB，同时保留 dirA 存在
    await fs.unlink(linkPath);
    await fs.symlink(dirB, linkPath, 'junction');

    // 3. 使用原 ticketId 调用 confirm，此时用户原输入 link 已指向 dirB，必须拒绝 400 INSPECTION_STALE
    const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: ticketId,
      replaceExisting: true,
    });
    assert.equal(confirmRes.statusCode, 400);
    assert.equal(confirmRes.json?.error?.code, 'INSPECTION_STALE');

    // 4. 断言旧配置字节绝对未被改写
    const configBytesAfter = await fs.readFile(configPath);
    assert.deepEqual(configBytesAfter, configBytesBefore, '配置字节必须完全不变');
  });

  test('Spec 1 [高]: 链接移除或目录被替换为非目录时，确认拒绝 400 INSPECTION_STALE 且配置不变', async () => {
    // 1. 链接被移除
    const targetDir = path.join(tempBaseDir, 'spec1_remove_target');
    const linkPath = path.join(tempBaseDir, 'spec1_remove_link');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(targetDir, linkPath, 'junction');

    const inspectRes1 = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: linkPath,
    });
    assert.equal(inspectRes1.statusCode, 200);

    const configBytesBefore = await fs.readFile(configPath);
    await fs.unlink(linkPath); // 移除 link

    const confirmRes1 = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes1.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmRes1.statusCode, 400);
    assert.equal(confirmRes1.json?.error?.code, 'INSPECTION_STALE');
    assert.deepEqual(await fs.readFile(configPath), configBytesBefore);

    // 2. 普通目录被替换为文件（非目录）
    const dirToReplace = path.join(tempBaseDir, 'spec1_dir_to_file');
    await fs.mkdir(dirToReplace, { recursive: true });
    const inspectRes2 = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
      rootPath: dirToReplace,
    });
    assert.equal(inspectRes2.statusCode, 200);

    await fs.rm(dirToReplace, { recursive: true });
    await fs.writeFile(dirToReplace, 'now a file, not a directory'); // 变成同名文件

    const confirmRes2 = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
      inspectionId: inspectRes2.json.inspectionId,
      replaceExisting: true,
    });
    assert.equal(confirmRes2.statusCode, 400);
    assert.equal(confirmRes2.json?.error?.code, 'INSPECTION_STALE');
    assert.deepEqual(await fs.readFile(configPath), configBytesBefore);
  });

  test('Spec 2 [中]: 损坏配置下带非法额外字段的材料 POST 必须在读配置前返回 400 INVALID_INPUT', async () => {
    // 备份正常配置并故意破坏配置文件
    const validConfigBackup = await fs.readFile(configPath, 'utf-8');
    await fs.writeFile(configPath, 'CORRUPTED JSON {]', 'utf-8');

    try {
      // 1. inspect 请求带多余 command 字段：必须在读配置前返回 400 INVALID_INPUT，绝不能返回 500 CONFIG_INVALID
      const inspectRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/inspect`, {
        rootPath: installerDir,
        command: 'bad',
      });
      assert.equal(inspectRes.statusCode, 400, '必须在读配置前拦截多余字段并返回 400');
      assert.equal(inspectRes.json?.error?.code, 'INVALID_INPUT');

      // 2. confirm 请求带额外 path 字段：必须在读配置前返回 400 INVALID_INPUT，绝不能返回 500 CONFIG_INVALID
      const confirmRes = await postJson(`/api/projects/${PROJECT_ID}/materials/installer/confirm`, {
        inspectionId: 'any_ticket',
        replaceExisting: true,
        path: 'illegal_path_field',
      });
      assert.equal(confirmRes.statusCode, 400, '必须在读配置前拦截多余字段并返回 400');
      assert.equal(confirmRes.json?.error?.code, 'INVALID_INPUT');
    } finally {
      // 恢复合法配置
      await fs.writeFile(configPath, validConfigBackup, 'utf-8');
    }
  });
});

