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
  recalculateAndCompareCommitPreview,
  clearAllCommitPreviewTickets,
  COMMIT_PREVIEW_ERRORS,
} from '../server/git/commit-preview.js';
import { GitError } from '../server/git/exec.js';

function gitCmd(cwd, args, envExtra = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
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

async function getDirSnapshot(dir) {
  const snapshot = new Map();
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(dir, fullPath).replace(/\\/g, '/');
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

async function captureRepoState(repoDir) {
  const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
  const headOid = headRes.status === 0 ? headRes.stdout.trim() : null;

  const gitDirRes = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: repoDir, encoding: 'utf8' });
  const gitDir = path.resolve(repoDir, gitDirRes.stdout.trim());
  const commonDirRes = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoDir, encoding: 'utf8' });
  const commonDir = path.resolve(repoDir, commonDirRes.stdout.trim());

  const indexPath = path.join(gitDir, 'index');
  let indexBytes = null;
  if (fsSync.existsSync(indexPath)) {
    indexBytes = crypto.createHash('sha256').update(fsSync.readFileSync(indexPath)).digest('hex');
  }

  const worktreeSnapshot = await getDirSnapshot(repoDir);

  // 严格快照对象库 (objects 目录，包括 common-dir)
  const objectsDir = path.join(commonDir, 'objects');
  const objectsSnapshot = new Map();
  function walkObjects(dir) {
    if (!fsSync.existsSync(dir)) return;
    const entries = fsSync.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkObjects(full);
      } else {
        const rel = path.relative(objectsDir, full).replace(/\\/g, '/');
        const hash = crypto.createHash('sha256').update(fsSync.readFileSync(full)).digest('hex');
        objectsSnapshot.set(rel, hash);
      }
    }
  }
  walkObjects(objectsDir);

  return { headOid, indexBytes, worktreeSnapshot, objectsSnapshot };
}

function assertRepoUnchanged(before, after) {
  assert.equal(after.headOid, before.headOid, 'HEAD 不得发生改变');
  assert.equal(after.indexBytes, before.indexBytes, '索引文件字节不得发生改变');
  assert.equal(after.worktreeSnapshot.size, before.worktreeSnapshot.size, '工作树文件数量不得改变');
  for (const [file, hash] of before.worktreeSnapshot.entries()) {
    assert.equal(after.worktreeSnapshot.get(file), hash, `工作树文件 ${file} 内容不得改变`);
  }
  // S1: 对象库零写入断言
  assert.equal(after.objectsSnapshot.size, before.objectsSnapshot.size, '被管理仓库对象库文件数量不得增加（必须零写入）');
  for (const [file, hash] of before.objectsSnapshot.entries()) {
    assert.equal(after.objectsSnapshot.get(file), hash, `对象库文件 ${file} 内容不得改变`);
  }
}

