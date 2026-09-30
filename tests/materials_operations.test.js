import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMaterialOperations } from '../server/materials/operations.js';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
async function fixture(t, limits) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-operations-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'materials'), repo = path.join(dir, 'repo'), configPath = path.join(dir, 'projects.json'), operationsDir = path.join(dir, 'material-operations');
  await fs.mkdir(root); await fs.mkdir(repo);
  await fs.writeFile(path.join(root, 'file.bin'), 'content');
  await fs.writeFile(path.join(root, 'material-records.json'), '{"protected":true}');
  const config = { projects: ['project', 'other'].map(id => ({ id, name: id, repositoryPath: repo, materials: { installer: { root }, upgrade: { root } } })) };
  await fs.writeFile(configPath, JSON.stringify(config));
  const options = { configPath, operationsDir, limits }, api = createMaterialOperations(options);
  const request = { projectId: 'project', kind: 'installer' };
  const preview = (extra = {}) => api.preview({ ...request, action: 'integrity', relativePath: 'file.bin', ...extra });
  const execute = async (id = 'op', extra = {}) => api.execute({ ...request, operationId: id, ticketId: (await preview(extra)).ticketId });
  return { dir, root, repo, configPath, config, operationsDir, options, api, request, preview, execute };
}
test('protected source, P2 records and configuration remain byte-identical; restart query does not write', async t => {
  const f = await fixture(t);
  const paths = [f.configPath, path.join(f.root, 'file.bin'), path.join(f.root, 'material-records.json')];
  const before = await Promise.all(paths.map(async p => sha(await fs.readFile(p))));
  const result = await f.execute('op', { baseline: { sha256: sha('content'), source: 'User-confirmed declaration' } });
  assert.equal(result.integrity, 'matched'); assert.equal(result.durable, true); assert.equal(result.status, 'completed');
  const stored = await fs.readFile(path.join(f.operationsDir, 'op.json'));
  const restarted = createMaterialOperations(f.options);
  assert.equal((await restarted.query({ ...f.request, operationId: 'op' })).integrity, 'matched');
  assert.deepEqual(await fs.readFile(path.join(f.operationsDir, 'op.json')), stored);
  assert.equal((await restarted.execute({ ...f.request, operationId: 'op', ticketId: 'missing' })).integrity, 'matched');
  assert.deepEqual(await Promise.all(paths.map(async p => sha(await fs.readFile(p)))), before);
  t.diagnostic(JSON.stringify({ protectedBefore: before, protectedAfter: before }));
});
test('missing query/cancel does not create store; invalid scope and targetless archive do not write', async t => {
  const f = await fixture(t);
  assert.equal((await f.api.query({ ...f.request, operationId: 'missing' })).status, 'not_started');
  await f.api.cancel({ ...f.request, operationId: 'missing' });
  await assert.rejects(fs.stat(f.operationsDir), { code: 'ENOENT' });
  await assert.rejects(f.preview({ action: 'archive' }), { code: 'INVALID_TARGET' });
  await assert.rejects(f.preview({ projectId: 'absent' }));
  await assert.rejects(f.preview({ baseline: { sha256: sha('content'), source: '' } }));
  await assert.rejects(fs.stat(f.operationsDir), { code: 'ENOENT' });
});
test('scope mixup, expired tickets, changed source and changed association stop before record creation', async t => {
  const f = await fixture(t);
  const ticket = await f.preview();
  for (const scope of [{ projectId: 'other' }, { kind: 'upgrade' }]) await assert.rejects(f.api.execute({ ...f.request, ...scope, operationId: 'mix', ticketId: ticket.ticketId }), { code: 'PREVIEW_SCOPE_MISMATCH' });
  await fs.writeFile(path.join(f.root, 'file.bin'), 'changed');
  await assert.rejects(f.api.execute({ ...f.request, operationId: 'changed', ticketId: ticket.ticketId }), { code: 'SOURCE_CHANGED' });
  const fresh = await f.preview();
  const replacement = path.join(f.dir, 'replacement'); await fs.mkdir(replacement); await fs.writeFile(path.join(replacement, 'file.bin'), 'changed');
  f.config.projects[0].materials.installer.root = replacement;
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  await assert.rejects(f.api.execute({ ...f.request, operationId: 'association', ticketId: fresh.ticketId }), { code: 'SOURCE_CHANGED' });
  await assert.rejects(fs.stat(f.operationsDir), { code: 'ENOENT' });
  const g = await fixture(t, { ticketTtlMs: 1 }); const expired = await g.preview(); await new Promise(r => setTimeout(r, 5));
  await assert.rejects(g.api.execute({ ...g.request, operationId: 'expired', ticketId: expired.ticketId }), { code: 'PREVIEW_STALE' });
});
test('preview and record capacity bounded; completed results mismatched/no baseline', async t => {
  const f = await fixture(t, { maxTickets: 1, maxRecords: 1 });
  const ticket = await f.preview({ baseline: { sha256: '0'.repeat(64), source: 'declaration' } });
  await assert.rejects(f.preview(), { code: 'PREVIEW_CAPACITY' });
  assert.equal((await f.api.execute({ ...f.request, operationId: 'one', ticketId: ticket.ticketId })).integrity, 'mismatched');
  await assert.rejects(f.execute('two'), { code: 'STORE_CAPACITY' });
  assert.deepEqual(await fs.readdir(f.operationsDir), ['one.json']);
  const g = await fixture(t); assert.equal((await g.execute()).integrity, 'no_baseline');
});
test('concurrent cancellation and restart classify running record unknown, never replay', async t => {
  const f = await fixture(t, { chunkBytes: 1 });
  await fs.writeFile(path.join(f.root, 'file.bin'), Buffer.alloc(100000));
  const ticket = await f.preview(), input = { ...f.request, operationId: 'running', ticketId: ticket.ticketId };
  const running = f.api.execute(input);
  let observed;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 2));
    try { observed = await f.api.query(input); } catch { continue; }
    if (observed.status === 'running') break;
  }
  assert.equal(observed.status, 'running');
  const restart = createMaterialOperations(f.options);
  assert.equal((await restart.query(input)).status, 'unknown');
  assert.equal((await restart.execute(input)).status, 'unknown');
  await assert.rejects(f.api.execute({ ...f.request, operationId: 'second', ticketId: ticket.ticketId }), { code: 'OPERATION_BUSY' });
  await assert.rejects(f.api.query({ ...input, projectId: 'other' }), { code: 'OPERATION_SCOPE_MISMATCH' });
  await f.api.cancel(input);
  const result = await running;
  assert.equal(result.integrity, 'cancelled'); assert.equal(result.status, 'completed');
});
test('store links, corruption, oversized records and identity replacement fail closed', async t => {
  const f = await fixture(t); await f.execute();
  const file = path.join(f.operationsDir, 'op.json');
  await fs.writeFile(file, 'invalid');
  await assert.rejects(f.api.query({ ...f.request, operationId: 'op' }), { code: 'STORE_CORRUPT' });
  await assert.rejects(f.api.execute({ ...f.request, operationId: 'op' }), { code: 'STORE_CORRUPT' });
  await fs.writeFile(file, Buffer.alloc(32769));
  await assert.rejects(f.api.query({ ...f.request, operationId: 'op' }), { code: 'RECORD_LIMIT' });
  await fs.unlink(file); await fs.symlink(path.join(f.root, 'file.bin'), file);
  await assert.rejects(f.api.query({ ...f.request, operationId: 'op' }), { code: 'UNSAFE_PATH' });
  await fs.rename(f.operationsDir, f.operationsDir + '-old'); await fs.mkdir(f.operationsDir);
  await assert.rejects(f.api.query({ ...f.request, operationId: 'op' }), { code: 'STORE_CHANGED' });
});
test('store overlapping protected paths rejected; record init failure starts no digest', async t => {
  const f = await fixture(t);
  const bad = createMaterialOperations({ configPath: f.configPath, operationsDir: path.join(f.root, 'operations') });
  await assert.rejects(bad.preview({ ...f.request, action: 'integrity', relativePath: 'file.bin' }), { code: 'UNSAFE_STORE' });
  await fs.writeFile(f.operationsDir, 'not a directory');
  await assert.rejects(f.execute());
  assert.equal(await fs.readFile(path.join(f.root, 'file.bin'), 'utf8'), 'content');
});
test('result write failure is partial and retained running evidence is unknown after restart', async t => {
  const f = await fixture(t, { chunkBytes: 1 });
  await fs.writeFile(path.join(f.root, 'file.bin'), Buffer.alloc(10000));
  const ticket = await f.preview(), input = { ...f.request, operationId: 'failure', ticketId: ticket.ticketId };
  // Seeing running on disk does not prove create() finished its final read.
  // Block the first source read instead: hashing can only start after durable
  // intent creation has returned, so this fault deterministically hits update().
  let notifyReadStarted, releaseRead;
  const readStarted = new Promise(resolve => { notifyReadStarted = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path.join(f.root, 'file.bin')) {
      const originalRead = handle.read.bind(handle);
      let first = true;
      handle.read = async (...readArgs) => {
        if (first) { first = false; notifyReadStarted(); await readGate; }
        return originalRead(...readArgs);
      };
    }
    return handle;
  });
  const promise = f.api.execute(input);
  await Promise.race([readStarted, promise.then(() => assert.fail('operation finished before source read'))]);
  // Only the fixture replaces its own store while source hashing is gated.
  try {
    await fs.rename(f.operationsDir, f.operationsDir + '-old');
    await fs.mkdir(f.operationsDir);
  } finally { releaseRead(); }
  const result = await promise;
  assert.equal(result.status, 'partial'); assert.equal(result.durable, false); assert.equal(result.reason, 'RESULT_NOT_PERSISTED');
  const old = createMaterialOperations({ ...f.options, operationsDir: f.operationsDir + '-old' });
  assert.equal((await old.query(input)).status, 'unknown');
});
test('association drift during digest prevents matched; older results identify obsolete association', async t => {
  const f = await fixture(t, { chunkBytes: 1 });
  await fs.writeFile(path.join(f.root, 'file.bin'), Buffer.alloc(5000));
  const ticket = await f.preview(), input = { ...f.request, operationId: 'drift', ticketId: ticket.ticketId };
  const promise = f.api.execute(input);
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 2));
    try { if ((await f.api.query(input)).status === 'running') break; } catch {}
  }
  const replacement = path.join(f.dir, 'new-root'); await fs.mkdir(replacement); await fs.writeFile(path.join(replacement, 'file.bin'), Buffer.alloc(5000));
  f.config.projects[0].materials.installer.root = replacement;
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const result = await promise;
  assert.equal(result.integrity, 'changed'); assert.equal(result.sha256, null); assert.equal(result.associationCurrent, false);
  assert.equal((await f.api.query(input)).associationCurrent, false);
});
test('root and record symlinks rejected before source work; abandoned creation lock never reaped', async t => {
  const f = await fixture(t);
  const elsewhere = path.join(f.dir, 'elsewhere'); await fs.mkdir(elsewhere); await fs.symlink(elsewhere, f.operationsDir);
  await assert.rejects(f.execute(), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(elsewhere), []);
  await fs.unlink(f.operationsDir); await fs.mkdir(f.operationsDir); await fs.mkdir(path.join(f.operationsDir, '.create-lock'));
  await assert.rejects(f.execute(), { code: 'STORE_BUSY' });
  assert.deepEqual(await fs.readdir(f.operationsDir), ['.create-lock']);
});
test('same ID competing factories never execute twice and retain the original binding', async t => {
  const f = await fixture(t, { chunkBytes: 1 });
  await fs.writeFile(path.join(f.root, 'file.bin'), Buffer.alloc(1000));
  const second = createMaterialOperations(f.options);
  const a = await f.preview(), b = await second.preview({ ...f.request, action: 'integrity', relativePath: 'file.bin' });
  const input = { ...f.request, operationId: 'shared' };
  const results = await Promise.allSettled([f.api.execute({ ...input, ticketId: a.ticketId }), second.execute({ ...input, ticketId: b.ticketId })]);
  assert.ok(results.some(result => result.status === 'fulfilled' && result.value.status === 'completed'));
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'STORE_BUSY');
  assert.deepEqual(await fs.readdir(f.operationsDir), ['shared.json']);
  const before = await fs.readFile(path.join(f.operationsDir, 'shared.json'));
  assert.equal((await second.execute({ ...input, ticketId: b.ticketId })).status, 'completed');
  assert.deepEqual(await fs.readFile(path.join(f.operationsDir, 'shared.json')), before);
});
for (const phase of ['config', 'store']) {
  test(`execution deadline includes initial ${phase} read before operation ownership`, async t => {
    const f = await fixture(t, { timeoutMs: 50 });
    const ticket = await f.preview();
    let delayed = false;
    if (phase === 'config') {
      const original = fs.readFile;
      t.mock.method(fs, 'readFile', async (...args) => {
        if (!delayed && args[0] === f.configPath) {
          delayed = true;
          await new Promise(r => setTimeout(r, 150));
        }
        return original(...args);
      });
    } else {
      const original = fs.lstat;
      t.mock.method(fs, 'lstat', async (...args) => {
        if (!delayed && args[0] === f.operationsDir) {
          delayed = true;
          await new Promise(r => setTimeout(r, 150));
        }
        return original(...args);
      });
    }
    const result = await f.api.execute({ ...f.request, operationId: phase, ticketId: ticket.ticketId });
    assert.equal(delayed, true);
    assert.equal(result.integrity, 'timeout');
    assert.equal(result.sha256, null);
    assert.equal(result.bytes, 0);
    assert.equal(result.status, 'completed');
    assert.equal(result.durable, true);
  });
}
for (const scenario of ['unrelated-repo', 'unrelated-material', 'own-missing', 'own-unassociated', 'own-remapped']) test(`historical query and cancel stay read-only after ${scenario}`, async t => {
  const f = await fixture(t), unrelatedRepo = path.join(f.dir, 'unrelated-repo'), unrelatedMaterial = path.join(f.dir, 'unrelated-material');
  await fs.mkdir(unrelatedRepo); await fs.mkdir(unrelatedMaterial);
  f.config.projects[1].repositoryPath = unrelatedRepo;
  f.config.projects[1].materials = { installer: { root: unrelatedMaterial } };
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const completed = await f.execute('history'), recordFile = path.join(f.operationsDir, 'history.json');
  if (scenario === 'unrelated-repo') await fs.rename(unrelatedRepo, unrelatedRepo + '-old');
  if (scenario === 'unrelated-material') await fs.rename(unrelatedMaterial, unrelatedMaterial + '-old');
  if (scenario === 'own-missing') await fs.rename(f.root, f.root + '-old');
  if (scenario === 'own-unassociated') { delete f.config.projects[0].materials; await fs.writeFile(f.configPath, JSON.stringify(f.config)); }
  if (scenario === 'own-remapped') { await fs.rename(f.root, f.root + '-old'); await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, 'file.bin'), 'replacement'); }
  const originalRoot = ['own-missing', 'own-remapped'].includes(scenario) ? f.root + '-old' : f.root;
  const paths = [recordFile, f.configPath, path.join(originalRoot, 'file.bin'), path.join(originalRoot, 'material-records.json')];
  const before = await Promise.all(paths.map(p => fs.readFile(p))), entries = await fs.readdir(f.operationsDir);
  const restarted = createMaterialOperations(f.options), input = { ...f.request, operationId: 'history' };
  for (const service of [f.api, restarted]) for (const method of ['query', 'cancel']) {
    const result = await service[method](input);
    assert.equal(result.status, 'completed'); assert.equal(result.integrity, completed.integrity);
    assert.equal(result.historical, true); assert.equal(result.checkedAt, completed.updatedAt);
    assert.equal(result.associationCurrent, scenario.startsWith('unrelated'));
  }
  assert.deepEqual(await Promise.all(paths.map(p => fs.readFile(p))), before);
  assert.deepEqual(await fs.readdir(f.operationsDir), entries);
  if (scenario.startsWith('unrelated')) await assert.rejects(f.preview(), { code: 'ENOENT' });
  else if (scenario !== 'own-remapped') await assert.rejects(f.preview());
});
for (const scenario of ['own-root', 'unrelated-root']) test(`cancel sets only its bound running flag after missing ${scenario}`, async t => {
  const f = await fixture(t, { chunkBytes: 1 }), unrelatedRepo = path.join(f.dir, 'unrelated-repo');
  await fs.mkdir(unrelatedRepo); f.config.projects[1].repositoryPath = unrelatedRepo;
  await fs.writeFile(f.configPath, JSON.stringify(f.config)); await fs.writeFile(path.join(f.root, 'file.bin'), Buffer.alloc(1000));
  const ticket = await f.preview(), input = { ...f.request, operationId: 'cancel-missing', ticketId: ticket.ticketId };
  let notifyStarted, releaseRead, reads = 0;
  const started = new Promise(resolve => { notifyStarted = resolve; }), gate = new Promise(resolve => { releaseRead = resolve; });
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const h = await originalOpen(...args);
    if (args[0] === path.join(f.root, 'file.bin')) {
      const read = h.read.bind(h);
      h.read = async (...params) => { reads++; if (reads === 1) { notifyStarted(); await gate; } return read(...params); };
    }
    return h;
  });
  const running = f.api.execute(input);
  await Promise.race([started, running.then(() => assert.fail('operation finished before source read'))]);
  const missing = scenario === 'own-root' ? f.root : unrelatedRepo;
  await fs.rename(missing, missing + '-old');
  const recordFile = path.join(f.operationsDir, 'cancel-missing.json'), before = await fs.readFile(recordFile);
  try {
    const result = await f.api.cancel(input);
    assert.equal(result.status, 'running'); assert.equal(result.associationCurrent, scenario === 'unrelated-root');
    assert.deepEqual(await fs.readFile(recordFile), before);
  } finally { releaseRead(); }
  await running; assert.equal(reads, 1, 'cancellation prevents the next source read');
});
test('historical read retains missing-project, scope, corrupt-store and linked-store refusal', async t => {
  const f = await fixture(t); await f.execute('history');
  const input = { ...f.request, operationId: 'history' };
  for (const method of ['query', 'cancel']) {
    await assert.rejects(f.api[method]({ ...input, projectId: 'missing' }), { code: 'PROJECT_NOT_FOUND' });
    await assert.rejects(f.api[method]({ ...input, projectId: 'other' }), { code: 'OPERATION_SCOPE_MISMATCH' });
  }
  const recordFile = path.join(f.operationsDir, 'history.json'); await fs.writeFile(recordFile, 'corrupt');
  for (const method of ['query', 'cancel']) await assert.rejects(f.api[method](input), { code: 'STORE_CORRUPT' });
  await fs.rename(f.operationsDir, f.operationsDir + '-old'); await fs.symlink(f.operationsDir + '-old', f.operationsDir);
  const restart = createMaterialOperations(f.options);
  for (const method of ['query', 'cancel']) await assert.rejects(restart[method](input), { code: 'UNSAFE_PATH' });
});
