import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { GitError } from './exec.js';
import {
  recalculateAndCompareCommitPreview,
  removeCommitPreviewTicket,
  assertRepositoryAndSecurity,
  COMMIT_PREVIEW_ERRORS,
} from './commit-preview.js';
import {
  acquireCommitLock,
  releaseCommitLock,
  saveCommitOperation,
  getCommitOperation,
  COMMIT_OPERATION_ERRORS,
} from './commit-operations.js';

const WRITE_GIT_TIMEOUT_MS = 15000; // 15 秒
const WRITE_GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB
const OPERATION_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export const COMMIT_WRITE_ERRORS = {
  PREVIEW_STALE: 'PREVIEW_STALE',
  REPOSITORY_BUSY: 'REPOSITORY_BUSY',
  OPERATION_INVALID: 'OPERATION_INVALID',
  COMMIT_PARTIAL: 'COMMIT_PARTIAL',
  COMMIT_UNKNOWN: 'COMMIT_UNKNOWN',
  COMMIT_FAILED: 'COMMIT_FAILED',
};

/**
 * 专用于本地提交写操作的 Git 执行器
 * 严格禁用 shell、终端交互、未受控环境变量
 * 绝不使用 add -A、commit -a、reset、restore、stash、clean、--no-verify，绝不静默关闭签名
 * @param {string[]} args 
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Buffer | string} [options.stdin]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxOutputBytes]
 * @returns {Promise<{ stdout: Buffer, stderr: Buffer, code: number }>}
 */
export async function runCommitWriteGit(args, options = {}) {
  const timeoutMs = options.timeoutMs || WRITE_GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes || WRITE_GIT_MAX_OUTPUT_BYTES;

  const gitArgs = [
    '--no-optional-locks',
    ...args,
  ];

  // 清洗环境变量：过滤外部任意继承的 GIT_*，仅注入受控变量
  const safeEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) {
      safeEnv[k] = v;
    }
  }

  safeEnv.GIT_TERMINAL_PROMPT = '0';
  safeEnv.GIT_OPTIONAL_LOCKS = '0';
  safeEnv.GIT_LITERAL_PATHSPECS = '1'; // 默认开启字面路径，杜绝通配符解释
  safeEnv.LC_ALL = 'C.UTF-8';
  safeEnv.LANG = 'C.UTF-8';

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
        reject(new GitError('GIT_WRITE_FAILED', '启动 Git 写命令失败', 500));
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
        reject(new GitError('GIT_WRITE_FAILED', 'Git 写入进程执行异常', 500));
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new GitError('GIT_TIMEOUT', `Git 写入命令执行超时 (超过 ${timeoutMs}ms)`, 500));
        return;
      }

      if (exceededLimit) {
        reject(new GitError('GIT_OUTPUT_LIMIT', `Git 输出超出 ${maxOutputBytes} 字节限制`, 500));
        return;
      }

      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });

    if (options.stdin !== undefined && options.stdin !== null) {
      child.stdin.end(options.stdin);
    }
  });
}

/**
 * 确认执行本地提交闭环
 * 必须遵守的铁律：
 * 1. 确认前重查所有事实，差异报 PREVIEW_STALE 且零写入；
 * 2. 同仓库互斥锁控制并发，防止双击或跨进程冲突；
 * 3. 幂等去重，已完成操作不重复提交；
 * 4. 在首个可能写操作前落盘 not_started 操作记录 (WAL)；
 * 5. 未跟踪精确 add，失败报 partial 且绝不隐式 reset / restore；
 * 6. 执行后检验真实 commit / tree / parent 事实，不盲从退出码 0。
 * @param {string} repositoryPath 
 * @param {object} params
 * @param {string} params.ticketId
 * @param {string} params.operationId
 * @param {object} [options]
 * @param {string} [options.operationsDir]
 * @returns {Promise<object>}
 */
