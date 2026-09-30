import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { GitError, assertDirectoryExists, assertNoConfiguredFilters } from './exec.js';

export const COMMIT_PREVIEW_ERRORS = {
  HEAD_DETACHED: 'HEAD_DETACHED',
  HEAD_UNBORN: 'HEAD_UNBORN',
  IDENTITY_MISSING: 'IDENTITY_MISSING',
  HOOKS_UNSUPPORTED: 'HOOKS_UNSUPPORTED',
  SIGNING_UNSUPPORTED: 'SIGNING_UNSUPPORTED',
  FSMONITOR_UNSUPPORTED: 'FSMONITOR_UNSUPPORTED',
  FILTER_UNSUPPORTED: 'FILTER_UNSUPPORTED',
  SPARSE_CHECKOUT_UNSUPPORTED: 'SPARSE_CHECKOUT_UNSUPPORTED',
  SUBMODULE_UNSUPPORTED: 'SUBMODULE_UNSUPPORTED',
  GIT_CONFLICT: 'GIT_CONFLICT',
  GIT_MERGING: 'GIT_MERGING',
  GIT_REBASING: 'GIT_REBASING',
  GIT_CHERRY_PICKING: 'GIT_CHERRY_PICKING',
  GIT_REVERTING: 'GIT_REVERTING',
  INVALID_COMMIT_MESSAGE: 'INVALID_COMMIT_MESSAGE',
  EMPTY_SELECTION: 'EMPTY_SELECTION',
  DUPLICATE_CANDIDATES: 'DUPLICATE_CANDIDATES',
  TOO_MANY_CANDIDATES: 'TOO_MANY_CANDIDATES',
  INVALID_CANDIDATE: 'INVALID_CANDIDATE',
  UNSELECTABLE_CANDIDATE: 'UNSELECTABLE_CANDIDATE',
  EMPTY_COMMIT: 'EMPTY_COMMIT',
  PREVIEW_STALE: 'PREVIEW_STALE',
  PATH_UNAVAILABLE: 'PATH_UNAVAILABLE',
  NOT_REPOSITORY: 'NOT_REPOSITORY',
  PREVIEW_CALC_FAILED: 'PREVIEW_CALC_FAILED',
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 64 * 1024; // 64 KiB
const MAX_STAT_BYTES = 8 * 1024; // 8 KiB
const MAX_CANDIDATES_LIMIT = 500;
const MAX_MESSAGE_LENGTH = 500;
const TICKET_TTL_MS = 5 * 60 * 1000; // 5 分钟
const MAX_TICKETS = 128;

// 内存中缓存的预览票据（重启失效，不落盘）
const previewTickets = new Map();

/**
 * 清理过期票据
 */
function pruneExpiredTickets() {
  const now = Date.now();
  for (const [id, ticket] of previewTickets.entries()) {
    if (now - ticket.createdAt > TICKET_TTL_MS) {
      previewTickets.delete(id);
    }
  }
  if (previewTickets.size > MAX_TICKETS) {
    const oldestKey = previewTickets.keys().next().value;
    if (oldestKey) previewTickets.delete(oldestKey);
  }
}

/**
 * 获取指定票据
 * @param {string} ticketId 
 * @returns {object | null}
 */
export function getCommitPreviewTicket(ticketId) {
  pruneExpiredTickets();
  if (!ticketId || typeof ticketId !== 'string') return null;
  return previewTickets.get(ticketId) || null;
}

/**
 * 删除指定票据
 * @param {string} ticketId 
 */
export function removeCommitPreviewTicket(ticketId) {
  previewTickets.delete(ticketId);
}

/**
 * 清空所有内存票据（供测试或管理重置）
 */
export function clearAllCommitPreviewTickets() {
  previewTickets.clear();
}

/**
 * 专用于只读预览的 Git 命令执行器
 * 严格禁用 shell、终端交互、外部 hook、filter、fsmonitor
 * 彻底过滤继承的任意 GIT_* 外部环境变量，防止与真实仓库身份或索引脱钩
 * @param {string[]} args 
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {Buffer | string} [options.stdin]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxOutputBytes]
 * @returns {Promise<{ stdout: Buffer, stderr: Buffer, code: number }>}
 */
export async function runPreviewGit(args, options = {}) {
  let timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  if (args[0] !== 'config') {
    const started = Date.now();
    // Configuration reads must never inherit content intended for hash-object,
    // check-attr or update-index: git config closes stdin without consuming it.
    const { stdin: _contentInput, ...configOptions } = options;
    const config = await runPreviewGit(['config', '--includes', '--null', '--list'], configOptions);
    if (config.code !== 0) throw new GitError('GIT_READ_FAILED', '无法安全读取 Git 配置', 500);
    assertNoConfiguredFilters(config.stdout);
    timeoutMs -= Date.now() - started;
    maxOutputBytes -= config.stdout.length + config.stderr.length;
    if (timeoutMs <= 0) throw new GitError('GIT_TIMEOUT', 'Git 安全检查超时', 500);
    if (maxOutputBytes <= 0) throw new GitError('GIT_OUTPUT_LIMIT', 'Git 安全检查输出超出限制', 500);
  }

  const isConfigCommand = args[0] === 'config';
  const gitArgs = [
    '-c', 'diff.external=',
    '-c', 'diff.renames=true',
    '--no-optional-locks',
  ];

  if (!isConfigCommand) {
    gitArgs.push(
      '-c', 'core.fsmonitor=false',
      '-c', 'core.useBuiltinFSMonitor=false',
      '-c', 'core.hooksPath=',
    );
  }

  gitArgs.push(...args);

  // 清洗环境变量：清除外部任意 GIT_* 变量，防止隐式影响
  const safeEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) {
      safeEnv[k] = v;
    }
  }

  safeEnv.GIT_TERMINAL_PROMPT = '0';
  safeEnv.GIT_OPTIONAL_LOCKS = '0';
  safeEnv.GIT_LITERAL_PATHSPECS = '1'; // 默认开启字面路径，杜绝 glob 模式匹配
  safeEnv.LC_ALL = 'C.UTF-8';
  safeEnv.LANG = 'C.UTF-8';

  if (options.env) {
    Object.assign(safeEnv, options.env);
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', gitArgs, {
        cwd: options.cwd,
        env: safeEnv,
        shell: false,
        windowsHide: true,
        stdio: [options.stdin !== undefined && options.stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        reject(new GitError('GIT_UNAVAILABLE', '系统未找到已安装的 Git 命令行工具', 500));
      } else {
        reject(new GitError('GIT_READ_FAILED', '启动 Git 命令失败', 500));
      }
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    let timedOut = false;
    let exceededLimit = false;
    let stdinError;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 500);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        exceededLimit = true;
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        exceededLimit = true;
        child.kill('SIGTERM');
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new GitError('GIT_UNAVAILABLE', '系统未找到已安装的 Git 命令行工具', 500));
      } else {
        reject(new GitError('GIT_READ_FAILED', 'Git 进程执行异常', 500));
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new GitError('GIT_TIMEOUT', `Git 命令执行超时 (超过 ${timeoutMs}ms)`, 500));
        return;
      }

      if (exceededLimit) {
        reject(new GitError('GIT_OUTPUT_LIMIT', `Git 输出超出 ${maxOutputBytes} 字节限制`, 500));
        return;
      }

      if (stdinError && code === 0) {
        reject(new GitError('GIT_READ_FAILED', 'Git 未能完整接收命令输入', 500));
        return;
      }

      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });

    if (options.stdin !== undefined && options.stdin !== null) {
      // Early child exit can close the input pipe; classify it after close
      // rather than allowing an unhandled EPIPE to terminate the API process.
      child.stdin.on('error', (error) => { stdinError = error; });
      child.stdin.end(options.stdin);
    }
  });
}

