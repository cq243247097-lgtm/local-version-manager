import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { GitError } from './exec.js';
import { loadProjectsConfig } from '../config.js';
import {
  recalculateAndCompareCommitPreview, getCommitPreviewTicket,
  removeCommitPreviewTicket, assertRepositoryAndSecurity,
  runPreviewGit, getRealIndexFingerprint, computeWorktreeFingerprint,
} from './commit-preview.js';
import {
  acquireCommitLock, releaseCommitLock, saveCommitOperation,
  getCommitOperation, listCommitOperations, getOperationsDir, assertOperationId,
} from './commit-operations.js';
const WRITE_GIT_TIMEOUT_MS = 15000;
const WRITE_GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const COMMIT_WRITE_ERRORS = {
  PREVIEW_STALE: 'PREVIEW_STALE', REPOSITORY_BUSY: 'REPOSITORY_BUSY',
  OPERATION_INVALID: 'OPERATION_INVALID', COMMIT_PARTIAL: 'COMMIT_PARTIAL',
  COMMIT_UNKNOWN: 'COMMIT_UNKNOWN', COMMIT_FAILED: 'COMMIT_FAILED',
};
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const invalid = () => new GitError('OPERATION_INVALID', '项目、仓库、票据或操作身份不匹配', 409);
export async function runCommitWriteGit(args, options = {}) {
  if (typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)) {
    throw new GitError('OPERATION_INVALID', 'Git 写入必须明确指定仓库目录', 400);
  }
  const timeoutMs = options.timeoutMs || WRITE_GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes || WRITE_GIT_MAX_OUTPUT_BYTES;

  const gitArgs = [
    '--no-optional-locks',
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
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
      child = (options._spawnForTest || spawn)('git', gitArgs, {
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

    let killTimer;
    let processError;
    let terminating = false;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      try { child.kill('SIGTERM'); } catch (error) { processError = error; }
      killTimer ??= setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 100);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        exceededLimit = true;
        terminate();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        exceededLimit = true;
        terminate();
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      if (child.pid) {
        // An error after spawn is not proof the child exited. Reap it before
        // allowing reconciliation to classify unchanged state as not_started.
        processError = err;
        terminate();
        return;
      }
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new GitError(err.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_WRITE_FAILED', '无法启动 Git 写入进程', 500));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);

      if (timedOut) {
        reject(new GitError('GIT_TIMEOUT', `Git 写入命令执行超时 (超过 ${timeoutMs}ms)`, 500));
        return;
      }

      if (exceededLimit) {
        reject(new GitError('GIT_OUTPUT_LIMIT', `Git 输出超出 ${maxOutputBytes} 字节限制`, 500));
        return;
      }

      if (processError) {
        reject(new GitError('GIT_WRITE_FAILED', 'Git 写入进程执行异常', 500));
        return;
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });

    if (options.stdin !== undefined && options.stdin !== null) {
      // EPIPE after an early Git exit is handled by the close result, never
      // an unhandled stream error that bypasses disk reconciliation.
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin);
    }
  });
}