export async function executeCommit(repositoryPath, params, options = {}) {
  const { ticketId, operationId } = params || {};

  // 1. 校验输入参数
  if (!operationId || typeof operationId !== 'string' || !OPERATION_ID_REGEX.test(operationId)) {
    throw new GitError(COMMIT_WRITE_ERRORS.OPERATION_INVALID, '缺少合法格式的 operationId', 400);
  }

  if (!ticketId || typeof ticketId !== 'string') {
    throw new GitError(COMMIT_WRITE_ERRORS.OPERATION_INVALID, '缺少合法的 ticketId', 400);
  }

  // 2. 幂等性与去重检查：查阅历史持久化操作记录
  const existingRecord = await getCommitOperation(operationId, options);
  if (existingRecord) {
    if (existingRecord.status === 'completed') {
      return {
        success: true,
        status: 'completed',
        operationId,
        commitOid: existingRecord.commitOid,
        treeOid: existingRecord.treeOidAfter,
        branch: existingRecord.branch,
        message: existingRecord.message,
        idempotent: true,
      };
    }
    if (existingRecord.status === 'partial') {
      return {
        success: false,
        status: 'partial',
        reason: COMMIT_WRITE_ERRORS.COMMIT_PARTIAL,
        message: existingRecord.userMessage || '选中的文件已暂存，但提交未完成，请检查后重新提交',
        operationId,
      };
    }
    if (existingRecord.status === 'unknown') {
      return {
        success: false,
        status: 'unknown',
        reason: COMMIT_WRITE_ERRORS.COMMIT_UNKNOWN,
        message: existingRecord.userMessage || '提交状态未知，请先在 Git 中核对仓库状态',
        operationId,
      };
    }
  }

  // 3. 校验并获取仓库真实根与身份
  const { repoRoot, commonDir } = await assertRepositoryAndSecurity(repositoryPath);
  const resolvedCommonDir = path.resolve(repoRoot, commonDir);

  // 4. 获取同仓库排他互斥锁
  await acquireCommitLock(resolvedCommonDir, { operationId }, options);

  try {
    // 5. 确认前只读重验（T01 契约）：重验仓库身份、HEAD、真实索引指纹、选中物理内容/类型、配置门槛
    const verifyResult = await recalculateAndCompareCommitPreview(ticketId);
    if (!verifyResult.valid) {
      return {
        success: false,
        status: 'stale',
        reason: COMMIT_WRITE_ERRORS.PREVIEW_STALE,
        message: verifyResult.message || '提交预览已陈旧，仓库状态已改变，请重新预览',
      };
    }

    const ticket = verifyResult.ticket;
    const { headOid, expectedTreeOid, branch, message, selectedFiles } = ticket;

    // 6. WAL 初始记录原子落盘（在第一个可能写操作之前）
    let opRecord = {
      operationId,
      projectId: ticket.projectId,
      repoRoot,
      commonDir: resolvedCommonDir,
      branch,
      headOidBefore: headOid,
      expectedTreeOid,
      message,
      selectedFiles,
      status: 'not_started',
    };
    await saveCommitOperation(opRecord, options);

    // 7. 处理未跟踪文件：必须先对精确选中的未跟踪文件执行精确 git add
    const untrackedPaths = [];
    for (const item of selectedFiles) {
      if (item.stageScope === 'untracked' || item.operationType === 'add') {
        untrackedPaths.push(item.path);
      }
    }

    const stagedFiles = [];
    if (untrackedPaths.length > 0) {
      const addInput = Buffer.from(untrackedPaths.join('\0') + '\0', 'utf-8');
      const addRes = await runCommitWriteGit(
        ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { cwd: repoRoot, stdin: addInput }
      );

      if (addRes.code !== 0) {
        opRecord.status = 'failed';
        opRecord.errorReason = 'UNTRACKED_ADD_FAILED';
        opRecord.userMessage = '暂存选中的未跟踪文件失败';
        await saveCommitOperation(opRecord, options);
        return {
          success: false,
          status: 'failed',
          reason: COMMIT_WRITE_ERRORS.COMMIT_FAILED,
          message: '暂存选中的未跟踪文件失败',
        };
      }

      // 精确 add 成功，记录已暂存文件
      stagedFiles.push(...untrackedPaths);
      opRecord.stagedFiles = stagedFiles;
      await saveCommitOperation(opRecord, options);
    }

    // 8. 执行核心提交命令：commit --only (支持故障注入测试)
    const allSelectedPaths = [];
    for (const item of selectedFiles) {
      if (item.operationType === 'rename' && item.oldPath) {
        allSelectedPaths.push(item.oldPath);
      }
      allSelectedPaths.push(item.path);
    }

    const commitInput = Buffer.from(allSelectedPaths.join('\0') + '\0', 'utf-8');
    let commitRes;
    if (options._faultInjection && options._faultInjection.failCommit) {
      commitRes = { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('simulated commit failure') };
    } else {
      commitRes = await runCommitWriteGit(
        ['commit', '--only', '--pathspec-from-file=-', '--pathspec-file-nul', '-m', message],
        { cwd: repoRoot, stdin: commitInput }
      );
    }

    // 9. 检验真实磁盘与 Git 事实（绝不只靠退出码 0）
    let currentHeadOid = null;
    let currentParentOid = null;
    let currentTreeOid = null;

    try {
      const headRes = await runCommitWriteGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
      if (headRes.code === 0) currentHeadOid = headRes.stdout.toString('utf-8').trim();

      const parentRes = await runCommitWriteGit(['rev-parse', 'HEAD^'], { cwd: repoRoot });
      if (parentRes.code === 0) currentParentOid = parentRes.stdout.toString('utf-8').trim();

      const treeRes = await runCommitWriteGit(['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot });
      if (treeRes.code === 0) currentTreeOid = treeRes.stdout.toString('utf-8').trim();
    } catch {
      // 容错读取
    }

    const commitVerified =
      currentHeadOid &&
      currentHeadOid !== headOid &&
      currentParentOid === headOid &&
      currentTreeOid === expectedTreeOid;

    if (commitVerified) {
      // 成功：落盘 completed 记录，清理已消费票据
      opRecord.status = 'completed';
      opRecord.headOidAfter = currentHeadOid;
      opRecord.treeOidAfter = currentTreeOid;
      opRecord.commitOid = currentHeadOid;
      await saveCommitOperation(opRecord, options);

      removeCommitPreviewTicket(ticketId);

      return {
        success: true,
        status: 'completed',
        operationId,
        commitOid: currentHeadOid,
        treeOid: currentTreeOid,
        branch,
        message,
      };
    }

    // 10. 若未通过检验，判定具体异常状态
    if (stagedFiles.length > 0) {
      // 精确 add 成功了，但 commit 未完成：绝不隐式回滚！保留实际状态，报 partial
      opRecord.status = 'partial';
      opRecord.errorReason = 'COMMIT_FAILED_AFTER_STAGING';
      opRecord.userMessage = '部分完成：选中的未跟踪文件已暂存，但提交未完成，请检查后重新提交';
      await saveCommitOperation(opRecord, options);

      return {
        success: false,
        status: 'partial',
        reason: COMMIT_WRITE_ERRORS.COMMIT_PARTIAL,
        message: '部分完成：选中的文件已暂存，但提交未完成，请检查后重新提交',
        operationId,
      };
    }

    if (commitRes.code !== 0) {
      opRecord.status = 'failed';
      opRecord.errorReason = 'COMMIT_COMMAND_FAILED';
      opRecord.userMessage = '提交命令执行失败';
      await saveCommitOperation(opRecord, options);

      return {
        success: false,
        status: 'failed',
        reason: COMMIT_WRITE_ERRORS.COMMIT_FAILED,
        message: '提交命令执行失败',
      };
    }

    // 退出码为 0 但 tree 不符合预期的未知异常
    opRecord.status = 'unknown';
    opRecord.errorReason = 'TREE_MISMATCH_OR_UNKNOWN';
    opRecord.userMessage = '提交结果未知：最终提交树与预期树不符，请先在 Git 中核实';
    await saveCommitOperation(opRecord, options);

    return {
      success: false,
      status: 'unknown',
      reason: COMMIT_WRITE_ERRORS.COMMIT_UNKNOWN,
      message: '提交结果未知：最终提交树与预期树不符，请先在 Git 中核实',
      operationId,
    };
  } finally {
    // 始终释放互斥锁
    await releaseCommitLock(resolvedCommonDir, { operationId }, options);
  }
}