/**
 * 校验仓库基本身份、路径与安全支持门槛
 * 纯只读，绝不写 Git
 * @param {string} repositoryPath 
 * @returns {Promise<{ repoRoot: string, gitDir: string, commonDir: string }>}
 */
export async function assertRepositoryAndSecurity(repositoryPath) {
  if (typeof repositoryPath !== 'string' || repositoryPath.trim() === '') {
    throw new GitError(COMMIT_PREVIEW_ERRORS.PATH_UNAVAILABLE, '请提供有效的本地目录路径', 400);
  }

  if (!path.isAbsolute(repositoryPath)) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.PATH_UNAVAILABLE, '仅支持当前主机的绝对目录路径', 400);
  }

  await assertDirectoryExists(repositoryPath);

  // 1. 验证是否为有效 Git 仓库及工作树根
  let isBareStr;
  try {
    const res = await runPreviewGit(['rev-parse', '--is-bare-repository'], { cwd: repositoryPath });
    if (res.code !== 0) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.NOT_REPOSITORY, '指定目录未包含有效的 Git 工作树', 400);
    }
    isBareStr = res.stdout.toString('utf-8').trim();
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw new GitError(COMMIT_PREVIEW_ERRORS.NOT_REPOSITORY, '无法读取 Git 仓库状态', 400);
  }

  if (isBareStr === 'true') {
    throw new GitError(COMMIT_PREVIEW_ERRORS.NOT_REPOSITORY, '不支持裸仓库 (bare repository)', 400);
  }

  let topLevelStr;
  let gitDirStr;
  let commonDirStr;

  try {
    const [topLevelRes, gitDirRes, commonDirRes] = await Promise.all([
      runPreviewGit(['rev-parse', '--show-toplevel'], { cwd: repositoryPath }),
      runPreviewGit(['rev-parse', '--git-dir'], { cwd: repositoryPath }),
      runPreviewGit(['rev-parse', '--git-common-dir'], { cwd: repositoryPath }),
    ]);

    if (topLevelRes.code !== 0 || gitDirRes.code !== 0) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.NOT_REPOSITORY, '无法定位 Git 工作树根目录', 400);
    }

    topLevelStr = topLevelRes.stdout.toString('utf-8').trim();
    gitDirStr = gitDirRes.stdout.toString('utf-8').trim();
    commonDirStr = commonDirRes.stdout.toString('utf-8').trim();
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw new GitError(COMMIT_PREVIEW_ERRORS.NOT_REPOSITORY, '读取仓库目录信息失败', 400);
  }

  const normalizedInput = path.resolve(repositoryPath);
  const normalizedTopLevel = path.resolve(topLevelStr);

  if (process.platform === 'win32') {
    if (normalizedInput.toLowerCase() !== normalizedTopLevel.toLowerCase()) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.PATH_UNAVAILABLE, '仓库根目录与工作树根不匹配', 400);
    }
  } else {
    if (normalizedInput !== normalizedTopLevel) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.PATH_UNAVAILABLE, '仓库根目录与工作树根不匹配', 400);
    }
  }

  const resolvedGitDir = path.resolve(normalizedTopLevel, gitDirStr);
  const resolvedCommonDir = path.resolve(normalizedTopLevel, commonDirStr);

  // 2. 检查未解决的并发/合并/挑拣/变基操作
  const mergeHeadPath = path.join(resolvedGitDir, 'MERGE_HEAD');
  const cherryPickHeadPath = path.join(resolvedGitDir, 'CHERRY_PICK_HEAD');
  const revertHeadPath = path.join(resolvedGitDir, 'REVERT_HEAD');
  const rebaseMergePath = path.join(resolvedGitDir, 'rebase-merge');
  const rebaseApplyPath = path.join(resolvedGitDir, 'rebase-apply');

  if (fsSync.existsSync(mergeHeadPath)) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.GIT_MERGING, '仓库当前正在合并中 (MERGE_HEAD)，首版不支持在此状态下提交', 400);
  }
  if (fsSync.existsSync(cherryPickHeadPath)) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.GIT_CHERRY_PICKING, '仓库当前正在挑拣中 (CHERRY_PICK_HEAD)，首版不支持在此状态下提交', 400);
  }
  if (fsSync.existsSync(revertHeadPath)) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.GIT_REVERTING, '仓库当前正在恢复中 (REVERT_HEAD)，首版不支持在此状态下提交', 400);
  }
  if (fsSync.existsSync(rebaseMergePath) || fsSync.existsSync(rebaseApplyPath)) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.GIT_REBASING, '仓库当前正在变基中，首版不支持在此状态下提交', 400);
  }

  // 3. 检查安全门槛：hooks、签名、fsmonitor、filter、稀疏检出
  // 3.1 core.hooksPath
  const hooksPathRes = await runPreviewGit(['config', '--get', 'core.hooksPath'], { cwd: normalizedTopLevel });
  if (hooksPathRes.code === 0 && hooksPathRes.stdout.toString('utf-8').trim() !== '') {
    throw new GitError(COMMIT_PREVIEW_ERRORS.HOOKS_UNSUPPORTED, '当前仓库配置了自定义钩子路径 (core.hooksPath)，首版不支持在存在提交钩子的仓库中运行', 400);
  }

  // 3.2 检查有效提交钩子文件（pre-commit, commit-msg, prepare-commit-msg, post-commit）
  const hookDirsToCheck = new Set([
    path.join(resolvedGitDir, 'hooks'),
    path.join(resolvedCommonDir, 'hooks'),
  ]);

  const commitHookNames = ['pre-commit', 'commit-msg', 'prepare-commit-msg', 'post-commit'];

  for (const hookDir of hookDirsToCheck) {
    if (fsSync.existsSync(hookDir)) {
      try {
        const files = await fs.readdir(hookDir);
        for (const file of files) {
          if (file.endsWith('.sample')) continue;
          for (const hookName of commitHookNames) {
            if (file === hookName || file.startsWith(hookName + '.')) {
              throw new GitError(COMMIT_PREVIEW_ERRORS.HOOKS_UNSUPPORTED, `当前仓库存在活动的提交钩子 (${file})，首版不支持在存在提交钩子的仓库中运行`, 400);
            }
          }
        }
      } catch (err) {
        if (err instanceof GitError) throw err;
      }
    }
  }

  // 3.3 签名配置检查
  const gpgSignRes = await runPreviewGit(['config', '--bool', '--get', 'commit.gpgSign'], { cwd: normalizedTopLevel });
  if (gpgSignRes.code === 0 && gpgSignRes.stdout.toString('utf-8').trim() === 'true') {
    throw new GitError(COMMIT_PREVIEW_ERRORS.SIGNING_UNSUPPORTED, '当前仓库或全局启用了提交签名 (commit.gpgSign)，首版不支持自动调用签名工具执行提交', 400);
  }

  // 3.4 core.fsmonitor 外部程序检查
  const fsmonitorRes = await runPreviewGit(['config', '--get', 'core.fsmonitor'], { cwd: normalizedTopLevel });
  if (fsmonitorRes.code === 0) {
    const val = fsmonitorRes.stdout.toString('utf-8').trim();
    if (val !== '' && val !== 'false') {
      throw new GitError(COMMIT_PREVIEW_ERRORS.FSMONITOR_UNSUPPORTED, '当前仓库启用了外部文件监视器 (core.fsmonitor)，首版暂不支持外部监控脚本', 400);
    }
  }

  // 3.5 Every non-config command is guarded by effective clean/process
  // configuration checks in runPreviewGit, before status or content hashing.

  // 3.6 稀疏检出
  const sparseRes = await runPreviewGit(['config', '--bool', '--get', 'core.sparseCheckout'], { cwd: normalizedTopLevel });
  if (sparseRes.code === 0 && sparseRes.stdout.toString('utf-8').trim() === 'true') {
    throw new GitError(COMMIT_PREVIEW_ERRORS.SPARSE_CHECKOUT_UNSUPPORTED, '当前仓库启用了稀疏检出 (core.sparseCheckout)，首版暂不支持', 400);
  }

  // 4. 用户提交身份 (author/committer) 检查
  const [authorRes, committerRes] = await Promise.all([
    runPreviewGit(['var', 'GIT_AUTHOR_IDENT'], { cwd: normalizedTopLevel }),
    runPreviewGit(['var', 'GIT_COMMITTER_IDENT'], { cwd: normalizedTopLevel }),
  ]);

  if (authorRes.code !== 0 || committerRes.code !== 0 || authorRes.stdout.toString('utf-8').trim() === '') {
    throw new GitError(
      COMMIT_PREVIEW_ERRORS.IDENTITY_MISSING,
      'Git 提交身份未配置，请先在 Git 中设置 user.name 和 user.email (例如 git config user.name "Your Name" 及 git config user.email "you@example.com")',
      400
    );
  }

  return {
    repoRoot: normalizedTopLevel,
    gitDir: resolvedGitDir,
    commonDir: resolvedCommonDir,
  };
}

