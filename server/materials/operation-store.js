import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, inspectPath, samePathSnapshot, sameIdentity, identity, DEFAULT_LIMITS } from './integrity.js';

export function assertOperationId(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) fail('INVALID_OPERATION_ID', 400); }
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export function createOperationStore(directory, limits = DEFAULT_LIMITS) {
  let rootSnapshot;
  async function root(create = false) {
    if (create) {
      await inspectPath(path.dirname(directory), true);
      try { await fs.mkdir(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    let snapshot;
    try { snapshot = await inspectPath(directory, true); }
    catch (e) { if (!create && e.code === 'ENOENT' && !rootSnapshot) return null; throw e; }
    if (rootSnapshot && !samePathSnapshot(rootSnapshot, snapshot, false)) fail('STORE_CHANGED');
    rootSnapshot ||= snapshot;
    return snapshot;
  }
  const filename = id => { assertOperationId(id); return path.join(directory, `${id}.json`); };
  function encode(record) {
    const payload = JSON.stringify(record);
    const data = JSON.stringify({ payload, sha256: digest(payload) });
    if (Buffer.byteLength(data) > limits.recordBytes) fail('RECORD_LIMIT');
    return data;
  }
  function decode(data, id) {
    let envelope, record;
    try {
      envelope = JSON.parse(data);
      if (typeof envelope.payload !== 'string' || envelope.sha256 !== digest(envelope.payload)) fail('STORE_CORRUPT');
      record = JSON.parse(envelope.payload);
    } catch { fail('STORE_CORRUPT'); }
    if (record?.version !== 1 || record.operationId !== id || typeof record.projectId !== 'string' || !['installer', 'upgrade'].includes(record.kind) || !record.binding || !['running', 'completed', 'partial', 'unknown'].includes(record.status)) fail('STORE_CORRUPT');
    return record;
  }
  async function read(id) {
    const file = filename(id);
    if (!await root()) return null;
    let snapshot;
    try { snapshot = await inspectPath(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (snapshot.identity.size > limits.recordBytes) fail('RECORD_LIMIT');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      if (!sameIdentity(snapshot.identity, identity(await handle.stat()))) fail('STORE_CHANGED');
      const buffer = Buffer.alloc(limits.recordBytes + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > limits.recordBytes) fail('RECORD_LIMIT');
      if (!sameIdentity(snapshot.identity, identity(await handle.stat())) || !samePathSnapshot(snapshot, await inspectPath(file))) fail('STORE_CHANGED');
      await root();
      return { record: decode(buffer.subarray(0, used).toString('utf8'), id), snapshot };
    } finally { await handle.close(); }
  }
  async function countEntries() {
    let count = 0;
    const dir = await fs.opendir(directory);
    try {
      for await (const item of dir) {
        if (++count > limits.maxRecords + 1) fail('STORE_CAPACITY');
        if (item.name === '.create-lock') continue;
        if (!/^[a-zA-Z0-9_-]{1,64}\.json$/.test(item.name) || !item.isFile()) fail('STORE_UNEXPECTED_ENTRY');
      }
    } finally { await dir.close().catch(() => {}); }
    return count - 1; // create lock is present
  }
  async function create(record) {
    const data = encode(record), file = filename(record.operationId);
    await root(true);
    // Serialize bounded capacity and initial publication across instances. An
    // interrupted lock fails closed; manual inspection is required, never reap.
    const lock = path.join(directory, '.create-lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); } catch { fail('STORE_BUSY'); }
    try {
      const previous = await read(record.operationId);
      if (previous) return { created: false, ...previous };
      if (await countEntries() >= limits.maxRecords) fail('STORE_CAPACITY');
      await root();
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await root();
      return { created: true, ...(await read(record.operationId)) };
    } finally { await fs.rmdir(lock).catch(() => {}); }
  }
  async function update(record, expected) {
    const data = encode(record), file = filename(record.operationId);
    await root();
    const current = await read(record.operationId);
    if (!current || !sameIdentity(current.snapshot.identity, expected.identity) || JSON.stringify(current.record.binding) !== JSON.stringify(record.binding) || current.record.projectId !== record.projectId || current.record.kind !== record.kind || current.record.status !== 'running') fail('STORE_CHANGED');
    const temp = path.join(directory, `.update-${crypto.randomUUID()}`);
    const h = await fs.open(temp, 'wx', 0o600);
    try { await h.writeFile(data); await h.sync(); } finally { await h.close(); }
    // No generic cleanup: failed updates preserve their owned evidence.
    await root();
    if (!samePathSnapshot(current.snapshot, await inspectPath(file))) fail('STORE_CHANGED');
    await fs.rename(temp, file);
    const saved = await read(record.operationId);
    if (!saved || JSON.stringify(saved.record) !== JSON.stringify(record)) fail('STORE_CHANGED');
    return saved;
  }
  return { read, create, update, directory };
}
