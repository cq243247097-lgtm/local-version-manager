import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  getCommitCandidates,
  createCommitPreview,
  clearAllCommitPreviewTickets,
} from '../server/git/commit-preview.js';
import {
  executeCommit,
  queryCommitOperation,
  runCommitWriteGit,
  COMMIT_WRITE_ERRORS,
} from '../server/git/commit-write.js';
import {
  getCommitOperation,
  saveCommitOperation,
  acquireCommitLock,
  releaseCommitLock,
  COMMIT_OPERATION_ERRORS,
  getOperationsDir,
  getRepoKeyHash,
  pruneOldOperations,
  listCommitOperations,
  COMMIT_JOURNAL_LIMITS,
} from '../server/git/commit-operations.js';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { GitError } from '../server/git/exec.js';

function gitCmd(cwd, args, envExtra = {}) {
  assert.ok(path.isAbsolute(cwd) && cwd.startsWith(os.tmpdir() + path.sep), 'ALL fixture Git commands must have an explicit system-temp cwd');
  const res = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_LITERAL_PATHSPECS: '1',
      LC_ALL: 'C.UTF-8',
      LANG: 'C.UTF-8',
      ...envExtra,
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

describe('本地提交确认执行与去重恢复测试套件 (P3-T02)', () => {
  let tempBaseDir;
  let repoDir;
  let operationsDir;
  let configPath;
  let operationOptions;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-commit-write-test-'));
    repoDir = path.join(tempBaseDir, 'test-repo');
    operationsDir = path.join(tempBaseDir, 'op-data');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(operationsDir, { recursive: true });

    gitCmd(repoDir, ['init', '-b', 'main']);
    gitCmd(repoDir, ['config', 'user.name', 'Test Committer']);
    gitCmd(repoDir, ['config', 'user.email', 'committer@example.com']);

    // 建立基线初始提交
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base content\n', 'utf-8');
    gitCmd(repoDir, ['add', 'base.txt']);
    gitCmd(repoDir, ['commit', '-m', 'Initial commit']);

    configPath = path.join(tempBaseDir, "projects.json");
    await fs.writeFile(configPath, JSON.stringify({ projects: [{id: "default", name: "Fixture", repositoryPath: repoDir}] }));
    operationOptions = { configPath, operationsDir };
    clearAllCommitPreviewTickets();
  });

  afterEach(async () => {
    clearAllCommitPreviewTickets();
    if (tempBaseDir && fsSync.existsSync(tempBaseDir)) {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  test('正常提交闭环：未跟踪新增与普通修改，验证新 HEAD、parent 与 expectedTree', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base v2 updated\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'new file content\n', 'utf-8');

    const cands = await getCommitCandidates(repoDir);
    const preview = await createCommitPreview(repoDir, {
      candidateIds: cands.candidates.map((c) => c.id),
      message: 'Commit base and new file',
    });

    const initHead = gitCmd(repoDir, ['rev-parse', 'HEAD']).trim();

    const result = await executeCommit(
      'default',
      { ticketId: preview.ticketId, operationId: 'op_normal_001' },
      operationOptions
    );

    assert.equal(result.success, true);
    assert.equal(result.status, 'completed');
    assert.ok(result.commitOid);
    assert.notEqual(result.commitOid, initHead);
    assert.equal(result.treeOid, preview.expectedTreeOid);

    // 真实 Git 事实校验
    const currentHead = gitCmd(repoDir, ['rev-parse', 'HEAD']).trim();
    const parent = gitCmd(repoDir, ['rev-parse', 'HEAD^']).trim();
    const currentTree = gitCmd(repoDir, ['rev-parse', 'HEAD^{tree}']).trim();

    assert.equal(currentHead, result.commitOid);
    assert.equal(parent, initHead);
    assert.equal(currentTree, preview.expectedTreeOid);

    // WAL 记录校验
    const opRecord = await getCommitOperation('op_normal_001', operationOptions);
    assert.ok(opRecord);
    assert.equal(opRecord.status, 'completed');
    assert.equal(opRecord.commitOid, result.commitOid);
  });

  test('未选已暂存文件保护：未选暂存文件完好保留，绝不混入新 commit', async () => {
    // 1. 预先暂存一个未选文件
    await fs.writeFile(path.join(repoDir, 'staged-keep.txt'), 'keep in index untouched\n', 'utf-8');
    gitCmd(repoDir, ['add', 'staged-keep.txt']);

    // 2. 工作区修改另一个待选文件
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'modified base\n', 'utf-8');

    const cands = await getCommitCandidates(repoDir);
    const baseCand = cands.candidates.find((c) => c.path === 'base.txt');
    assert.ok(baseCand);

    const preview = await createCommitPreview(repoDir, {
      candidateIds: [baseCand.id],
      message: 'Only commit base.txt',
    });

    const result = await executeCommit(
      'default',
      { ticketId: preview.ticketId, operationId: 'op_keep_staged' },
      operationOptions
    );

    assert.equal(result.success, true);

    // 检验新提交包含的文件：只应有 base.txt，绝无 staged-keep.txt
    const showFiles = gitCmd(repoDir, ['show', '--name-only', '--oneline', 'HEAD'])
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean);
    assert.deepEqual(showFiles, ['base.txt']);

    // 关键校验：staged-keep.txt 依然保持在暂存区！
    const statRes = gitCmd(repoDir, ['status', '--porcelain=v2', '-z']);
    const chunks = statRes.split('\0');
    const keepEntry = chunks.find((c) => c.includes('staged-keep.txt'));
    assert.ok(keepEntry);
    assert.ok(keepEntry.startsWith('1 A. '));
  });

  test('幂等去重与重启恢复：相同 operationId 重复调用直接返回已记录结果，零二次写入', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base for idempotency\n', 'utf-8');
    const cands = await getCommitCandidates(repoDir);
    const preview = await createCommitPreview(repoDir, {
      candidateIds: [cands.candidates[0].id],
      message: 'Idempotency test commit',
    });

    const firstRun = await executeCommit(
      'default',
      { ticketId: preview.ticketId, operationId: 'op_idempotent_01' },
      operationOptions
    );
    assert.equal(firstRun.success, true);
    assert.equal(firstRun.status, 'completed');

    // 第二次调用（模拟前端重复点击或服务重启后查询）
    const secondRun = await executeCommit(
      'default',
      { ticketId: preview.ticketId, operationId: 'op_idempotent_01' },
      operationOptions
    );
    assert.equal(secondRun.success, true);
    assert.equal(secondRun.status, 'completed');
    assert.equal(secondRun.commitOid, firstRun.commitOid);
    assert.equal(secondRun.idempotent, true);

    const logLines = gitCmd(repoDir, ['log', '--oneline']).trim().split(/\r?\n/);
    assert.equal(logLines.length, 2);
  });

  test('仓库排他互斥锁：并发调用时第二个操作被阻止并报 REPOSITORY_BUSY', async () => {
    const commonDirRel = gitCmd(repoDir, ['rev-parse', '--git-common-dir']).trim();
    const commonDirAbs = path.resolve(repoDir, commonDirRel);
    const lease = await acquireCommitLock(commonDirAbs, { operationId: 'op_active_lock' }, operationOptions);

    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base changed\n', 'utf-8');
    const cands = await getCommitCandidates(repoDir);
    const preview = await createCommitPreview(repoDir, {
      candidateIds: [cands.candidates[0].id],
      message: 'Lock test',
    });

    await assert.rejects(
      () => executeCommit(
        'default',
        { ticketId: preview.ticketId, operationId: 'op_blocked' },
        operationOptions
      ),
      (err) => {
        assert.ok(err instanceof GitError);
        assert.equal(err.code, COMMIT_OPERATION_ERRORS.REPOSITORY_BUSY);
        return true;
      }
    );

    // 释放锁后恢复正常
    await releaseCommitLock(commonDirAbs, lease, operationOptions);
  });

  test('状态陈旧拦截（PREVIEW_STALE）：外部修改文件、HEAD 变化或暂存变化时零写入并拒绝', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base v1\n', 'utf-8');
    const cands = await getCommitCandidates(repoDir);
    const preview = await createCommitPreview(repoDir, {
      candidateIds: [cands.candidates[0].id],
      message: 'Stale test',
    });

    const initHead = gitCmd(repoDir, ['rev-parse', 'HEAD']).trim();

    // 模拟外部修改选中文件
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base modified externally\n', 'utf-8');

    const result = await executeCommit(
      'default',
      { ticketId: preview.ticketId, operationId: 'op_stale_test' },
      operationOptions
    );

    assert.equal(result.success, false);
    assert.equal(result.status, 'stale');
    assert.equal(result.reason, COMMIT_WRITE_ERRORS.PREVIEW_STALE);

    // 核心断言：仓库零写入，HEAD 丝毫未动
    const currentHead = gitCmd(repoDir, ['rev-parse', 'HEAD']).trim();
    assert.equal(currentHead, initHead);
  });

  test('特殊路径支持：包含中文、空格、前导横杠及方括号 [ab].txt', async () => {
    const specialChinese = '中文 路径.txt';
    const specialDash = '-leading-dash.txt';
    const specialBracket = '[ab].txt';

    await fs.writeFile(path.join(repoDir, specialChinese), 'chinese\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, specialDash), 'dash\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, specialBracket), 'bracket\n', 'utf-8');

    const cands = await getCommitCandidates(repoDir);
    const preview = await createCommitPreview(repoDir, {
      candidateIds: cands.candidates.map((c) => c.id),
      message: 'Special characters commit',
    });

    const result = await executeCommit(
      'default',
      { ticketId: preview.ticketId, operationId: 'op_special_chars' },
      operationOptions
    );

    assert.equal(result.success, true);
    assert.equal(result.status, 'completed');

    const committedFiles = gitCmd(repoDir, ['show', '--name-only', '--oneline', 'HEAD'])
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean);

    assert.ok(committedFiles.includes(specialDash));
    assert.ok(committedFiles.includes(specialBracket));
    assert.ok(committedFiles.some((f) => f.includes('中文')));
  });

  test('删除与重命名操作提交支持', async () => {
    await fs.writeFile(path.join(repoDir, 'to-delete.txt'), 'delete\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, 'to-rename.txt'), 'rename\n', 'utf-8');
    gitCmd(repoDir, ['add', '.']);
    gitCmd(repoDir, ['commit', '-m', 'Add del and ren']);

    await fs.unlink(path.join(repoDir, 'to-delete.txt'));
    gitCmd(repoDir, ['mv', 'to-rename.txt', 'renamed.txt']);

    const cands = await getCommitCandidates(repoDir);
    const preview = await createCommitPreview(repoDir, {
      candidateIds: cands.candidates.map((c) => c.id),
      message: 'Delete and rename commit',
    });

    const result = await executeCommit(
      'default',
      { ticketId: preview.ticketId, operationId: 'op_del_ren' },
      operationOptions
    );

    assert.equal(result.success, true);
    assert.equal(result.status, 'completed');

    const showDiff = gitCmd(repoDir, ['show', '--stat', 'HEAD']);
    assert.ok(showDiff.includes('to-delete.txt'));
    assert.ok(showDiff.includes('to-rename.txt => renamed.txt'));
  });

  test('精确 add 之后 commit 失败时报 partial，保留实际暂存状态且绝不隐式回滚', async () => {
    await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'new content for partial\n', 'utf-8');
    const cands = await getCommitCandidates(repoDir);
    const preview = await createCommitPreview(repoDir, {
      candidateIds: [cands.candidates[0].id],
      message: 'Partial test',
    });

    const initialHead = gitCmd(repoDir, ['rev-parse', 'HEAD']).trim();

    // 注入提交失败故障：模拟精确 add 成功后，commit 命令非零退出
    const result = await executeCommit(
      'default',
      { ticketId: preview.ticketId, operationId: 'op_partial_001' },
      { ...operationOptions, _faultInjection: { failCommit: true } }
    );

    assert.equal(result.success, false);
    assert.equal(result.status, 'partial');
    assert.equal(result.reason, COMMIT_WRITE_ERRORS.COMMIT_PARTIAL);

    // 核心安全保证 1：HEAD 没有产生新提交，未损坏提交树
    const currentHead = gitCmd(repoDir, ['rev-parse', 'HEAD']).trim();
    assert.equal(currentHead, initialHead);

    // 核心安全保证 2：绝不隐式 reset / restore！选中的未跟踪文件保留在暂存区
    const statRes = gitCmd(repoDir, ['status', '--porcelain=v2', '-z']);
    const chunks = statRes.split('\0');
    const stagedEntry = chunks.find((c) => c.includes('new-file.txt'));
    assert.ok(stagedEntry, '未跟踪文件必须已被暂存');
    assert.ok(stagedEntry.startsWith('1 A. '));

    // 核心安全保证 3：WAL 记录保存为 partial
    const opRecord = await getCommitOperation('op_partial_001', operationOptions);
    assert.ok(opRecord);
    assert.equal(opRecord.status, 'partial');
    assert.ok(opRecord.stagedFiles.includes('new-file.txt'));
  });
  async function previewFor(paths = ['base.txt'], projectId = 'default', repo = repoDir) {
    const cands = await getCommitCandidates(repo, { projectId });
    return createCommitPreview(repo, { projectId,
      candidateIds: cands.candidates.filter((c) => paths.includes(c.path)).map((c) => c.id), message: 'Safety fixture' });
  }
  async function snapshot(repo = repoDir) {
    const gitDir = path.resolve(repo, gitCmd(repo, ['rev-parse', '--git-dir']).trim());
    const files = {};
    async function walk(dir, prefix = '') {
      for (const name of await fs.readdir(dir)) {
        if (name === '.git') continue;
        const rel = prefix + name;
        const stat = await fs.lstat(path.join(dir, name));
        if (stat.isDirectory()) await walk(path.join(dir, name), rel + '/');
        else files[rel] = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex');
      }
    }
    await walk(repo);
    return { head: gitCmd(repo, ['rev-parse', 'HEAD']).trim(), tree: gitCmd(repo, ['rev-parse', 'HEAD^{tree}']).trim(),
      index: (await fs.readFile(path.join(gitDir, 'index'))).toString('base64'),
      entries: gitCmd(repo, ['ls-files', '--stage', '-z']), flags: gitCmd(repo, ['ls-files', '-v', '-z']), files };
  }
  async function secondRepo(id = 'other') {
    const repo = path.join(tempBaseDir, id);
    await fs.mkdir(repo);
    gitCmd(repo, ['init', '-b', 'main']);
    gitCmd(repo, ['config', 'user.name', 'Fixture']); gitCmd(repo, ['config', 'user.email', 'fixture@example.com']);
    await fs.writeFile(path.join(repo, 'base.txt'), 'base content\n');
    gitCmd(repo, ['add', 'base.txt']); gitCmd(repo, ['commit', '-m', 'Initial commit']);
    const config = JSON.parse(await fs.readFile(configPath));
    config.projects.push({ id, name: id, repositoryPath: repo });
    await fs.writeFile(configPath, JSON.stringify(config));
    return repo;
  }
  const writeModule = pathToFileURL(path.resolve('server/git/commit-write.js')).href;
  const opsModule = pathToFileURL(path.resolve('server/git/commit-operations.js')).href;
  const previewModule = pathToFileURL(path.resolve('server/git/commit-preview.js')).href;
  async function runNode(source, args = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { cwd: tempBaseDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { err += b; });
      child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err || 'fixture child failed')));
    });
  }

  test('R1 cross-repository ticket is rejected before HEAD/index/worktree writes', async () => {
    const other = await secondRepo();
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'same update\n');
    await fs.writeFile(path.join(other, 'base.txt'), 'same update\n');
    const preview = await previewFor(['base.txt'], 'other', other);
    const beforeA = await snapshot(), beforeB = await snapshot(other);
    await assert.rejects(executeCommit('default', { ticketId: preview.ticketId, operationId: 'wrong_repo' }, operationOptions), { code: 'OPERATION_INVALID' });
    assert.deepEqual(await snapshot(), beforeA); assert.deepEqual(await snapshot(other), beforeB);
    assert.equal(await getCommitOperation('wrong_repo', operationOptions), null);
  });
  test('R1 completed operation cannot be returned in another project or for another ticket', async () => {
    const other = await secondRepo();
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'commit A\n');
    const preview = await previewFor();
    const params = { ticketId: preview.ticketId, operationId: 'bound_result' };
    assert.equal((await executeCommit('default', params, operationOptions)).status, 'completed');
    const before = await snapshot(other);
    await assert.rejects(executeCommit('other', params, operationOptions), { code: 'OPERATION_INVALID' });
    await assert.rejects(executeCommit('default', { ...params, ticketId: 'a'.repeat(64) }, operationOptions), { code: 'OPERATION_INVALID' });
    assert.deepEqual(await snapshot(other), before);
  });
  test('R1 config remapping after preview, and same-repository project aliases, reject mismatched tickets', async () => {
    const other = await secondRepo();
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'A changed\n');
    await fs.writeFile(path.join(other, 'base.txt'), 'B changed\n');
    const preview = await previewFor();
    await fs.writeFile(configPath, JSON.stringify({ projects: [{ id: 'default', name: 'Replacement', repositoryPath: other }, { id: 'alias', name: 'Alias', repositoryPath: repoDir }] }));
    const a = await snapshot(), b = await snapshot(other);
    for (const id of ['default', 'alias']) await assert.rejects(executeCommit(id, { ticketId: preview.ticketId, operationId: 'config_' + id }, operationOptions), { code: 'OPERATION_INVALID' });
    assert.deepEqual(await snapshot(), a); assert.deepEqual(await snapshot(other), b);
  });
  test('R1 config changes during WAL preparation stop before Git writes', async () => {
    const other = await secondRepo();
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'prepared change\n');
    const preview = await previewFor(), before = await snapshot();
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'mid_config' }, { ...operationOptions, _testHooks: { afterPrepared: async () => {
      await fs.writeFile(configPath, JSON.stringify({ projects: [{ id: 'default', name: 'Swap', repositoryPath: other }] }));
    } } });
    assert.equal(result.status, 'stale'); assert.deepEqual(await snapshot(), before);
  });
  test('R2 every existing not_started/failed ID is recovery-only, never replayed', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'ready\n');
    const preview = await previewFor(), before = await snapshot();
    const params = { ticketId: preview.ticketId, operationId: 'never_replay' };
    const first = await executeCommit('default', params, { ...operationOptions, _faultInjection: { failCommit: true } });
    assert.equal(first.status, 'not_started');
    for (const status of ['not_started', 'failed']) {
      const record = await getCommitOperation(params.operationId, operationOptions);
      await saveCommitOperation({ ...record, status }, operationOptions);
      const result = await executeCommit('default', params, operationOptions);
      assert.equal(result.status, 'not_started'); assert.equal(result.idempotent, true);
      assert.deepEqual(await snapshot(), before);
    }
  });
  test('R2 double click is serialized and produces exactly one commit', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'double click\n');
    const preview = await previewFor(), params = { ticketId: preview.ticketId, operationId: 'double' };
    const results = await Promise.all([executeCommit('default', params, operationOptions), executeCommit('default', params, operationOptions)]);
    assert.ok(results.every((r) => r.status === 'completed'));
    assert.equal(results[0].commitOid, results[1].commitOid);
    assert.equal(gitCmd(repoDir, ['rev-list', '--count', 'HEAD']).trim(), '2');
  });
  test('R2 result-record write failure is recovered in a fresh process without a second commit', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'durable retry\n');
    const preview = await previewFor(), params = { ticketId: preview.ticketId, operationId: 'result_fail' };
    const result = await executeCommit('default', params, { ...operationOptions, _testHooks: { beforeJournalAppend: (r) => { if (r.status === 'completed') throw Error('disk full private text'); } } });
    assert.equal(result.status, 'completed'); assert.equal(result.durable, false);
    assert.equal((await getCommitOperation(params.operationId, operationOptions)).phase, 'commit_started');
    const before = await snapshot(); clearAllCommitPreviewTickets();
    const recovered = JSON.parse(await runNode(`import {executeCommit} from ${JSON.stringify(writeModule)}; console.log(JSON.stringify(await executeCommit('default', ${JSON.stringify(params)}, ${JSON.stringify(operationOptions)})));`));
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.idempotent, true); assert.deepEqual(await snapshot(), before);
  });
  test('R2 unknown armed operation fences new tickets and is never replayed after restart', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'new\n');
    const preview = await previewFor(['new.txt']), params = { ticketId: preview.ticketId, operationId: 'armed' };
    const first = await executeCommit('default', params, { ...operationOptions, _testHooks: { beforeAdd: () => { throw Error('simulated lost owner'); } } });
    assert.equal(first.status, 'unknown');
    const before = await snapshot();
    assert.equal((await executeCommit('default', params, operationOptions)).status, 'unknown');
    const next = await previewFor(['new.txt']);
    const blocked = await executeCommit('default', { ticketId: next.ticketId, operationId: 'new_attempt' }, operationOptions);
    assert.equal(blocked.blockedByOperationId, 'armed'); assert.deepEqual(await snapshot(), before);
  });
  test('R2 malformed operation record fails closed with no writes', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'unchanged by retry\n');
    const preview = await previewFor(), before = await snapshot();
    await fs.mkdir(path.join(operationsDir, 'records'));
    await fs.writeFile(path.join(operationsDir, 'records', 'corrupt.json'), '{bad');
    await assert.rejects(executeCommit('default', { ticketId: preview.ticketId, operationId: 'corrupt' }, operationOptions), { code: 'OPERATION_STORE_FAILED' });
    assert.deepEqual(await snapshot(), before);
  });

  test('R3 live lock survives TTL and pruning, old release cannot delete successor', async () => {
    const key = path.join(repoDir, '.git');
    const lease = await acquireCommitLock(key, { operationId: 'owner', ttlMs: 1 }, operationOptions);
    await fs.utimes(path.join(lease.lockFile, lease.token + '.json'), new Date(0), new Date(0));
    await new Promise((r) => setTimeout(r, 10));
    await pruneOldOperations(operationOptions);
    await assert.rejects(acquireCommitLock(key, { operationId: 'contender' }, { ...operationOptions, lockWaitMs: 30 }), { code: 'REPOSITORY_BUSY' });
    await releaseCommitLock(key, lease, operationOptions);
    const next = await acquireCommitLock(key, { operationId: 'owner' }, operationOptions);
    await releaseCommitLock(key, lease, operationOptions);
    assert.ok((await fs.readdir(next.lockFile)).includes(next.token + '.json'));
    await releaseCommitLock(key, next, operationOptions);
  });
  test('R3 cross-process dead-owner reclaim and live-owner refusal', async () => {
    const key = path.join(repoDir, '.git');
    const lease = await acquireCommitLock(key, { operationId: 'parent_owner', ttlMs: 1 }, operationOptions);
    const contender = `import {acquireCommitLock} from ${JSON.stringify(opsModule)}; try { await acquireCommitLock(${JSON.stringify(key)}, {operationId:'child'}, ${JSON.stringify({ ...operationOptions, lockWaitMs: 20 })}); throw Error('stole live lock'); } catch(e) { if(e.code!=='REPOSITORY_BUSY') throw e; console.log('busy'); }`;
    assert.equal((await runNode(contender)).trim(), 'busy');
    await releaseCommitLock(key, lease, operationOptions);
    await runNode(`import {acquireCommitLock} from ${JSON.stringify(opsModule)}; await acquireCommitLock(${JSON.stringify(key)}, {operationId:'dead_child'}, ${JSON.stringify(operationOptions)});`);
    const recovered = await acquireCommitLock(key, { operationId: 'after_crash' }, operationOptions);
    await releaseCommitLock(key, recovered, operationOptions);
  });
  test('R3 multi-process collisions never overlap the critical section', async () => {
    const key = path.join(repoDir, '.git'), sentinel = path.join(tempBaseDir, 'critical-section');
    const source = `import fs from 'node:fs/promises'; import {acquireCommitLock,releaseCommitLock} from ${JSON.stringify(opsModule)};
      const options=${JSON.stringify({ ...operationOptions, lockWaitMs: 5000 })};
      for(let i=0;i<5;i++){ const lease=await acquireCommitLock(${JSON.stringify(key)},{operationId:'collision_'+process.pid},options);
        const h=await fs.open(${JSON.stringify(sentinel)},'wx'); await h.close();
        await new Promise(r=>setTimeout(r,5)); await fs.unlink(${JSON.stringify(sentinel)}); await releaseCommitLock(${JSON.stringify(key)},lease,options); }`;
    await Promise.all(Array.from({ length: 6 }, () => runNode(source)));
    await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
  });
  test('R3 case-sensitive repositories do not share a lowercased key', () => {
    if (process.platform !== 'win32') assert.notEqual(getRepoKeyHash(path.join(tempBaseDir, 'A')), getRepoKeyHash(path.join(tempBaseDir, 'a')));
  });

  test('R4 add exception after actual staging is partial from disk, without rollback', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'new exact\n');
    const preview = await previewFor(['new.txt']);
    const head = gitCmd(repoDir, ['rev-parse', 'HEAD']);
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'add_throws' }, { ...operationOptions, _testHooks: { afterAdd: () => { throw Object.assign(Error('hidden'), { code: 'GIT_TIMEOUT' }); } } });
    assert.equal(result.status, 'partial'); assert.equal(result.indexChange, 'selected_only');
    assert.equal(gitCmd(repoDir, ['rev-parse', 'HEAD']), head); assert.match(gitCmd(repoDir, ['ls-files', '--stage']), /new.txt/);
    assert.deepEqual((await getCommitOperation('add_throws', operationOptions)).stagedFiles, ['new.txt']);
  });
  test('R4 exception after actual commit still proves completed', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'committed before timeout\n');
    const preview = await previewFor();
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'commit_throws' }, { ...operationOptions, _testHooks: { afterCommit: () => { throw Object.assign(Error('private'), { code: 'GIT_TIMEOUT' }); } } });
    assert.equal(result.status, 'completed'); assert.equal(result.treeOid, preview.expectedTreeOid);
  });
  test('R4 actual commit output limit is reconciled instead of reported failed', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'output bounded\n');
    const preview = await previewFor();
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'output_limit' }, { ...operationOptions, _testWriteLimits: { maxOutputBytes: 1 } });
    const head = gitCmd(repoDir, ['rev-parse', 'HEAD']).trim();
    assert.equal(result.status, head === preview.headOid ? 'not_started' : 'completed');
    if (result.status === 'completed') assert.equal(result.treeOid, preview.expectedTreeOid);
    assert.equal((await getCommitOperation('output_limit', operationOptions)).errorReason, 'GIT_OUTPUT_LIMIT');
  });
  test('R4 unselected index corruption after commit forces unknown, preserves actual bytes', async () => {
    await fs.writeFile(path.join(repoDir, 'keep.txt'), 'keep staged\n'); gitCmd(repoDir, ['add', 'keep.txt']);
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'selected\n');
    const preview = await previewFor();
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'index_corrupt' }, { ...operationOptions, _testHooks: { afterCommit: async () => {
      await fs.writeFile(path.join(repoDir, 'keep.txt'), 'external new staging\n'); gitCmd(repoDir, ['add', 'keep.txt']);
    } } });
    assert.equal(result.status, 'unknown'); assert.equal(result.indexChange, 'unselected_changed');
    assert.equal(await fs.readFile(path.join(repoDir, 'keep.txt'), 'utf8'), 'external new staging\n');
    const before = await snapshot();
    assert.equal((await executeCommit('default', { ticketId: preview.ticketId, operationId: 'index_corrupt' }, operationOptions)).status, 'unknown');
    assert.deepEqual(await snapshot(), before);
  });
  test('R4 changed tree despite command success is unknown, never partial', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'previewed\n');
    const preview = await previewFor(['new.txt']);
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'foreign_tree' }, { ...operationOptions, _testHooks: { beforeCommit: async () => {
      await fs.writeFile(path.join(repoDir, 'new.txt'), 'external race\n');
    } } });
    assert.equal(result.status, 'unknown'); assert.notEqual(gitCmd(repoDir, ['rev-parse', 'HEAD']).trim(), preview.headOid);
    assert.notEqual(gitCmd(repoDir, ['rev-parse', 'HEAD^{tree}']).trim(), preview.expectedTreeOid);
  });
  test('R4 unreadable HEAD after command is unknown, never failed or partial', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'new\n');
    const preview = await previewFor(['new.txt']);
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'unreadable_head' }, { ...operationOptions, _testHooks: { afterCommit: async () => {
      await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'invalid fixture HEAD\n');
    } } });
    assert.equal(result.status, 'unknown'); assert.equal(result.success, false);
  });
  test('R4 failed commit without real changes is not_started and consumes operation ID', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'failed but retained\n');
    const preview = await previewFor(), before = await snapshot();
    const params = { ticketId: preview.ticketId, operationId: 'no_changes' };
    assert.equal((await executeCommit('default', params, { ...operationOptions, _faultInjection: { failCommit: true } })).status, 'not_started');
    assert.deepEqual(await snapshot(), before);
    assert.equal((await executeCommit('default', params, operationOptions)).status, 'not_started');
    assert.deepEqual(await snapshot(), before);
  });

  test('R5 configured stable root, path traversal and managed-repo data roots rejected', async () => {
    assert.throws(() => getOperationsDir(), { code: 'OPERATION_INVALID' });
    assert.throws(() => getOperationsDir({ operationsDir: 'relative' }), { code: 'OPERATION_INVALID' });
    assert.equal(getOperationsDir({ configPath }), path.join(tempBaseDir, 'commit-operations'));
    for (const bad of ['../outside', 'a/b', '', '.']) await assert.rejects(getCommitOperation(bad, operationOptions), { code: 'OPERATION_INVALID' });
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'root safety\n');
    const preview = await previewFor(), before = await snapshot();
    await assert.rejects(executeCommit('default', { ticketId: preview.ticketId, operationId: 'inside_repo' }, { configPath, operationsDir: path.join(repoDir, 'private') }), { code: 'OPERATION_INVALID' });
    assert.deepEqual(await snapshot(), before);
  });
  test('R5 WAL failure before append causes zero Git writes', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'not staged\n');
    const preview = await previewFor(['new.txt']), before = await snapshot();
    await assert.rejects(executeCommit('default', { ticketId: preview.ticketId, operationId: 'wal_failed' }, { ...operationOptions, _testHooks: { beforeJournalAppend: () => { throw Error('ENOSPC private'); } } }), { code: 'OPERATION_STORE_FAILED' });
    assert.deepEqual(await snapshot(), before);
    assert.equal(await getCommitOperation('wal_failed', operationOptions), null);
    assert.deepEqual(await listCommitOperations(operationOptions), []);
  });
  test('R5 WAL failure after complete append never permits replay and stores no host paths/body/stderr', async () => {
    const body = 'PRIVATE_FILE_BODY_TOKEN';
    await fs.writeFile(path.join(repoDir, 'new.txt'), body);
    const preview = await previewFor(['new.txt']), before = await snapshot();
    const params = { ticketId: preview.ticketId, operationId: 'wal_after_rename' };
    await assert.rejects(executeCommit('default', params, { ...operationOptions, _testHooks: { afterJournalWrite: () => { throw Error('PRIVATE_ERROR_TOKEN'); } } }), { code: 'OPERATION_STORE_FAILED' });
    assert.deepEqual(await snapshot(), before);
    const result = await executeCommit('default', params, operationOptions);
    assert.equal(result.status, 'not_started'); assert.equal(result.idempotent, true); assert.deepEqual(await snapshot(), before);
    const raw = (await fs.readFile(path.join(operationsDir, 'operations.journal'))).toString('utf8');
    assert.ok(!raw.includes(repoDir) && !raw.includes(body) && !raw.includes('PRIVATE_ERROR_TOKEN') && !raw.includes(preview.ticketId));
    const record = await getCommitOperation(params.operationId, operationOptions); assert.equal(record.repositoryIdentity.length, 64); assert.equal(record.ticketDigest.length, 64); assert.ok(record.indexBefore.all);
  });
  test('R5 pruning successful detail preserves a bounded no-replay retirement filter', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'retirement\n');
    const preview = await previewFor(), params = { ticketId: preview.ticketId, operationId: 'retired' };
    assert.equal((await executeCommit('default', params, operationOptions)).status, 'completed');
    const clockNow = Date.now;
    try { Date.now = () => clockNow() + 8 * 24 * 60 * 60 * 1000; await pruneOldOperations(operationOptions); }
    finally { Date.now = clockNow; }
    assert.equal((await getCommitOperation('retired', operationOptions)).retired, true);
    const before = await snapshot();
    assert.equal((await executeCommit('default', params, operationOptions)).status, 'unknown');
    assert.deepEqual(await snapshot(), before);
    assert.ok((await fs.stat(path.join(operationsDir, 'operations.journal'))).size < COMMIT_JOURNAL_LIMITS.bytes);
  });
  test('write executor requires explicit cwd and ignores inherited GIT_INDEX_FILE', async () => {
    await assert.rejects(runCommitWriteGit(['status']), { code: 'OPERATION_INVALID' });
    const external = path.join(tempBaseDir, 'must-not-create-index');
    const old = process.env.GIT_INDEX_FILE; process.env.GIT_INDEX_FILE = external;
    try {
      const result = await runCommitWriteGit(['ls-files', '--stage'], { cwd: repoDir });
      assert.equal(result.code, 0); assert.match(result.stdout.toString(), /base.txt/);
      await assert.rejects(fs.stat(external), { code: 'ENOENT' });
    } finally { if (old === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = old; }
  });

  test('R2 actual service crash in armed phase remains unknown and fences new writes', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'crash armed\n');
    const source = `import {getCommitCandidates,createCommitPreview} from ${JSON.stringify(previewModule)};
      import {executeCommit} from ${JSON.stringify(writeModule)};
      const repo=${JSON.stringify(repoDir)}, options=${JSON.stringify(operationOptions)};
      const c=await getCommitCandidates(repo); const p=await createCommitPreview(repo,{projectId:'default',candidateIds:c.candidates.map(x=>x.id),message:'Crash fixture'});
      await executeCommit('default',{ticketId:p.ticketId,operationId:'crashed_service'},{...options,_testHooks:{beforeCommit:async()=>{process.send({ticketId:p.ticketId}); await new Promise(()=>{});}}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: tempBaseDir, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
    const [msg] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(stderr || 'child exited before armed phase'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const before = await snapshot();
    const same = await executeCommit('default', { ticketId: msg.ticketId, operationId: 'crashed_service' }, operationOptions);
    assert.equal(same.status, 'unknown'); assert.equal(same.idempotent, true);
    const next = await previewFor();
    const blocked = await executeCommit('default', { ticketId: next.ticketId, operationId: 'after_crashed_service' }, operationOptions);
    assert.equal(blocked.blockedByOperationId, 'crashed_service'); assert.deepEqual(await snapshot(), before);
  });
  test('R2 two service instances preview together but only one may commit', async () => {
    await fs.writeFile(path.join(repoDir, 'keep.txt'), 'kept staged\n'); gitCmd(repoDir, ['add', 'keep.txt']);
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'shared services\n');
    const keep = gitCmd(repoDir, ['ls-files', '--stage', '--', 'keep.txt']);
    const source = `import {once} from 'node:events'; import {getCommitCandidates,createCommitPreview} from ${JSON.stringify(previewModule)};
      import {executeCommit} from ${JSON.stringify(writeModule)};
      const repo=${JSON.stringify(repoDir)}, options=${JSON.stringify(operationOptions)};
      const c=await getCommitCandidates(repo); const p=await createCommitPreview(repo,{projectId:'default',candidateIds:c.candidates.filter(x=>x.path==='base.txt').map(x=>x.id),message:'Concurrent fixture'});
      process.send({ready:true}); await once(process,'message');
      const result=await executeCommit('default',{ticketId:p.ticketId,operationId:'service_'+process.pid},options); process.send({result}); process.disconnect();`;
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: tempBaseDir, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    const results = children.map((child) => new Promise((resolve, reject) => {
      let err = ''; child.stderr.on('data', (b) => { err += b; });
      child.on('error', reject); child.on('message', (m) => { if (m.result) resolve(m.result); });
      child.on('exit', (code) => { if (code !== 0) reject(Error(err)); });
    }));
    await Promise.all(children.map((child) => once(child, 'message')));
    children.forEach((child) => child.send('go'));
    const out = await Promise.all(results);
    assert.deepEqual(out.map((r) => r.status).sort(), ['completed', 'stale']);
    assert.equal(gitCmd(repoDir, ['rev-list', '--count', 'HEAD']).trim(), '2');
    assert.equal(gitCmd(repoDir, ['ls-files', '--stage', '--', 'keep.txt']), keep);
    assert.equal(await fs.readFile(path.join(repoDir, 'keep.txt'), 'utf8'), 'kept staged\n');
  });
  test('R1 linked worktrees share common lock but cannot share ticket identity', async () => {
    const linked = path.join(tempBaseDir, 'linked');
    gitCmd(repoDir, ['worktree', 'add', '-b', 'fixture-linked', linked]);
    const config = JSON.parse(await fs.readFile(configPath)); config.projects.push({ id: 'linked', name: 'Linked fixture', repositoryPath: linked });
    await fs.writeFile(configPath, JSON.stringify(config));
    await fs.writeFile(path.join(linked, 'base.txt'), 'linked modified\n');
    const preview = await previewFor(['base.txt'], 'linked', linked);
    const before = await snapshot(linked);
    await assert.rejects(executeCommit('default', { ticketId: preview.ticketId, operationId: 'linked_wrong' }, operationOptions), { code: 'OPERATION_INVALID' });
    const lease = await acquireCommitLock(path.join(repoDir, '.git'), { operationId: 'linked_owner' }, operationOptions);
    await assert.rejects(executeCommit('linked', { ticketId: preview.ticketId, operationId: 'linked_busy' }, { ...operationOptions, lockWaitMs: 20 }), { code: 'REPOSITORY_BUSY' });
    await releaseCommitLock(path.join(repoDir, '.git'), lease, operationOptions);
    assert.deepEqual(await snapshot(linked), before);
    assert.equal((await executeCommit('linked', { ticketId: preview.ticketId, operationId: 'linked_ok' }, operationOptions)).status, 'completed');
  });
  test('R5 read-only bound result query does not touch locks, records or repository', async () => {
    const other = await secondRepo();
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'read-only query\n');
    const preview = await previewFor(), params = { ticketId: preview.ticketId, operationId: 'query_only' };
    await executeCommit('default', params, { ...operationOptions, _testHooks: { beforeJournalAppend: (r) => { if (r.status === 'completed') throw Error('result unavailable'); } } });
    const recordPath = path.join(operationsDir, 'operations.journal');
    const raw = await fs.readFile(recordPath), stat = await fs.stat(recordPath), before = await snapshot();
    assert.equal((await queryCommitOperation('default', params.operationId, operationOptions)).status, 'completed');
    await assert.rejects(queryCommitOperation('other', params.operationId, operationOptions), { code: 'OPERATION_INVALID' });
    assert.deepEqual(await fs.readFile(recordPath), raw); assert.equal((await fs.stat(recordPath)).mtimeMs, stat.mtimeMs);
    assert.deepEqual(await fs.readdir(path.join(operationsDir, 'locks')), []); assert.deepEqual(await snapshot(), before);
    assert.ok(other);
  });
  test('executor deterministic timeout and output limit reap spawned children before rejection', async () => {
    for (const mode of ['timeout', 'output']) {
      let child;
      const start = Date.now();
      const promise = runCommitWriteGit(['status'], { cwd: repoDir, timeoutMs: mode === 'timeout' ? 100 : 3000, maxOutputBytes: 32,
        _spawnForTest: (command, args, opts) => {
          assert.equal(command, 'git'); assert.equal(opts.shell, false); assert.equal(opts.cwd, repoDir);
          child = spawn(process.execPath, ['-e', mode === 'timeout' ? "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)" : "process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('x'.repeat(100)),5)"], opts);
          return child;
        } });
      await assert.rejects(promise, { code: mode === 'timeout' ? 'GIT_TIMEOUT' : 'GIT_OUTPUT_LIMIT' });
      assert.ok(child.exitCode !== null || child.signalCode !== null); assert.ok(Date.now() - start < 2500);
    }
  });
  test('R4 staged-only selection preserves the entire unselected index including flags', async () => {
    await fs.writeFile(path.join(repoDir, 'keep.txt'), 'keep committed\n'); gitCmd(repoDir, ['add', 'keep.txt']); gitCmd(repoDir, ['commit', '-m', 'fixture seed']);
    gitCmd(repoDir, ['update-index', '--assume-unchanged', 'keep.txt']);
    await fs.writeFile(path.join(repoDir, 'keep.txt'), 'untouched physical change\n');
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'selected staged\n'); gitCmd(repoDir, ['add', 'base.txt']);
    const beforeKeep = gitCmd(repoDir, ['ls-files', '--stage', '--', 'keep.txt']) + gitCmd(repoDir, ['ls-files', '-v', '--', 'keep.txt']);
    const preview = await previewFor();
    assert.equal((await executeCommit('default', { ticketId: preview.ticketId, operationId: 'staged_only' }, operationOptions)).status, 'completed');
    assert.equal(gitCmd(repoDir, ['ls-files', '--stage', '--', 'keep.txt']) + gitCmd(repoDir, ['ls-files', '-v', '--', 'keep.txt']), beforeKeep);
    assert.equal(await fs.readFile(path.join(repoDir, 'keep.txt'), 'utf8'), 'untouched physical change\n');
  });
  test('T01 partial staging remains refused, preview/execute preserve literal path isolation', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'staged\n'); gitCmd(repoDir, ['add', 'base.txt']);
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'unstaged too\n');
    await assert.rejects(previewFor(), { code: 'UNSELECTABLE_CANDIDATE' });
    await fs.writeFile(path.join(repoDir, '[ab].txt'), 'literal selected\n');
    await fs.writeFile(path.join(repoDir, 'a.txt'), 'must remain untracked\n');
    const preview = await previewFor(['[ab].txt']);
    const baseEntry = gitCmd(repoDir, ['ls-files', '--stage', '--', 'base.txt']);
    assert.equal((await executeCommit('default', { ticketId: preview.ticketId, operationId: 'literal_exact' }, operationOptions)).status, 'completed');
    assert.equal(gitCmd(repoDir, ['ls-files', '--stage', '--', 'base.txt']), baseEntry);
    assert.equal(gitCmd(repoDir, ['ls-files', '--stage', '--', 'a.txt']), '');
    assert.equal(await fs.readFile(path.join(repoDir, 'a.txt'), 'utf8'), 'must remain untracked\n');
  });

  test('T02 add/ref transaction hooks are rejected before any repository write', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'hooks test\n');
    const preview = await previewFor();
    for (const hook of ['post-index-change', 'reference-transaction']) {
      const hookFile = path.join(repoDir, '.git', 'hooks', hook);
      const marker = path.join(tempBaseDir, 'must-not-run-hook');
      await fs.writeFile(hookFile, '#!/bin/sh\nprintf bad > ' + JSON.stringify(marker) + '\n'); await fs.chmod(hookFile, 0o755);
      const before = await snapshot();
      await assert.rejects(executeCommit('default', { ticketId: preview.ticketId, operationId: 'hook_' + hook }, operationOptions), { code: 'HOOKS_UNSUPPORTED' });
      assert.deepEqual(await snapshot(), before); await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
      await fs.unlink(hookFile);
    }
  });
  test('R5 capacity refuses new IDs instead of evicting unresolved safety evidence', async () => {
    for (let i = 0; i < 100; i++) await saveCommitOperation({ operationId: `capacity_${i}`, status: 'unknown', projectId: 'fixture', repositoryIdentity: 'a'.repeat(64), commonIdentity: 'b'.repeat(64), ticketDigest: 'c'.repeat(64), previewDigest: 'd'.repeat(64), selectedFiles: [], addPaths: [], indexBefore: { all: 'e'.repeat(64) } }, operationOptions);
    await pruneOldOperations(operationOptions);
    assert.equal((await listCommitOperations(operationOptions)).length, 100);
    await assert.rejects(saveCommitOperation({ operationId: 'over_capacity', status: 'not_started' }, operationOptions), { code: 'OPERATION_CAPACITY' });
    assert.equal((await listCommitOperations(operationOptions)).length, 100);
  });
  test('R5 nested data roots support process-crash persistence and symlink data roots cannot enter managed repository', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'nested store\n');
    const preview = await previewFor();
    const nested = path.join(tempBaseDir, 'nested', 'local', 'operations');
    assert.equal((await executeCommit('default', { ticketId: preview.ticketId, operationId: 'nested_root' }, { configPath, operationsDir: nested })).status, 'completed');
    if (process.platform !== 'win32') {
      const alias = path.join(tempBaseDir, 'alias-data'); await fs.symlink(repoDir, alias, 'dir');
      const before = await snapshot();
      await assert.rejects(executeCommit('default', { ticketId: preview.ticketId, operationId: 'symlink_store' }, { configPath, operationsDir: path.join(alias, 'operations') }), { code: 'OPERATION_INVALID' });
      assert.deepEqual(await snapshot(), before);
    }
  });

  test('R02 hook introduced after prepared WAL is rejected by final pre-add gate', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'must stay untracked\n');
    const preview = await previewFor(['new.txt']), before = await snapshot();
    const marker = path.join(tempBaseDir, 'late-hook-ran');
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'late_hook' }, { ...operationOptions, _testHooks: { afterPrepared: async () => {
      const hook = path.join(repoDir, '.git', 'hooks', 'post-index-change');
      await fs.writeFile(hook, '#!/bin/sh\nprintf unsafe > ' + JSON.stringify(marker) + '\n'); await fs.chmod(hook, 0o755);
    } } });
    assert.equal(result.status, 'stale'); assert.equal(result.reason, 'PREVIEW_STALE');
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' }); assert.deepEqual(await snapshot(), before);
  });
  test('R02 hook introduced immediately before add is also refused without staging', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'must stay untracked\n');
    const preview = await previewFor(['new.txt']), before = await snapshot();
    const marker = path.join(tempBaseDir, 'pre-add-hook-ran');
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'pre_add_hook' }, { ...operationOptions, _testHooks: { beforeAdd: async () => {
      const hook = path.join(repoDir, '.git', 'hooks', 'post-index-change');
      await fs.writeFile(hook, '#!/bin/sh\nprintf unsafe > ' + JSON.stringify(marker) + '\n'); await fs.chmod(hook, 0o755);
    } } });
    assert.equal(result.success, false); await assert.rejects(fs.stat(marker), { code: 'ENOENT' }); assert.deepEqual(await snapshot(), before);
  });
  test('R02 unchanged unselected intent-to-add remains intact after selected commit', async () => {
    await fs.writeFile(path.join(repoDir, 'empty.txt'), ''); gitCmd(repoDir, ['add', '--intent-to-add', 'empty.txt']);
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'selected change\n');
    const beforeDebug = gitCmd(repoDir, ['ls-files', '--debug', '--', 'empty.txt']);
    const preview = await previewFor();
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'keep_ita' }, operationOptions);
    assert.equal(result.status, 'completed');
    assert.equal(gitCmd(repoDir, ['ls-files', '--debug', '--', 'empty.txt']), beforeDebug);
    assert.match(gitCmd(repoDir, ['status', '--porcelain=v2', '--', 'empty.txt']), /1 \.A /);
  });
  test('R02 clearing CE_INTENT_TO_ADD is detected even when stage OID/mode and -v output match', async () => {
    await fs.writeFile(path.join(repoDir, 'empty.txt'), ''); gitCmd(repoDir, ['add', '--intent-to-add', 'empty.txt']);
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'selected change\n');
    const simpleBefore = gitCmd(repoDir, ['ls-files', '--stage', '--', 'empty.txt']) + gitCmd(repoDir, ['ls-files', '-v', '--', 'empty.txt']);
    const debugBefore = gitCmd(repoDir, ['ls-files', '--debug', '--', 'empty.txt']);
    const preview = await previewFor();
    const result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'changed_ita' }, { ...operationOptions, _testHooks: { afterCommit: () => gitCmd(repoDir, ['add', 'empty.txt']) } });
    assert.equal(gitCmd(repoDir, ['ls-files', '--stage', '--', 'empty.txt']) + gitCmd(repoDir, ['ls-files', '-v', '--', 'empty.txt']), simpleBefore);
    assert.notEqual(gitCmd(repoDir, ['ls-files', '--debug', '--', 'empty.txt']), debugBefore);
    assert.equal(result.status, 'unknown'); assert.equal(result.indexChange, 'unselected_changed');
  });
  test('R02 lock-directory setup failures expose only stable sanitized errors', async () => {
    const fileStore = path.join(tempBaseDir, 'regular-file-store'); await fs.writeFile(fileStore, 'not a directory');
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'safe before storage error\n');
    const preview = await previewFor(), before = await snapshot();
    await assert.rejects(executeCommit('default', { ticketId: preview.ticketId, operationId: 'regular_store' }, { configPath, operationsDir: fileStore }), (error) => {
      assert.ok(error instanceof GitError); assert.equal(error.code, 'OPERATION_STORE_FAILED');
      assert.ok(!error.message.includes(tempBaseDir)); assert.equal(error.path, undefined); assert.equal(error.syscall, undefined); return true;
    });
    assert.deepEqual(await snapshot(), before);
  });

  test('R02 old completed records without full-flag evidence cannot bypass new result validation', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'legacy proof\n');
    const preview = await previewFor(), params = { ticketId: preview.ticketId, operationId: 'legacy_flags' };
    assert.equal((await executeCommit('default', params, operationOptions)).status, 'completed');
    const record = await getCommitOperation(params.operationId, operationOptions);
    delete record.indexBefore.format; delete record.indexAfter.format;
    await saveCommitOperation(record, operationOptions);
    const before = await snapshot();
    assert.equal((await executeCommit('default', params, operationOptions)).status, 'unknown');
    assert.deepEqual(await snapshot(), before);
  });

  function frames(bytes) {
    const result = []; let offset = 0;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset + 8), end = offset + 52 + length;
      result.push({ start: offset, end: end + 32, header: bytes.subarray(offset, offset + 52),
        sequence: Number(bytes.readBigUInt64BE(offset + 12)), payload: JSON.parse(bytes.subarray(offset + 52, end)),
        hash: bytes.subarray(end, end + 32), unsigned: bytes.subarray(offset, end) });
      offset = end + 32;
    }
    return result;
  }
  function reframe(frame, payload = frame.payload, sequence = frame.sequence) {
    const body = Buffer.from(JSON.stringify(payload)), header = Buffer.from(frame.header);
    header.writeUInt32BE(body.length, 8); header.writeBigUInt64BE(BigInt(sequence), 12);
    const unsigned = Buffer.concat([header, body]);
    return Buffer.concat([unsigned, crypto.createHash('sha256').update(unsigned).digest()]);
  }
  async function clonedStore(name) {
    const dir = path.join(tempBaseDir, name); await fs.mkdir(dir);
    for (const file of ['operations.journal', 'journal-store.json']) await fs.copyFile(path.join(operationsDir, file), path.join(dir, file));
    return { configPath, operationsDir: dir };
  }
  async function normalJournalCommit(operationId = 'journal_normal') {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'journal commit\n');
    const preview = await previewFor(), params = { ticketId: preview.ticketId, operationId };
    const result = await executeCommit('default', params, operationOptions);
    assert.equal(result.status, 'completed'); return { preview, params, result };
  }
  test('R03 journal contains chained, checksummed, consecutive authoritative frames', async () => {
    const { params, result } = await normalJournalCommit();
    assert.equal(result.persistenceGuarantee, 'service-process-crash-only');
    const journal = await fs.readFile(path.join(operationsDir, 'operations.journal'));
    const events = frames(journal);
    let previous = Buffer.alloc(32);
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].sequence, i); assert.equal(events[i].header.subarray(0, 8).toString(), 'LVMJNL3\n');
      assert.deepEqual(events[i].header.subarray(20), previous);
      assert.deepEqual(events[i].hash, crypto.createHash('sha256').update(events[i].unsigned).digest());
      previous = events[i].hash;
    }
    assert.equal(events[0].payload.type, 'init');
    assert.deepEqual(events.slice(1).map((f) => f.payload.record.phase), ['prepared', 'commit_started', 'settled']);
    assert.deepEqual(events.slice(1).map((f) => f.payload.reserveFrames), [4, 3, 0]);
    assert.equal(events.at(-1).payload.record.operationId, params.operationId);
    await assert.rejects(fs.stat(path.join(operationsDir, 'records')), { code: 'ENOENT' });
  });
  test('R03 torn tail, checksum, sequence, chain and checksummed semantic corruption all stop writes', async () => {
    const { params } = await normalJournalCommit();
    const bytes = await fs.readFile(path.join(operationsDir, 'operations.journal'));
    const last = frames(bytes).at(-1), prefix = bytes.subarray(0, last.start);
    const variants = {
      torn: bytes.subarray(0, bytes.length - 1),
      checksum: Buffer.from(bytes),
      sequence: Buffer.concat([prefix, reframe(last, last.payload, last.sequence + 1)]),
      type: Buffer.concat([prefix, reframe(last, { type: 'unsupported', anything: 'rejected' })]),
      identity: Buffer.concat([prefix, reframe(last, { ...last.payload, record: { ...last.payload.record, repositoryIdentity: 'f'.repeat(64) } })]),
      missing_id: Buffer.concat([prefix, reframe(last, { ...last.payload, record: { ...last.payload.record, operationId: undefined } })]),
    };
    variants.checksum[variants.checksum.length - 2] ^= 1;
    const changedHeader = Buffer.from(last.header); changedHeader[20] ^= 1;
    variants.chain = Buffer.concat([prefix, reframe({ ...last, header: changedHeader })]);
    const before = await snapshot();
    for (const [name, corrupted] of Object.entries(variants)) {
      const options = await clonedStore('bad_' + name);
      const file = path.join(options.operationsDir, 'operations.journal'); await fs.writeFile(file, corrupted);
      await assert.rejects(getCommitOperation(params.operationId, options), { code: 'OPERATION_STORE_FAILED' });
      await assert.rejects(executeCommit('default', params, options), { code: 'OPERATION_STORE_FAILED' });
      assert.deepEqual(await fs.readFile(file), corrupted); assert.deepEqual(await snapshot(), before);
    }
  });
  test('R03 missing marker/journal, empty journal and legacy stores never become empty history', async () => {
    const { params } = await normalJournalCommit(), before = await snapshot();
    for (const name of ['marker_missing', 'journal_missing', 'journal_empty']) {
      const options = await clonedStore(name);
      if (name === 'marker_missing') await fs.unlink(path.join(options.operationsDir, 'journal-store.json'));
      else if (name === 'journal_missing') await fs.unlink(path.join(options.operationsDir, 'operations.journal'));
      else await fs.writeFile(path.join(options.operationsDir, 'operations.journal'), '');
      await assert.rejects(executeCommit('default', params, options), { code: 'OPERATION_STORE_FAILED' });
      assert.deepEqual(await snapshot(), before);
    }
    const legacyDir = path.join(tempBaseDir, 'legacy'); await fs.mkdir(path.join(legacyDir, 'records'), { recursive: true });
    const legacy = { operationId: 'legacy', status: 'completed', commitOid: params.operationId };
    const legacyPath = path.join(legacyDir, 'records', 'legacy.json'); await fs.writeFile(legacyPath, JSON.stringify(legacy));
    await assert.rejects(executeCommit('default', { ...params, operationId: 'new_in_legacy' }, { configPath, operationsDir: legacyDir }), { code: 'OPERATION_STORE_FAILED' });
    assert.equal(await fs.readFile(legacyPath, 'utf8'), JSON.stringify(legacy));
    await assert.rejects(fs.stat(path.join(legacyDir, 'operations.journal')), { code: 'ENOENT' });
  });
  test('R03 interrupted bootstrap is retained and refused without repository writes', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'bootstrap safe\n');
    const preview = await previewFor(), before = await snapshot(), params = { ticketId: preview.ticketId, operationId: 'bootstrap_crash' };
    await assert.rejects(executeCommit('default', params, { ...operationOptions, _testHooks: { afterJournalMarker: () => { throw Error('bootstrap interruption'); } } }), { code: 'OPERATION_STORE_FAILED' });
    const marker = await fs.readFile(path.join(operationsDir, 'journal-store.json'));
    await assert.rejects(executeCommit('default', params, operationOptions), { code: 'OPERATION_STORE_FAILED' });
    assert.deepEqual(await fs.readFile(path.join(operationsDir, 'journal-store.json')), marker);
    assert.deepEqual(await snapshot(), before);
  });
  test('R03 partial append poisons the store without implicit truncation or replay', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'must not stage\n');
    const preview = await previewFor(['new.txt']), before = await snapshot(), params = { ticketId: preview.ticketId, operationId: 'partial_frame' };
    await assert.rejects(executeCommit('default', params, { ...operationOptions, _testJournalChunkBytes: 16, _testHooks: { afterJournalChunk: () => { throw Error('partial write'); } } }), { code: 'OPERATION_STORE_FAILED' });
    const file = path.join(operationsDir, 'operations.journal'), damaged = await fs.readFile(file);
    await assert.rejects(executeCommit('default', params, operationOptions), { code: 'OPERATION_STORE_FAILED' });
    await assert.rejects(pruneOldOperations(operationOptions), { code: 'OPERATION_STORE_FAILED' });
    assert.deepEqual(await fs.readFile(file), damaged); assert.deepEqual(await snapshot(), before);
  });
  test('R03 real file-sync error after complete frame consumes ID but never launches Git', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'sync error safe\n');
    const preview = await previewFor(), before = await snapshot(), params = { ticketId: preview.ticketId, operationId: 'file_sync_fail' };
    const originalOpen = fs.open;
    fs.open = async (file, flags, ...rest) => {
      const handle = await originalOpen(file, flags, ...rest);
      if (String(file) === path.join(operationsDir, 'operations.journal') && flags === 'r+') handle.sync = async () => { throw Object.assign(Error('private sync path'), { code: 'EIO' }); };
      return handle;
    };
    try { await assert.rejects(executeCommit('default', params, operationOptions), { code: 'OPERATION_STORE_FAILED' }); }
    finally { fs.open = originalOpen; }
    assert.deepEqual(await snapshot(), before);
    assert.equal((await executeCommit('default', params, operationOptions)).status, 'not_started');
    assert.deepEqual(await snapshot(), before);
  });
  test('R03 lost acknowledgement after journal sync is recovered without duplicate Git command', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'lost acknowledgement\n');
    const preview = await previewFor(), params = { ticketId: preview.ticketId, operationId: 'lost_sync_ack' };
    const result = await executeCommit('default', params, { ...operationOptions, _testHooks: { afterJournalSync: (record) => { if (record.status === 'completed') throw Error('lost ack'); } } });
    assert.equal(result.status, 'completed'); assert.equal(result.durable, false);
    const before = await snapshot(); clearAllCommitPreviewTickets();
    const recovered = JSON.parse(await runNode(`import {executeCommit} from ${JSON.stringify(writeModule)}; console.log(JSON.stringify(await executeCommit('default',${JSON.stringify(params)},${JSON.stringify(operationOptions)})));`));
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.idempotent, true); assert.deepEqual(await snapshot(), before);
  });
  test('R03 simulated Windows directory-handle limitation permits normal writable-file synced commit', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'portable file sync\n');
    const preview = await previewFor(), originalOpen = fs.open, synced = [];
    fs.open = async (file, flags, ...rest) => {
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isDirectory()) throw Object.assign(Error('Windows directory handle unsupported'), { code: 'EPERM' });
      const handle = await originalOpen(file, flags, ...rest), originalSync = handle.sync.bind(handle);
      handle.sync = async () => { assert.ok(flags.includes('+') || flags.includes('w'), 'fsync target must be writable'); synced.push(String(file)); return originalSync(); };
      return handle;
    };
    let result;
    try { result = await executeCommit('default', { ticketId: preview.ticketId, operationId: 'simulated_windows' }, operationOptions); }
    finally { fs.open = originalOpen; }
    assert.equal(result.status, 'completed'); assert.equal(result.persistenceGuarantee, 'service-process-crash-only');
    assert.ok(synced.filter((file) => file.endsWith('operations.journal')).length >= 4);
  });
  test('R03 different repositories serialize shared journal appends without frame collisions', async () => {
    const other = await secondRepo();
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'first repo\n'); await fs.writeFile(path.join(other, 'base.txt'), 'second repo\n');
    const a = await previewFor(), b = await previewFor(['base.txt'], 'other', other);
    const results = await Promise.all([
      executeCommit('default', { ticketId: a.ticketId, operationId: 'journal_repo_a' }, operationOptions),
      executeCommit('other', { ticketId: b.ticketId, operationId: 'journal_repo_b' }, operationOptions),
    ]);
    assert.ok(results.every((r) => r.status === 'completed')); assert.equal((await listCommitOperations(operationOptions)).length, 2);
    const events = frames(await fs.readFile(path.join(operationsDir, 'operations.journal')));
    assert.deepEqual(events.map((f) => f.sequence), events.map((_, i) => i));
  });
  test('R03 journal capacity reserves remaining frames for an in-flight operation', async () => {
    const other = await secondRepo();
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'reserved first\n'); await fs.writeFile(path.join(other, 'base.txt'), 'capacity second\n');
    const a = await previewFor(), b = await previewFor(['base.txt'], 'other', other), beforeB = await snapshot(other);
    const options = { ...operationOptions, _testJournalMaxBytes: 17 * 1024 * 1024 };
    let prepared, release;
    const ready = new Promise((r) => { prepared = r; }), hold = new Promise((r) => { release = r; });
    const first = executeCommit('default', { ticketId: a.ticketId, operationId: 'reserved_a' }, { ...options, _testHooks: { afterPrepared: async () => { prepared(); await hold; } } });
    await ready;
    try {
      await assert.rejects(executeCommit('other', { ticketId: b.ticketId, operationId: 'reserved_b' }, options), { code: 'OPERATION_CAPACITY' });
      assert.deepEqual(await snapshot(other), beforeB);
    } finally { release(); }
    assert.equal((await first).status, 'completed');
    assert.equal((await executeCommit('other', { ticketId: b.ticketId, operationId: 'reserved_b' }, options)).status, 'completed');
  });
  test('R03 repeated unchanged unknown recovery does not consume journal capacity', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'unknown no-op\n');
    const preview = await previewFor(['new.txt']), params = { ticketId: preview.ticketId, operationId: 'unknown_noop' };
    assert.equal((await executeCommit('default', params, { ...operationOptions, _testHooks: { beforeAdd: () => { throw Error('owner interrupted'); } } })).status, 'unknown');
    const file = path.join(operationsDir, 'operations.journal'), before = await fs.readFile(file);
    for (let i = 0; i < 3; i++) assert.equal((await executeCommit('default', params, operationOptions)).status, 'unknown');
    assert.deepEqual(await fs.readFile(file), before);
  });
  test('R03 short-write loop completes valid frames and read-only query during append never repairs tail', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'short writes\n');
    const preview = await previewFor(), params = { ticketId: preview.ticketId, operationId: 'short_frames' };
    let entered, release, chunks = 0;
    const ready = new Promise((r) => { entered = r; }), hold = new Promise((r) => { release = r; });
    const operation = executeCommit('default', params, { ...operationOptions, _testJournalChunkBytes: 17, _testHooks: { afterJournalChunk: async () => { if (++chunks === 1) { entered(); await hold; } } } });
    await ready;
    const file = path.join(operationsDir, 'operations.journal'), partial = await fs.readFile(file);
    try {
      await assert.rejects(queryCommitOperation('default', params.operationId, operationOptions), { code: 'OPERATION_STORE_FAILED' });
      assert.deepEqual(await fs.readFile(file), partial);
    } finally { release(); }
    assert.equal((await operation).status, 'completed'); assert.ok(chunks > 10);
    assert.equal((await queryCommitOperation('default', params.operationId, operationOptions)).status, 'completed');
  });
  test('R03 actual crash mid-frame is refused by a fresh service process', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'partial service crash\n');
    const source = `import {getCommitCandidates,createCommitPreview} from ${JSON.stringify(previewModule)}; import {executeCommit} from ${JSON.stringify(writeModule)};
      const c=await getCommitCandidates(${JSON.stringify(repoDir)}); const p=await createCommitPreview(${JSON.stringify(repoDir)},{candidateIds:c.candidates.map(x=>x.id),message:'Frame crash'});
      await executeCommit('default',{ticketId:p.ticketId,operationId:'frame_crash'},{...${JSON.stringify(operationOptions)},_testJournalChunkBytes:16,_testHooks:{afterJournalChunk:async()=>{process.send({ticketId:p.ticketId});await new Promise(()=>{});}}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: tempBaseDir, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
    const [msg] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(stderr || 'child exited early'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const before = await snapshot(), journal = await fs.readFile(path.join(operationsDir, 'operations.journal'));
    const output = await runNode(`import {executeCommit} from ${JSON.stringify(writeModule)}; try {await executeCommit('default',{ticketId:${JSON.stringify(msg.ticketId)},operationId:'frame_crash'},${JSON.stringify(operationOptions)});throw Error('unexpected success');}catch(e){if(e.code!=='OPERATION_STORE_FAILED')throw e;console.log(e.code);}`);
    assert.equal(output.trim(), 'OPERATION_STORE_FAILED'); assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await fs.readFile(path.join(operationsDir, 'operations.journal')), journal);
  });

  test('T04 contract: verified partial reports only the actual new staging delta in a mixed selection', async () => {
    await fs.writeFile(path.join(repoDir, 'already-staged.txt'), 'previously staged\n');
    await fs.writeFile(path.join(repoDir, 'keep-staged.txt'), 'unselected staging\n');
    gitCmd(repoDir, ['add', 'already-staged.txt', 'keep-staged.txt']);
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'selected tracked worktree change\n');
    await fs.mkdir(path.join(repoDir, 'nested'));
    await fs.writeFile(path.join(repoDir, 'nested', 'new.txt'), 'new staging only\n');
    const trackedBefore = gitCmd(repoDir, ['ls-files', '--stage', '--', 'base.txt', 'already-staged.txt', 'keep-staged.txt']);
    const preview = await previewFor(['base.txt', 'already-staged.txt', 'nested/new.txt']);
    const params = { ticketId: preview.ticketId, operationId: 'partial_precise_paths' };
    const result = await executeCommit('default', params, { ...operationOptions, _faultInjection: { failCommit: true } });
    assert.equal(result.status, 'partial'); assert.deepEqual(result.stagedFiles, ['nested/new.txt']);
    assert.equal(gitCmd(repoDir, ['rev-parse', 'HEAD']).trim(), preview.headOid);
    assert.equal(gitCmd(repoDir, ['ls-files', '--stage', '--', 'base.txt', 'already-staged.txt', 'keep-staged.txt']), trackedBefore);
    assert.equal(await fs.readFile(path.join(repoDir, 'base.txt'), 'utf8'), 'selected tracked worktree change\n');
    result.stagedFiles.push('not-a-proven-path');
    const query = await queryCommitOperation('default', params.operationId, operationOptions);
    assert.equal(query.status, 'partial'); assert.deepEqual(query.stagedFiles, ['nested/new.txt']);
    assert.ok(query.stagedFiles.every((p) => !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p)));
  });
  test('T04 contract: unknown drops a previously proven stagedFiles list after unrelated HEAD changes', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'new staged\n');
    const preview = await previewFor(['new.txt']), params = { ticketId: preview.ticketId, operationId: 'partial_then_unknown' };
    const first = await executeCommit('default', params, { ...operationOptions, _faultInjection: { failCommit: true } });
    assert.deepEqual(first.stagedFiles, ['new.txt']);
    await fs.writeFile(path.join(repoDir, 'external.txt'), 'unrelated external commit\n');
    gitCmd(repoDir, ['add', 'external.txt']); gitCmd(repoDir, ['commit', '-m', 'External change differs from preview']);
    assert.deepEqual((await getCommitOperation(params.operationId, operationOptions)).stagedFiles, ['new.txt']);
    const before = await snapshot();
    const query = await queryCommitOperation('default', params.operationId, operationOptions);
    assert.equal(query.status, 'unknown'); assert.equal(Object.hasOwn(query, 'stagedFiles'), false);
    const repeated = await executeCommit('default', params, operationOptions);
    assert.equal(repeated.status, 'unknown'); assert.equal(Object.hasOwn(repeated, 'stagedFiles'), false);
    assert.deepEqual(await snapshot(), before);
  });
  test('T04 contract: completed recovery does not present historical partial staging as current changes', async () => {
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'new staged\n');
    const preview = await previewFor(['new.txt']), params = { ticketId: preview.ticketId, operationId: 'partial_then_completed' };
    assert.deepEqual((await executeCommit('default', params, { ...operationOptions, _faultInjection: { failCommit: true } })).stagedFiles, ['new.txt']);
    gitCmd(repoDir, ['commit', '-m', 'External completion of exact preview']);
    const before = await snapshot();
    const result = await queryCommitOperation('default', params.operationId, operationOptions);
    assert.equal(result.status, 'completed'); assert.equal(Object.hasOwn(result, 'stagedFiles'), false);
    assert.deepEqual(await snapshot(), before);
  });

  test('T04 contract: POSIX colon and backslash filenames preserve the full proven staging list', { skip: process.platform === 'win32' }, async () => {
    const names = ['a:b', 'literal\\name.txt', '\\leading.txt', '..\\relative.txt'];
    for (const name of names) await fs.writeFile(path.join(repoDir, name), `literal file ${name}\n`);
    const preview = await previewFor(names), params = { ticketId: preview.ticketId, operationId: 'posix_literal_staging' };
    const result = await executeCommit('default', params, { ...operationOptions, _faultInjection: { failCommit: true } });
    assert.equal(result.status, 'partial'); assert.deepEqual([...result.stagedFiles].sort(), [...names].sort());
    assert.equal(gitCmd(repoDir, ['rev-parse', 'HEAD']).trim(), preview.headOid);
    const actualNames = gitCmd(repoDir, ['ls-files', '-z']).split('\0').filter(Boolean);
    for (const name of names) assert.ok(actualNames.includes(name));
    const query = await queryCommitOperation('default', params.operationId, operationOptions);
    assert.equal(query.status, 'partial'); assert.deepEqual([...query.stagedFiles].sort(), [...names].sort());
  });

});