/**
 * 检查路径是否适用了外部 clean/filter 程序
 * @param {string} repoRoot
 * @param {string[]} paths
 */
export async function assertNoApplicableFilter(repoRoot, paths) {
  if (!paths || paths.length === 0) return;
  const input = Buffer.from(paths.join('\0') + '\0', 'utf-8');
  const attrRes = await runPreviewGit(
    ['check-attr', '-z', '--stdin', 'filter'],
    { cwd: repoRoot, stdin: input }
  );
  if (attrRes.code === 0) {
    const chunks = attrRes.stdout.toString('utf-8').split('\0');
    for (let i = 0; i < chunks.length - 2; i += 3) {
      const filePath = chunks[i];
      const attr = chunks[i + 1];
      const val = chunks[i + 2];
      if (attr === 'filter' && val && val !== 'unspecified' && val !== 'unset') {
        throw new GitError(
          COMMIT_PREVIEW_ERRORS.FILTER_UNSUPPORTED,
          `文件 (${filePath}) 适用了外部 filter (${val})，首版不支持外部过滤程序`,
          400
        );
      }
    }
  }
}

/**
 * 计算真实索引文件的稳定指纹
 * @param {string} gitDir 
 * @returns {Promise<string>}
 */
export async function getRealIndexFingerprint(gitDir) {
  const indexPath = path.join(gitDir, 'index');
  try {
    const stat = await fs.stat(indexPath);
    const content = await fs.readFile(indexPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `size:${stat.size}|hash:${hash}`;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return 'index:absent';
    }
    throw err;
  }
}

