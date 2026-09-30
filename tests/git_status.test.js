import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parsePorcelainV2, getRepositorySource } from '../server/git/status.js';

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
  return res.stdout;
}

describe('Git 状态与 Porcelain v2 解析测试', () => {
  test('换行路径与重命名双路径的 Porcelain v2 夹具解析', () => {
    // 模拟包含换行符与空格的文件路径
    // Windows 文件系统无法直接创建带 \n 的文件，通过 raw Buffer 夹具验证解析器
    const pathWithNewline = 'file\nwith\nnewline.txt';
    const oldPathWithNewline = 'old\nfile\nname.txt';
    const regularFile = '普通中文 文件.txt';

    const rawBuf = Buffer.concat([
      Buffer.from('# branch.oid 1234567890123456789012345678901234567890\0', 'utf-8'),
      Buffer.from('# branch.head main\0', 'utf-8'),
      Buffer.from('# branch.upstream origin/main\0', 'utf-8'),
      Buffer.from('# branch.ab +2 -1\0', 'utf-8'),
      // 1: 普通修改
      Buffer.from(`1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 ${regularFile}\0`, 'utf-8'),
      // 2: 重命名且含换行
      Buffer.from(`2 R. N... 100644 100644 100644 2222222222222222222222222222222222222222 2222222222222222222222222222222222222222 R100 ${pathWithNewline}\0${oldPathWithNewline}\0`, 'utf-8'),
      // u: 冲突
      Buffer.from('u UU N... 100644 100644 100644 100644 3333333333333333333333333333333333333333 4444444444444444444444444444444444444444 5555555555555555555555555555555555555555 conflict.txt\0', 'utf-8'),
      // ?: 未跟踪
      Buffer.from('? untracked_new.txt\0', 'utf-8'),
    ]);

    const result = parsePorcelainV2(rawBuf);

    assert.equal(result.headState, 'attached');
    assert.equal(result.branch, 'main');
    assert.deepEqual(result.upstream, {
      state: 'available',
      name: 'origin/main',
      ahead: 2,
      behind: 1,
    });

    assert.equal(result.changes.length, 4);

    const renameItem = result.changes.find((c) => c.path === pathWithNewline);
    assert.ok(renameItem, '应正确识别换行路径');
    assert.equal(renameItem.oldPath, oldPathWithNewline);
    assert.equal(renameItem.indexStatus, 'R');
    assert.equal(renameItem.worktreeStatus, '.');
    assert.equal(renameItem.conflicted, false);

    const conflictItem = result.changes.find((c) => c.path === 'conflict.txt');
    assert.ok(conflictItem);
    assert.equal(conflictItem.conflicted, true);
    assert.equal(conflictItem.indexStatus, 'U');
    assert.equal(conflictItem.worktreeStatus, 'U');

    const regularItem = result.changes.find((c) => c.path === regularFile);
    assert.ok(regularItem);
    assert.equal(regularItem.worktreeStatus, 'M');

    // 检查 UTF-8 字节序排序
    for (let i = 0; i < result.changes.length - 1; i++) {
      const cmp = Buffer.compare(
        Buffer.from(result.changes[i].path, 'utf-8'),
        Buffer.from(result.changes[i + 1].path, 'utf-8')
      );
      assert.ok(cmp <= 0, '结果必须按 UTF-8 字节序排列');
    }
  });

  test('真实临时 Git 仓库状态全覆盖', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-full-status-'));
    const repoDir = path.join(tempDir, 'repo');
    const remoteDir = path.join(tempDir, 'remote.git');

    try {
      await fs.mkdir(repoDir);
      await fs.mkdir(remoteDir);

      // 1. 初始化空 bare remote
      gitCmd(remoteDir, ['init', '--bare']);

      // 2. 初始化本地 repo
      gitCmd(repoDir, ['init', '-b', 'main']);
      gitCmd(repoDir, ['config', 'user.name', 'Tester']);
      gitCmd(repoDir, ['config', 'user.email', 'tester@test.com']);
      gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir]);

      // 空仓库 unborn 检查
      const unbornSource = await getRepositorySource(repoDir);
      assert.equal(unbornSource.headState, 'unborn');
      assert.equal(unbornSource.branch, 'main');
      assert.equal(unbornSource.changedCount, 0);
      assert.deepEqual(unbornSource.upstream, {
        state: 'not-configured',
        name: null,
        ahead: null,
        behind: null,
      });

      // 创建初始文件并推送到 remote
      await fs.writeFile(path.join(repoDir, 'base.txt'), 'base');
      await fs.writeFile(path.join(repoDir, '中文 文件.txt'), 'chinese');
      await fs.writeFile(path.join(repoDir, 'to_rename.txt'), 'rename_me');
      await fs.writeFile(path.join(repoDir, 'to_delete.txt'), 'delete_me');
      gitCmd(repoDir, ['add', '.']);
      gitCmd(repoDir, ['commit', '-m', 'initial commit']);
      gitCmd(repoDir, ['push', '-u', 'origin', 'main']);

      // 此时仓库干净，upstream 处于 available 且 ahead=0, behind=0
      const cleanSource = await getRepositorySource(repoDir);
      assert.equal(cleanSource.headState, 'attached');
      assert.equal(cleanSource.branch, 'main');
      assert.equal(cleanSource.changedCount, 0);
      assert.equal(cleanSource.upstream.state, 'available');
      assert.equal(cleanSource.upstream.ahead, 0);
      assert.equal(cleanSource.upstream.behind, 0);

      // 构造各种变更：
      // - 重命名：to_rename.txt -> renamed.txt
      gitCmd(repoDir, ['mv', 'to_rename.txt', 'renamed.txt']);

      // - 删除：to_delete.txt
      await fs.unlink(path.join(repoDir, 'to_delete.txt'));
      gitCmd(repoDir, ['add', 'to_delete.txt']); // 暂存删除

      // - 同一文件暂存区与工作区同时修改 (both staged and unstaged)
      await fs.writeFile(path.join(repoDir, 'base.txt'), 'staged edit');
      gitCmd(repoDir, ['add', 'base.txt']);
      await fs.writeFile(path.join(repoDir, 'base.txt'), 'staged edit + unstaged edit');

      // - 未跟踪文件
      await fs.writeFile(path.join(repoDir, '新 未跟踪.txt'), 'untracked');

      const dirtySource = await getRepositorySource(repoDir);
      assert.equal(dirtySource.changes.length, 4);
      assert.equal(dirtySource.changedCount, 4);

      // 验证重命名
      const ren = dirtySource.changes.find((c) => c.path === 'renamed.txt');
      assert.ok(ren);
      assert.equal(ren.oldPath, 'to_rename.txt');

      // 验证同一文件双侧修改只计一次
      const baseChange = dirtySource.changes.find((c) => c.path === 'base.txt');
      assert.ok(baseChange);
      assert.equal(baseChange.indexStatus, 'M');
      assert.equal(baseChange.worktreeStatus, 'M');

      // 验证未跟踪文件
      const untracked = dirtySource.changes.find((c) => c.path === '新 未跟踪.txt');
      assert.ok(untracked);
      assert.equal(untracked.indexStatus, '?');
      assert.equal(untracked.worktreeStatus, '?');

      // 提交并制造 ahead
      gitCmd(repoDir, ['add', '.']);
      gitCmd(repoDir, ['commit', '-m', 'commit changes']);

      const aheadSource = await getRepositorySource(repoDir);
      assert.equal(aheadSource.upstream.state, 'available');
      assert.equal(aheadSource.upstream.ahead, 1);
      assert.equal(aheadSource.upstream.behind, 0);

      // 切回 main 并推送到远端，使之同步
      gitCmd(repoDir, ['checkout', 'main']);
      gitCmd(repoDir, ['push']);

      // 制造 behind 场景：向远端推送新提交，本地 reset --hard 回退 1 步
      gitCmd(repoDir, ['commit', '--allow-empty', '-m', 'remote advanced commit']);
      gitCmd(repoDir, ['push']);
      gitCmd(repoDir, ['reset', '--hard', 'HEAD~1']);

      const behindSource = await getRepositorySource(repoDir);
      assert.equal(behindSource.upstream.state, 'available');
      assert.equal(behindSource.upstream.behind, 1);
      assert.equal(behindSource.upstream.ahead, 0);

      // 制造 upstream 跟踪引用丢失场景 (unavailable)
      const remoteRefPath = path.join(repoDir, '.git', 'refs', 'remotes', 'origin', 'main');
      try {
        await fs.unlink(remoteRefPath);
      } catch {}

      const missingUpstreamSource = await getRepositorySource(repoDir);
      assert.equal(missingUpstreamSource.upstream.state, 'unavailable');
      assert.equal(missingUpstreamSource.upstream.name, 'origin/main');
      assert.equal(missingUpstreamSource.upstream.ahead, null);
      assert.equal(missingUpstreamSource.upstream.behind, null);

      // 制造真实合并冲突场景 (conflicted: true)
      await fs.writeFile(path.join(repoDir, 'conflict_demo.txt'), 'base\n');
      gitCmd(repoDir, ['add', 'conflict_demo.txt']);
      gitCmd(repoDir, ['commit', '-m', 'conflict base']);

      gitCmd(repoDir, ['checkout', '-b', 'conflict-a']);
      await fs.writeFile(path.join(repoDir, 'conflict_demo.txt'), 'version A\n');
      gitCmd(repoDir, ['add', 'conflict_demo.txt']);
      gitCmd(repoDir, ['commit', '-m', 'conflict a']);

      gitCmd(repoDir, ['checkout', 'main']);
      gitCmd(repoDir, ['checkout', '-b', 'conflict-b']);
      await fs.writeFile(path.join(repoDir, 'conflict_demo.txt'), 'version B\n');
      gitCmd(repoDir, ['add', 'conflict_demo.txt']);
      gitCmd(repoDir, ['commit', '-m', 'conflict b']);

      // 合并产生冲突
      const mergeRes = spawnSync('git', ['merge', 'conflict-a'], {
        cwd: repoDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' },
      });
      assert.notEqual(mergeRes.status, 0, '合并应产生冲突退出');

      const conflictSource = await getRepositorySource(repoDir);
      const confItem = conflictSource.changes.find((c) => c.path === 'conflict_demo.txt');
      assert.ok(confItem, '应检测到冲突文件');
      assert.equal(confItem.conflicted, true, 'conflicted 必须为 true');
      assert.equal(confItem.indexStatus, 'U');
      assert.equal(confItem.worktreeStatus, 'U');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('Git 命令超时限制 (GIT_TIMEOUT)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-timeout-'));
    try {
      gitCmd(tempDir, ['init', '-b', 'main']);
      const { runGit, GitError } = await import('../server/git/exec.js');
      // 设置 1ms 极短超时模拟执行超时
      await assert.rejects(async () => {
        await runGit(['status'], { cwd: tempDir, timeoutMs: 1 });
      }, (err) => err instanceof GitError && err.code === 'GIT_TIMEOUT');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('Git 命令 stderr 输出上限拦截 (GIT_OUTPUT_LIMIT)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-limit-'));
    try {
      gitCmd(tempDir, ['init', '-b', 'main']);
      const { runGit, GitError } = await import('../server/git/exec.js');
      // 设置极小 maxOutputBytes: 10 字节，故意触发一个产生较多 stderr 的非法参数
      await assert.rejects(async () => {
        await runGit(['--invalid-option-producing-large-help-text-in-stderr'], { cwd: tempDir, maxOutputBytes: 10 });
      }, (err) => err instanceof GitError && err.code === 'GIT_OUTPUT_LIMIT');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
