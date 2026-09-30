import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { inspectRepository, getInspectionTicket } from '../server/git/inspect.js';
import { GitError } from '../server/git/exec.js';

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

describe('Git 接入只读检查与票据管理测试', () => {
  test('仓库子目录归一化到仓库根，并生成高熵有效票据', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-inspect-sub-'));
    const repoDir = path.join(tempDir, 'my-repo');
    const subDir = path.join(repoDir, 'src', 'components');

    try {
      await fs.mkdir(subDir, { recursive: true });
      gitCmd(repoDir, ['init', '-b', 'main']);
      gitCmd(repoDir, ['config', 'user.name', 'Tester']);
      gitCmd(repoDir, ['config', 'user.email', 'tester@test.com']);

      await fs.writeFile(path.join(repoDir, 'README.md'), 'test');
      gitCmd(repoDir, ['add', '.']);
      gitCmd(repoDir, ['commit', '-m', 'initial commit']);

      // 制造一个子目录未跟踪文件
      await fs.writeFile(path.join(subDir, 'Button.js'), 'export const Button = 1;');

      // 用户输入的是深层子目录 subDir
      const summary = await inspectRepository(subDir);

      // 验证自动归一化到仓库根
      const expectedRoot = await fs.realpath(repoDir);
      assert.equal(summary.repositoryRoot, expectedRoot);
      assert.equal(summary.branch, 'main');
      assert.equal(summary.headState, 'attached');
      assert.equal(summary.hasHistory, true);
      assert.ok(summary.latestCommit);
      assert.equal(summary.latestCommit.subject, 'initial commit');
      assert.equal(summary.changedCount, 1); // Button.js
      assert.ok(summary.inspectionId);
      assert.equal(summary.inspectionId.length, 48); // 24 bytes hex = 48 chars

      // 验证可以在内存中查询到此票据
      const ticket = getInspectionTicket(summary.inspectionId);
      assert.ok(ticket);
      assert.equal(ticket.repositoryRoot, expectedRoot);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('空仓库检查成功，未跟踪文件正常计数，无提交历史', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-inspect-empty-'));
    try {
      gitCmd(tempDir, ['init', '-b', 'main']);
      await fs.writeFile(path.join(tempDir, 'untracked.txt'), 'hello');

      const summary = await inspectRepository(tempDir);
      assert.equal(summary.headState, 'unborn');
      assert.equal(summary.branch, 'main');
      assert.equal(summary.hasHistory, false);
      assert.equal(summary.latestCommit, null);
      assert.equal(summary.changedCount, 1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('裸仓库拒绝并抛出 NOT_REPOSITORY', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-inspect-bare-'));
    try {
      gitCmd(tempDir, ['init', '--bare']);
      await assert.rejects(async () => {
        await inspectRepository(tempDir);
      }, (err) => err instanceof GitError && err.code === 'NOT_REPOSITORY');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('非 Git 目录拒绝并抛出 NOT_REPOSITORY', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-inspect-nongit-'));
    try {
      await assert.rejects(async () => {
        await inspectRepository(tempDir);
      }, (err) => err instanceof GitError && err.code === 'NOT_REPOSITORY');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('不存在的目录拒绝并抛出 PATH_UNAVAILABLE', async () => {
    const nonExistent = path.join(os.tmpdir(), `non_existent_dir_${Date.now()}`);
    await assert.rejects(async () => {
      await inspectRepository(nonExistent);
    }, (err) => err instanceof GitError && err.code === 'PATH_UNAVAILABLE');
  });

  test('票据缓存上限 32 项自动淘汰', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-inspect-tickets-'));
    try {
      gitCmd(tempDir, ['init', '-b', 'main']);
      const tickets = [];
      for (let i = 0; i < 35; i++) {
        const s = await inspectRepository(tempDir);
        tickets.push(s.inspectionId);
      }

      // 前 3 个应该已被淘汰
      assert.equal(getInspectionTicket(tickets[0]), null);
      assert.equal(getInspectionTicket(tickets[1]), null);
      assert.equal(getInspectionTicket(tickets[2]), null);

      // 最后的 32 个应该仍然有效
      assert.ok(getInspectionTicket(tickets[34]));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('S1: 仓库配置 core.fsmonitor 时，inspectRepository 安全读取且不执行监控脚本', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-inspect-fsmonitor-'));
    const repoDir = path.join(tempDir, 'repo');
    await fs.mkdir(repoDir);
    try {
      gitCmd(repoDir, ['init', '-b', 'main']);
      gitCmd(repoDir, ['config', 'user.name', 'MonitorTester']);
      gitCmd(repoDir, ['config', 'user.email', 'monitor@test.com']);

      await fs.writeFile(path.join(repoDir, 'file.txt'), 'content\n');
      gitCmd(repoDir, ['add', '.']);
      gitCmd(repoDir, ['commit', '-m', 'commit for monitor']);

      // 制造未暂存改动
      await fs.writeFile(path.join(repoDir, 'file.txt'), 'changed content\n');
      await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'untracked\n');

      const hookFile = path.join(repoDir, '.git', 'hooks', 'test-inspect-monitor');
      await fs.mkdir(path.dirname(hookFile), { recursive: true });
      await fs.writeFile(hookFile, '#!/bin/sh\nprintf executed > .git/inspect-monitor-ran\nexit 1\n');
      gitCmd(repoDir, ['config', 'core.fsmonitor', hookFile.replaceAll('\\', '/')]);

      const markerFile = path.join(repoDir, '.git', 'inspect-monitor-ran');

      // 执行接入检查
      const summary = await inspectRepository(repoDir);

      // 断言成功读取且变更计数准确
      assert.equal(summary.branch, 'main');
      assert.equal(summary.changedCount, 2);
      assert.ok(summary.inspectionId);

      // 断言标记文件绝不存在（说明 fsmonitor 脚本被严格禁用，从未执行）
      const markerExists = await fs.access(markerFile).then(() => true, () => false);
      assert.equal(markerExists, false, 'core.fsmonitor 脚本不应被执行');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