/**
 * 查找字符串中第 N 个空格的索引
 * @param {string} str 
 * @param {number} n 
 * @returns {number}
 */
function findNthSpace(str, n) {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === ' ') {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

/**
 * 检查文件在工作树中的物理状态（使用 lstat 防止跟随符号链接）
 * @param {string} repoRoot 
 * @param {string} relPath
 * @returns {Promise<{ exists: boolean, isFile: boolean, isSymlink: boolean, isDirectory: boolean }>}
 */
async function checkPathLstat(repoRoot, relPath) {
  const fullPath = path.join(repoRoot, relPath);
  try {
    const st = await fs.lstat(fullPath);
    return {
      exists: true,
      isFile: st.isFile(),
      isSymlink: st.isSymbolicLink(),
      isDirectory: st.isDirectory(),
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { exists: false, isFile: false, isSymlink: false, isDirectory: false };
    }
    return { exists: true, isFile: false, isSymlink: false, isDirectory: false };
  }
}

/**
 * 读取已登记仓库的提交候选条目
 * @param {string} repositoryPath 
 * @param {object} [options]
 * @param {string} [options.projectId]
 * @returns {Promise<{ branch: string, headOid: string, candidates: Array<object>, candidateCount: number, selectableCount: number }>}
 */
export async function getCommitCandidates(repositoryPath, options = {}) {
  const { repoRoot } = await assertRepositoryAndSecurity(repositoryPath);

  // 运行 git status --porcelain=v2 --branch --untracked-files=all -z
  // 必须指定 --untracked-files=all，精确枚举每个未跟踪文件，严禁将未跟踪目录整体当下发
  const statusRes = await runPreviewGit(
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
    { cwd: repoRoot }
  );

  if (statusRes.code !== 0) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.NOT_REPOSITORY, '读取仓库状态失败', 400);
  }

  const rawStr = statusRes.stdout.toString('utf-8');
  const chunks = rawStr.split('\0');

  let headOid = null;
  let branchName = null;
  const candidates = [];
  let hasConflicts = false;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    if (chunk.startsWith('# ')) {
      if (chunk.startsWith('# branch.oid ')) {
        headOid = chunk.slice('# branch.oid '.length).trim();
      } else if (chunk.startsWith('# branch.head ')) {
        branchName = chunk.slice('# branch.head '.length).trim();
      }
      continue;
    }

    const type = chunk[0];

    if (type === 'u') {
      // 冲突文件
      hasConflicts = true;
      const spaceIdx = findNthSpace(chunk, 10);
      const filePath = spaceIdx !== -1 ? chunk.slice(spaceIdx + 1) : chunk;
      const id = `cand_${crypto.createHash('sha256').update('u:' + filePath).digest('hex').slice(0, 16)}`;
      candidates.push({
        id,
        path: filePath,
        oldPath: null,
        stageScope: 'unstaged',
        operationType: 'modify',
        selectable: false,
        unselectableReason: '该文件存在未解决的代码冲突',
      });
    } else if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const spaceIdx = findNthSpace(chunk, 8);
      if (spaceIdx !== -1) {
        const xy = chunk.slice(2, 4);
        const parts = chunk.slice(0, spaceIdx).split(' ');
        const mH = parts[3];
        const mI = parts[4];
        const mW = parts[5];
        const filePath = chunk.slice(spaceIdx + 1);

        // 绝不将目录当做候选
        if (filePath.endsWith('/') || filePath.endsWith('\\')) {
          continue;
        }

        const isSubmodule = mH === '160000' || mI === '160000' || mW === '160000';
        const isGitSymlink = mH === '120000' || mI === '120000' || mW === '120000';
        const indexStatus = xy[0];
        const worktreeStatus = xy[1];

        let stageScope;
        if (indexStatus !== '.' && worktreeStatus !== '.') {
          stageScope = 'both';
        } else if (indexStatus !== '.') {
          stageScope = 'staged';
        } else {
          stageScope = 'unstaged';
        }

        let operationType = 'modify';
        if (indexStatus === 'D' || worktreeStatus === 'D') {
          operationType = 'delete';
        } else if (indexStatus === 'A') {
          operationType = 'add';
        } else if (indexStatus === 'T' || worktreeStatus === 'T') {
          operationType = 'typechange';
        }

        let selectable = true;
        let unselectableReason = null;

        if (isSubmodule) {
          selectable = false;
          unselectableReason = '不支持直接提交子模块';
        } else if (isGitSymlink) {
          selectable = false;
          unselectableReason = '不支持提交符号链接 (symlink)';
        } else if (stageScope === 'both') {
          selectable = false;
          unselectableReason = '该文件同时存在已暂存与未暂存的不同改动，请先在 Git 中处理部分暂存后再选择提交';
        }

        // 使用 lstat 检查工作区物理文件类型（避免跟随链接）
        const lstatInfo = await checkPathLstat(repoRoot, filePath);
        if (lstatInfo.exists) {
          if (lstatInfo.isDirectory) {
            continue; // 目录绝当下发
          }
          if (lstatInfo.isSymlink) {
            selectable = false;
            unselectableReason = '不支持提交符号链接 (symlink)';
          } else if (!lstatInfo.isFile && operationType !== 'delete') {
            selectable = false;
            unselectableReason = '不支持提交特殊文件类型';
          }
        }

        const id = `cand_${crypto.createHash('sha256').update('1:' + filePath).digest('hex').slice(0, 16)}`;
        candidates.push({
          id,
          path: filePath,
          oldPath: null,
          stageScope,
          operationType,
          selectable,
          unselectableReason,
        });
      }
    } else if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<oldPath>
      const spaceIdx = findNthSpace(chunk, 9);
      if (spaceIdx !== -1) {
        const xy = chunk.slice(2, 4);
        const parts = chunk.slice(0, spaceIdx).split(' ');
        const mH = parts[3];
        const mI = parts[4];
        const mW = parts[5];
        const filePath = chunk.slice(spaceIdx + 1);
        const oldFilePath = chunks[++i] || null;

        const isSubmodule = mH === '160000' || mI === '160000' || mW === '160000';
        const isGitSymlink = mH === '120000' || mI === '120000' || mW === '120000';

        const indexStatus = xy[0];
        const worktreeStatus = xy[1];

        let stageScope = 'staged';
        let selectable = true;
        let unselectableReason = null;

        if (isSubmodule) {
          selectable = false;
          unselectableReason = '不支持直接提交子模块';
        } else if (isGitSymlink) {
          selectable = false;
          unselectableReason = '不支持提交符号链接 (symlink)';
        } else if (worktreeStatus !== '.') {
          stageScope = 'both';
          selectable = false;
          unselectableReason = '重命名文件在工作树中又有未暂存改动，请先在 Git 中处理部分暂存后再选择提交';
        }

        const lstatInfo = await checkPathLstat(repoRoot, filePath);
        if (lstatInfo.exists) {
          if (lstatInfo.isDirectory) {
            continue;
          }
          if (lstatInfo.isSymlink) {
            selectable = false;
            unselectableReason = '不支持提交符号链接 (symlink)';
          } else if (!lstatInfo.isFile) {
            selectable = false;
            unselectableReason = '不支持提交特殊文件类型';
          }
        }

        // 只支持旧路径已从工作树移走的重命名；旧路径重现时，
        // git commit --only 会把它的当前内容也纳入提交。
        if (oldFilePath && (await checkPathLstat(repoRoot, oldFilePath)).exists) {
          selectable = false;
          unselectableReason = '重命名的原路径仍存在，请先处理该路径后重新预览';
        }

        const id = `cand_${crypto.createHash('sha256').update('2:' + filePath + ':' + (oldFilePath || '')).digest('hex').slice(0, 16)}`;
        candidates.push({
          id,
          path: filePath,
          oldPath: oldFilePath,
          stageScope,
          operationType: 'rename',
          selectable,
          unselectableReason,
        });
      }
    } else if (type === '?') {
      // ? <path>
      const filePath = chunk.slice(2);
      // 绝不将未跟踪目录整体作为条目
      if (filePath.endsWith('/') || filePath.endsWith('\\')) {
        continue;
      }

      const lstatInfo = await checkPathLstat(repoRoot, filePath);
      if (lstatInfo.isDirectory) {
        continue;
      }

      let selectable = true;
      let unselectableReason = null;

      if (lstatInfo.isSymlink) {
        selectable = false;
        unselectableReason = '不支持提交符号链接 (symlink)';
      } else if (!lstatInfo.isFile) {
        selectable = false;
        unselectableReason = '不支持提交特殊文件类型';
      }

      const id = `cand_${crypto.createHash('sha256').update('?:' + filePath).digest('hex').slice(0, 16)}`;
      candidates.push({
        id,
        path: filePath,
        oldPath: null,
        stageScope: 'untracked',
        operationType: 'add',
        selectable,
        unselectableReason,
      });
    }
  }

  // 校验 HEAD 状态
  if (!headOid || headOid === '(initial)') {
    throw new GitError(COMMIT_PREVIEW_ERRORS.HEAD_UNBORN, '当前仓库尚未产生任何初始提交，首版仅支持在已有提交的本地分支上提交', 400);
  }

  if (!branchName || branchName === '(detached)') {
    throw new GitError(COMMIT_PREVIEW_ERRORS.HEAD_DETACHED, '当前仓库处于游离 HEAD (detached) 状态，请切换到本地分支后再提交', 400);
  }

  if (hasConflicts) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.GIT_CONFLICT, '仓库当前存在未解决的代码冲突，请先在 Git 中解决冲突后再提交', 400);
  }

  // 检查候选条目中是否有文件适用了外部 clean/filter 程序
  const allCandidatePaths = candidates.map((c) => c.path);
  await assertNoApplicableFilter(repoRoot, allCandidatePaths);

  return {
    branch: branchName,
    headOid,
    candidates,
    candidateCount: candidates.length,
    selectableCount: candidates.filter((c) => c.selectable).length,
  };
}

