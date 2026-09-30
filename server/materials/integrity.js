import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MaterialError } from './association.js';

export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 1024 ** 3, timeoutMs: 60000, chunkBytes: 65536, maxTickets: 128, ticketTtlMs: 300000, maxRecords: 1024, recordBytes: 32768 });
export function limitsWith(overrides = {}) {
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) fail('INVALID_LIMIT');
    result[key] = value;
  }
  return result;
}
export function fail(code, status = 409) { throw new MaterialError(code, status, code); }
export function baselineWith(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['sha256', 'source'].includes(k)) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256) ||
      typeof value.source !== 'string' || !value.source.trim() || value.source.length > 512 || /[\x00-\x1f\x7f]/.test(value.source)) fail('INVALID_BASELINE', 400);
  return { sha256: value.sha256.toLowerCase(), source: value.source.trim() };
}
export function identity(stat) {
  if (!stat.ino || !Number.isSafeInteger(stat.ino) || !Number.isSafeInteger(stat.dev)) fail('IDENTITY_UNAVAILABLE');
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
export function sameIdentity(a, b, content = true) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && (!content || ['size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]));
}
export function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..')) fail('INVALID_PATH', 400);
  return value;
}
// Check every ancestor, including ancestors outside the associated root. Node
// has no portable openat capability: adversarial path races remain a limitation.
export async function inspectPath(absolute, directory = false) {
  if (typeof absolute !== 'string' || !path.isAbsolute(absolute) || absolute.length > 4096 || absolute.includes('\0')) fail('INVALID_PATH', 400);
  absolute = path.resolve(absolute);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const chain = [];
  for (const part of [null, ...components]) {
    if (part !== null) current = path.join(current, part);
    const stat = await fs.lstat(current);
    const last = current === absolute;
    if (stat.isSymbolicLink() || (!last || directory ? !stat.isDirectory() : !stat.isFile())) fail('UNSAFE_PATH');
    chain.push({ path: current, identity: identity(stat) });
  }
  if (path.resolve(await fs.realpath(absolute)) !== absolute) fail('UNSAFE_PATH');
  return { path: absolute, chain, identity: chain.at(-1).identity };
}
export function samePathSnapshot(a, b, file = true) {
  return a.path === b.path && a.chain.length === b.chain.length && a.chain.every((item, i) => item.path === b.chain[i].path && sameIdentity(item.identity, b.chain[i].identity, file && i === a.chain.length - 1));
}
export async function inspectSource(root, relativePath) {
  relativeFile(relativePath);
  const directory = await inspectPath(root, true);
  const file = await inspectPath(path.join(directory.path, relativePath));
  return { root: directory, file, relativePath };
}
export function sameSource(a, b) { return samePathSnapshot(a.root, b.root, false) && samePathSnapshot(a.file, b.file); }
export async function hashSource(snapshot, { limits = DEFAULT_LIMITS, baseline = null, signal, onChunk } = {}) {
  const started = performance.now();
  let bytes = 0, handle;
  const check = () => {
    if (signal?.aborted) fail('cancelled');
    if (performance.now() - started >= limits.timeoutMs) fail('timeout');
    if (bytes > limits.maxBytes) fail('limit_exceeded');
  };
  try {
    check();
    if (snapshot.file.identity.size > limits.maxBytes) fail('limit_exceeded');
    if (!sameSource(snapshot, await inspectSource(snapshot.root.path, snapshot.relativePath))) fail('changed');
    handle = await fs.open(snapshot.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const initial = await handle.stat();
    if (!initial.isFile() || !sameIdentity(snapshot.file.identity, identity(initial))) fail('changed');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(limits.chunkBytes);
    while (true) {
      check();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limits.maxBytes - bytes + 1), null);
      if (!bytesRead) break;
      bytes += bytesRead;
      check();
      hash.update(buffer.subarray(0, bytesRead));
      if (onChunk) await onChunk(bytes); // internal helper seam; never request controlled
    }
    check();
    if (!sameIdentity(snapshot.file.identity, identity(await handle.stat())) || !sameSource(snapshot, await inspectSource(snapshot.root.path, snapshot.relativePath)) || bytes !== snapshot.file.identity.size) fail('changed');
    // Final metadata I/O can itself consume the budget or observe cancellation.
    check();
    const sha256 = hash.digest('hex');
    return { integrity: baseline ? sha256 === baseline.sha256 ? 'matched' : 'mismatched' : 'no_baseline', bytes, sha256, reason: null };
  } catch (error) {
    const known = ['changed', 'cancelled', 'timeout', 'limit_exceeded'];
    return { integrity: known.includes(error.code) ? error.code : ['UNSAFE_PATH', 'ENOENT'].includes(error.code) ? 'changed' : 'unreadable', bytes, sha256: null, reason: error.code || 'READ_FAILED' };
  } finally { await handle?.close().catch(() => {}); }
}
