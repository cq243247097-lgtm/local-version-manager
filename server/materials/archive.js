import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadMaterialRecords } from './records.js';
import { fail, identity, sameIdentity, inspectPath, inspectSource, sameSource, samePathSnapshot, hashSource } from './integrity.js';

const nested = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
export async function archiveTarget(targetRoot, source, protectedPaths) {
  const root = await inspectPath(targetRoot, true);
  for (const p of protectedPaths) {
    const resolved = path.resolve(p);
    if (nested(root.path, resolved) || nested(resolved, root.path)) fail('UNSAFE_TARGET');
  }
  const basename = path.basename(source.relativePath);
  // Portable Windows/POSIX basename, including device aliases and trailing dots.
  if (basename.length > 255 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(basename) || /[. ]$/.test(basename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename) || basename === 'material-records.json') fail('UNSAFE_BASENAME');
  const target = { root, basename, path: path.join(root.path, basename) };
  target.existing = await inspectFinal(target);
  return target;
}
export async function inspectFinal(target) {
  if (!samePathSnapshot(target.root, await inspectPath(target.root.path, true), false)) fail('TARGET_CHANGED');
  try {
    const snapshot = await inspectPath(target.path);
    if ((await fs.lstat(target.path)).nlink !== 1) fail('UNSAFE_TARGET');
    return snapshot;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function declarationFor(source, kind, deadline) {
  const file = path.join(source.root.path, 'material-records.json');
  let snapshot = null;
  try { snapshot = await inspectPath(file); } catch (e) { if (e.code !== 'ENOENT') return { snapshot: null, declaration: null, state: 'unavailable' }; }
  const parsed = await loadMaterialRecords(source.root.path, kind, deadline);
  if (snapshot && !samePathSnapshot(snapshot, await inspectPath(file))) fail('DECLARATION_CHANGED');
  if (!snapshot && parsed.hasRecordFile) fail('DECLARATION_CHANGED');
  const record = parsed.recordsMap.get(source.relativePath);
  const declaration = record?.state === 'available' ? {
    sourceOrigin: record.sourceOrigin, targetVersion: record.targetVersion, revision: record.revision,
    sourceCommit: record.sourceCommit, platform: record.platform,
  } : null;
  return { snapshot, declaration, state: parsed.recordFileError ? 'unavailable' : record?.state || 'unknown' };
}
export async function verifyArchiveBinding(ticket) {
  const existing = await inspectFinal(ticket.target);
  if (ticket.target.existing && (!existing || !samePathSnapshot(ticket.target.existing, existing))) fail('TARGET_CHANGED');
  const metadata = await declarationFor(ticket.source, ticket.kind);
  if (JSON.stringify(metadata.declaration) !== JSON.stringify(ticket.metadata.declaration) || metadata.state !== ticket.metadata.state || Boolean(metadata.snapshot) !== Boolean(ticket.metadata.snapshot) || (metadata.snapshot && !samePathSnapshot(metadata.snapshot, ticket.metadata.snapshot))) fail('DECLARATION_CHANGED');
}

// No cleanup of failed/unknown evidence and no rename-overwrite fallback.
// These are portable path checks, not directory capabilities against hostile OS races.
export async function archiveSource(ticket, { limits, signal, started, validate }) {
  const { source, target, stagingPath } = ticket;
  let sourceHandle, stagingHandle, staging, stagingRoot, bytes = 0, sha256 = null;
  let published = false, publicationAttempted = false;
  const archive = { state: 'not_published', targetPath: target.path, stagingPath, stagingRetained: false, checkedAt: null };
  const check = () => {
    if (signal?.aborted) fail('cancelled');
    if (performance.now() - started >= limits.timeoutMs) fail('timeout');
    if (bytes > limits.maxBytes || source.file.identity.size > limits.maxBytes) fail('limit_exceeded');
  };
  const remaining = () => ({ ...limits, timeoutMs: Math.max(1, Math.ceil(limits.timeoutMs - (performance.now() - started))) });
  async function stable() {
    await validate();
    if (!sameSource(source, await inspectSource(source.root.path, source.relativePath))) fail('changed');
    if (!samePathSnapshot(target.root, await inspectPath(target.root.path, true), false)) fail('TARGET_CHANGED');
    check();
  }
  async function duplicate() {
    const existing = await inspectFinal(target);
    if (!existing) return false;
    check();
    const result = await hashSource({ root: target.root, file: existing, relativePath: target.basename }, { limits: remaining(), signal });
    if (result.integrity !== 'no_baseline') fail(result.reason || result.integrity);
    await stable();
    if (!samePathSnapshot(existing, await inspectFinal(target))) fail('TARGET_CHANGED');
    check();
    archive.state = result.sha256 === sha256 && result.bytes === bytes ? 'duplicate' : 'conflict';
    archive.existingSha256 = result.sha256;
    archive.checkedAt = Date.now();
    return true;
  }
  try {
    check(); await stable();
    await fs.mkdir(stagingPath, { mode: 0o700 });
    archive.stagingRetained = true;
    stagingRoot = await inspectPath(stagingPath, true);
    await stable();
    const stagingFile = path.join(stagingPath, 'payload');
    stagingHandle = await fs.open(stagingFile, 'wx', 0o600);
    const initialStage = identity(await stagingHandle.stat());
    sourceHandle = await fs.open(source.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    if (!sameIdentity(source.file.identity, identity(await sourceHandle.stat()))) fail('changed');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(limits.chunkBytes);
    while (true) {
      check();
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, limits.maxBytes - bytes + 1), null);
      if (!bytesRead) break;
      bytes += bytesRead; check();
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        check();
        const part = await stagingHandle.write(buffer, written, bytesRead - written, null);
        if (!part.bytesWritten) fail('WRITE_FAILED');
        written += part.bytesWritten;
      }
    }
    if (!sameIdentity(source.file.identity, identity(await sourceHandle.stat())) || bytes !== source.file.identity.size) fail('changed');
    sha256 = hash.digest('hex');
    await stagingHandle.sync();
    if (!sameIdentity(initialStage, identity(await stagingHandle.stat()), false)) fail('STAGING_CHANGED');
    staging = await inspectSource(stagingPath, 'payload');
    if (!sameIdentity(initialStage, staging.file.identity, false) || !samePathSnapshot(stagingRoot, staging.root, false)) fail('STAGING_CHANGED');
    check();
    const copied = await hashSource(staging, { limits: remaining(), signal });
    if (copied.integrity !== 'no_baseline') fail(copied.reason || copied.integrity);
    if (copied.sha256 !== sha256 || copied.bytes !== bytes) fail('COPY_MISMATCH');
    await stable();
    const integrity = ticket.baseline ? sha256 === ticket.baseline.sha256 ? 'matched' : 'mismatched' : 'no_baseline';
    if (integrity === 'mismatched') return { integrity, bytes, sha256, reason: 'BASELINE_MISMATCH', archive };
    if (await duplicate()) return { integrity, bytes, sha256, reason: archive.state === 'conflict' ? 'TARGET_CONFLICT' : null, archive };
    await stable();
    if (!sameSource(staging, await inspectSource(stagingPath, 'payload'))) fail('STAGING_CHANGED');
    check();
    publicationAttempted = true;
    try { await fs.link(staging.file.path, target.path); }
    catch (e) {
      if (e.code === 'EEXIST') {
        publicationAttempted = false;
        if (!await duplicate()) fail('TARGET_CHANGED');
        return { integrity, bytes, sha256, reason: archive.state === 'conflict' ? 'TARGET_CONFLICT' : null, archive };
      }
      if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(e.code)) { publicationAttempted = false; archive.state = 'unavailable'; fail('SAFE_PUBLICATION_UNAVAILABLE'); }
      throw e;
    }
    published = true;
    archive.state = 'published';
    // link() changes ctime/nlink. Compare inode plus bytes/mtime, not pre-link ctime.
    const final = await inspectPath(target.path);
    if (!sameIdentity(staging.file.identity, final.identity, false) || final.identity.size !== bytes || final.identity.mtimeMs !== staging.file.identity.mtimeMs || !samePathSnapshot(target.root, await inspectPath(target.root.path, true), false)) fail('PUBLICATION_UNVERIFIED');
    archive.checkedAt = Date.now();
    // Cleanup only the positively identified owned staging file. Keep its empty
    // private directory; never remove the final file, even on later failures.
    if (!samePathSnapshot(stagingRoot, await inspectPath(stagingPath, true), false) || !sameIdentity(final.identity, (await inspectPath(staging.file.path)).identity)) fail('STAGING_CHANGED');
    await fs.unlink(staging.file.path);
    archive.stagingRetained = false;
    // Cancellation/budget after link reports the already-published fact.
    const reason = signal?.aborted ? 'CANCELLED_AFTER_PUBLICATION' : performance.now() - started >= limits.timeoutMs ? 'TIMEOUT_AFTER_PUBLICATION' : null;
    return { integrity, bytes, sha256, reason, archive };
  } catch (e) {
    if (published || publicationAttempted) archive.state = 'unknown';
    const known = ['cancelled', 'timeout', 'limit_exceeded', 'changed'];
    return { integrity: known.includes(e.code) ? e.code : ['SOURCE_CHANGED', 'SOURCE_OR_ASSOCIATION_CHANGED', 'DECLARATION_CHANGED'].includes(e.code) ? 'changed' : 'unreadable', bytes, sha256: null, reason: e.code || 'ARCHIVE_FAILED', archive, ...(published || publicationAttempted ? { status: 'partial' } : {}) };
  } finally {
    await sourceHandle?.close().catch(() => {});
    await stagingHandle?.close().catch(() => {});
  }
}