describe('本地提交候选与可信预览测试套件 (P3-T01 返修)', () => {
  let tempBaseDir;
  let repoDir;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-commit-preview-test-'));
    repoDir = path.join(tempBaseDir, 'test-repo');
    await fs.mkdir(repoDir, { recursive: true });

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

  test('S1（阻断）对象库零写入：普通仓库与 linked worktree 预览前后对象库完全零写入', async () => {
    // 1. 普通仓库下创建未跟踪与修改
    await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'new file for S1\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base modified S1\n', 'utf-8');

    const beforeNormal = await captureRepoState(repoDir);
    const candNormal = await getCommitCandidates(repoDir);
    const previewNormal = await createCommitPreview(repoDir, {
      candidateIds: candNormal.candidates.map((c) => c.id),
      message: 'Test S1 zero object write',
    });
    assert.ok(previewNormal.ticketId);
    await recalculateAndCompareCommitPreview(previewNormal.ticketId);
    const afterNormal = await captureRepoState(repoDir);
    assertRepoUnchanged(beforeNormal, afterNormal);

    // 2. linked worktree 场景
    const worktreeDir = path.join(tempBaseDir, 'linked-wt');
    gitCmd(repoDir, ['worktree', 'add', '-b', 'feature-wt', worktreeDir]);
    await fs.writeFile(path.join(worktreeDir, 'wt-file.txt'), 'worktree content\n', 'utf-8');

    const beforeWt = await captureRepoState(worktreeDir);
    const candWt = await getCommitCandidates(worktreeDir);
    const previewWt = await createCommitPreview(worktreeDir, {
      candidateIds: candWt.candidates.map((c) => c.id),
      message: 'Worktree zero object write',
    });
    assert.ok(previewWt.ticketId);
    await recalculateAndCompareCommitPreview(previewWt.ticketId);
    const afterWt = await captureRepoState(worktreeDir);
    assertRepoUnchanged(beforeWt, afterWt);
  });

  test('R1（阻断）字面路径模式：文件名包含方括号 [ab].txt 时绝不匹配未选文件 a.txt', async () => {
    await fs.writeFile(path.join(repoDir, 'a.txt'), 'file a content\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, '[ab].txt'), 'file bracket content\n', 'utf-8');

    const before = await captureRepoState(repoDir);

    const candData = await getCommitCandidates(repoDir);
    const bracketCand = candData.candidates.find((c) => c.path === '[ab].txt');
    const aCand = candData.candidates.find((c) => c.path === 'a.txt');
    assert.ok(bracketCand);
    assert.ok(aCand);

    // 仅选中 [ab].txt
    const preview = await createCommitPreview(repoDir, {
      candidateIds: [bracketCand.id],
      message: 'Add bracket file only',
    });

    assert.equal(preview.summary.fileCount, 1);
    assert.equal(preview.summary.operations[0].path, '[ab].txt');
    // 关键断言：diff 文本绝对不能出现 a.txt
    assert.ok(preview.diffOverview.diffText.includes('[ab].txt'));
    assert.ok(!preview.diffOverview.diffText.includes('file a content'));
    assert.ok(!preview.diffOverview.statText.includes('a.txt'));

    // 关键断言：仅且只有 [ab].txt 在变更操作与 diff 文本中，绝对没有 a.txt
    assert.equal(preview.summary.operations.length, 1);
    assert.equal(preview.summary.operations[0].path, '[ab].txt');
    assert.ok(preview.diffOverview.diffText.includes('[ab].txt'));
    assert.ok(preview.diffOverview.diffText.includes('file bracket content'));
    assert.ok(!preview.diffOverview.diffText.includes('file a content'));
    assert.ok(!preview.diffOverview.statText.includes('a.txt'));

    const after = await captureRepoState(repoDir);
    assertRepoUnchanged(before, after);
  });

  test('R2（阻断）未跟踪嵌套目录精确枚举：只选其中一个文件时，其他未跟踪文件绝不混入，目录不作为候选', async () => {
    const subDir = path.join(repoDir, 'folder', 'sub');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'f1.txt'), 'f1 content\n', 'utf-8');
    await fs.writeFile(path.join(subDir, 'f2.txt'), 'f2 content\n', 'utf-8');

    const before = await captureRepoState(repoDir);

    const candData = await getCommitCandidates(repoDir);
    // 验证绝无目录条目
    for (const c of candData.candidates) {
      assert.ok(!c.path.endsWith('/'), `候选不应为目录: ${c.path}`);
      assert.ok(!c.path.endsWith('\\'), `候选不应为目录: ${c.path}`);
    }

    const f1Cand = candData.candidates.find((c) => c.path === 'folder/sub/f1.txt');
    const f2Cand = candData.candidates.find((c) => c.path === 'folder/sub/f2.txt');
    assert.ok(f1Cand);
    assert.ok(f2Cand);

    // 仅选中 f1.txt
    const preview = await createCommitPreview(repoDir, {
      candidateIds: [f1Cand.id],
      message: 'Add folder/sub/f1.txt only',
    });

    assert.equal(preview.summary.fileCount, 1);
    assert.equal(preview.summary.operations[0].path, 'folder/sub/f1.txt');
    assert.ok(preview.diffOverview.diffText.includes('f1 content'));
    assert.ok(!preview.diffOverview.diffText.includes('f2 content'));

    const after = await captureRepoState(repoDir);
    assertRepoUnchanged(before, after);
  });

  test('R3（阻断）符号链接与特殊类型拒绝：链接不可选，且预览后替换为链接报 PREVIEW_STALE', async () => {
    const linkTarget = path.join(repoDir, 'base.txt');
    const symlinkPath = path.join(repoDir, 'link-file.txt');

    let canCreateSymlink = false;
    try {
      await fs.symlink(linkTarget, symlinkPath, 'file');
      canCreateSymlink = true;
    } catch (e) {
      // 若系统权限不允许创建 symlink，跳过创建步骤
    }

    if (canCreateSymlink) {
      const candData = await getCommitCandidates(repoDir);
      const linkCand = candData.candidates.find((c) => c.path === 'link-file.txt');
      assert.ok(linkCand);
      assert.equal(linkCand.selectable, false);
      assert.ok(linkCand.unselectableReason.includes('符号链接'));

      // 强行尝试提交 symlink 必须拒绝
      await assert.rejects(
        () => createCommitPreview(repoDir, {
          candidateIds: [linkCand.id],
          message: 'Try committing symlink',
        }),
        { code: COMMIT_PREVIEW_ERRORS.UNSELECTABLE_CANDIDATE }
      );

      // 清理测试链接
      await fs.unlink(symlinkPath);
    }

    // 测试预览后，普通文件被替换为符号链接时的重验陈旧检测
    await fs.writeFile(path.join(repoDir, 'target.txt'), 'target content\n', 'utf-8');
    const candData2 = await getCommitCandidates(repoDir);
    const targetCand = candData2.candidates.find((c) => c.path === 'target.txt');
    assert.ok(targetCand);

    const preview = await createCommitPreview(repoDir, {
      candidateIds: [targetCand.id],
      message: 'Valid file preview',
    });
    assert.ok(preview.ticketId);

    if (canCreateSymlink) {
      // 删除文件并替换为同名符号链接
      await fs.unlink(path.join(repoDir, 'target.txt'));
      await fs.symlink(path.join(repoDir, 'base.txt'), path.join(repoDir, 'target.txt'), 'file');

      // 重验必须返回 PREVIEW_STALE
      const verify = await recalculateAndCompareCommitPreview(preview.ticketId);
      assert.equal(verify.valid, false);
      assert.equal(verify.reason, COMMIT_PREVIEW_ERRORS.PREVIEW_STALE);
    }
  });

  test('候选获取与只读状态：修改、未跟踪与删除', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base modified\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'new content\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, 'to-delete.txt'), 'delete me\n', 'utf-8');
    gitCmd(repoDir, ['add', 'to-delete.txt']);
    gitCmd(repoDir, ['commit', '-m', 'Add to-delete']);
    await fs.unlink(path.join(repoDir, 'to-delete.txt'));

    const before = await captureRepoState(repoDir);

    const candidatesResult = await getCommitCandidates(repoDir);
    assert.equal(candidatesResult.branch, 'main');
    assert.ok(candidatesResult.headOid);
    assert.equal(candidatesResult.candidates.length, 3);

    const modCand = candidatesResult.candidates.find((c) => c.path === 'base.txt');
    assert.ok(modCand);
    assert.equal(modCand.operationType, 'modify');
    assert.equal(modCand.selectable, true);

    const addCand = candidatesResult.candidates.find((c) => c.path === 'new-file.txt');
    assert.ok(addCand);
    assert.equal(addCand.operationType, 'add');
    assert.equal(addCand.stageScope, 'untracked');
    assert.equal(addCand.selectable, true);

    const delCand = candidatesResult.candidates.find((c) => c.path === 'to-delete.txt');
    assert.ok(delCand);
    assert.equal(delCand.operationType, 'delete');
    assert.equal(delCand.selectable, true);

    const after = await captureRepoState(repoDir);
    assertRepoUnchanged(before, after);
  });

  test('选中/未选中暂存并存：预览只计算选中文件，未选暂存不混入预期树', async () => {
    await fs.writeFile(path.join(repoDir, 'staged-unselected.txt'), 'staged content\n', 'utf-8');
    gitCmd(repoDir, ['add', 'staged-unselected.txt']);
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base v2 updated\n', 'utf-8');

    const before = await captureRepoState(repoDir);

    const candidates = await getCommitCandidates(repoDir);
    const baseCand = candidates.candidates.find((c) => c.path === 'base.txt');
    assert.ok(baseCand);

    const preview = await createCommitPreview(repoDir, {
      candidateIds: [baseCand.id],
      message: 'Update base.txt only',
    });

    assert.ok(preview.ticketId);
    assert.equal(preview.summary.fileCount, 1);
    assert.equal(preview.summary.operations[0].path, 'base.txt');
    assert.ok(preview.diffOverview.diffText.includes('base v2 updated'));
    assert.ok(!preview.diffOverview.diffText.includes('staged-unselected.txt'));
    assert.ok(!preview.diffOverview.statText.includes('staged-unselected.txt'));

    const after = await captureRepoState(repoDir);
    assertRepoUnchanged(before, after);
  });

  test('同一路径部分暂存阻止：同一文件有暂存和未暂存改动时拒绝', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'partially staged\n', 'utf-8');
    gitCmd(repoDir, ['add', 'base.txt']);
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'worktree further modified\n', 'utf-8');

    const before = await captureRepoState(repoDir);

    const candData = await getCommitCandidates(repoDir);
    const baseCand = candData.candidates.find((c) => c.path === 'base.txt');
    assert.ok(baseCand);
    assert.equal(baseCand.stageScope, 'both');
    assert.equal(baseCand.selectable, false);
    assert.ok(baseCand.unselectableReason.includes('部分暂存'));

    await assert.rejects(
      async () => {
        await createCommitPreview(repoDir, {
          candidateIds: [baseCand.id],
          message: 'Try committing both version',
        });
      },
      (err) => {
        assert.ok(err instanceof GitError);
        assert.equal(err.code, COMMIT_PREVIEW_ERRORS.UNSELECTABLE_CANDIDATE);
        return true;
      }
    );

    const after = await captureRepoState(repoDir);
    assertRepoUnchanged(before, after);
  });

  test('重命名文件支持与旧/新路径原子候选', async () => {
    gitCmd(repoDir, ['mv', 'base.txt', 'renamed-base.txt']);

    const before = await captureRepoState(repoDir);

    const candData = await getCommitCandidates(repoDir);
    const renCand = candData.candidates.find((c) => c.path === 'renamed-base.txt');
    assert.ok(renCand);
    assert.equal(renCand.oldPath, 'base.txt');
    assert.equal(renCand.operationType, 'rename');
    assert.equal(renCand.selectable, true);

    const preview = await createCommitPreview(repoDir, {
      candidateIds: [renCand.id],
      message: 'Rename base.txt to renamed-base.txt',
    });

    assert.ok(preview.ticketId);
    assert.equal(preview.summary.fileCount, 1);
    assert.equal(preview.summary.operations[0].operationType, 'rename');
    assert.equal(preview.summary.operations[0].oldPath, 'base.txt');

    const after = await captureRepoState(repoDir);
    assertRepoUnchanged(before, after);
  });

  test('重命名旧路径重现后预览失效，重新预览也拒绝该重命名', async () => {
    gitCmd(repoDir, ['mv', 'base.txt', 'renamed-base.txt']);
    const candidates = await getCommitCandidates(repoDir);
    const rename = candidates.candidates.find((c) => c.operationType === 'rename');
    assert.ok(rename);

    const preview = await createCommitPreview(repoDir, {
      candidateIds: [rename.id],
      message: 'Rename base.txt',
    });

    await fs.writeFile(path.join(repoDir, 'base.txt'), 'new content at old path\n', 'utf-8');
    const beforeRecheck = await captureRepoState(repoDir);
    const recheck = await recalculateAndCompareCommitPreview(preview.ticketId);
    assert.equal(recheck.valid, false);
    assert.equal(recheck.reason, COMMIT_PREVIEW_ERRORS.PREVIEW_STALE);

    const updatedCandidates = await getCommitCandidates(repoDir);
    const updatedRename = updatedCandidates.candidates.find((c) => c.id === rename.id);
    assert.ok(updatedRename);
    assert.equal(updatedRename.selectable, false);
    await assert.rejects(
      () => createCommitPreview(repoDir, { candidateIds: [rename.id], message: 'Rename base.txt' }),
      { code: COMMIT_PREVIEW_ERRORS.UNSELECTABLE_CANDIDATE }
    );
    assertRepoUnchanged(beforeRecheck, await captureRepoState(repoDir));
  });

  test('中文、空格及前导 - 文件名支持', async () => {
    const specialChinese = '中文 资料.txt';
    const specialDash = '-leading-dash.txt';

    await fs.writeFile(path.join(repoDir, specialChinese), '中文内容测试\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, specialDash), '前导横杠内容\n', 'utf-8');

    const before = await captureRepoState(repoDir);

    const candData = await getCommitCandidates(repoDir);
    const chineseCand = candData.candidates.find((c) => c.path === specialChinese);
    const dashCand = candData.candidates.find((c) => c.path === specialDash);

    assert.ok(chineseCand);
    assert.ok(dashCand);

    const preview = await createCommitPreview(repoDir, {
      candidateIds: [chineseCand.id, dashCand.id],
      message: 'Add special name files',
    });

    assert.equal(preview.summary.fileCount, 2);
    assert.ok(preview.diffOverview.diffText.includes('中文内容测试'));
    assert.ok(preview.diffOverview.diffText.includes('前导横杠内容'));

    const after = await captureRepoState(repoDir);
    assertRepoUnchanged(before, after);
  });

  test('冲突状态检测：存在冲突时拒绝候选和预览', async () => {
    gitCmd(repoDir, ['checkout', '-b', 'feature']);
    await fs.writeFile(path.join(repoDir, 'conflict.txt'), 'feature branch\n', 'utf-8');
    gitCmd(repoDir, ['add', 'conflict.txt']);
    gitCmd(repoDir, ['commit', '-m', 'Feature conflict']);

    gitCmd(repoDir, ['checkout', 'main']);
    await fs.writeFile(path.join(repoDir, 'conflict.txt'), 'main branch\n', 'utf-8');
    gitCmd(repoDir, ['add', 'conflict.txt']);
    gitCmd(repoDir, ['commit', '-m', 'Main conflict']);

    spawnSync('git', ['merge', 'feature'], { cwd: repoDir });

    const before = await captureRepoState(repoDir);

    await assert.rejects(
      async () => {
        await getCommitCandidates(repoDir);
      },
      (err) => {
        assert.ok(err instanceof GitError);
        assert.ok(
          err.code === COMMIT_PREVIEW_ERRORS.GIT_MERGING ||
          err.code === COMMIT_PREVIEW_ERRORS.GIT_CONFLICT
        );
        return true;
      }
    );

    const after = await captureRepoState(repoDir);
    assertRepoUnchanged(before, after);
  });

  test('未出生 HEAD (unborn) 与游离 HEAD (detached) 拒绝', async () => {
    const emptyRepoDir = path.join(tempBaseDir, 'empty-repo');
    await fs.mkdir(emptyRepoDir, { recursive: true });
    gitCmd(emptyRepoDir, ['init', '-b', 'main']);
    gitCmd(emptyRepoDir, ['config', 'user.name', 'Test']);
    gitCmd(emptyRepoDir, ['config', 'user.email', 'test@test.com']);
    await fs.writeFile(path.join(emptyRepoDir, 'first.txt'), 'first');

    await assert.rejects(
      () => getCommitCandidates(emptyRepoDir),
      { code: COMMIT_PREVIEW_ERRORS.HEAD_UNBORN }
    );

    const headOid = gitCmd(repoDir, ['rev-parse', 'HEAD']).trim();
    gitCmd(repoDir, ['checkout', headOid]);

    await assert.rejects(
      () => getCommitCandidates(repoDir),
      { code: COMMIT_PREVIEW_ERRORS.HEAD_DETACHED }
    );
  });

  test('参数校验：空说明、超长说明、换行/控制字符、空选、重复选、空提交', async () => {
    await fs.writeFile(path.join(repoDir, 'file.txt'), 'content\n', 'utf-8');
    const candData = await getCommitCandidates(repoDir);
    const candId = candData.candidates[0].id;

    await assert.rejects(
      () => createCommitPreview(repoDir, { candidateIds: [candId], message: '   ' }),
      { code: COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE }
    );

    await assert.rejects(
      () => createCommitPreview(repoDir, { candidateIds: [candId], message: 'Line1\nLine2' }),
      { code: COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE }
    );

    await assert.rejects(
      () => createCommitPreview(repoDir, { candidateIds: [candId], message: 'Line\x07Alert' }),
      { code: COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE }
    );

    await assert.rejects(
      () => createCommitPreview(repoDir, { candidateIds: [candId], message: 'a'.repeat(501) }),
      { code: COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE }
    );

    await assert.rejects(
      () => createCommitPreview(repoDir, { candidateIds: [], message: 'Valid' }),
      { code: COMMIT_PREVIEW_ERRORS.EMPTY_SELECTION }
    );

    await assert.rejects(
      () => createCommitPreview(repoDir, { candidateIds: [candId, candId], message: 'Valid' }),
      { code: COMMIT_PREVIEW_ERRORS.DUPLICATE_CANDIDATES }
    );

    await assert.rejects(
      () => createCommitPreview(repoDir, { candidateIds: ['cand_unknown123'], message: 'Valid' }),
      { code: COMMIT_PREVIEW_ERRORS.INVALID_CANDIDATE }
    );
  });

  test('身份缺失检测：未配置 author/committer 时拒绝并返回 IDENTITY_MISSING', async () => {
    const noIdentRepo = path.join(tempBaseDir, 'no-ident-repo');
    await fs.mkdir(noIdentRepo, { recursive: true });
    gitCmd(noIdentRepo, ['init', '-b', 'main']);
    await fs.writeFile(path.join(noIdentRepo, 'f.txt'), 'hello');

    const fakeHome = path.join(tempBaseDir, 'fake-home');
    await fs.mkdir(fakeHome, { recursive: true });

    const origEnv = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = path.join(fakeHome, 'empty-config');
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;

    try {
      await assert.rejects(
        () => getCommitCandidates(noIdentRepo),
        (err) => {
          assert.ok(err instanceof GitError);
          assert.equal(err.code, COMMIT_PREVIEW_ERRORS.IDENTITY_MISSING);
          return true;
        }
      );
    } finally {
      if (origEnv !== undefined) {
        process.env.GIT_CONFIG_GLOBAL = origEnv;
      } else {
        delete process.env.GIT_CONFIG_GLOBAL;
      }
    }
  });

  test('安全配置门槛检测：hooks、签名、fsmonitor、filter 均被明确拒绝', async () => {
    // 1. 自定义 hooksPath
    gitCmd(repoDir, ['config', 'core.hooksPath', '.githooks']);
    await assert.rejects(
      () => getCommitCandidates(repoDir),
      { code: COMMIT_PREVIEW_ERRORS.HOOKS_UNSUPPORTED }
    );
    gitCmd(repoDir, ['config', '--unset', 'core.hooksPath']);

    // 2. 存在活动提交 hook 文件 (pre-commit)
    const hooksDir = path.join(repoDir, '.git', 'hooks');
    const hookFile = path.join(hooksDir, 'pre-commit');
    await fs.writeFile(hookFile, '#!/bin/sh\nexit 0\n', 'utf-8');
    await assert.rejects(
      () => getCommitCandidates(repoDir),
      { code: COMMIT_PREVIEW_ERRORS.HOOKS_UNSUPPORTED }
    );
    await fs.unlink(hookFile);

    // 3. commit.gpgSign = true
    gitCmd(repoDir, ['config', 'commit.gpgSign', 'true']);
    await assert.rejects(
      () => getCommitCandidates(repoDir),
      { code: COMMIT_PREVIEW_ERRORS.SIGNING_UNSUPPORTED }
    );
    gitCmd(repoDir, ['config', '--unset', 'commit.gpgSign']);

    // 4. core.fsmonitor 外部脚本
    gitCmd(repoDir, ['config', 'core.fsmonitor', 'some-monitor-tool']);
    await assert.rejects(
      () => getCommitCandidates(repoDir),
      { code: COMMIT_PREVIEW_ERRORS.FSMONITOR_UNSUPPORTED }
    );
    gitCmd(repoDir, ['config', '--unset', 'core.fsmonitor']);

    // 5. filter.clean 外部程序
    gitCmd(repoDir, ['config', 'filter.testfilter.clean', 'clean-cmd']);
    await assert.rejects(
      () => getCommitCandidates(repoDir),
      { code: COMMIT_PREVIEW_ERRORS.FILTER_UNSUPPORTED }
    );
    gitCmd(repoDir, ['config', '--unset', 'filter.testfilter.clean']);
  });

  test('票据签发与 recalculateAndCompareCommitPreview 状态比对与陈旧拦截', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base changed\n', 'utf-8');

    const candData = await getCommitCandidates(repoDir);
    const cand = candData.candidates[0];

    const preview = await createCommitPreview(repoDir, {
      candidateIds: [cand.id],
      message: 'Clean preview verification',
    });

    const ticketId = preview.ticketId;
    assert.ok(ticketId);

    // 1. 无任何修改时，重新核验通过
    const verify1 = await recalculateAndCompareCommitPreview(ticketId);
    assert.equal(verify1.valid, true);
    assert.ok(verify1.ticket);

    // 2. 更改选中文件的工作树内容后，重新核验应报 PREVIEW_STALE
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base changed AGAIN\n', 'utf-8');
    const verify2 = await recalculateAndCompareCommitPreview(ticketId);
    assert.equal(verify2.valid, false);
    assert.equal(verify2.reason, COMMIT_PREVIEW_ERRORS.PREVIEW_STALE);

    // 还原内容后核验再次通过
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base changed\n', 'utf-8');
    const verify3 = await recalculateAndCompareCommitPreview(ticketId);
    assert.equal(verify3.valid, true);

    // 3. 改变暂存区状态（例如暂存了一个未选文件），核验应报 PREVIEW_STALE
    await fs.writeFile(path.join(repoDir, 'other.txt'), 'other\n', 'utf-8');
    gitCmd(repoDir, ['add', 'other.txt']);
    const verify4 = await recalculateAndCompareCommitPreview(ticketId);
    assert.equal(verify4.valid, false);
    assert.equal(verify4.reason, COMMIT_PREVIEW_ERRORS.PREVIEW_STALE);

    // 4. 重启/删除票据测试
    clearAllCommitPreviewTickets();
    const verify5 = await recalculateAndCompareCommitPreview(ticketId);
    assert.equal(verify5.valid, false);
    assert.equal(verify5.reason, COMMIT_PREVIEW_ERRORS.PREVIEW_STALE);
    assert.ok(verify5.message.includes('过期'));
  });
});
