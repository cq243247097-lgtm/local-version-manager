import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  getCommitCandidates,
  createCommitPreview,
  clearAllCommitPreviewTickets,
} from '../server/git/commit-preview.js';
import {
  executeCommit,
  COMMIT_WRITE_ERRORS,
} from '../server/git/commit-write.js';
import {
  getCommitOperation,
  saveCommitOperation,
  acquireCommitLock,
  releaseCommitLock,
  COMMIT_OPERATION_ERRORS,
} from '../server/git/commit-operations.js';
import { GitError } from '../server/git/exec.js';

function gitCmd(cwd, args, envExtra = {}) {
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
      repoDir,
      { ticketId: preview.ticketId, operationId: 'op_normal_001' },
      { operationsDir }
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
    const opRecord = await getCommitOperation('op_normal_001', { operationsDir });
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
      repoDir,
      { ticketId: preview.ticketId, operationId: 'op_keep_staged' },
      { operationsDir }
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
      repoDir,
      { ticketId: preview.ticketId, operationId: 'op_idempotent_01' },
      { operationsDir }
    );
    assert.equal(firstRun.success, true);
    assert.equal(firstRun.status, 'completed');

    // 第二次调用（模拟前端重复点击或服务重启后查询）
    const secondRun = await executeCommit(
      repoDir,
      { ticketId: preview.ticketId, operationId: 'op_idempotent_01' },
      { operationsDir }
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
    await acquireCommitLock(commonDirAbs, { operationId: 'op_active_lock' }, { operationsDir });

    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base changed\n', 'utf-8');
    const cands = await getCommitCandidates(repoDir);
    const preview = await createCommitPreview(repoDir, {
      candidateIds: [cands.candidates[0].id],
      message: 'Lock test',
    });

    await assert.rejects(
      () => executeCommit(
        repoDir,
        { ticketId: preview.ticketId, operationId: 'op_blocked' },
        { operationsDir }
      ),
      (err) => {
        assert.ok(err instanceof GitError);
        assert.equal(err.code, COMMIT_OPERATION_ERRORS.REPOSITORY_BUSY);
        return true;
      }
    );

    // 释放锁后恢复正常
    await releaseCommitLock(commonDirAbs, { operationId: 'op_active_lock' }, { operationsDir });
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
      repoDir,
      { ticketId: preview.ticketId, operationId: 'op_stale_test' },
      { operationsDir }
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
      repoDir,
      { ticketId: preview.ticketId, operationId: 'op_special_chars' },
      { operationsDir }
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
      repoDir,
      { ticketId: preview.ticketId, operationId: 'op_del_ren' },
      { operationsDir }
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
      repoDir,
      { ticketId: preview.ticketId, operationId: 'op_partial_001' },
      { operationsDir, _faultInjection: { failCommit: true } }
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
    const opRecord = await getCommitOperation('op_partial_001', { operationsDir });
    assert.ok(opRecord);
    assert.equal(opRecord.status, 'partial');
    assert.ok(opRecord.stagedFiles.includes('new-file.txt'));
  });
});