/**
 * 计算选中文件在工作树中的内容指纹与存在状态
 * 采用 fs.lstat 防止跟随外部链接，对符号链接与特殊类型标记独立指纹
 * @param {string} repoRoot 
 * @param {Array<{ path: string, oldPath: string | null, operationType: string }>} selectedFiles 
 * @returns {Promise<string>}
 */
export async function computeWorktreeFingerprint(repoRoot, selectedFiles) {
  const parts = [];
  for (const item of selectedFiles) {
    if (item.oldPath) {
      const oldPathState = await checkPathLstat(repoRoot, item.oldPath);
      parts.push(`${item.oldPath}|rename-source:${oldPathState.exists ? 'present' : 'absent'}`);
    }
    const fullPath = path.join(repoRoot, item.path);
    try {
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        parts.push(`${item.path}|type:symlink|size:${stat.size}`);
      } else if (!stat.isFile()) {
        parts.push(`${item.path}|type:special|size:${stat.size}`);
      } else {
        const content = await fs.readFile(fullPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        parts.push(`${item.path}|type:file|size:${stat.size}|mode:${stat.mode}|hash:${hash}`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        parts.push(`${item.path}|absent`);
      } else {
        parts.push(`${item.path}|error:${err.code}`);
      }
    }
  }
  return crypto.createHash('sha256').update(parts.sort().join(';')).digest('hex');
}

/**
 * 校验提交说明文本
 * 限制长度不超过 MAX_MESSAGE_LENGTH，单行非空，无控制字符
 * @param {string} message 
 * @returns {string}
 */
export function validateCommitMessage(message) {
  if (typeof message !== 'string') {
    throw new GitError(COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE, '提交说明必须为字符串', 400);
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE, '提交说明不能为空', 400);
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE, `提交说明过长 (最大允许 ${MAX_MESSAGE_LENGTH} 字符)`, 400);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE, '提交说明仅支持单行文本，不可包含换行符', 400);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.INVALID_COMMIT_MESSAGE, '提交说明不可包含不可见控制字符', 400);
  }
  return trimmed;
}

