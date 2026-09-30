import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getRepositoryHistory } from '../server/git/history.js';

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

describe('Git 历史、图与引用解析测试', () => {
  test('空仓库返回空 commits, 空 refs, truncated: false', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-hist-empty-'));
    try {
      gitCmd(tempDir, ['init', '-b', 'main']);
      const result = await getRepositoryHistory(tempDir);
      assert.deepEqual(result.commits, []);
      assert.deepEqual(result.refs, []);
      assert.equal(result.truncated, false);
      assert.ok(result.scannedAt);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('包含分支、合并、附注标签、远端跟踪引用及稳定排序', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-hist-full-'));
    const repoDir = path.join(tempDir, 'repo');
    const remoteDir = path.join(tempDir, 'remote.git');

    try {
      await fs.mkdir(repoDir);
      await fs.mkdir(remoteDir);

      gitCmd(remoteDir, ['init', '--bare']);
      gitCmd(repoDir, ['init', '-b', 'main']);
      gitCmd(repoDir, ['config', 'user.name', 'Tester']);
      gitCmd(repoDir, ['config', 'user.email', 'tester@test.com']);
      gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir]);

      // 1. 提交 c1
      await fs.writeFile(path.join(repoDir, 'file.txt'), 'c1');
      gitCmd(repoDir, ['add', '.']);
      gitCmd(repoDir, ['commit', '-m', 'commit 1']);
      gitCmd(repoDir, ['push', '-u', 'origin', 'main']);

      // 2. 切分支 feature，提交 c2
      gitCmd(repoDir, ['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(repoDir, 'feat.txt'), 'feature');
      gitCmd(repoDir, ['add', '.']);
      gitCmd(repoDir, ['commit', '-m', 'commit feature']);

      // 打附注标签 annotated tag
      gitCmd(repoDir, ['tag', '-a', 'v1.0-annotated', '-m', 'release 1.0 tag']);
      // 打轻量标签
      gitCmd(repoDir, ['tag', 'v1.0-lightweight']);

      // 3. 回到 main，提交 c3
      gitCmd(repoDir, ['checkout', 'main']);
      await fs.writeFile(path.join(repoDir, 'main.txt'), 'main edit');
      gitCmd(repoDir, ['add', '.']);
      gitCmd(repoDir, ['commit', '-m', 'commit main']);

      // 4. 合并 feature 到 main 产生合并提交
      gitCmd(repoDir, ['merge', '--no-ff', '-m', 'Merge feature into main', 'feature']);

      // 第一次读取
      const hist1 = await getRepositoryHistory(repoDir);
      // 第二次读取（验证稳定排序）
      const hist2 = await getRepositoryHistory(repoDir);

      assert.deepEqual(hist1.commits.map((c) => c.oid), hist2.commits.map((c) => c.oid), '多次读取顺序必须完全一致');

      // 验证合并提交的父 OID
      const mergeCommit = hist1.commits.find((c) => c.subject === 'Merge feature into main');
      assert.ok(mergeCommit);
      assert.equal(mergeCommit.parents.length, 2, '合并提交必须有两个父 OID');

      // 验证 refs 种类
      const kinds = new Set(hist1.refs.map((r) => r.kind));
      assert.ok(kinds.has('head'), '应包含 head');
      assert.ok(kinds.has('local-branch'), '应包含 local-branch');
      assert.ok(kinds.has('remote-tracking'), '应包含 remote-tracking');
      assert.ok(kinds.has('tag'), '应包含 tag');

      // 验证附注标签已剥离为 commit OID
      const annTag = hist1.refs.find((r) => r.name === 'v1.0-annotated');
      assert.ok(annTag);
      // 验证该 OID 确实指向 commit feature
      const featCommit = hist1.commits.find((c) => c.subject === 'commit feature');
      assert.ok(featCommit);
      assert.equal(annTag.oid, featCommit.oid, '附注标签必须剥离到所指 commit OID');

      assert.equal(hist1.truncated, false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('超过 100 条历史时截断，truncated 为 true 且返回前 100 条', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-hist-trunc-'));
    try {
      gitCmd(tempDir, ['init', '-b', 'main']);
      gitCmd(tempDir, ['config', 'user.name', 'Tester']);
      gitCmd(tempDir, ['config', 'user.email', 'tester@test.com']);

      // 创建 105 个提交
      for (let i = 1; i <= 105; i++) {
        await fs.writeFile(path.join(tempDir, 'count.txt'), `${i}\n`);
        gitCmd(tempDir, ['add', 'count.txt']);
        gitCmd(tempDir, ['commit', '-m', `commit ${i}`]);
      }

      const result = await getRepositoryHistory(tempDir);
      assert.equal(result.truncated, true);
      assert.equal(result.commits.length, 100);
      // 拓扑/日期逆序，最新的提交在最前
      assert.equal(result.commits[0].subject, 'commit 105');
      // 验证每个 commit 保留真实 parents 数组
      assert.ok(result.commits[0].parents.length >= 1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('HEAD 未出生时仍能读取其他分支的已有历史 (未出生 HEAD 不掩盖历史)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-hist-orphan-'));
    try {
      gitCmd(tempDir, ['init', '-b', 'main']);
      gitCmd(tempDir, ['config', 'user.name', 'Tester']);
      gitCmd(tempDir, ['config', 'user.email', 'tester@test.com']);

      await fs.writeFile(path.join(tempDir, 'init.txt'), 'hello main');
      gitCmd(tempDir, ['add', '.']);
      gitCmd(tempDir, ['commit', '-m', 'commit on main']);

      // 切换到未出生的孤立分支 orphan-branch
      gitCmd(tempDir, ['checkout', '--orphan', 'orphan-branch']);
      await fs.unlink(path.join(tempDir, 'init.txt'));

      // 读取历史：即使当前 HEAD 未出生，main 分支的历史和引用依然完整可见
      const result = await getRepositoryHistory(tempDir);
      assert.ok(result.commits.length >= 1, '应能看到 main 上的提交');
      assert.equal(result.commits[0].subject, 'commit on main');
      assert.ok(result.refs.some((r) => r.name === 'main' && r.kind === 'local-branch'));
      // HEAD 由于未出生，不应出现在 refs 中
      assert.equal(result.refs.some((r) => r.kind === 'head'), false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('排除指向 blob 或 tree 的非提交标签 (OID 必须指向 commit)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-hist-blobtag-'));
    try {
      gitCmd(tempDir, ['init', '-b', 'main']);
      gitCmd(tempDir, ['config', 'user.name', 'Tester']);
      gitCmd(tempDir, ['config', 'user.email', 'tester@test.com']);

      await fs.writeFile(path.join(tempDir, 'content.txt'), 'blob content');
      gitCmd(tempDir, ['add', '.']);
      gitCmd(tempDir, ['commit', '-m', 'commit for blob tag test']);

      // 获取一个 blob 的 hash
      const blobHash = gitCmd(tempDir, ['hash-object', '-w', 'content.txt']).toString().trim();

      // 创建直接指向 blob 的轻量标签
      gitCmd(tempDir, ['tag', 'tag-to-blob-light', blobHash]);
      // 创建指向 blob 的附注标签
      gitCmd(tempDir, ['tag', '-a', 'tag-to-blob-annotated', '-m', 'annotated blob', blobHash]);

      const result = await getRepositoryHistory(tempDir);
      // 两个指向 blob 的标签必须被排除，不得进入 refs
      assert.equal(result.refs.some((r) => r.name === 'tag-to-blob-light'), false, '轻量 blob 标签必须被排除');
      assert.equal(result.refs.some((r) => r.name === 'tag-to-blob-annotated'), false, '附注 blob 标签必须被排除');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
