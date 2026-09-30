import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createMaterialOperations } from '../server/materials/operations.js';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const error = code => Object.assign(new Error(code), { code });
async function fixture(t, limits, content = 'archive content') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-archive-'));
  const root = path.join(dir, 'materials'), repo = path.join(dir, 'repo'), target = path.join(dir, 'archive'), data = path.join(dir, 'data');
  for (const p of [root, repo, target, data]) await fs.mkdir(p);
  const source = path.join(root, 'package.zip'), records = path.join(root, 'material-records.json'), configPath = path.join(data, 'projects.json'), operationsDir = path.join(dir, 'material-operations');
  await fs.writeFile(source, content);
  await fs.writeFile(records, JSON.stringify({ schemaVersion: 1, records: [{ kind: 'installer', file: 'package.zip', targetVersion: 'v1.2.3', revision: 'r2', sourceCommit: 'a'.repeat(40) }] }));
  const config = { projects: [{ id: 'project', name: 'Project', repositoryPath: repo, materials: { installer: { root } } }] };
  await fs.writeFile(configPath, JSON.stringify(config));
  const options = { configPath, operationsDir, limits }, api = createMaterialOperations(options), scope = { projectId: 'project', kind: 'installer' };
  const preview = (extra = {}, service = api) => service.preview({ ...scope, action: 'archive', relativePath: 'package.zip', targetRoot: target, ...extra });
  const run = async (id = 'op', extra = {}, service = api) => service.execute({ ...scope, operationId: id, ticketId: (await preview(extra, service)).ticketId });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, data, root, repo, source, records, target, final: path.join(target, 'package.zip'), config, configPath, operationsDir, options, api, scope, preview, run };
}
async function noFinal(f) { await assert.rejects(fs.stat(f.final), { code: 'ENOENT' }); }
async function hashes(paths) { return Promise.all(paths.map(async p => sha(await fs.readFile(p)))); }
async function waitRunning(f, id) {
  for (let i = 0; i < 300; i++) {
    try { if ((await f.api.query({ ...f.scope, operationId: id })).status === 'running') return; } catch {}
    await new Promise(r => setTimeout(r, 2));
  }
  assert.fail('operation did not enter running');
}