/**
 * 创建本地提交的可信预览
 * 纯只读，通过独立临时索引和独立临时对象库计算预期树与 diff
 * 核心保证：绝不向被管理仓库的真实索引、HEAD、工作树及 .git/objects 库写任何数据
 * @param {string} repositoryPath 
 * @param {object} params 
 * @param {string} [params.projectId]
 * @param {string[]} params.candidateIds
 * @param {string} params.message
 * @returns {Promise<object>}
 */
export async function createCommitPreview(repositoryPath, params) {
  const { projectId = 'default', candidateIds, message } = params || {};

  // 1. 参数结构基础校验
  const cleanMessage = validateCommitMessage(message);

  if (!Array.isArray(candidateIds)) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.EMPTY_SELECTION, '选中的候选条目列表必须为数组', 400);
  }
  if (candidateIds.length === 0) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.EMPTY_SELECTION, '请至少选择一个待提交的文件条目', 400);
  }
  if (candidateIds.length > MAX_CANDIDATES_LIMIT) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.TOO_MANY_CANDIDATES, `单次选择条目数量不能超过 ${MAX_CANDIDATES_LIMIT} 个`, 400);
  }
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.DUPLICATE_CANDIDATES, '选中的条目列表中包含重复的候选 ID', 400);
  }

  // 2. 重新获取仓库状态与候选
  const { repoRoot, gitDir, commonDir } = await assertRepositoryAndSecurity(repositoryPath);
  const candidatesData = await getCommitCandidates(repoRoot, { projectId });
  const { branch, headOid, candidates } = candidatesData;

  const candidateMap = new Map(candidates.map((c) => [c.id, c]));
  const selectedCandidates = [];

  for (const id of candidateIds) {
    const cand = candidateMap.get(id);
    if (!cand) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.INVALID_CANDIDATE, '未找到指定的候选条目或状态已过期', 400);
    }
    if (!cand.selectable) {
      throw new GitError(
        COMMIT_PREVIEW_ERRORS.UNSELECTABLE_CANDIDATE,
        `选中的条目不可提交: ${cand.path} (${cand.unselectableReason || '不可选'})`,
        400
      );
    }

    // 复核选中的物理文件类型
    const lstatInfo = await checkPathLstat(repoRoot, cand.path);
    if (lstatInfo.exists) {
      if (lstatInfo.isSymlink) {
        throw new GitError(COMMIT_PREVIEW_ERRORS.UNSELECTABLE_CANDIDATE, `选中的条目不可提交: ${cand.path} (不支持提交符号链接)`, 400);
      }
      if (lstatInfo.isDirectory || !lstatInfo.isFile) {
        throw new GitError(COMMIT_PREVIEW_ERRORS.UNSELECTABLE_CANDIDATE, `选中的条目不可提交: ${cand.path} (仅支持普通文件)`, 400);
      }
    }

    if (cand.oldPath && (await checkPathLstat(repoRoot, cand.oldPath)).exists) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.UNSELECTABLE_CANDIDATE, '重命名的原路径仍存在，请重新选择并预览', 400);
    }

    selectedCandidates.push(cand);
  }

  // 检查选中路径是否适用了外部 clean/filter 程序
  await assertNoApplicableFilter(repoRoot, selectedCandidates.map((c) => c.path));

  // 3. 计算真实索引与工作树指纹
  const indexFingerprint = await getRealIndexFingerprint(gitDir);
  const worktreeFingerprint = await computeWorktreeFingerprint(
    repoRoot,
    selectedCandidates.map((c) => ({ path: c.path, oldPath: c.oldPath, operationType: c.operationType }))
  );

  // 4. 获取 HEAD commit 对应的 Tree OID
  const headTreeRes = await runPreviewGit(['rev-parse', `${headOid}^{tree}`], { cwd: repoRoot });
  if (headTreeRes.code !== 0) {
    throw new GitError(COMMIT_PREVIEW_ERRORS.NOT_REPOSITORY, '无法解析 HEAD 提交树', 400);
  }
  const headTreeOid = headTreeRes.stdout.toString('utf-8').trim();

  // 5. 隔离计算：使用系统临时目录中的独立临时索引与独立临时对象库
  // 核心保证：
  // 1) GIT_INDEX_FILE 指向 tempIndexFile
  // 2) GIT_OBJECT_DIRECTORY 指向 tempObjDir
  // 3) tempObjDir/info/alternates 只读引用仓库的真实对象库，被管理仓库零写入！
  // 4) GIT_LITERAL_PATHSPECS=1 杜绝通配符解释
  const tempId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const tempIndexFile = path.join(os.tmpdir(), `commit-preview-idx-${tempId}`);
  const tempObjDir = path.join(os.tmpdir(), `commit-preview-obj-${tempId}`);

  let expectedTreeOid = null;
  let diffStatText = '';
  let diffDetailsText = '';
  let diffTruncated = false;
  let hasBinary = false;

  try {
    // 5.0 初始化临时对象库与 alternates
    await fs.mkdir(path.join(tempObjDir, 'info'), { recursive: true });
    const realObjectsDir = path.resolve(commonDir, 'objects').replace(/\\/g, '/');
    await fs.writeFile(path.join(tempObjDir, 'info', 'alternates'), realObjectsDir + '\n', 'utf-8');

    const isoEnv = {
      GIT_INDEX_FILE: tempIndexFile,
      GIT_OBJECT_DIRECTORY: tempObjDir,
      GIT_DIR: gitDir,
      GIT_LITERAL_PATHSPECS: '1',
    };

    // 5.1 从 HEAD 树初始化临时索引
    const readTreeRes = await runPreviewGit(['read-tree', headOid], {
      cwd: repoRoot,
      env: isoEnv,
    });
    if (readTreeRes.code !== 0) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.PREVIEW_CALC_FAILED, '初始化临时索引失败', 500);
    }

    // 5.2 对选中的条目更新临时索引
    const pathsToRemove = [];
    const pathsToAdd = [];

    for (const cand of selectedCandidates) {
      if (cand.operationType === 'delete') {
        pathsToRemove.push(cand.path);
      } else if (cand.operationType === 'rename') {
        if (cand.oldPath) pathsToRemove.push(cand.oldPath);
        pathsToAdd.push(cand.path);
      } else {
        pathsToAdd.push(cand.path);
      }
    }

    if (pathsToRemove.length > 0) {
      const rmInput = Buffer.from(pathsToRemove.join('\0') + '\0', 'utf-8');
      const rmRes = await runPreviewGit(
        ['rm', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'],
        {
          cwd: repoRoot,
          env: isoEnv,
          stdin: rmInput,
        }
      );
      if (rmRes.code !== 0) {
        throw new GitError(COMMIT_PREVIEW_ERRORS.PREVIEW_CALC_FAILED, '临时索引删除路径失败', 500);
      }
    }

    if (pathsToAdd.length > 0) {
      const addInput = Buffer.from(pathsToAdd.join('\0') + '\0', 'utf-8');
      const addRes = await runPreviewGit(
        ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        {
          cwd: repoRoot,
          env: isoEnv,
          stdin: addInput,
        }
      );
      if (addRes.code !== 0) {
        throw new GitError(COMMIT_PREVIEW_ERRORS.PREVIEW_CALC_FAILED, '临时索引添加路径失败', 500);
      }
    }

    // 5.3 写入临时树
    const writeTreeRes = await runPreviewGit(['write-tree'], {
      cwd: repoRoot,
      env: isoEnv,
    });
    if (writeTreeRes.code !== 0) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.PREVIEW_CALC_FAILED, '生成预期树失败', 500);
    }
    expectedTreeOid = writeTreeRes.stdout.toString('utf-8').trim();

    // 5.4 验证是否产生实际改动（拒绝空提交）
    if (expectedTreeOid === headTreeOid) {
      throw new GitError(COMMIT_PREVIEW_ERRORS.EMPTY_COMMIT, '选中的条目未产生实际内容差异，不支持提交空提交', 400);
    }

    // 5.5 计算 HEAD 到 expectedTreeOid 的差异概览 (diff-tree)
    const diffStatRes = await runPreviewGit(
      ['diff-tree', '--stat', '-M', headTreeOid, expectedTreeOid],
      { cwd: repoRoot, env: isoEnv }
    );
    if (diffStatRes.code === 0) {
      const statRaw = diffStatRes.stdout.toString('utf-8');
      diffStatText = statRaw.length > MAX_STAT_BYTES ? statRaw.slice(0, MAX_STAT_BYTES) + '\n... [统计已截断]' : statRaw;
    }

    const diffDetailRes = await runPreviewGit(
      ['diff-tree', '-p', '-M', headTreeOid, expectedTreeOid],
      { cwd: repoRoot, env: isoEnv }
    );
    if (diffDetailRes.code === 0) {
      let diffRaw = diffDetailRes.stdout.toString('utf-8');
      if (diffRaw.includes('Binary files') || diffRaw.includes('GIT binary patch')) {
        hasBinary = true;
      }
      if (Buffer.byteLength(diffRaw, 'utf-8') > MAX_DIFF_BYTES) {
        diffTruncated = true;
        diffDetailsText = diffRaw.slice(0, MAX_DIFF_BYTES) + '\n... [差异内容超出上限，已截断] ...';
      } else {
        diffDetailsText = diffRaw;
      }
    }
  } finally {
    // 无论成功、异常或超时，彻底清理临时目录与临时索引
    await fs.rm(tempObjDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(tempIndexFile).catch(() => {});
  }

  // 6. 构造高熵、有限 TTL 的短期确认票据
  const ticketId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  const ticketData = {
    ticketId,
    projectId,
    repoRoot,
    commonDir,
    branchRef: `refs/heads/${branch}`,
    branch,
    headOid,
    headTreeOid,
    indexFingerprint,
    worktreeFingerprint,
    selectedCandidateIds: [...candidateIds],
    selectedFiles: selectedCandidates.map((c) => ({
      path: c.path,
      oldPath: c.oldPath,
      operationType: c.operationType,
      stageScope: c.stageScope,
    })),
    expectedTreeOid,
    message: cleanMessage,
    createdAt: now,
  };

  pruneExpiredTickets();
  previewTickets.set(ticketId, ticketData);

  // 7. 返回可供安全展示的 DTO（不暴露仓库宿主机绝对根，仅包含相对路径与必要摘要）
  return {
    ticketId,
    branch,
    headOid,
    expectedTreeOid,
    message: cleanMessage,
    summary: {
      fileCount: selectedCandidates.length,
      operations: selectedCandidates.map((c) => ({
        path: c.path,
        oldPath: c.oldPath,
        operationType: c.operationType,
      })),
    },
    diffOverview: {
      statText: diffStatText.trim(),
      diffText: diffDetailsText.trim(),
      truncated: diffTruncated,
      hasBinary,
    },
    expiresInSeconds: Math.floor(TICKET_TTL_MS / 1000),
  };
}

