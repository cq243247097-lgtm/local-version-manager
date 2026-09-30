import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

const DEFAULT_GIT_TIMEOUT_MS = 10000; // 10 秒
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB

export class GitError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * 检查路径是否存在且为目录
 * @param {string} dirPath 
 */
export async function assertDirectoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      throw new GitError('PATH_UNAVAILABLE', '指定路径不是一个有效的目录', 400);
    }
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw new GitError('PATH_UNAVAILABLE', '指定目录不存在或无法访问', 400);
  }
}

/**
 * 安全执行 Git CLI 只读命令
 * @param {string[]} args 
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxOutputBytes]
 * @returns {Promise<Buffer>}
 */
export async function runGit(args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_GIT_MAX_OUTPUT_BYTES;

  if (options.cwd) {
    try {
      const stat = await fs.stat(options.cwd);
      if (!stat.isDirectory()) {
        throw new GitError('PATH_UNAVAILABLE', '指定的工作目录不是有效目录', 400);
      }
    } catch (err) {
      if (err instanceof GitError) throw err;
      throw new GitError('PATH_UNAVAILABLE', '指定的工作目录不存在', 400);
    }
  }

  // 严格禁用终端交互提示、外部 diff、hooks、可选锁、fsmonitor 等外部脚本
  const gitArgs = [
    '-c', 'diff.external=',
    '-c', 'diff.renames=true',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.useBuiltinFSMonitor=false',
    '-c', 'core.hooksPath=',
    '--no-optional-locks',
    ...args,
  ];

  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', gitArgs, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        reject(new GitError('GIT_UNAVAILABLE', '系统未找到已安装的 Git 命令行工具', 500));
      } else {
        reject(new GitError('GIT_READ_FAILED', `启动 Git 命令失败: ${err.message}`, 500));
      }
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    let timedOut = false;
    let exceededLimit = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // 容错兜底，若未能在 500ms 内退出则强杀
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
        reject(new GitError('GIT_READ_FAILED', `Git 进程异常: ${err.message}`, 500));
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new GitError('GIT_TIMEOUT', `Git 命令执行超时 (超过 ${timeoutMs}ms)`, 500));
        return;
      }

      if (exceededLimit) {
        reject(new GitError('GIT_OUTPUT_LIMIT', `Git 输出超出 ${maxOutputBytes} 字节限制`, 500));
        return;
      }

      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrStr = Buffer.concat(stderrChunks).toString('utf-8');

      if (code === 0) {
        resolve(stdoutBuf);
        return;
      }

      // 分析 stderr 错误信息并映射到规范的错误码
      if (stderrStr.includes('detected dubious ownership in repository')) {
        reject(new GitError('GIT_UNSAFE_DIRECTORY', 'Git 检测到不安全的仓库目录所有权', 403));
        return;
      }

      if (
        stderrStr.includes('not a git repository') ||
        stderrStr.includes('Must be started from the root of the work tree') ||
        stderrStr.includes('this operation must be run in a work tree')
      ) {
        reject(new GitError('NOT_REPOSITORY', '指定目录不是一个有效的 Git 仓库或工作树', 400));
        return;
      }

      reject(new GitError('GIT_READ_FAILED', `Git 命令执行失败 (退出码 ${code})`, 500));
    });
  });
}
