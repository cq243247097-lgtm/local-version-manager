import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { GitError } from './exec.js';

export const COMMIT_OPERATION_ERRORS = {
  REPOSITORY_BUSY: 'REPOSITORY_BUSY',
  OPERATION_INVALID: 'OPERATION_INVALID',
  OPERATION_NOT_FOUND: 'OPERATION_NOT_FOUND',
  OPERATION_STORE_FAILED: 'OPERATION_STORE_FAILED',
  OPERATION_CAPACITY: 'OPERATION_CAPACITY',
  LOCK_RELEASE_MISMATCH: 'LOCK_RELEASE_MISMATCH',
};
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_SAVED_OPERATIONS = 100;
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Fixed-size, monotonic retirement filter. False positives refuse a new ID;
// false negatives (and therefore replay of a retired ID) are not permitted.
const RETIRED_BYTES = 8192;
const HOST = os.hostname();
const safeError = (code = 'OPERATION_STORE_FAILED') => new GitError(code, '提交操作记录不可用，请先核对本地操作状态', 409);
export function assertOperationId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw safeError('OPERATION_INVALID');
}
export function getOperationsDir(options = {}) {
  const dir = options.operationsDir ?? (typeof options.configPath === 'string' && path.isAbsolute(options.configPath)
    ? path.join(path.dirname(options.configPath), 'commit-operations') : null);
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw safeError('OPERATION_INVALID');
  return path.normalize(dir);
}
export function getRepoKeyHash(identifier) {
  // Callers supply real paths. Never lowercase on a case-sensitive platform.
  const normalized = path.resolve(identifier);
  return crypto.createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex');
}
// Portable guarantee is service-process crash/restart with the OS and local
// filesystem still running. Writable files are fsynced; directory/volume
// persistence across OS crash or power loss is explicitly not promised.
async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); }
function deadOwner(owner) {
  if (owner?.host !== HOST || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; } // EPERM/PID reuse/unknown => busy
}
async function reapDeadLock(lockDir) {
  let names;
  try { names = await fs.readdir(lockDir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (names.length === 0) { await fs.rmdir(lockDir).catch(() => {}); return; }
  if (names.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(names[0])) return;
  const tokenFile = path.join(lockDir, names[0]);
  let owner;
  try { owner = JSON.parse(await fs.readFile(tokenFile, 'utf8')); } catch { return; }
  if (owner.token + '.json' !== names[0] || !deadOwner(owner)) return;
  // A token pathname is never reused. Even if another contender publishes a
  // successor between these calls, unlink cannot hit its token and nonrecursive
  // rmdir cannot delete its nonempty directory. No read/unlink shared-file race.
  await fs.unlink(tokenFile).catch(() => {});
  await fs.rmdir(lockDir).catch(() => {});
}

/** Atomic nonempty-directory publication; TTL is diagnostic, not a lease. */
export async function acquireCommitLock(identifier, params, options = {}) {
  assertOperationId(params?.operationId);
  const locksDir = path.join(getOperationsDir(options), 'locks');
  const lockFile = path.join(locksDir, `${getRepoKeyHash(identifier)}.lock`);
  const token = crypto.randomUUID();
  const candidate = path.join(locksDir, `.candidate-${token}`);
  const owner = { token, pid: process.pid, host: HOST, operationId: params.operationId, createdAt: Date.now() };
  const tokenFile = `${token}.json`;
  try {
    await ensureDir(locksDir);
    await fs.mkdir(candidate, { mode: 0o700 });
    const h = await fs.open(path.join(candidate, tokenFile), 'wx', 0o600);
    try { await h.writeFile(JSON.stringify(owner)); await h.sync(); } finally { await h.close(); }
    const waitMs = Math.max(0, Math.min(options.lockWaitMs ?? 1000, 5000));
    const deadline = Date.now() + waitMs;
    do {
      try {
        await fs.rename(candidate, lockFile);
        return { acquired: true, lockFile, token, operationId: params.operationId };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        await reapDeadLock(lockFile);
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 20));
    } while (true);
    throw new GitError('REPOSITORY_BUSY', '仓库当前正在执行其他提交操作，请稍候再试', 409);
  } catch (error) {
    // Cleanup is restricted to this unique token, never a successor token.
    await fs.unlink(path.join(lockFile, tokenFile)).catch(() => {});
    await fs.rmdir(lockFile).catch(() => {});
    if (error instanceof GitError) throw error;
    throw safeError();
  } finally {
    await fs.unlink(path.join(candidate, tokenFile)).catch(() => {});
    await fs.rmdir(candidate).catch(() => {});
  }
}
export async function releaseCommitLock(identifier, lease, options = {}) {
  if (!lease?.token || !/^[a-f0-9-]{36}$/.test(lease.token)) return;
  const lockFile = path.join(getOperationsDir(options), 'locks', `${getRepoKeyHash(identifier)}.lock`);
  if (lease.lockFile !== lockFile) throw safeError('LOCK_RELEASE_MISMATCH');
  await fs.unlink(path.join(lockFile, `${lease.token}.json`)).catch((e) => { if (e.code !== 'ENOENT') throw safeError(); });
  await fs.rmdir(lockFile).catch((e) => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw safeError(); });
}
function retirementBits(id) {
  const hash = crypto.createHash('sha256').update(id).digest();
  return [0, 4, 8, 12].map((offset) => hash.readUInt32BE(offset) % (RETIRED_BYTES * 8));
}

