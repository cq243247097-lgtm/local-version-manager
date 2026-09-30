import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { runGit, assertDirectoryExists, GitError } from './exec.js';
import { getRepositorySource } from './status.js';

const MAX_INSPECTION_TICKETS = 32;
const INSPECTION_TTL_MS = 10 * 60 * 1000; // 10 分钟

// 进程内缓存票据
const inspectionTickets = new Map();

/**
 * 清理过期的票据
 */
function pruneExpiredTickets() {
  const now = Date.now();
  for (const [id, ticket] of inspectionTickets.entries()) {
    if (now - ticket.createdAt > INSPECTION_TTL_MS) {
      inspectionTickets.delete(id);
    }
  }
}

/**
 * 获取并验证缓存的接入票据（供 T03 确认使用）
 * @param {string} inspectionId 
 * @returns {any | null}
 */
export function getInspectionTicket(inspectionId) {
  pruneExpiredTickets();
  const ticket = inspectionTickets.get(inspectionId);
  if (!ticket) return null;
  return ticket;
}

/**
 * 清除已使用的票据
 * @param {string} inspectionId 
 */
export function removeInspectionTicket(inspectionId) {
  inspectionTickets.delete(inspectionId);
}

/**
 * 执行接入只读检查
 * @param {string} repositoryPath 用户输入的当前主机绝对目录路径
 * @returns {Promise<any>}
 */
export async function inspectRepository(repositoryPath) {
  // 1. 基础校验
  if (typeof repositoryPath !== 'string' || repositoryPath.trim() === '') {
    throw new GitError('PATH_UNAVAILABLE', '请提供有效的本地目录路径', 400);
  }

  const byteLength = Buffer.byteLength(repositoryPath, 'utf-8');
  if (byteLength > 4096) {
    throw new GitError('PATH_UNAVAILABLE', '路径长度超出 4096 字节上限', 400);
  }

  if (!path.isAbsolute(repositoryPath)) {
    throw new GitError('PATH_UNAVAILABLE', '仅支持输入当前主机的绝对目录路径', 400);
  }

  // 必须是已存在的目录
  await assertDirectoryExists(repositoryPath);

  // 2. 识别 Git 工作树根目录及是否为 bare 仓库
  let isBareStr;
  try {
    const isBareBuf = await runGit(['rev-parse', '--is-bare-repository'], { cwd: repositoryPath });
    isBareStr = isBareBuf.toString('utf-8').trim();
  } catch (err) {
    if (err instanceof GitError && err.code === 'NOT_REPOSITORY') {
      throw new GitError('NOT_REPOSITORY', '指定目录未包含有效的 Git 工作树', 400);
    }
    throw err;
  }

  if (isBareStr === 'true') {
    throw new GitError('NOT_REPOSITORY', '当前版本不支持接入裸仓库 (bare repository)', 400);
  }

  let topLevelStr;
  let gitDirStr;

  try {
    const [topLevelBuf, gitDirBuf] = await Promise.all([
      runGit(['rev-parse', '--show-toplevel'], { cwd: repositoryPath }),
      runGit(['rev-parse', '--git-dir'], { cwd: repositoryPath }),
    ]);

    topLevelStr = topLevelBuf.toString('utf-8').trim();
    gitDirStr = gitDirBuf.toString('utf-8').trim();
  } catch (err) {
    if (err instanceof GitError && err.code === 'NOT_REPOSITORY') {
      throw new GitError('NOT_REPOSITORY', '指定目录未包含有效的 Git 工作树', 400);
    }
    throw err;
  }

  if (!topLevelStr) {
    throw new GitError('NOT_REPOSITORY', '未找到有效的 Git 工作树根目录', 400);
  }

  // 规范化绝对路径
  const normRoot = await fs.realpath(topLevelStr);
  const resolvedGitDir = path.isAbsolute(gitDirStr)
    ? gitDirStr
    : path.resolve(normRoot, gitDirStr);
  const normGitDir = await fs.realpath(resolvedGitDir);

  // 3. 复用状态读取
  const source = await getRepositorySource(normRoot);

  // 4. 读取最新提交 (latestCommit)
  let latestCommit = null;
  let hasHistory = false;

  if (source.headState !== 'unborn') {
    const logBuf = await runGit(['log', '-1', '--format=%H%x00%s%x00%cI%x00', 'HEAD'], { cwd: normRoot });
    const parts = logBuf.toString('utf-8').split('\0');
    if (parts.length >= 3 && parts[0]) {
      latestCommit = {
        oid: parts[0],
        subject: parts[1],
        committedAt: new Date(parts[2]).toISOString(),
      };
      hasHistory = true;
    } else {
      throw new GitError('GIT_READ_FAILED', '解析最新提交记录失败', 500);
    }
  }

  // 5. 生成高熵随机票据
  pruneExpiredTickets();
  if (inspectionTickets.size >= MAX_INSPECTION_TICKETS) {
    // 移除最早创建的一项
    const firstKey = inspectionTickets.keys().next().value;
    if (firstKey) inspectionTickets.delete(firstKey);
  }

  const inspectionId = crypto.randomBytes(24).toString('hex');

  const summary = {
    inspectionId,
    repositoryRoot: normRoot,
    headState: source.headState,
    branch: source.branch,
    latestCommit,
    changedCount: source.changedCount,
    upstream: source.upstream,
    hasHistory,
    scannedAt: source.scannedAt,
  };

  inspectionTickets.set(inspectionId, {
    inspectionId,
    repositoryRoot: normRoot,
    worktreeIdentity: {
      rootPath: normRoot,
      gitDir: normGitDir,
    },
    summary,
    createdAt: Date.now(),
  });

  return summary;
}