/**
 * 确认前重新计算并比对提交预览（供 T02 确认执行器调用）
 * 严格只读核查，若有任何状态不一致返回 PREVIEW_STALE，不写 Git
 * @param {string} ticketId 
 * @returns {Promise<{ valid: boolean, reason?: string, message?: string, ticket?: object }>}
 */
export async function recalculateAndCompareCommitPreview(ticketId) {
  const ticket = getCommitPreviewTicket(ticketId);
  if (!ticket) {
    return {
      valid: false,
      reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
      message: '提交预览票据已过期或不存在，请重新生成预览',
    };
  }

  try {
    // 1. 核对仓库身份与安全支持门槛
    const { repoRoot, gitDir, commonDir } = await assertRepositoryAndSecurity(ticket.repoRoot);
    if (commonDir !== ticket.commonDir) {
      return {
        valid: false,
        reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
        message: '仓库 Git 配置环境已发生变更',
      };
    }

    // 2. 核对分支与 HEAD OID
    const candidatesData = await getCommitCandidates(repoRoot, { projectId: ticket.projectId });
    if (candidatesData.branch !== ticket.branch) {
      return {
        valid: false,
        reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
        message: `当前分支已改变 (原: ${ticket.branch}, 现: ${candidatesData.branch})`,
      };
    }

    if (candidatesData.headOid !== ticket.headOid) {
      return {
        valid: false,
        reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
        message: '仓库 HEAD 已发生变化 (检测到新的提交或移动)',
      };
    }

    // 3. 核对真实索引指纹（未选暂存文件是否改变等）
    const currentIndexFingerprint = await getRealIndexFingerprint(gitDir);
    if (currentIndexFingerprint !== ticket.indexFingerprint) {
      return {
        valid: false,
        reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
        message: '仓库暂存区内容已发生变化，请重新预览',
      };
    }

    // 4. 核对选中工作树内容指纹与类型
    const currentWorktreeFingerprint = await computeWorktreeFingerprint(repoRoot, ticket.selectedFiles);
    if (currentWorktreeFingerprint !== ticket.worktreeFingerprint) {
      return {
        valid: false,
        reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
        message: '选中的文件内容在工作区已发生变动，请重新预览',
      };
    }

    // 5. 重新在隔离临时对象库和索引中计算 expectedTreeOid
    const tempId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const tempIndexFile = path.join(os.tmpdir(), `commit-verify-idx-${tempId}`);
    const tempObjDir = path.join(os.tmpdir(), `commit-verify-obj-${tempId}`);

    let recalculatedTreeOid = null;
    try {
      await fs.mkdir(path.join(tempObjDir, 'info'), { recursive: true });
      const realObjectsDir = path.resolve(commonDir, 'objects').replace(/\\/g, '/');
      await fs.writeFile(path.join(tempObjDir, 'info', 'alternates'), realObjectsDir + '\n', 'utf-8');

      const isoEnv = {
        GIT_INDEX_FILE: tempIndexFile,
        GIT_OBJECT_DIRECTORY: tempObjDir,
        GIT_DIR: gitDir,
        GIT_LITERAL_PATHSPECS: '1',
      };

      const readTreeRes = await runPreviewGit(['read-tree', ticket.headOid], {
        cwd: repoRoot,
        env: isoEnv,
      });
      if (readTreeRes.code !== 0) {
        return {
          valid: false,
          reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
          message: '重新构建预期树失败',
        };
      }

      const pathsToRemove = [];
      const pathsToAdd = [];

      for (const item of ticket.selectedFiles) {
        if (item.operationType === 'delete') {
          pathsToRemove.push(item.path);
        } else if (item.operationType === 'rename') {
          if (item.oldPath) pathsToRemove.push(item.oldPath);
          pathsToAdd.push(item.path);
        } else {
          pathsToAdd.push(item.path);
        }
      }

      if (pathsToRemove.length > 0) {
        const rmInput = Buffer.from(pathsToRemove.join('\0') + '\0', 'utf-8');
        const rmRes = await runPreviewGit(
          ['rm', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'],
          {
            cwd: repoRoot,
            env: isoEnv,
            stdin: rmInput,
          }
        );
        if (rmRes.code !== 0) {
          return {
            valid: false,
            reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
            message: '重新构建预期树失败',
          };
        }
      }

      if (pathsToAdd.length > 0) {
        const addInput = Buffer.from(pathsToAdd.join('\0') + '\0', 'utf-8');
        const addRes = await runPreviewGit(
          ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
          {
            cwd: repoRoot,
            env: isoEnv,
            stdin: addInput,
          }
        );
        if (addRes.code !== 0) {
          return {
            valid: false,
            reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
            message: '重新构建预期树失败',
          };
        }
      }

      const writeTreeRes = await runPreviewGit(['write-tree'], {
        cwd: repoRoot,
        env: isoEnv,
      });
      if (writeTreeRes.code === 0) {
        recalculatedTreeOid = writeTreeRes.stdout.toString('utf-8').trim();
      } else {
        return {
          valid: false,
          reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
          message: '重新构建预期树失败',
        };
      }
    } finally {
      await fs.rm(tempObjDir, { recursive: true, force: true }).catch(() => {});
      await fs.unlink(tempIndexFile).catch(() => {});
    }

    if (!recalculatedTreeOid || recalculatedTreeOid !== ticket.expectedTreeOid) {
      return {
        valid: false,
        reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
        message: '预期提交树重算不一致，请重新预览',
      };
    }

    return {
      valid: true,
      ticket,
    };
  } catch (err) {
    return {
      valid: false,
      reason: COMMIT_PREVIEW_ERRORS.PREVIEW_STALE,
      message: '重验过程中检测到状态不符合条件',
    };
  }
}