export const COMMIT_JOURNAL_LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, frameBytes: 4 * 1024 * 1024, activeOperations: MAX_SAVED_OPERATIONS });
const JOURNAL_NAME = 'operations.journal';
const MARKER_NAME = 'journal-store.json';
const MAGIC = Buffer.from('LVMJNL3\n');
const HEADER_BYTES = 52; // magic(8), payload bytes(4), sequence(8), previous digest(32)
const HASH_BYTES = 32;
const ZERO_HASH = '0'.repeat(64);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const checksum = (bytes) => crypto.createHash('sha256').update(bytes).digest();
// Explicit allowlist: no host absolute paths, credentials, file bodies or stderr.
const FIELDS = ['operationId', 'projectId', 'repositoryIdentity', 'commonIdentity', 'ticketDigest', 'previewDigest',
  'branch', 'headOidBefore', 'headOidAfter', 'expectedTreeOid', 'treeOidAfter', 'commitOid',
  'message', 'status', 'phase', 'selectedFiles', 'addPaths', 'stagedFiles', 'indexBefore',
  'indexAfter', 'indexChange', 'worktreeFingerprint', 'errorReason', 'userMessage', 'verified', 'createdAt'];
function validateRecord(record) {
  if (!record || typeof record.operationId !== 'string' || !ID.test(record.operationId) || record.version !== 3 ||
      !['repositoryIdentity', 'commonIdentity', 'ticketDigest', 'previewDigest'].every((key) => HASH.test(record[key])) ||
      typeof record.projectId !== 'string' || !Array.isArray(record.selectedFiles) || !Array.isArray(record.addPaths) ||
      !record.indexBefore || !HASH.test(record.indexBefore.all) ||
      !['not_started', 'completed', 'partial', 'unknown', 'failed'].includes(record.status) ||
      !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)) throw safeError();
}
function sameBinding(a, b) {
  return ['projectId', 'repositoryIdentity', 'commonIdentity', 'ticketDigest', 'previewDigest'].every((key) => a[key] === b[key]);
}
function isRetired(bits, id) { return retirementBits(id).every((bit) => bits[bit >> 3] & (1 << (bit & 7))); }
function emptyState() { return { initialized: false, records: new Map(), reserves: new Map(), retired: Buffer.alloc(RETIRED_BYTES), bytes: 0, sequence: -1, lastHash: ZERO_HASH }; }
function encodeFrame(payload, state) {
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > COMMIT_JOURNAL_LIMITS.frameBytes) throw safeError('OPERATION_CAPACITY');
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(body.length, 8);
  header.writeBigUInt64BE(BigInt(state.sequence + 1), 12);
  Buffer.from(state.lastHash, 'hex').copy(header, 20);
  const unsigned = Buffer.concat([header, body]);
  return Buffer.concat([unsigned, checksum(unsigned)]);
}
function nextReservation(previous, record) {
  // At most four transitions remain after prepared: add-started, post-add,
  // commit-started, result. Once an outcome exists, this ID is query-only.
  if (record.status !== 'not_started' || record.verified) return 0;
  if (previous === undefined) return 4;
  if (previous < 1) throw safeError();
  return previous - 1;
}
function reservedBytes(state) {
  return [...state.reserves.values()].reduce((sum, count) => sum + count * (COMMIT_JOURNAL_LIMITS.frameBytes + HEADER_BYTES + HASH_BYTES), 0);
}
function applyEvent(state, event, sequence) {
  if (sequence === 0) {
    if (event?.type !== 'init' || event.version !== 3 || !UUID.test(event.storeId)) throw safeError();
    state.storeId = event.storeId; state.initialized = true;
    return;
  }
  if (event?.type === 'operation') {
    const record = event.record;
    validateRecord(record);
    const existing = state.records.get(record.operationId);
    if ((!existing && isRetired(state.retired, record.operationId)) || (existing && !sameBinding(existing, record))) throw safeError();
    if (!existing && state.records.size >= MAX_SAVED_OPERATIONS) throw safeError();
    if (event.reserveFrames !== nextReservation(state.reserves.get(record.operationId), record)) throw safeError();
    state.records.set(record.operationId, record);
    state.reserves.set(record.operationId, event.reserveFrames);
  } else if (event?.type === 'retire') {
    if (!Array.isArray(event.operationIds) || event.operationIds.length > MAX_SAVED_OPERATIONS || new Set(event.operationIds).size !== event.operationIds.length) throw safeError();
    for (const id of event.operationIds) {
      const record = state.records.get(id);
      if (!ID.test(id) || record?.status !== 'completed' || !record.verified) throw safeError();
      for (const bit of retirementBits(id)) state.retired[bit >> 3] |= 1 << (bit & 7);
      state.records.delete(id); state.reserves.delete(id);
    }
  } else { throw safeError(); }
}
function decodeJournal(bytes, storeId) {
  const state = emptyState();
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < HEADER_BYTES + HASH_BYTES || !bytes.subarray(offset, offset + 8).equals(MAGIC)) throw safeError();
    const length = bytes.readUInt32BE(offset + 8);
    const sequenceBig = bytes.readBigUInt64BE(offset + 12);
    if (length > COMMIT_JOURNAL_LIMITS.frameBytes || sequenceBig > BigInt(Number.MAX_SAFE_INTEGER)) throw safeError();
    const sequence = Number(sequenceBig);
    const end = offset + HEADER_BYTES + length;
    if (end + HASH_BYTES > bytes.length || sequence !== state.sequence + 1 ||
        bytes.subarray(offset + 20, offset + HEADER_BYTES).toString('hex') !== state.lastHash) throw safeError();
    const hash = checksum(bytes.subarray(offset, end));
    if (!hash.equals(bytes.subarray(end, end + HASH_BYTES))) throw safeError();
    let event;
    try { event = JSON.parse(bytes.subarray(offset + HEADER_BYTES, end).toString('utf8')); } catch { throw safeError(); }
    applyEvent(state, event, sequence);
    state.lastHash = hash.toString('hex'); state.sequence = sequence;
    offset = end + HASH_BYTES;
    if (offset + reservedBytes(state) > COMMIT_JOURNAL_LIMITS.bytes) throw safeError();
  }
  if (!state.initialized || state.storeId !== storeId) throw safeError();
  state.bytes = bytes.length;
  return state;
}
async function readStore(options = {}) {
  const base = getOperationsDir(options);
  let names;
  try { names = await fs.readdir(base); } catch (error) { if (error.code === 'ENOENT') return emptyState(); throw safeError(); }
  // No automatic migration/empty-store fallback. Old records and retirement
  // evidence must never silently disappear merely because a new format exists.
  if (names.some((name) => !['locks', MARKER_NAME, JOURNAL_NAME].includes(name))) throw safeError();
  const hasMarker = names.includes(MARKER_NAME), hasJournal = names.includes(JOURNAL_NAME);
  if (!hasMarker && !hasJournal) return emptyState();
  if (!hasMarker || !hasJournal) throw safeError();
  try {
    const markerPath = path.join(base, MARKER_NAME), journalPath = path.join(base, JOURNAL_NAME);
    const markerStat = await fs.lstat(markerPath), journalStat = await fs.lstat(journalPath);
    if (!markerStat.isFile() || markerStat.size > 4096 || !journalStat.isFile() || journalStat.size > COMMIT_JOURNAL_LIMITS.bytes) throw safeError();
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (marker.version !== 3 || marker.guarantee !== 'service-process-crash' || !UUID.test(marker.storeId)) throw safeError();
    // Concurrent read-only queries may encounter an incomplete in-flight append:
    // conservatively refuse that observation; never truncate, skip or repair it.
    return decodeJournal(await fs.readFile(journalPath), marker.storeId);
  } catch { throw safeError(); }
}
async function writeAll(handle, bytes, position, options, record) {
  let written = 0;
  while (written < bytes.length) {
    const length = Math.min(bytes.length - written, options._testJournalChunkBytes ?? bytes.length);
    if (!Number.isSafeInteger(length) || length < 1) throw safeError();
    const result = await handle.write(bytes, written, length, position + written);
    if (result.bytesWritten <= 0) throw safeError();
    written += result.bytesWritten;
    if (record) await options._testHooks?.afterJournalChunk?.(record, written);
  }
}
async function initializeStore(options) {
  let state = await readStore(options);
  if (state.initialized) return state;
  const base = getOperationsDir(options);
  const storeId = crypto.randomUUID();
  // Bootstrap is exclusive under the catalog lock. A crash at either creation
  // leaves evidence that is refused, not silently recreated as empty history.
  const marker = await fs.open(path.join(base, MARKER_NAME), 'wx+', 0o600);
  try {
    await marker.writeFile(JSON.stringify({ version: 3, storeId, guarantee: 'service-process-crash' }));
    await marker.sync();
  } finally { await marker.close(); }
  await options._testHooks?.afterJournalMarker?.();
  const journal = await fs.open(path.join(base, JOURNAL_NAME), 'wx+', 0o600);
  try {
    const frame = encodeFrame({ type: 'init', version: 3, storeId }, state);
    await writeAll(journal, frame, 0, options);
    await journal.sync();
  } finally { await journal.close(); }
  return readStore(options);
}
async function appendEvent(state, event, options) {
  const frame = encodeFrame(event, state);
  const reservationDelta = event.type === 'operation'
    ? (event.reserveFrames - (state.reserves.get(event.record.operationId) ?? 0)) * (COMMIT_JOURNAL_LIMITS.frameBytes + HEADER_BYTES + HASH_BYTES) : 0;
  const byteLimit = Math.min(COMMIT_JOURNAL_LIMITS.bytes, options._testJournalMaxBytes ?? COMMIT_JOURNAL_LIMITS.bytes);
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 0 || state.bytes + frame.length + reservedBytes(state) + reservationDelta > byteLimit) throw safeError('OPERATION_CAPACITY');
  const record = event.type === 'operation' ? event.record : null;
  // r+ provides GENERIC_WRITE on Windows; unlike a directory read handle,
  // this is a valid FlushFileBuffers target. Writes only occur at verified EOF.
  const handle = await fs.open(path.join(getOperationsDir(options), JOURNAL_NAME), 'r+');
  try {
    if ((await handle.stat()).size !== state.bytes) throw safeError();
    const onHandle = decodeJournal(await handle.readFile(), state.storeId);
    if (onHandle.lastHash !== state.lastHash || onHandle.sequence !== state.sequence || onHandle.bytes !== state.bytes) throw safeError();
    if (record) await options._testHooks?.beforeJournalAppend?.(record);
    await writeAll(handle, frame, state.bytes, options, record);
    if (record) await options._testHooks?.afterJournalWrite?.(record);
    if (record) await options._testHooks?.beforeJournalSync?.(record);
    await handle.sync(); // Required acknowledgement before add/commit may start.
    if (record) await options._testHooks?.afterJournalSync?.(record);
  } finally { await handle.close(); }
}
export async function getCommitOperation(id, options = {}) {
  assertOperationId(id);
  const state = await readStore(options);
  return state.records.get(id) ?? (isRetired(state.retired, id) ? { operationId: id, status: 'unknown', retired: true } : null);
}
export async function listCommitOperations(options = {}) { return [...(await readStore(options)).records.values()]; }
export async function saveCommitOperation(operation, options = {}) {
  assertOperationId(operation?.operationId);
  const base = getOperationsDir(options);
  const lease = await acquireCommitLock(path.join(base, 'catalog'), { operationId: operation.operationId }, options);
  try {
    const state = await initializeStore(options);
    const existing = state.records.get(operation.operationId);
    if ((!existing && isRetired(state.retired, operation.operationId)) || (existing && !sameBinding(existing, operation)) || (options.exclusive && existing)) throw safeError('OPERATION_INVALID');
    if (!existing && state.records.size >= MAX_SAVED_OPERATIONS) throw safeError('OPERATION_CAPACITY');
    const clean = { version: 3 };
    for (const key of FIELDS) if (operation[key] !== undefined) clean[key] = operation[key];
    clean.createdAt = existing?.createdAt ?? operation.createdAt ?? Date.now();
    clean.updatedAt = Date.now();
    validateRecord(clean);
    // Do not append identical observations indefinitely merely because a client
    // queried repeatedly. New facts/phase still append and fsync normally.
    if (existing && JSON.stringify({ ...existing, updatedAt: 0 }) === JSON.stringify({ ...clean, updatedAt: 0 })) return existing;
    await appendEvent(state, { type: 'operation', record: clean, reserveFrames: nextReservation(state.reserves.get(clean.operationId), clean) }, options);
    return clean;
  } catch (error) { if (error instanceof GitError) throw error; throw safeError(); }
  finally { await releaseCommitLock(path.join(base, 'catalog'), lease, options); }
}
/** Logical retirement only. Raw journal history remains bounded by the byte cap.
 * No automatic compaction/rotation/truncation can erase no-replay evidence. */
export async function pruneOldOperations(options = {}) {
  const base = getOperationsDir(options);
  const lease = await acquireCommitLock(path.join(base, 'catalog'), { operationId: 'prune' }, options);
  try {
    const state = await readStore(options);
    const expired = [...state.records.values()].filter((record) => record.status === 'completed' && record.verified && Date.now() - record.updatedAt > OPERATION_RETENTION_MS);
    if (expired.length) await appendEvent(state, { type: 'retire', operationIds: expired.map((r) => r.operationId) }, options);
    const locks = path.join(base, 'locks');
    for (const name of await fs.readdir(locks)) if (name.endsWith('.lock') || name.startsWith('.candidate-')) await reapDeadLock(path.join(locks, name));
  } catch (error) { if (error instanceof GitError) throw error; throw safeError(); }
  finally { await releaseCommitLock(path.join(base, 'catalog'), lease, options); }
}