/**
 * 确认登记时重新只读验证 Git 工作树身份
 * 确保路径仍存在、是非 bare Git 工作树、根与绝对 git-dir 的 realpath 均与检查时一致
 * @param {object} ticket 
 * @returns {Promise<string>} 验证通过的规范化根路径
 */
export async function verifyRepositoryIdentity(ticket) {
  if (!ticket || !ticket.repositoryRoot || !ticket.worktreeIdentity) {
    throw new GitError('INSPECTION_STALE', '无效的检查票据', 400);
  }

  const rootPath = ticket.repositoryRoot;

  // 1. 验证路径存在且为目录
  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      throw new GitError('PATH_UNAVAILABLE', '仓库根路径不是有效的目录', 400);
    }
  } catch (err) {
    throw new GitError('PATH_UNAVAILABLE', '仓库根目录不存在或无法访问', 400);
  }

  // 2. 识别是否为 bare 仓库
  let isBareStr;
  try {
    const isBareBuf = await runGit(['rev-parse', '--is-bare-repository'], { cwd: rootPath });
    isBareStr = isBareBuf.toString('utf-8').trim();
  } catch (err) {
    if (err instanceof GitError) {
      if (err.code === 'NOT_REPOSITORY') {
        throw new GitError('NOT_REPOSITORY', '指定目录未包含有效的 Git 工作树', 400);
      }
      throw err;
    }
    throw new GitError('NOT_REPOSITORY', '读取 Git 仓库失败', 400);
  }

  if (isBareStr === 'true') {
    throw new GitError('NOT_REPOSITORY', '当前版本不支持接入裸仓库', 400);
  }

  // 3. 读取 toplevel 和 git-dir
  let topLevelStr;
  let gitDirStr;
  try {
    const [topLevelBuf, gitDirBuf] = await Promise.all([
      runGit(['rev-parse', '--show-toplevel'], { cwd: rootPath }),
      runGit(['rev-parse', '--git-dir'], { cwd: rootPath }),
    ]);
    topLevelStr = topLevelBuf.toString('utf-8').trim();
    gitDirStr = gitDirBuf.toString('utf-8').trim();
  } catch (err) {
    if (err instanceof GitError) {
      if (err.code === 'NOT_REPOSITORY') {
        throw new GitError('NOT_REPOSITORY', '指定目录未包含有效的 Git 工作树', 400);
      }
      throw err;
    }
    throw new GitError('NOT_REPOSITORY', '读取 Git 仓库身份失败', 400);
  }

  if (!topLevelStr) {
    throw new GitError('NOT_REPOSITORY', '未找到有效的 Git 工作树根目录', 400);
  }

  let normRoot;
  let normGitDir;
  try {
    normRoot = await fs.realpath(topLevelStr);
    const resolvedGitDir = path.isAbsolute(gitDirStr)
      ? gitDirStr
      : path.resolve(normRoot, gitDirStr);
    normGitDir = await fs.realpath(resolvedGitDir);
  } catch {
    throw new GitError('PATH_UNAVAILABLE', '仓库工作树真实路径解析失败', 400);
  }

  const isWindows = process.platform === 'win32';
  const expectedRoot = ticket.worktreeIdentity.rootPath;
  const expectedGitDir = ticket.worktreeIdentity.gitDir;

  const rootMatch = isWindows
    ? normRoot.toLowerCase() === expectedRoot.toLowerCase()
    : normRoot === expectedRoot;
  const gitDirMatch = isWindows
    ? normGitDir.toLowerCase() === expectedGitDir.toLowerCase()
    : normGitDir === expectedGitDir;

  if (!rootMatch || !gitDirMatch) {
    throw new GitError('INSPECTION_STALE', '仓库工作树身份与检查时不一致，可能已被替换或移动', 400);
  }

  return normRoot;
}

