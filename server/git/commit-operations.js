import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { GitError } from './exec.js';

export const COMMIT_OPERATION_ERRORS = {
  REPOSITORY_BUSY: 'REPOSITORY_BUSY',
  OPERATION_INVALID: 'OPERATION_INVALID',
  OPERATION_NOT_FOUND: 'OPERATION_NOT_FOUND',
  LOCK_RELEASE_MISMATCH: 'LOCK_RELEASE_MISMATCH',
};

const DEFAULT_LOCK_TTL_MS = 30000; // 30 秒
const MAX_SAVED_OPERATIONS = 100;
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 获取提交操作数据的持久化根目录
 * 支持通过 options.operationsDir 注入，方便隔离测试
 * @param {object} [options] 
 * @returns {string}
 */
export function getOperationsDir(options = {}) {
  if (options.operationsDir && typeof options.operationsDir === 'string') {
    return path.resolve(options.operationsDir);
  }
  return path.resolve(process.cwd(), '.local', 'commit-operations');
}

/**
 * 计算仓库的规范化 Key 哈希
 * @param {string} repoIdentifier 
 * @returns {string}
 */
export function getRepoKeyHash(repoIdentifier) {
  const normalized = path.resolve(repoIdentifier).toLowerCase().replace(/\\/g, '/');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * 获取仓库排他互斥锁
 * 同一仓库内部只允许单个写操作进行，跨标签页和跨进程互斥
 * 具备锁超时和崩溃死锁自愈机制，绝不误删其他活动进程的未超时锁
 * @param {string} repoIdentifier 仓库工作树根或 common-dir
 * @param {object} params
 * @param {string} params.operationId
 * @param {number} [params.ttlMs]
 * @param {object} [options]
 */
export async function acquireCommitLock(repoIdentifier, params, options = {}) {
  const { operationId, ttlMs = DEFAULT_LOCK_TTL_MS } = params || {};
  if (!operationId || typeof operationId !== 'string') {
    throw new GitError(COMMIT_OPERATION_ERRORS.OPERATION_INVALID, '缺少合法的操作 ID', 400);
  }

  const baseDir = getOperationsDir(options);
  const locksDir = path.join(baseDir, 'locks');
  await fs.mkdir(locksDir, { recursive: true });

  const repoHash = getRepoKeyHash(repoIdentifier);
  const lockFile = path.join(locksDir, `${repoHash}.lock`);

  const lockContent = JSON.stringify({
    repoIdentifier,
    operationId,
    pid: process.pid,
    createdAt: Date.now(),
    ttlMs,
  });

  let acquired = false;
  let attempts = 0;

  while (!acquired && attempts < 3) {
    attempts++;
    let handle = null;
    try {
      handle = await fs.open(lockFile, 'wx');
      await handle.writeFile(lockContent, 'utf-8');
      await handle.sync();
      await handle.close();
      acquired = true;
      return { acquired: true, lockFile };
    } catch (err) {
      if (handle) {
        try { await handle.close(); } catch {}
      }

      if (err.code === 'EEXIST') {
        // 检查已有锁是否过期或进程已死亡
        let existingLock = null;
        try {
          const raw = await fs.readFile(lockFile, 'utf-8');
          existingLock = JSON.parse(raw);
        } catch {
          // 锁文件为空或正在写入，稍等下一轮
          existingLock = null;
        }

        if (existingLock && existingLock.createdAt) {
          const age = Date.now() - existingLock.createdAt;
          let processAlive = false;

          if (existingLock.pid) {
            try {
              // 探测持有锁的进程是否仍在运行
              process.kill(existingLock.pid, 0);
              processAlive = true;
            } catch (e) {
              if (e.code === 'ESRCH') {
                processAlive = false;
              } else {
                processAlive = true; // 无权限探测视为存活
              }
            }
          }

          // 如果进程已死，或者锁已经超时
          if (!processAlive || age > existingLock.ttlMs) {
            // 安全覆盖接管陈旧锁
            try {
              await fs.unlink(lockFile);
              continue; // 下一轮重新 wx 获取
            } catch {
              // 可能已被其他进程删除或重试接管
              continue;
            }
          } else {
            // 锁仍在有效期内且进程存活，拒绝并报 REPOSITORY_BUSY
            throw new GitError(
              COMMIT_OPERATION_ERRORS.REPOSITORY_BUSY,
              '仓库当前正在执行其他提交操作，请稍候再试',
              409
            );
          }
        }

        // 短暂休眠 100ms 重试
        await new Promise((r) => setTimeout(r, 100));
      } else {
        throw new GitError('LOCK_FAILED', `创建仓库锁文件失败: ${err.message}`, 500);
      }
    }
  }

  throw new GitError(
    COMMIT_OPERATION_ERRORS.REPOSITORY_BUSY,
    '仓库当前正在执行其他提交操作，请稍候再试',
    409
  );
}

/**
 * 释放仓库排他互斥锁
 * 严格核对锁内 operationId，绝不误删其他调用者获得的新锁
 * @param {string} repoIdentifier 
 * @param {object} params
 * @param {string} params.operationId
 * @param {object} [options]
 */
export async function releaseCommitLock(repoIdentifier, params, options = {}) {
  const { operationId } = params || {};
  if (!operationId) return;

  const baseDir = getOperationsDir(options);
  const repoHash = getRepoKeyHash(repoIdentifier);
  const lockFile = path.join(baseDir, 'locks', `${repoHash}.lock`);

  try {
    const raw = await fs.readFile(lockFile, 'utf-8');
    const existing = JSON.parse(raw);
    if (existing && existing.operationId === operationId) {
      await fs.unlink(lockFile);
    }
  } catch {
    // 锁文件已被清理或不存在，忽略
  }
}

/**
 * 持久化写入提交操作记录 (WAL)
 * 使用原子替换 (fs.rename) 和 fsync，保证落盘一致性
 * @param {object} operation 
 * @param {object} [options]
 */
export async function saveCommitOperation(operation, options = {}) {
  if (!operation || !operation.operationId) {
    throw new GitError(COMMIT_OPERATION_ERRORS.OPERATION_INVALID, '无效的提交操作记录', 400);
  }

  const baseDir = getOperationsDir(options);
  const recordsDir = path.join(baseDir, 'records');
  await fs.mkdir(recordsDir, { recursive: true });

  const targetFile = path.join(recordsDir, `${operation.operationId}.json`);
  const tempFile = path.join(
    recordsDir,
    `${operation.operationId}.tmp.${crypto.randomBytes(6).toString('hex')}`
  );

  const cleanOperation = {
    operationId: operation.operationId,
    projectId: operation.projectId || 'default',
    repoRoot: operation.repoRoot,
    commonDir: operation.commonDir,
    branch: operation.branch,
    headOidBefore: operation.headOidBefore,
    headOidAfter: operation.headOidAfter || null,
    expectedTreeOid: operation.expectedTreeOid,
    treeOidAfter: operation.treeOidAfter || null,
    commitOid: operation.commitOid || null,
    message: operation.message,
    status: operation.status || 'not_started', // not_started | completed | partial | unknown | failed
    selectedFiles: operation.selectedFiles || [],
    stagedFiles: operation.stagedFiles || [],
    errorReason: operation.errorReason || null,
    userMessage: operation.userMessage || null,
    createdAt: operation.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  const payload = JSON.stringify(cleanOperation, null, 2);

  const handle = await fs.open(tempFile, 'w');
  try {
    await handle.writeFile(payload, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(tempFile, targetFile);
  return cleanOperation;
}

/**
 * 查询已持久化的提交操作记录
 * @param {string} operationId 
 * @param {object} [options]
 * @returns {Promise<object | null>}
 */
export async function getCommitOperation(operationId, options = {}) {
  if (!operationId || typeof operationId !== 'string') return null;

  const baseDir = getOperationsDir(options);
  const targetFile = path.join(baseDir, 'records', `${operationId}.json`);

  try {
    const raw = await fs.readFile(targetFile, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * 清理过期的操作记录与孤立锁文件
 * 限制最大保留数量，防止无界占用磁盘空间
 * @param {object} [options]
 */
export async function pruneOldOperations(options = {}) {
  const baseDir = getOperationsDir(options);
  const recordsDir = path.join(baseDir, 'records');
  const locksDir = path.join(baseDir, 'locks');

  // 1. 清理孤立/超时的锁
  if (fsSync.existsSync(locksDir)) {
    try {
      const lockFiles = await fs.readdir(locksDir);
      for (const lf of lockFiles) {
        if (!lf.endsWith('.lock')) continue;
        const full = path.join(locksDir, lf);
        try {
          const stat = await fs.stat(full);
          if (Date.now() - stat.mtimeMs > DEFAULT_LOCK_TTL_MS * 2) {
            await fs.unlink(full);
          }
        } catch {}
      }
    } catch {}
  }

  // 2. 清理超过保留期或超出数量限制的操作记录
  if (fsSync.existsSync(recordsDir)) {
    try {
      const files = await fs.readdir(recordsDir);
      const records = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const full = path.join(recordsDir, f);
        try {
          const stat = await fs.stat(full);
          records.push({ file: full, mtimeMs: stat.mtimeMs });
        } catch {}
      }

      records.sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (let i = 0; i < records.length; i++) {
        const item = records[i];
        const isOld = Date.now() - item.mtimeMs > OPERATION_RETENTION_MS;
        const isOverLimit = i >= MAX_SAVED_OPERATIONS;
        if (isOld || isOverLimit) {
          await fs.unlink(item.file).catch(() => {});
        }
      }
    } catch {}
  }
}