test('archive is byte-identical, preserves originals and records, records only declared provenance', async t => {
  const f = await fixture(t), protectedFiles = [f.source, f.records, f.configPath], before = await hashes(protectedFiles);
  const p = await f.preview();
  assert.equal(p.basename, 'package.zip'); assert.equal(p.declaration.targetVersion, 'v1.2.3'); assert.equal(p.declaration.sourceCommit, 'a'.repeat(40));
  const r = await f.api.execute({ ...f.scope, operationId: 'ok', ticketId: p.ticketId });
  assert.equal(r.archive.state, 'published'); assert.equal(r.integrity, 'no_baseline'); assert.equal(r.status, 'completed'); assert.equal(r.durable, true);
  assert.deepEqual(await fs.readFile(f.final), await fs.readFile(f.source)); assert.equal(r.sha256, sha('archive content'));
  assert.deepEqual(await hashes(protectedFiles), before); assert.equal((await fs.stat(f.final)).nlink, 1);
  assert.deepEqual(await fs.readdir(r.archive.stagingPath), []);
  assert.equal(r.binding.metadata.declaration.installationRecord, undefined); assert.equal(r.binding.metadata.declaration.directFrom, undefined);
  t.diagnostic(JSON.stringify({ sourceAndRecordsBefore: before.slice(0, 2), sourceAndRecordsAfter: (await hashes(protectedFiles)).slice(0, 2), targetSha256: sha(await fs.readFile(f.final)) }));
});
test('explicit matching baseline publishes; mismatch never publishes', async t => {
  const f = await fixture(t);
  const bad = await f.run('bad', { baseline: { sha256: '0'.repeat(64), source: 'explicit declaration' } });
  assert.equal(bad.integrity, 'mismatched'); assert.equal(bad.archive.state, 'not_published'); await noFinal(f);
  assert.equal(bad.archive.stagingRetained, true);
  const good = await f.run('good', { baseline: { sha256: sha('archive content'), source: 'explicit declaration' } });
  assert.equal(good.integrity, 'matched'); assert.equal(good.archive.state, 'published');
});
for (const same of [true, false]) test(`${same ? 'same' : 'different'} existing content is non-destructive ${same ? 'duplicate' : 'conflict'}`, async t => {
  const f = await fixture(t); await fs.writeFile(f.final, same ? 'archive content' : 'old content');
  const files = [f.source, f.final, f.records, f.configPath], before = await hashes(files), old = await fs.stat(f.final);
  const r = await f.run(); assert.equal(r.archive.state, same ? 'duplicate' : 'conflict');
  assert.deepEqual(await hashes(files), before); assert.equal((await fs.stat(f.final)).ino, old.ino);
  t.diagnostic(JSON.stringify({ files: ['source', 'oldTarget', 'records', 'config'], before, after: await hashes(files) }));
});
test('same operation ID after restart only returns timestamped historical facts, without recopy', async t => {
  const f = await fixture(t), result = await f.run('same');
  const record = path.join(f.operationsDir, 'same.json'), before = await fs.readFile(record), entries = await fs.readdir(f.target);
  await fs.unlink(f.final); // fixture simulates an external deletion; query must not restore it
  const restarted = createMaterialOperations(f.options);
  const r = await restarted.execute({ ...f.scope, operationId: 'same', ticketId: 'expired' });
  assert.equal(r.archive.state, 'published'); assert.equal(r.historical, true); assert.equal(r.checkedAt, result.updatedAt);
  assert.deepEqual(await fs.readFile(record), before); await noFinal(f);
  assert.deepEqual(await fs.readdir(f.target), entries.filter(n => n !== 'package.zip'));
});
test('two IDs racing one target publish at most once, preserving both sources', async t => {
  const f = await fixture(t), second = createMaterialOperations(f.options);
  const a = await f.preview(), b = await f.preview({}, second);
  const first = f.api.execute({ ...f.scope, operationId: 'one', ticketId: a.ticketId });
  await waitRunning(f, 'one');
  const other = second.execute({ ...f.scope, operationId: 'two', ticketId: b.ticketId });
  const results = await Promise.all([first, other]);
  assert.equal(results.filter(r => r.archive.state === 'published').length, 1);
  assert.ok(results.every(r => ['published', 'duplicate'].includes(r.archive.state) || r.reason === 'UNSAFE_TARGET'), JSON.stringify(results.map(r => ({ state: r.archive.state, reason: r.reason }))));
  assert.equal(await fs.readFile(f.final, 'utf8'), 'archive content'); assert.equal(await fs.readFile(f.source, 'utf8'), 'archive content');
});
test('same ID contenders preserve original binding and restart unknown never recopy', async t => {
  const f = await fixture(t, { chunkBytes: 1 }, Buffer.alloc(20000));
  const ticket = await f.preview(), input = { ...f.scope, operationId: 'shared', ticketId: ticket.ticketId };
  const promise = f.api.execute(input); await waitRunning(f, 'shared');
  const restarted = createMaterialOperations(f.options), before = await fs.readFile(path.join(f.operationsDir, 'shared.json'));
  assert.equal((await restarted.execute(input)).status, 'unknown'); assert.equal((await restarted.query(input)).status, 'unknown');
  assert.deepEqual(await fs.readFile(path.join(f.operationsDir, 'shared.json')), before);
  await f.api.cancel(input); const result = await promise;
  assert.equal(result.integrity, 'cancelled'); await noFinal(f);
});
for (const targetKind of ['material', 'repo', 'store', 'source-parent', 'symlink', 'final-link', 'final-hardlink', 'missing']) test(`unsafe archive target ${targetKind} refused before intent`, async t => {
  const f = await fixture(t); let targetRoot = f.target;
  if (targetKind === 'material') targetRoot = f.root;
  if (targetKind === 'repo') targetRoot = f.repo;
  if (targetKind === 'store') { await fs.mkdir(f.operationsDir); targetRoot = f.operationsDir; }
  if (targetKind === 'source-parent') targetRoot = f.dir;
  if (targetKind === 'symlink') { targetRoot = path.join(f.dir, 'link'); await fs.symlink(f.target, targetRoot); }
  if (targetKind === 'final-link') await fs.symlink(f.source, f.final);
  if (targetKind === 'final-hardlink') await fs.link(f.source, f.final);
  if (targetKind === 'missing') targetRoot = path.join(f.dir, 'absent');
  await assert.rejects(f.preview({ targetRoot }));
  assert.equal(await fs.readFile(f.source, 'utf8'), 'archive content');
});
test('confirmation refuses target injection; changed root or parent never starts archive', async t => {
  const f = await fixture(t), ticket = await f.preview();
  await assert.rejects(f.api.execute({ ...f.scope, operationId: 'injected', ticketId: ticket.ticketId, targetRoot: f.repo }), { code: 'INVALID_INPUT' });
  await fs.rename(f.target, f.target + '-old'); await fs.mkdir(f.target);
  await assert.rejects(f.api.execute({ ...f.scope, operationId: 'changed', ticketId: ticket.ticketId }), { code: 'TARGET_CHANGED' });
  assert.deepEqual(await fs.readdir(f.target), []);
});
test('changed declaration refuses confirmation; invalid declaration stays unknown', async t => {
  const f = await fixture(t), ticket = await f.preview();
  await fs.writeFile(f.records, 'invalid');
  await assert.rejects(f.api.execute({ ...f.scope, operationId: 'changed', ticketId: ticket.ticketId }), { code: 'DECLARATION_CHANGED' });
  const r = await f.run('unknown'); assert.equal(r.binding.metadata.declaration, null); assert.equal(r.archive.state, 'published');
});
for (const fault of ['read', 'write', 'ENOSPC', 'publish', 'unsupported', 'result']) test(`controlled ${fault} failure preserves originals and reports actual publication`, async t => {
  const f = await fixture(t), before = await hashes([f.source, f.records]);
  const originalOpen = fs.open, originalLink = fs.link, originalRename = fs.rename;
  if (['read', 'write', 'ENOSPC'].includes(fault)) t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (fault === 'read' && args[0] === f.source) handle.read = async () => { throw error('EIO'); };
    if (fault !== 'read' && String(args[0]).endsWith('/payload') && args[1] === 'wx') handle.write = async () => { throw error(fault === 'ENOSPC' ? 'ENOSPC' : 'EIO'); };
    return handle;
  });
  if (['publish', 'unsupported'].includes(fault)) t.mock.method(fs, 'link', async (...args) => { if (args[1] === f.final) throw error(fault === 'unsupported' ? 'ENOTSUP' : 'EIO'); return originalLink(...args); });
  if (fault === 'result') t.mock.method(fs, 'rename', async (...args) => { if (args[1] === path.join(f.operationsDir, 'op.json')) throw error('ENOSPC'); return originalRename(...args); });
  const result = await f.run(); t.mock.restoreAll();
  assert.deepEqual(await hashes([f.source, f.records]), before);
  if (fault === 'result') {
    assert.equal(result.archive.state, 'published'); assert.equal(result.status, 'partial'); assert.equal(result.durable, false); assert.equal(result.reason, 'RESULT_NOT_PERSISTED');
    assert.equal(await fs.readFile(f.final, 'utf8'), 'archive content');
    const restart = createMaterialOperations(f.options), entries = await fs.readdir(f.target);
    assert.equal((await restart.execute({ ...f.scope, operationId: 'op' })).status, 'unknown');
    assert.deepEqual(await fs.readdir(f.target), entries);
  } else { await noFinal(f); assert.notEqual(result.archive.state, 'published'); assert.equal(result.reason, fault === 'unsupported' ? 'SAFE_PUBLICATION_UNAVAILABLE' : fault === 'ENOSPC' ? 'ENOSPC' : 'EIO'); }
});
test('initial intent failure produces no staging and no target', async t => {
  const f = await fixture(t); await fs.mkdir(f.operationsDir); await fs.mkdir(path.join(f.operationsDir, '.create-lock'));
  await assert.rejects(f.run(), { code: 'STORE_BUSY' }); assert.deepEqual(await fs.readdir(f.target), []);
});
for (const scenario of ['size', 'timeout', 'cancel', 'root-change', 'parent-change']) test(`during copy ${scenario} prevents publication`, async t => {
  const f = await fixture(t, { chunkBytes: 1, ...(scenario === 'timeout' ? { timeoutMs: 50 } : {}) }, Buffer.alloc(10000));
  const ticket = await f.preview(), input = { ...f.scope, operationId: scenario, ticketId: ticket.ticketId };
  const promise = f.api.execute(input); await waitRunning(f, scenario);
  if (scenario === 'size') await fs.appendFile(f.source, 'changed');
  if (scenario === 'cancel') await f.api.cancel(input);
  if (scenario === 'root-change') { await fs.rename(f.target, f.target + '-old'); await fs.mkdir(f.target); }
  if (scenario === 'parent-change') { await fs.rename(f.target, f.target + '-old'); await fs.symlink(f.repo, f.target); }
  const r = await promise;
  assert.notEqual(r.archive.state, 'published'); await noFinal(f);
  if (scenario === 'timeout') assert.equal(r.integrity, 'timeout');
  if (scenario === 'cancel') assert.equal(r.integrity, 'cancelled');
});
test('byte limit starts no staging; post-publication cancellation reports published fact', async t => {
  const small = await fixture(t, { maxBytes: 2 }); const limited = await small.run();
  assert.equal(limited.integrity, 'limit_exceeded'); assert.deepEqual(await fs.readdir(small.target), []);
  const f = await fixture(t), original = fs.link;
  t.mock.method(fs, 'link', async (...args) => {
    const r = await original(...args);
    if (args[1] === f.final) await f.api.cancel({ ...f.scope, operationId: 'op' });
    return r;
  });
  const r = await f.run(); assert.equal(r.archive.state, 'published'); assert.equal(r.reason, 'CANCELLED_AFTER_PUBLICATION');
});
test('metadata digest is never an implicit baseline and absent provenance remains null', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.records, JSON.stringify({ schemaVersion: 1, records: [{ kind: 'installer', file: 'package.zip', recordedFile: { sizeBytes: 15, sha256: '0'.repeat(64) } }] }));
  const r = await f.run(); assert.equal(r.integrity, 'no_baseline'); assert.equal(r.archive.state, 'published');
  assert.equal(r.binding.metadata.declaration.targetVersion, null); assert.equal(r.binding.metadata.declaration.revision, null); assert.equal(r.binding.metadata.declaration.sourceCommit, null);
});
test('target parent replacement and symlinked registered repository overlap are refused', async t => {
  const f = await fixture(t), parent = path.join(f.dir, 'parent'), target = path.join(parent, 'archive');
  await fs.mkdir(parent); await fs.mkdir(target);
  const ticket = await f.preview({ targetRoot: target });
  await fs.rename(parent, parent + '-old'); await fs.mkdir(parent); await fs.mkdir(target);
  await assert.rejects(f.api.execute({ ...f.scope, operationId: 'parent', ticketId: ticket.ticketId }), { code: 'TARGET_CHANGED' });
  const realRepo = path.join(f.dir, 'real-repo'); await fs.rename(f.repo, realRepo); await fs.symlink(realRepo, f.repo);
  await assert.rejects(f.preview({ targetRoot: realRepo }), { code: 'UNSAFE_TARGET' });
});
test('publish collision created by another writer is never overwritten', async t => {
  const f = await fixture(t), original = fs.link;
  t.mock.method(fs, 'link', async (...args) => {
    if (args[1] === f.final) await fs.writeFile(f.final, 'external writer', { flag: 'wx' });
    return original(...args);
  });
  const r = await f.run(); assert.equal(r.archive.state, 'conflict'); assert.equal(await fs.readFile(f.final, 'utf8'), 'external writer');
});
test('uncertain link result is partial unknown, never removes published bytes or retries ID', async t => {
  const f = await fixture(t), original = fs.link;
  t.mock.method(fs, 'link', async (...args) => { await original(...args); throw error('EIO'); });
  const r = await f.run(); t.mock.restoreAll();
  assert.equal(r.status, 'partial'); assert.equal(r.archive.state, 'unknown'); assert.equal(r.archive.stagingRetained, true);
  assert.equal(await fs.readFile(f.final, 'utf8'), 'archive content');
  const before = await fs.readdir(f.target), restart = createMaterialOperations(f.options);
  assert.equal((await restart.execute({ ...f.scope, operationId: 'op' })).status, 'partial');
  assert.deepEqual(await fs.readdir(f.target), before);
});
test('source replacement during streaming prevents publication, preserving external replacement', async t => {
  const f = await fixture(t), original = fs.open; let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const h = await original(...args);
    if (args[0] === f.source) {
      const read = h.read.bind(h);
      h.read = async (...params) => {
        const r = await read(...params);
        if (!changed && r.bytesRead) { changed = true; await fs.rename(f.source, f.source + '-original'); await fs.writeFile(f.source, 'external replacement'); }
        return r;
      };
    }
    return h;
  });
  const r = await f.run(); assert.notEqual(r.archive.state, 'published'); await noFinal(f);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'external replacement'); assert.equal(await fs.readFile(f.source + '-original', 'utf8'), 'archive content');
});
test('staging corruption is detected and safe-publication fallback never uses rename', async t => {
  const f = await fixture(t), original = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const h = await original(...args);
    if (String(args[0]).endsWith('/payload') && args[1] === 'wx') {
      const sync = h.sync.bind(h);
      h.sync = async () => { await h.write(Buffer.from('X'), 0, 1, 0); return sync(); };
    }
    return h;
  });
  const r = await f.run(); assert.equal(r.reason, 'COPY_MISMATCH'); await noFinal(f);
});
test('existing target identity is bound at preview and may not be replaced before confirm', async t => {
  const f = await fixture(t); await fs.writeFile(f.final, 'old target'); const p = await f.preview();
  assert.equal(p.targetExists, true);
  await fs.rename(f.final, f.final + '-old'); await fs.writeFile(f.final, 'replacement');
  await assert.rejects(f.api.execute({ ...f.scope, operationId: 'replace', ticketId: p.ticketId }), { code: 'TARGET_CHANGED' });
  assert.equal(await fs.readFile(f.final, 'utf8'), 'replacement'); assert.equal(await fs.readFile(f.final + '-old', 'utf8'), 'old target');
});
for (const phase of ['before-link', 'after-link']) test(`actual process termination ${phase} leaves query-only unknown intent`, async t => {
  const f = await fixture(t), module = new URL('../server/materials/operations.js', import.meta.url).href;
  const script = `import fs from 'node:fs/promises';
    import { createMaterialOperations } from ${JSON.stringify(module)};
    const service = createMaterialOperations(${JSON.stringify(f.options)});
    const scope = ${JSON.stringify(f.scope)};
    const ticket = await service.preview({ ...scope, action: 'archive', relativePath: 'package.zip', targetRoot: ${JSON.stringify(f.target)} });
    const link = fs.link;
    fs.link = async (...args) => {
      ${phase === 'after-link' ? 'await link(...args);' : ''}
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    };
    await service.execute({ ...scope, operationId: 'crashed', ticketId: ticket.ticketId });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(exit.signal, 'SIGKILL', stderr);
  const record = path.join(f.operationsDir, 'crashed.json'), before = await fs.readFile(record), entries = await fs.readdir(f.target);
  const restart = createMaterialOperations(f.options);
  const r = await restart.execute({ ...f.scope, operationId: 'crashed', ticketId: 'missing' });
  assert.equal(r.status, 'unknown'); assert.equal(r.historical, true);
  assert.deepEqual(await fs.readFile(record), before); assert.deepEqual(await fs.readdir(f.target), entries);
  if (phase === 'after-link') assert.equal(await fs.readFile(f.final, 'utf8'), 'archive content'); else await noFinal(f);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'archive content');
});
for (const child of ['', 'commit-operations', 'archives', 'future/archives']) test(`tool data target ${child || 'root'} is refused without altering either store`, async t => {
  const f = await fixture(t), commitStore = path.join(f.data, 'commit-operations');
  await fs.mkdir(commitStore); await fs.mkdir(f.operationsDir);
  const commitRecord = path.join(commitStore, 'existing.json'), materialRecord = path.join(f.operationsDir, 'existing.json');
  await fs.writeFile(commitRecord, 'protected commit evidence'); await fs.writeFile(materialRecord, 'protected material evidence');
  const target = path.join(f.data, child); await fs.mkdir(target, { recursive: true });
  const files = [f.source, f.records, commitRecord, materialRecord], before = await hashes(files);
  await assert.rejects(f.preview({ targetRoot: target }), { code: 'UNSAFE_TARGET' });
  assert.deepEqual(await hashes(files), before);
  assert.deepEqual(await fs.readdir(f.operationsDir), ['existing.json']);
  assert.deepEqual(await fs.readdir(commitStore), ['existing.json']);
});
test('trusted injected commit store and its ancestors/descendants are protected, including future stores', async t => {
  const f = await fixture(t), outer = path.join(f.dir, 'external-data'), commitOperationsDir = path.join(outer, 'future', 'commit-operations');
  await fs.mkdir(outer);
  const api = createMaterialOperations({ ...f.options, commitOperationsDir });
  await assert.rejects(f.preview({ targetRoot: outer }, api), { code: 'UNSAFE_TARGET' });
  await assert.rejects(fs.stat(path.join(outer, 'future')), { code: 'ENOENT' });
  await fs.mkdir(path.join(commitOperationsDir, 'archives'), { recursive: true });
  for (const targetRoot of [commitOperationsDir, path.join(commitOperationsDir, 'archives')]) await assert.rejects(f.preview({ targetRoot }, api), { code: 'UNSAFE_TARGET' });
  assert.equal((await f.run('outside', {}, api)).archive.state, 'published');
  assert.throws(() => createMaterialOperations({ ...f.options, commitOperationsDir: 'relative' }), { code: 'INVALID_STORE' });
});
test('commit-store ancestor remapping after preview refuses confirm before intent or target writes', async t => {
  const f = await fixture(t), external = path.join(f.dir, 'external-data'), elsewhere = path.join(f.dir, 'elsewhere');
  await fs.mkdir(external); await fs.mkdir(elsewhere);
  const api = createMaterialOperations({ ...f.options, commitOperationsDir: path.join(external, 'future-store') });
  const ticket = await f.preview({}, api);
  await fs.rename(external, external + '-old'); await fs.symlink(elsewhere, external);
  await assert.rejects(api.execute({ ...f.scope, operationId: 'remapped', ticketId: ticket.ticketId }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(f.target), []); assert.deepEqual(await fs.readdir(elsewhere), []);
  await assert.rejects(fs.stat(f.operationsDir), { code: 'ENOENT' });
});
test('runtime remapping of injected commit root stops before publication', async t => {
  const f = await fixture(t), external = path.join(f.dir, 'external-data'), elsewhere = path.join(f.dir, 'elsewhere');
  await fs.mkdir(external); await fs.mkdir(elsewhere);
  const api = createMaterialOperations({ ...f.options, commitOperationsDir: path.join(external, 'future-store') });
  const originalOpen = fs.open; let remapped = false;
  t.mock.method(fs, 'open', async (...args) => {
    const h = await originalOpen(...args);
    if (args[0] === f.source) {
      const originalRead = h.read.bind(h);
      h.read = async (...params) => {
        const result = await originalRead(...params);
        if (!remapped) { remapped = true; await fs.rename(external, external + '-old'); await fs.symlink(elsewhere, external); }
        return result;
      };
    }
    return h;
  });
  const r = await f.run('runtime-remap', {}, api);
  assert.equal(remapped, true); assert.notEqual(r.archive.state, 'published'); assert.equal(r.reason, 'UNSAFE_PATH');
  await noFinal(f); assert.deepEqual(await fs.readdir(elsewhere), []);
});
