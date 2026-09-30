import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createAppServer } from '../server/app.js';
import { acquireConfigLock, releaseConfigLock } from '../server/config.js';

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
  return res.stdout.toString('utf-8');
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

describe('P1-T03: 确认登记与配置保存端到端测试', () => {
  let server;
  let port;
  let tempBaseDir;
  let configPath;
  let testRepoDir;
  let appInstance;

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 't03-confirm-suite-'));
    configPath = path.join(tempBaseDir, '.local', 'projects.json');
    testRepoDir = path.join(tempBaseDir, 'test-repo');

    await fs.mkdir(testRepoDir, { recursive: true });
    gitCmd(testRepoDir, ['init', '-b', 'main']);
    gitCmd(testRepoDir, ['config', 'user.name', 'Tester']);
    gitCmd(testRepoDir, ['config', 'user.email', 'tester@test.com']);

    await fs.writeFile(path.join(testRepoDir, 'demo.txt'), 'hello world\n');
    gitCmd(testRepoDir, ['add', '.']);
    gitCmd(testRepoDir, ['commit', '-m', 'initial commit']);

    appInstance = createAppServer({ port: 0, configPath });
    server = appInstance.server;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        appInstance.setListeningPort(port);
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

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: pathname,
          method: options.method || 'GET',
          headers,
        },
        (res) => {
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
        }
      );

      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  async function postInspect(repoPath) {
    return await request('/api/projects/inspect', {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'x-local-intent': 'project-onboarding',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ repositoryPath: repoPath }),
    });
  }

  async function postConfirm(body) {
    return await request('/api/projects', {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'x-local-intent': 'project-onboarding',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  test('请求体字段校验：拒绝多余字段、非法 ID 与非法名称', async () => {
    // 1. 包含未知额外字段
    const resExtra = await postConfirm({
      inspectionId: 'any_id',
      id: 'valid_id',
      name: '合法名称',
      command: 'git push',
    });
    assert.equal(resExtra.statusCode, 400);
    assert.equal(resExtra.json?.error?.code, 'INVALID_INPUT');

    // 2. 包含客户端路径
    const resPath = await postConfirm({
      inspectionId: 'any_id',
      id: 'valid_id',
      name: '合法名称',
      repositoryPath: '/some/path',
    });
    assert.equal(resPath.statusCode, 400);
    assert.equal(resPath.json?.error?.code, 'INVALID_INPUT');

    // 3. 非法 ID 格式（大写、空格、非字母开头、超过 32 位）
    const invalidIds = ['INVALID_CAPS', '123num_start', 'has space', 'a'.repeat(33), '_start'];
    for (const badId of invalidIds) {
      const resBadId = await postConfirm({
        inspectionId: 'any_id',
        id: badId,
        name: '合法名称',
      });
      assert.equal(resBadId.statusCode, 400);
      assert.equal(resBadId.json?.error?.code, 'INVALID_INPUT');
    }

    // 4. 非法名称（空字符串、全是空白、超过 80 字符）
    const invalidNames = ['', '   ', 'n'.repeat(81)];
    for (const badName of invalidNames) {
      const resBadName = await postConfirm({
        inspectionId: 'any_id',
        id: 'valid_id',
        name: badName,
      });
      assert.equal(resBadName.statusCode, 400);
      assert.equal(resBadName.json?.error?.code, 'INVALID_INPUT');
    }
  });

  test('票据不存在或过期返回 400 INSPECTION_STALE，不写入配置', async () => {
    const resStale = await postConfirm({
      inspectionId: 'non_existent_ticket_12345',
      id: 'stale_proj',
      name: '过期测试',
    });
    assert.equal(resStale.statusCode, 400);
    assert.equal(resStale.json?.error?.code, 'INSPECTION_STALE');

    // 验证配置未创建
    let fileExists = true;
    try {
      await fs.stat(configPath);
    } catch {
      fileExists = false;
    }
    assert.equal(fileExists, false, '不应创建配置文件');
  });

  test('检查失败或用户取消不创建配置文件', async () => {
    // 检查失败情况
    const nonGitDir = path.join(tempBaseDir, 'empty-non-git');
    await fs.mkdir(nonGitDir, { recursive: true });
    const failInspect = await postInspect(nonGitDir);
    assert.equal(failInspect.statusCode, 400);

    // 用户取消（即 inspect 成功但不调用 confirm）
    const successInspect = await postInspect(testRepoDir);
    assert.equal(successInspect.statusCode, 200);
    assert.ok(successInspect.json?.inspectionId);

    // 依然不应创建配置
    let fileExists = true;
    try {
      await fs.stat(configPath);
    } catch {
      fileExists = false;
    }
    assert.equal(fileExists, false, '用户取消或未确认前绝不保存配置');
  });

  test('成功确认登记：被管理仓库零变更、保存归一化根、GET 可见且重启后可用', async () => {
    // 在 testRepoDir 中制造一些未提交修改、未跟踪文件和提交
    await fs.writeFile(path.join(testRepoDir, 'uncommitted.txt'), 'dirty worktree\n');
    await fs.writeFile(path.join(testRepoDir, 'untracked.txt'), 'untracked file\n');

    // 记录仓库完整快照
    const snapshotBefore = await getDirSnapshot(testRepoDir);

    // 1. inspect 获取票据
    const inspectRes = await postInspect(testRepoDir);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId, repositoryRoot } = inspectRes.json;
    assert.ok(inspectionId);
    assert.ok(repositoryRoot);

    // 2. confirm 确认登记
    const confirmRes = await postConfirm({
      inspectionId,
      id: 'primary_repo',
      name: '  主项目测试  ', // 测试两端空格 trim
    });
    assert.equal(confirmRes.statusCode, 200);
    assert.deepEqual(confirmRes.json, {
      project: {
        id: 'primary_repo',
        name: '主项目测试',
      },
      alreadyRegistered: false,
    });

    // 3. 校验被管理仓库快照完全一致（零写入）
    const snapshotAfter = await getDirSnapshot(testRepoDir);
    assert.equal(snapshotAfter.size, snapshotBefore.size, '仓库文件数量应不变');
    for (const [relPath, hash] of snapshotBefore.entries()) {
      assert.equal(snapshotAfter.get(relPath), hash, `文件 ${relPath} 在确认前后应保持一致`);
    }

    // 4. 检查 projects.json 内容
    const fileContent = await fs.readFile(configPath, 'utf-8');
    const savedConfig = JSON.parse(fileContent);
    assert.equal(savedConfig.projects.length, 1);
    assert.equal(savedConfig.projects[0].id, 'primary_repo');
    assert.equal(savedConfig.projects[0].name, '主项目测试');
    assert.equal(savedConfig.projects[0].repositoryPath, repositoryRoot);

    // 5. 立即调用 GET /api/projects 验证脱敏列表
    const getRes = await request('/api/projects');
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json.configured, true);
    assert.equal(getRes.json.projects.length, 1);
    assert.equal(getRes.json.projects[0].id, 'primary_repo');
    assert.equal(getRes.json.projects[0].name, '主项目测试');
    assert.equal(getRes.json.projects[0].repositoryPath, undefined, '不应泄露仓库绝对路径');

    // 6. 重启服务验证持久化与 source/history API 可用性
    const newApp = createAppServer({ port: 0, configPath });
    const newServer = newApp.server;
    let newPort;
    await new Promise((resolve) => {
      newServer.listen(0, '127.0.0.1', () => {
        newPort = newServer.address().port;
        newApp.setListeningPort(newPort);
        resolve();
      });
    });

    try {
      const restartGet = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${newPort}/api/projects`, {
          headers: { host: `127.0.0.1:${newPort}` },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
        });
      });
      assert.equal(restartGet.configured, true);
      assert.equal(restartGet.projects[0].id, 'primary_repo');

      // 验证 source API 正常读取
      const sourceRes = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${newPort}/api/projects/primary_repo/source`, {
          headers: { host: `127.0.0.1:${newPort}` },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
        });
      });
      assert.equal(sourceRes.branch, 'main');
      assert.ok(sourceRes.changedCount >= 1);
    } finally {
      await new Promise((resolve) => newServer.close(resolve));
    }
  });

  test('输入子目录时归一化到仓库根登记', async () => {
    const subDir = path.join(testRepoDir, 'src', 'components', 'button');
    await fs.mkdir(subDir, { recursive: true });

    // 用子目录进行 inspect
    const inspectRes = await postInspect(subDir);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;

    // 确认登记：由于 testRepoDir 已经登记为 primary_repo，此处应返回 alreadyRegistered: true
    const confirmRes = await postConfirm({
      inspectionId,
      id: 'sub_repo_id',
      name: '子目录项目',
    });
    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.json.alreadyRegistered, true);
    assert.equal(confirmRes.json.project.id, 'primary_repo');
    assert.equal(confirmRes.json.project.name, '主项目测试');
  });

  test('重复点击与并发确认：返回同一项目，不重复新增', async () => {
    // 创建第二个新仓库
    const repo2 = path.join(tempBaseDir, 'repo2');
    await fs.mkdir(repo2, { recursive: true });
    gitCmd(repo2, ['init', '-b', 'main']);
    gitCmd(repo2, ['config', 'user.name', 'Tester']);
    gitCmd(repo2, ['config', 'user.email', 'tester@test.com']);
    await fs.writeFile(path.join(repo2, 'r2.txt'), 'repo 2\n');
    gitCmd(repo2, ['add', '.']);
    gitCmd(repo2, ['commit', '-m', 'r2 commit']);

    const inspectRes = await postInspect(repo2);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;

    // 并发两个确认请求
    const [res1, res2] = await Promise.all([
      postConfirm({ inspectionId, id: 'repo_two', name: '仓库2' }),
      postConfirm({ inspectionId, id: 'repo_two', name: '仓库2' }),
    ]);

    assert.equal(res1.statusCode, 200);
    assert.equal(res2.statusCode, 200);
    assert.equal(res1.json.project.id, 'repo_two');
    assert.equal(res2.json.project.id, 'repo_two');

    // 验证配置文件中仅有 2 个项目，没有重复的 repo2
    const fileContent = await fs.readFile(configPath, 'utf-8');
    const savedConfig = JSON.parse(fileContent);
    assert.equal(savedConfig.projects.length, 2);
  });

  test('ID 冲突拦截：不同仓库使用已被占用的 ID 拒绝 409 ID_CONFLICT', async () => {
    // 创建第三个新仓库
    const repo3 = path.join(tempBaseDir, 'repo3');
    await fs.mkdir(repo3, { recursive: true });
    gitCmd(repo3, ['init', '-b', 'main']);
    gitCmd(repo3, ['config', 'user.name', 'Tester']);
    gitCmd(repo3, ['config', 'user.email', 'tester@test.com']);
    await fs.writeFile(path.join(repo3, 'r3.txt'), 'repo 3\n');
    gitCmd(repo3, ['add', '.']);
    gitCmd(repo3, ['commit', '-m', 'r3 commit']);

    const inspectRes = await postInspect(repo3);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;

    // 试图使用已被 repo1 占用的 primary_repo ID 登记
    const conflictRes = await postConfirm({
      inspectionId,
      id: 'primary_repo',
      name: '试图抢占 ID',
    });
    assert.equal(conflictRes.statusCode, 409);
    assert.equal(conflictRes.json?.error?.code, 'ID_CONFLICT');

    // 验证 projects.json 未被篡改
    const fileContent = await fs.readFile(configPath, 'utf-8');
    const savedConfig = JSON.parse(fileContent);
    assert.equal(savedConfig.projects.length, 2);
    assert.equal(savedConfig.projects[0].name, '主项目测试');
  });

  test('检查期间产生新提交不影响身份验证与登记', async () => {
    // 创建第四个新仓库
    const repo4 = path.join(tempBaseDir, 'repo4');
    await fs.mkdir(repo4, { recursive: true });
    gitCmd(repo4, ['init', '-b', 'main']);
    gitCmd(repo4, ['config', 'user.name', 'Tester']);
    gitCmd(repo4, ['config', 'user.email', 'tester@test.com']);
    await fs.writeFile(path.join(repo4, 'r4.txt'), 'repo 4 initial\n');
    gitCmd(repo4, ['add', '.']);
    gitCmd(repo4, ['commit', '-m', 'r4 commit']);

    const inspectRes = await postInspect(repo4);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;

    // 模拟开发者在检查后、确认前新增提交和新文件
    await fs.writeFile(path.join(repo4, 'r4_dev.txt'), 'repo 4 dev file\n');
    gitCmd(repo4, ['add', '.']);
    gitCmd(repo4, ['commit', '-m', 'r4 dev commit']);

    // 确认登记依然应成功
    const confirmRes = await postConfirm({
      inspectionId,
      id: 'repo_four',
      name: '仓库4开发态',
    });
    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.json.project.id, 'repo_four');
    assert.equal(confirmRes.json.alreadyRegistered, false);
  });

  test('仓库身份变化（被移走或删除 .git）拒绝登记', async () => {
    // 创建临时测试仓库
    const repoBroken = path.join(tempBaseDir, 'repo-broken');
    await fs.mkdir(repoBroken, { recursive: true });
    gitCmd(repoBroken, ['init', '-b', 'main']);
    gitCmd(repoBroken, ['config', 'user.name', 'Tester']);
    gitCmd(repoBroken, ['config', 'user.email', 'tester@test.com']);
    await fs.writeFile(path.join(repoBroken, 'rb.txt'), 'rb\n');
    gitCmd(repoBroken, ['add', '.']);
    gitCmd(repoBroken, ['commit', '-m', 'rb commit']);

    const inspectRes = await postInspect(repoBroken);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;

    // 检查后故意删除 .git 目录使之失效
    await fs.rm(path.join(repoBroken, '.git'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    const confirmRes = await postConfirm({
      inspectionId,
      id: 'repo_broken',
      name: '损坏仓库',
    });
    assert.equal(confirmRes.statusCode, 400);
    assert.ok(['INSPECTION_STALE', 'NOT_REPOSITORY'].includes(confirmRes.json?.error?.code));
  });

  test('配置文件损坏时拒绝覆盖，原字节完整保留', async () => {
    // 备份当前合法配置内容
    const beforeContent = await fs.readFile(configPath, 'utf-8');

    // 模拟配置文件损坏
    const corruptedContent = '{ "projects": invalid_json_syntax';
    await fs.writeFile(configPath, corruptedContent, 'utf-8');

    // 准备一个有效仓库票据
    const inspectRes = await postInspect(testRepoDir);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;

    const confirmRes = await postConfirm({
      inspectionId,
      id: 'should_fail',
      name: '失败测试',
    });
    assert.equal(confirmRes.statusCode, 500);
    assert.equal(confirmRes.json?.error?.code, 'CONFIG_INVALID');

    // 验证损坏文件原字节未被篡改覆盖
    const afterContent = await fs.readFile(configPath, 'utf-8');
    assert.equal(afterContent, corruptedContent, '损坏的配置原字节必须完整保留');

    // 恢复配置
    await fs.writeFile(configPath, beforeContent, 'utf-8');
  });

  test('陈旧锁保护与恢复提示：不可静默抢占覆盖', async () => {
    const lockPath = path.join(path.dirname(configPath), 'projects.lock');

    // 制造一个 60 秒前创建的陈旧锁
    await fs.writeFile(lockPath, JSON.stringify({ pid: 99999, createdAt: Date.now() - 60000 }));
    const sixtySecAgo = (Date.now() - 60000) / 1000;
    await fs.utimes(lockPath, sixtySecAgo, sixtySecAgo);

    const inspectRes = await postInspect(testRepoDir);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;

    const resBusy = await postConfirm({
      inspectionId,
      id: 'busy_test',
      name: '忙碌测试',
    });

    assert.equal(resBusy.statusCode, 409);
    assert.equal(resBusy.json?.error?.code, 'CONFIG_BUSY');
    assert.ok(resBusy.json?.error?.message.includes('projects.lock'), '错误提示应给出包含锁文件的恢复提示');
    assert.equal(resBusy.body.includes(tempBaseDir), false, '不应向客户端泄露宿主机绝对路径');

    // 验证锁文件依然存在，没有被静默抢占覆盖
    let lockExists = false;
    try {
      await fs.stat(lockPath);
      lockExists = true;
    } catch {}
    assert.equal(lockExists, true, '陈旧锁不能被静默抢占');

    // 手动清理锁文件
    await fs.unlink(lockPath);
  });

  test('已确认票据在配置文件被移除或项目被删除后拒绝返回假成功', async () => {
    // 1. 创建独立仓库并完成首次确认
    const repoDisk = path.join(tempBaseDir, 'repo-disk-check');
    await fs.mkdir(repoDisk, { recursive: true });
    gitCmd(repoDisk, ['init', '-b', 'main']);
    gitCmd(repoDisk, ['config', 'user.name', 'Tester']);
    gitCmd(repoDisk, ['config', 'user.email', 'tester@test.com']);
    await fs.writeFile(path.join(repoDisk, 'd.txt'), 'disk test\n');
    gitCmd(repoDisk, ['add', '.']);
    gitCmd(repoDisk, ['commit', '-m', 'disk commit']);

    const inspectRes = await postInspect(repoDisk);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;

    const res1 = await postConfirm({
      inspectionId,
      id: 'repo_disk',
      name: '磁盘核对测试',
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.json.alreadyRegistered, false);

    // 2. 模拟外部或人工将配置文件彻底移除 (ENOENT)
    const backupContent = await fs.readFile(configPath, 'utf-8');
    await fs.unlink(configPath);

    // 3. 相同票据再次确认：不能脱离磁盘凭内存态返回 200 假成功！
    const resAfterDelete = await postConfirm({
      inspectionId,
      id: 'repo_disk',
      name: '磁盘核对测试',
    });
    assert.equal(resAfterDelete.statusCode, 500);
    assert.equal(resAfterDelete.json?.error?.code, 'CONFIG_INVALID');
    assert.ok(resAfterDelete.json?.error?.message.includes('已被移除'));

    // 4. 模拟配置文件存在，但该项目被从配置中删除
    await fs.writeFile(configPath, JSON.stringify({ projects: [] }), 'utf-8');
    const resAfterProjRemoved = await postConfirm({
      inspectionId,
      id: 'repo_disk',
      name: '磁盘核对测试',
    });
    assert.equal(resAfterProjRemoved.statusCode, 500);
    assert.equal(resAfterProjRemoved.json?.error?.code, 'CONFIG_INVALID');
    assert.ok(resAfterProjRemoved.json?.error?.message.includes('不存在'));

    // 恢复配置
    await fs.writeFile(configPath, backupContent, 'utf-8');
  });

  test('模拟写入失败（原子替换前失败）旧登记仍可读，临时文件与锁完全清理', async () => {
    const { confirmAndSaveProject, loadProjectsConfig } = await import('../server/config.js');
    const isoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iso-fail-test-'));
    const isoConfigPath = path.join(isoDir, 'projects.json');

    // 预置已有旧项目
    const initialConfig = {
      projects: [
        {
          id: 'existing_proj',
          name: '已有旧项目',
          repositoryPath: testRepoDir,
        },
      ],
    };
    const initialContent = JSON.stringify(initialConfig, null, 2) + '\n';
    await fs.writeFile(isoConfigPath, initialContent, 'utf-8');

    const beforeHash = crypto.createHash('sha256').update(await fs.readFile(isoConfigPath)).digest('hex');
    const beforeBytes = (await fs.stat(isoConfigPath)).size;

    // 准备一个新仓库用于模拟保存失败
    const repoFail = path.join(tempBaseDir, 'repo-fail-sim');
    await fs.mkdir(repoFail, { recursive: true });
    gitCmd(repoFail, ['init', '-b', 'main']);
    gitCmd(repoFail, ['config', 'user.name', 'Tester']);
    gitCmd(repoFail, ['config', 'user.email', 'tester@test.com']);
    await fs.writeFile(path.join(repoFail, 'f.txt'), 'fail sim\n');
    gitCmd(repoFail, ['add', '.']);
    gitCmd(repoFail, ['commit', '-m', 'fail sim commit']);

    const inspectRes = await postInspect(repoFail);
    assert.equal(inspectRes.statusCode, 200);
    const { inspectionId } = inspectRes.json;
    const { getInspectionTicket } = await import('../server/git/inspect.js');
    const ticket = getInspectionTicket(inspectionId);

    // 注入写入故障：在临时文件写出后、原子替换前抛出异常
    await assert.rejects(async () => {
      await confirmAndSaveProject({
        configPath: isoConfigPath,
        ticket,
        id: 'new_fail_proj',
        name: '失败新项目',
        normRoot: await fs.realpath(repoFail),
        _simulateWriteFailure: true,
      });
    }, (err) => err.code === 'CONFIG_SAVE_FAILED');

    // 1. 旧配置文件的字节与哈希完全不变
    const afterContent = await fs.readFile(isoConfigPath, 'utf-8');
    const afterHash = crypto.createHash('sha256').update(afterContent).digest('hex');
    const afterBytes = (await fs.stat(isoConfigPath)).size;
    assert.equal(afterBytes, beforeBytes, '旧配置文件字节数必须保持一致');
    assert.equal(afterHash, beforeHash, '旧配置文件哈希必须保持一致');

    // 2. 旧登记项目仍可正常读取
    const loaded = await loadProjectsConfig(isoConfigPath);
    assert.equal(loaded.configured, true);
    assert.equal(loaded.projects.length, 1);
    assert.equal(loaded.projects[0].id, 'existing_proj');
    assert.equal(loaded.projects[0].name, '已有旧项目');

    // 3. 验证同目录下没有任何遗留的临时文件 (.tmp.*)
    const dirEntries = await fs.readdir(isoDir);
    const tmpFiles = dirEntries.filter((f) => f.includes('.tmp.'));
    assert.equal(tmpFiles.length, 0, '临时文件必须已被清理');

    // 4. 验证锁文件已被释放
    const lockExists = dirEntries.includes('projects.lock');
    assert.equal(lockExists, false, '锁文件必须已被释放');

    // 5. 后续正常写入能够不受阻碍地成功完成
    const retryRes = await confirmAndSaveProject({
      configPath: isoConfigPath,
      ticket,
      id: 'new_fail_proj',
      name: '失败新项目重试',
      normRoot: await fs.realpath(repoFail),
      _simulateWriteFailure: false,
    });
    assert.equal(retryRes.alreadyRegistered, false);
    assert.equal(retryRes.project.id, 'new_fail_proj');

    const reloaded = await loadProjectsConfig(isoConfigPath);
    assert.equal(reloaded.projects.length, 2);

    await fs.rm(isoDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