async function readGit(repoRoot, args) {
  const result = await runPreviewGit(args, { cwd: repoRoot });
  if (result.code !== 0) throw new GitError('COMMIT_UNKNOWN', '无法核对提交事实，请先在 Git 中核对', 409);
  return result.stdout;
}
// Resolve existing ancestors too, so a symlinked injected store cannot escape
// the configured data boundary into the managed worktree or .git directory.
async function realLocation(value) {
  try { return await fs.realpath(value); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const parent = path.dirname(value);
    if (parent === value) throw e;
    return path.join(await realLocation(parent), path.basename(value));
  }
}
const within = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
async function repositoryIdentity(repositoryPath) {
  const repoRoot = await fs.realpath(repositoryPath);
  const top = await fs.realpath((await readGit(repoRoot, ['rev-parse', '--show-toplevel'])).toString().trim());
  if (repoRoot !== top) throw invalid();
  const gitDir = await fs.realpath(path.resolve(repoRoot, (await readGit(repoRoot, ['rev-parse', '--git-dir'])).toString().trim()));
  const commonDir = await fs.realpath(path.resolve(repoRoot, (await readGit(repoRoot, ['rev-parse', '--git-common-dir'])).toString().trim()));
  const facts = [];
  for (const p of [repoRoot, gitDir, commonDir]) {
    const stat = await fs.stat(p);
    facts.push([p, String(stat.dev), String(stat.ino)]);
  }
  return { repoRoot, gitDir, commonDir, hash: digest(JSON.stringify(facts)), commonIdentity: digest(JSON.stringify(facts[2])) };
}
async function resolveProject(projectId, options) {
  try {
  if (typeof projectId !== 'string' || typeof options.configPath !== 'string' || !path.isAbsolute(options.configPath)) throw invalid();
  const config = await loadProjectsConfig(options.configPath);
  const project = config.projectMap.get(projectId);
  if (!project) throw new GitError('PROJECT_NOT_FOUND', '未找到已登记的项目', 404);
  const identity = await repositoryIdentity(project.repositoryPath);
  const operationsDir = await realLocation(getOperationsDir(options));
  if ([identity.repoRoot, identity.gitDir, identity.commonDir].some((p) => within(operationsDir, p))) throw invalid();
  return { ...identity, operationsDir, projectId };
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError('PATH_UNAVAILABLE', '无法安全定位已登记项目或操作目录', 409);
  }
}
// add/commit can trigger these hooks in addition to T01's commit hooks.
async function assertWriteSafety(identity) {
  await assertRepositoryAndSecurity(identity.repoRoot);
  for (const dir of new Set([identity.gitDir, identity.commonDir])) {
    for (const hook of ['post-index-change', 'reference-transaction']) {
      try {
        await fs.lstat(path.join(dir, 'hooks', hook));
        throw new GitError('HOOKS_UNSUPPORTED', '当前仓库存在写入钩子，首版不支持自动运行', 409);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
function ticketSummary(ticket) {
  return digest(JSON.stringify({ projectId: ticket.projectId, branch: ticket.branch,
    headOid: ticket.headOid, expectedTreeOid: ticket.expectedTreeOid,
    indexFingerprint: ticket.indexFingerprint, worktreeFingerprint: ticket.worktreeFingerprint,
    selectedFiles: ticket.selectedFiles, message: ticket.message }));
}
function selectedPaths(files) { return [...new Set(files.flatMap((f) => f.oldPath ? [f.oldPath, f.path] : [f.path]))]; }
function parseDetailedIndex(buffer) {
  const entries = new Map();
  const entryFlags = new Map();
  const raw = buffer.toString('utf8');
  let offset = 0;
  // --debug is Git's documented human diagnostic format, not a stable wire
  // protocol. Parse the entire known structure and fail closed if it changes.
  // NUL terminates each pathname; embedded tabs/newlines in names stay literal.
  const metadata = /^  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: ([0-9a-fA-F]+)\n/;
  while (offset < raw.length) {
    const end = raw.indexOf('\0', offset);
    if (end < 0) throw invalid();
    const entry = raw.slice(offset, end);
    const tab = entry.indexOf('\t');
    if (tab < 0 || !/^\d{6} [a-f0-9]{40,64} [0-3]$/.test(entry.slice(0, tab))) throw invalid();
    const name = entry.slice(tab + 1);
    const match = metadata.exec(raw.slice(end + 1));
    if (!match) throw invalid();
    const flags = Number.parseInt(match[1], 16);
    if (!Number.isSafeInteger(flags) || flags > 0xffffffff) throw invalid();
    entries.set(name, [...(entries.get(name) || []), entry.slice(0, tab)]);
    entryFlags.set(name, [...(entryFlags.get(name) || []), flags]);
    offset = end + 1 + match[0].length;
  }
  return { entries, entryFlags };
}
function entriesHash(entries, flags, entryFlags, excluded = new Set()) {
  return digest(JSON.stringify([...entries].filter(([p]) => !excluded.has(p)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([p, value]) => [p, value, flags.get(p), entryFlags.get(p)])));
}

async function readIndex(identity, files, addPaths) {
  const rawBefore = await getRealIndexFingerprint(identity.gitDir);
  const { entries, entryFlags } = parseDetailedIndex(await readGit(identity.repoRoot, ['ls-files', '--stage', '--debug', '-z']));
  const flags = new Map((await readGit(identity.repoRoot, ['ls-files', '-v', '-z'])).toString().split('\0').filter(Boolean).map((r) => [r.slice(2), r[0]]));
  const rawAfter = await getRealIndexFingerprint(identity.gitDir);
  if (rawBefore !== rawAfter) throw invalid();
  const selected = new Set(selectedPaths(files));
  const selectedEntries = Object.fromEntries([...selected].map((p) => [p, digest(JSON.stringify([entries.get(p) || [], flags.get(p) || null, entryFlags.get(p) || []]))]));
  return { raw: rawAfter, all: entriesHash(entries, flags, entryFlags), unselected: entriesHash(entries, flags, entryFlags, selected),
    exceptAdd: entriesHash(entries, flags, entryFlags, new Set(addPaths)), selectedEntries, entries, flags, entryFlags };
}
function indexSummary(index) {
  const { raw, all, unselected, exceptAdd, selectedEntries } = index;
  return { format: 'git-index-flags-v1', raw, all, unselected, exceptAdd, selectedEntries };
}
async function captureFacts(identity, record) {
  const head = (await readGit(identity.repoRoot, ['rev-parse', 'HEAD'])).toString().trim();
  const branch = (await readGit(identity.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toString().trim();
  // Pin to the captured object, never mix HEAD and HEAD^ from different instants.
  const object = (await readGit(identity.repoRoot, ['cat-file', '-p', head])).toString();
  const headers = object.split('\n\n', 1)[0].split('\n');
  const tree = headers.find((l) => l.startsWith('tree '))?.slice(5);
  const parents = headers.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));
  const index = await readIndex(identity, record.selectedFiles, record.addPaths);
  const treeEntries = new Map();
  for (const raw of (await readGit(identity.repoRoot, ['ls-tree', '-r', '-z', head])).toString().split('\0').filter(Boolean)) {
    const tab = raw.indexOf('\t');
    const [mode, , oid] = raw.slice(0, tab).split(' ');
    treeEntries.set(raw.slice(tab + 1), `${mode} ${oid} 0`);
  }
  if ((await readGit(identity.repoRoot, ['rev-parse', 'HEAD'])).toString().trim() !== head ||
      (await readGit(identity.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toString().trim() !== branch ||
      await getRealIndexFingerprint(identity.gitDir) !== index.raw) throw invalid();
  return { head, branch, tree, parents, index, treeEntries };
}
function isRepositoryRelativePath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0') || path.isAbsolute(name)) return false;
  // Git paths follow the server filesystem. Colon/backslash are literal POSIX
  // filename characters; only Windows treats them as drive/separator syntax.
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(name)) return false;
  const parts = name.split(process.platform === 'win32' ? /[\\/]/ : '/');
  return !parts.some((part) => part === '..' || part === '.');
}
function resultOf(record, extra = {}) {
  let status = record.status;
  let provenStagedFiles = null;
  if (status === 'partial') {
    // Never silently filter a proven delta down to a misleading incomplete list.
    // Unexpected invalid evidence becomes unknown, with no old paths exposed.
    if (record.verified === true && Array.isArray(record.stagedFiles) && record.stagedFiles.length > 0 &&
        record.stagedFiles.every((name) => isRepositoryRelativePath(name) && record.addPaths?.includes(name))) {
      provenStagedFiles = [...record.stagedFiles];
    } else { status = 'unknown'; }
  }
  const messages = {
    completed: '本地提交已完成，并已核对提交树和暂存区保护',
    partial: '部分完成：HEAD 未改变，但选中文件已暂存；请先核对，勿自动重复提交',
    not_started: '未检测到提交或暂存变化；此操作 ID 只可查询，请重新预览后使用新操作 ID',
    unknown: '提交状态未能确认，请先在 Git 中核对；禁止自动重复提交',
  };
  return { success: status === 'completed', status, operationId: record.operationId,
    persistenceGuarantee: 'service-process-crash-only',
    reason: status === 'completed' ? undefined : status === 'partial' ? 'COMMIT_PARTIAL' : status === 'not_started' ? 'COMMIT_FAILED' : 'COMMIT_UNKNOWN',
    commitOid: record.commitOid || null, treeOid: record.treeOidAfter || null,
    branch: record.branch, message: status === 'completed' ? record.message : messages[status],
    indexChange: record.indexChange || 'unknown',
    ...(provenStagedFiles ? { stagedFiles: provenStagedFiles } : {}), ...extra };
}
async function reconcile(identity, record, { settled = false } = {}) {
  const output = { ...record, status: 'unknown', verified: false, indexChange: 'unknown', commitOid: null };
  try {
    const facts = await captureFacts(identity, record);
    output.headOidAfter = facts.head;
    output.treeOidAfter = facts.tree;
    output.indexAfter = indexSummary(facts.index);
    if (record.indexBefore?.format !== 'git-index-flags-v1' || facts.branch !== record.branch) return output;
    const indexUnchanged = facts.index.all === record.indexBefore.all;
    const unselectedSafe = facts.index.unselected === record.indexBefore.unselected;
    output.indexChange = indexUnchanged ? (facts.index.raw === record.indexBefore.raw ? 'unchanged' : 'metadata_only') : unselectedSafe ? 'selected_only' : 'unselected_changed';
    const selectedMatchTree = selectedPaths(record.selectedFiles).every((p) => {
      const expected = facts.treeEntries.get(p);
      const actual = facts.index.entries.get(p) || [];
      return expected ? actual.length === 1 && actual[0] === expected && facts.index.flags.get(p) === 'H' && facts.index.entryFlags.get(p)?.every((flags) => flags === 0) : actual.length === 0;
    });
    if (facts.head !== record.headOidBefore && facts.parents.length === 1 && facts.parents[0] === record.headOidBefore &&
        facts.tree === record.expectedTreeOid && unselectedSafe && selectedMatchTree) {
      output.status = 'completed'; output.commitOid = facts.head; output.verified = true;
    } else if (facts.head === record.headOidBefore && (settled || record.phase === 'prepared' || record.phase === 'settled')) {
      if (indexUnchanged) { output.status = 'not_started'; output.verified = true; }
      else if (unselectedSafe && facts.index.exceptAdd === record.indexBefore.exceptAdd && record.addPaths.length > 0) {
        const changed = record.addPaths.filter((p) => facts.index.selectedEntries[p] !== record.indexBefore.selectedEntries[p]);
        if (changed.length && changed.every((p) => facts.index.entries.get(p)?.length === 1 && facts.index.entries.get(p)[0].endsWith(' 0'))) {
          output.status = 'partial'; output.stagedFiles = changed; output.verified = true;
        }
      }
    }
  } catch { /* An unreadable/incoherent observation never proves failure. */ }
  if (settled || (record.phase === 'prepared' && output.status === 'not_started')) output.phase = 'settled';
  return output;
}
async function persistResult(record, options) {
  try { return { record: await saveCommitOperation(record, options), durable: true }; }
  catch {
    // A final append can fail even after its complete frame was written. Re-read without replay. The
    // pre-write durable armed phase survives a crash and fences new operations.
    try {
      const disk = await getCommitOperation(record.operationId, options);
      if (disk?.status === record.status && disk?.headOidAfter === record.headOidAfter && disk?.indexAfter?.all === record.indexAfter?.all) {
        // Still don't promise file fsync if the append failed before acknowledgement.
        return { record, durable: false };
      }
    } catch {}
    return { record, durable: false };
  }
}
async function existingResult(identity, record, ticketId, options, readOnly = false) {
  if (record.retired) return resultOf({ ...record, status: 'unknown' }, { idempotent: true, retired: true });
  if (record.projectId !== identity.projectId || record.repositoryIdentity !== identity.hash || (ticketId !== undefined && record.ticketDigest !== digest(ticketId))) throw invalid();
  if (record.status === 'completed' && record.verified && record.commitOid &&
      record.indexBefore?.format === 'git-index-flags-v1' && record.indexAfter?.format === 'git-index-flags-v1') {
    // Historical completed result remains meaningful after later work. Verify
    // its immutable object, not today's unrelated HEAD/index.
    try {
      const object = (await readGit(identity.repoRoot, ['cat-file', '-p', record.commitOid])).toString().split('\n\n', 1)[0].split('\n');
      if (object.filter((l) => l.startsWith('parent ')).join('\n') === `parent ${record.headOidBefore}` &&
          object.includes(`tree ${record.expectedTreeOid}`) && record.indexAfter?.unselected === record.indexBefore?.unselected) return resultOf(record, { idempotent: true });
    } catch {}
  }
  const recovered = await reconcile(identity, record);
  const saved = readOnly ? { record: recovered, durable: false } : await persistResult(recovered, options);
  return resultOf(saved.record, { idempotent: true, durable: saved.durable });
}

/** Read-only result route boundary: no locks, preview tickets or record writes. */
export async function queryCommitOperation(projectId, operationId, options = {}) {
  assertOperationId(operationId);
  const identity = await resolveProject(projectId, options);
  const record = await getCommitOperation(operationId, { ...options, operationsDir: identity.operationsDir });
  if (!record) throw new GitError('OPERATION_NOT_FOUND', '未找到该提交操作', 404);
  return existingResult(identity, record, undefined, options, true);
}

/**
 * Trusted server API, not a request-body options bag. Resolve the registered
 * project afresh from absolute configPath; caller supplies only ticket/op ID.
 * Any existing ID is query/recovery-only, even after a failed/expired ticket.
 */
export async function executeCommit(projectId, params, options = {}) {
  assertOperationId(params?.operationId);
  const { operationId, ticketId } = params;
  if (typeof ticketId !== 'string' || !/^[a-f0-9]{64}$/.test(ticketId)) throw invalid();
  let identity = await resolveProject(projectId, options);
  options = { ...options, operationsDir: identity.operationsDir };
  // Global ID lock prevents equal IDs in different repositories from racing to
  // overwrite one durable reservation. Always ID -> repository -> catalog.
  const idKey = path.join(identity.operationsDir, `operation-${operationId}`);
  const idLease = await acquireCommitLock(idKey, { operationId }, options);
  let repoLease;
  try {
    repoLease = await acquireCommitLock(identity.commonDir, { operationId }, options);
    const current = await resolveProject(projectId, options);
    if (current.hash !== identity.hash) throw invalid();
    identity = current;
    const existing = await getCommitOperation(operationId, options);
    if (existing) return await existingResult(identity, existing, ticketId, options);
    const unresolved = (await listCommitOperations(options)).find((r) => r.commonIdentity === identity.commonIdentity &&
      !(r.status === 'completed' && r.verified && r.indexBefore?.format === 'git-index-flags-v1' && r.indexAfter?.format === 'git-index-flags-v1') && !(r.status === 'not_started' && r.verified && r.phase === 'settled'));
    if (unresolved) return resultOf({ operationId, status: 'unknown' }, { blockedByOperationId: unresolved.operationId });
    const ticket = getCommitPreviewTicket(ticketId);
    if (!ticket) return { success: false, status: 'stale', reason: 'PREVIEW_STALE', operationId };
    if (ticket.projectId !== projectId) throw invalid();
    const ticketIdentity = await repositoryIdentity(ticket.repoRoot);
    if (ticketIdentity.hash !== identity.hash || await fs.realpath(ticket.commonDir) !== identity.commonDir) throw invalid();
    await assertWriteSafety(identity);
    const verified = await recalculateAndCompareCommitPreview(ticketId);
    if (!verified.valid) return { success: false, status: 'stale', reason: 'PREVIEW_STALE', operationId };
    if (!selectedPaths(ticket.selectedFiles).every(isRepositoryRelativePath)) throw invalid();
    const addPaths = ticket.selectedFiles.filter((f) => f.stageScope === 'untracked').map((f) => f.path);
    const before = await readIndex(identity, ticket.selectedFiles, addPaths);
    if (before.raw !== ticket.indexFingerprint) return { success: false, status: 'stale', reason: 'PREVIEW_STALE', operationId };
    let record = { operationId, projectId, repositoryIdentity: identity.hash, commonIdentity: identity.commonIdentity, ticketDigest: digest(ticketId), previewDigest: ticketSummary(ticket),
      branch: ticket.branch, headOidBefore: ticket.headOid, expectedTreeOid: ticket.expectedTreeOid,
      message: ticket.message, selectedFiles: ticket.selectedFiles, addPaths, stagedFiles: [],
      worktreeFingerprint: ticket.worktreeFingerprint, indexBefore: indexSummary(before),
      status: 'not_started', phase: 'prepared', verified: false, indexChange: 'unchanged' };
    // Reservation durable before any command that could change the repository.
    record = await saveCommitOperation(record, { ...options, exclusive: true });
    let settled = true;
    try {
      await options._testHooks?.afterPrepared?.(record);
      // Re-read project, safety gates, HEAD/index/content after WAL I/O. External
      // Git is not serialized by this application lock; the final narrow race
      // is detected by postconditions, never claimed to be eliminated.
      const latest = await resolveProject(projectId, options);
      const lastCheck = await recalculateAndCompareCommitPreview(ticketId);
      let writeSafetyValid = true;
      try { await assertWriteSafety(identity); } catch { writeSafetyValid = false; }
      if (latest.hash !== identity.hash || !lastCheck.valid || !writeSafetyValid) {
        record = await reconcile(identity, record, { settled: true });
        await persistResult(record, options);
        return { success: false, status: 'stale', reason: 'PREVIEW_STALE', operationId };
      }
      if (addPaths.length) {
        record.phase = 'add_started'; record = await saveCommitOperation(record, options);
        settled = false;
        await options._testHooks?.beforeAdd?.(record);
        try { await assertWriteSafety(identity); } catch (error) { settled = true; throw error; }
        let addResult;
        try { addResult = await runCommitWriteGit(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: identity.repoRoot, stdin: Buffer.from(addPaths.join('\0') + '\0'), ...options._testWriteLimits }); }
        finally { settled = true; }
        await options._testHooks?.afterAdd?.(record, addResult);
        if (addResult.code !== 0) throw new GitError('COMMIT_FAILED', '暂存命令未正常结束', 409);
        const afterAdd = await reconcile(identity, record, { settled: true });
        if (!['partial', 'not_started'].includes(afterAdd.status) ||
            await computeWorktreeFingerprint(identity.repoRoot, ticket.selectedFiles) !== ticket.worktreeFingerprint) throw invalid();
        record = { ...record, phase: 'settled', indexAfter: afterAdd.indexAfter, stagedFiles: afterAdd.stagedFiles };
        record = await saveCommitOperation(record, options);
      }
      await assertWriteSafety(identity);
      if ((await resolveProject(projectId, options)).hash !== identity.hash ||
          (await readGit(identity.repoRoot, ['rev-parse', 'HEAD'])).toString().trim() !== ticket.headOid ||
          (await readGit(identity.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toString().trim() !== ticket.branch ||
          await computeWorktreeFingerprint(identity.repoRoot, ticket.selectedFiles) !== ticket.worktreeFingerprint ||
          (await readIndex(identity, ticket.selectedFiles, addPaths)).all !== (record.indexAfter?.all ?? record.indexBefore.all)) throw invalid();
      record.phase = 'commit_started'; record = await saveCommitOperation(record, options);
      settled = false;
      await options._testHooks?.beforeCommit?.(record);
      try {
        if (options._faultInjection?.failCommit) throw new GitError('COMMIT_FAILED', '提交命令未正常结束', 409);
        await runCommitWriteGit(['commit', '--only', '--pathspec-from-file=-', '--pathspec-file-nul', '-m', ticket.message],
          { cwd: identity.repoRoot, stdin: Buffer.from(selectedPaths(ticket.selectedFiles).join('\0') + '\0'), ...options._testWriteLimits });
      } finally { settled = true; }
      await options._testHooks?.afterCommit?.(record);
    } catch (error) {
      // Never expose stderr, host paths or arbitrary exception text.
      record.errorReason = ['GIT_TIMEOUT', 'GIT_OUTPUT_LIMIT'].includes(error.code) ? error.code : 'EXECUTION_INTERRUPTED';
    }
    record = await reconcile(identity, record, { settled });
    const saved = await persistResult(record, options);
    if (record.status === 'completed') removeCommitPreviewTicket(ticketId);
    return resultOf(saved.record, { durable: saved.durable });
  } finally {
    if (repoLease) await releaseCommitLock(identity.commonDir, repoLease, options);
    await releaseCommitLock(idKey, idLease, options);
  }
}
