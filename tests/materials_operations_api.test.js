import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAppServer } from '../server/app.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const route = (action, project = 'project', kind = 'installer') => `/api/projects/${project}/materials/${kind}/operations/${action}`;
async function fixture(t, { customStore = false, customCommitStore = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-api-'));
  const root = path.join(dir, 'materials'), repo = path.join(dir, 'repo'), target = path.join(dir, 'target');
  const dataRoot = path.join(dir, 'data');
  const configPath = path.join(dataRoot, 'projects.json'), operationsDir = customStore ? path.join(dir, 'custom-store') : path.join(dataRoot, 'material-operations');
  const commitOperationsDir = customCommitStore ? path.join(dir, 'p3-zone', 'commit-operations') : path.join(dataRoot, 'commit-operations');
  for (const p of [root, repo, target, dataRoot]) await fs.mkdir(p);
  await fs.writeFile(path.join(root, 'file.bin'), 'content');
  await fs.writeFile(path.join(root, 'material-records.json'), '{"protected":true}');
  const config = { projects: ['project', 'other'].map(id => ({ id, name: id, repositoryPath: repo, materials: { installer: { root }, upgrade: { root } } })) };
  const save = () => fs.writeFile(configPath, JSON.stringify(config));
  await save();
  let app, port;
  const stop = async () => { if (app) { const server = app.server; app = null; await new Promise(r => server.close(r)); } };
  const start = async () => {
    app = createAppServer({ configPath, ...(customCommitStore ? { operationsDir: commitOperationsDir } : {}), ...(customStore ? { materialOperationsDir: operationsDir } : {}) });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    port = app.server.address().port; app.setListeningPort(port);
  };
  await start();
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = (url, { method = 'GET', body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const defaults = { host: `127.0.0.1:${port}` };
    if (method === 'POST') Object.assign(defaults, { origin: `http://127.0.0.1:${port}`, 'x-local-intent': 'material-operations', 'content-type': 'application/json' });
    const finalHeaders = { ...defaults, ...headers };
    for (const k of Object.keys(finalHeaders)) if (finalHeaders[k] === null) delete finalHeaders[k];
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined && !finalHeaders['content-length'] && !finalHeaders['transfer-encoding']) finalHeaders['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method,
      headers: Object.entries(finalHeaders).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).flatMap(x => [k, x])) }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null, text, headers: res.headers }));
    });
    req.on('error', reject); req.end(payload);
  });
  const preview = async (extra = {}) => {
    const res = await request(route('preview'), { method: 'POST', body: { action: 'integrity', relativePath: 'file.bin', ...extra } });
    assert.equal(res.status, 200, res.text); return res.json;
  };
  const confirm = (ticket, operationId = 'op', project = 'project', kind = 'installer') => request(route('confirm', project, kind), { method: 'POST', body: { ticketId: ticket.ticketId, operationId } });
  const noStore = () => assert.rejects(fs.stat(operationsDir), { code: 'ENOENT' });
  const noLeak = response => {
    for (const forbidden of [dir, root, repo, configPath, target, '"binding"', '"stagingPath"', '"targetPath"', '"stack"']) assert.ok(!response.text.includes(forbidden), response.text);
  };
  return { dir, dataRoot, root, repo, target, configPath, operationsDir, commitOperationsDir, config, save, stop, start, request, preview, confirm, noStore, noLeak, get port() { return port; } };
}
const baseline = { sha256: sha('content'), source: 'Explicitly accepted release digest' };

test('integrity HTTP loop, duplicate/restart historical read-only query and protected hashes', async t => {
  const f = await fixture(t, { customStore: true });
  const protectedFiles = [f.configPath, path.join(f.root, 'file.bin'), path.join(f.root, 'material-records.json')];
  const before = await Promise.all(protectedFiles.map(async p => sha(await fs.readFile(p))));
  const preview = await f.preview({ baseline });
  assert.deepEqual(preview.baseline, baseline); assert.equal(preview.limits.maxBytes, 1024 ** 3);
  await f.noStore();
  const result = await f.confirm(preview);
  assert.equal(result.status, 200); assert.equal(result.json.integrity, 'matched'); assert.equal(result.json.durable, true);
  assert.equal(result.json.historical, true); assert.equal(result.json.checkedAt, result.json.updatedAt); f.noLeak(result);
  const saved = await fs.readFile(path.join(f.operationsDir, 'op.json'));
  assert.equal((await f.confirm(preview)).json.integrity, 'matched');
  await f.stop(); await f.start();
  const queried = await f.request(route('op')); assert.equal(queried.json.integrity, 'matched'); f.noLeak(queried);
  assert.deepEqual(await fs.readFile(path.join(f.operationsDir, 'op.json')), saved);
  assert.equal((await f.confirm(preview)).json.integrity, 'matched');
  const cancelled = await f.request(route('op/cancel'), { method: 'POST', body: {} });
  assert.equal(cancelled.json.cancellation.state, 'already_finished'); assert.equal(cancelled.json.integrity, 'matched');
  assert.deepEqual(await Promise.all(protectedFiles.map(async p => sha(await fs.readFile(p)))), before);
  t.diagnostic(JSON.stringify({ protectedBefore: before, protectedAfter: before }));
});

test('missing query/cancel never create stores or config locks; no baseline and mismatch are completed facts', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(route('missing'))).json.status, 'not_started');
  assert.equal((await f.request(route('missing/cancel'), { method: 'POST', body: {} })).json.status, 'not_started');
  await f.noStore(); await assert.rejects(fs.stat(path.join(f.dataRoot, 'projects.lock')), { code: 'ENOENT' });
  const computed = await f.confirm(await f.preview(), 'computed');
  assert.equal(computed.json.integrity, 'no_baseline'); assert.equal(computed.json.baseline, null);
  const mismatch = await f.confirm(await f.preview({ baseline: { ...baseline, sha256: '0'.repeat(64) } }), 'mismatch');
  assert.equal(mismatch.status, 200); assert.equal(mismatch.json.status, 'completed'); assert.equal(mismatch.json.integrity, 'mismatched');
});

test('archive explicit target preview, publication, duplicate and conflict do not leak paths or overwrite', async t => {
  const f = await fixture(t);
  const p = await f.preview({ action: 'archive', targetRoot: f.target, baseline });
  assert.equal(p.basename, 'file.bin'); assert.equal(p.targetExists, false); assert.equal(p.targetRoot, undefined);
  assert.deepEqual(await fs.readdir(f.target), []);
  const published = await f.confirm(p, 'archive');
  assert.equal(published.json.archive.state, 'published', published.text); f.noLeak(published);
  assert.equal(await fs.readFile(path.join(f.target, 'file.bin'), 'utf8'), 'content');
  const duplicate = await f.confirm(await f.preview({ action: 'archive', targetRoot: f.target }), 'duplicate');
  assert.equal(duplicate.json.archive.state, 'duplicate'); f.noLeak(duplicate);
  await fs.writeFile(path.join(f.target, 'file.bin'), 'old target');
  const conflict = await f.confirm(await f.preview({ action: 'archive', targetRoot: f.target }), 'conflict');
  assert.equal(conflict.json.archive.state, 'conflict'); assert.equal(conflict.json.reason, 'TARGET_CONFLICT'); f.noLeak(conflict);
  assert.equal(await fs.readFile(path.join(f.target, 'file.bin'), 'utf8'), 'old target');
});

test('POST header and size boundaries before configuration reads', async t => {
  const f = await fixture(t); await fs.writeFile(f.configPath, 'broken');
  const body = { action: 'integrity', relativePath: 'file.bin' };
  const cases = [
    [{ origin: null }, 403], [{ origin: 'null' }, 403], [{ origin: `HTTP://127.0.0.1:${f.port}` }, 403],
    [{ 'x-local-intent': null }, 400], [{ 'x-local-intent': 'git-commit' }, 400],
    [{ 'content-type': 'text/plain' }, 415], [{ 'content-type': 'application/json; charset=latin1' }, 415],
    [{ 'sec-fetch-site': 'cross-site' }, 403], [{ host: 'example.com' }, 403], [{ host: [`127.0.0.1:${f.port}`, `127.0.0.1:${f.port}`] }, 403],
  ];
  for (const [headers, status] of cases) {
    const r = await f.request(route('preview'), { method: 'POST', body, headers }); assert.equal(r.status, status, r.text); f.noLeak(r);
  }
  assert.equal((await f.request(route('preview'), { method: 'POST', raw: '{' })).json.error.code, 'JSON_SYNTAX_ERROR');
  const large = await f.request(route('preview'), { method: 'POST', raw: ' '.repeat(8193), headers: { 'transfer-encoding': 'chunked' } });
  assert.equal(large.status, 413); assert.equal(large.headers.connection, 'close');
  assert.equal((await f.request(route('preview'), { method: 'POST', raw: ' '.repeat(8193), headers: { 'content-length': '8193' } })).status, 413);
  await f.noStore(); assert.deepEqual(await fs.readdir(f.target), []);
});

test('strict preview/confirm/cancel field allowlists, enums and portable paths reject before config/store', async t => {
  const f = await fixture(t); await fs.writeFile(f.configPath, 'broken');
  const base = { action: 'integrity', relativePath: 'file.bin' };
  const invalid = [null, [], {}, { ...base, arbitrary: true }, { ...base, sourceRoot: f.root }, { ...base, action: 'execute' },
    { ...base, baseline: null }, { ...base, baseline: { ...baseline, extra: true } }, { ...base, baseline: { sha256: 'bad', source: 'x' } },
    { ...base, baseline: { ...baseline, source: ' '.repeat(512) } }, { ...base, baseline: { ...baseline, source: 'x'.repeat(513) } },
    { ...base, targetRoot: f.target }, { ...base, action: 'archive' }, { ...base, action: 'archive', targetRoot: 'relative' },
    { ...base, action: 'archive', targetRoot: '/'.repeat(4097) }];
  for (const relativePath of ['/etc/passwd', '../secret', 'x/../file', 'x//file', 'x/./file', 'C:\\file', 'x\\file', 'NUL', 'dir/CON.txt', 'COM¹.log', 'CONIN$', 'a.', 'a ', 'x\0', 'x\n', 'https://host/x', 'a'.repeat(1025)]) invalid.push({ ...base, relativePath });
  for (const body of invalid) assert.equal((await f.request(route('preview'), { method: 'POST', body })).json.error.code, 'INVALID_INPUT', JSON.stringify(body));
  for (const body of [{}, { ticketId: 'bad', operationId: 'id' }, { ticketId: crypto.randomUUID(), operationId: '../id' },
    { ticketId: crypto.randomUUID(), operationId: 'id', targetRoot: f.target }, ...['preview', 'confirm'].map(operationId => ({ ticketId: crypto.randomUUID(), operationId }))]) {
    assert.equal((await f.request(route('confirm'), { method: 'POST', body })).json.error.code, 'INVALID_INPUT');
  }
  assert.equal((await f.request(route('id/cancel'), { method: 'POST', body: { force: true } })).json.error.code, 'INVALID_INPUT');
  for (const id of ['preview', 'confirm']) assert.equal((await f.request(route(`${id}/cancel`), { method: 'POST', body: {} })).json.error.code, 'INVALID_INPUT');
  await f.noStore();
});

test('method/query/routing failures are closed and preserve P2 routing', async t => {
  const f = await fixture(t); await fs.writeFile(f.configPath, 'broken');
  for (const [endpoint, method, allow] of [['preview', 'GET', 'POST'], ['confirm', 'PUT', 'POST'], ['id', 'POST', 'GET'], ['id/cancel', 'GET', 'POST']]) {
    const r = await f.request(route(endpoint), { method, body: {} }); assert.equal(r.status, 405); assert.equal(r.headers.allow, allow);
  }
  assert.equal((await f.request(route('preview') + '?root=anything', { method: 'POST', body: {} })).status, 400);
  for (const url of [route('preview', 'Bad'), route('preview', 'project', 'bad'), route('a/extra'), route('')]) assert.equal((await f.request(url)).status, 404);
  await f.noStore();
});

test('unknown project, missing association, cross scope ticket/record and stale source refuse safely', async t => {
  const f = await fixture(t);
  const p = await f.preview();
  const missing = await f.request(route('preview', 'absent'), { method: 'POST', body: { action: 'integrity', relativePath: 'file.bin' } });
  assert.equal(missing.status, 404); assert.equal(missing.json.error.code, 'PROJECT_NOT_FOUND'); f.noLeak(missing);
  for (const [project, kind] of [['other', 'installer'], ['project', 'upgrade']]) {
    assert.equal((await f.confirm(p, 'scope', project, kind)).json.error.code, 'PREVIEW_SCOPE_MISMATCH');
  }
  await f.noStore();
  assert.equal((await f.confirm(p)).status, 200);
  for (const [project, kind] of [['other', 'installer'], ['project', 'upgrade']]) {
    assert.equal((await f.request(route('op', project, kind))).json.error.code, 'OPERATION_SCOPE_MISMATCH');
    assert.equal((await f.request(route('op/cancel', project, kind), { method: 'POST', body: {} })).json.error.code, 'OPERATION_SCOPE_MISMATCH');
  }
  const stale = await f.preview(); await fs.writeFile(path.join(f.root, 'file.bin'), 'changed');
  assert.equal((await f.confirm(stale, 'stale')).json.error.code, 'SOURCE_CHANGED');
  await assert.rejects(fs.stat(path.join(f.operationsDir, 'stale.json')), { code: 'ENOENT' });
  delete f.config.projects[0].materials; await f.save();
  const historical = await f.request(route('op'));
  assert.equal(historical.status, 200); assert.equal(historical.json.status, 'completed');
  assert.equal(historical.json.historical, true); assert.equal(historical.json.associationCurrent, false);
  assert.equal((await f.request(route('unknown'))).json.status, 'not_started');
});

// Deterministic I/O gate pauses only the fixture's source read, never production paths.
async function gateSource(t, f) {
  const originalOpen = fs.open;
  let release, entered;
  const gate = new Promise(r => { release = r; }), seen = new Promise(r => { entered = r; });
  fs.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (file === path.join(f.root, 'file.bin')) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { entered(); await gate; return read(...readArgs); };
    }
    return handle;
  };
  t.after(() => { release(); fs.open = originalOpen; });
  return { seen, release, restore() { release(); fs.open = originalOpen; } };
}

test('concurrent confirm/query/duplicate/busy/cancel, cross scope cancellation and restart unknown', async t => {
  const f = await fixture(t), p = await f.preview(), second = await f.preview();
  const gate = await gateSource(t, f);
  const running = f.confirm(p, 'running'); await gate.seen;
  const q = await f.request(route('running')); assert.equal(q.status, 202); assert.equal(q.json.status, 'running'); f.noLeak(q);
  const duplicate = await f.confirm(p, 'running'); assert.equal(duplicate.status, 202);
  const busy = await f.confirm(second, 'other-id'); assert.equal(busy.json.status, 'busy'); assert.equal(busy.json.error.code, 'OPERATION_BUSY');
  const wrong = await f.request(route('running/cancel', 'other'), { method: 'POST', body: {} }); assert.equal(wrong.json.error.code, 'OPERATION_SCOPE_MISMATCH');
  const cancel = await f.request(route('running/cancel'), { method: 'POST', body: {} }); assert.equal(cancel.json.cancellation.cooperative, true);
  gate.release();
  const result = await running; assert.equal(result.json.integrity, 'cancelled'); assert.equal(result.json.durable, true); f.noLeak(result); gate.restore();
  // A checksum-valid persisted running record simulates process exit mid-operation.
  const file = path.join(f.operationsDir, 'running.json');
  const envelope = JSON.parse(await fs.readFile(file, 'utf8')), record = JSON.parse(envelope.payload);
  record.status = 'running'; record.integrity = null; const payload = JSON.stringify(record);
  await fs.writeFile(file, JSON.stringify({ payload, sha256: sha(payload) }));
  await f.stop(); await f.start(); const before = await fs.readFile(file);
  const unknown = await f.request(route('running')); assert.equal(unknown.status, 409); assert.equal(unknown.json.status, 'unknown'); assert.equal(unknown.json.reason, 'INTERRUPTED_OR_OTHER_INSTANCE');
  assert.equal((await f.confirm(p, 'running')).json.status, 'unknown');
  assert.deepEqual(await fs.readFile(file), before);
});

test('configuration remap during operation and later query cannot become current-source proof', async t => {
  const f = await fixture(t); const p = await f.preview({ baseline }), unused = await f.preview();
  const gate = await gateSource(t, f), running = f.confirm(p, 'remap'); await gate.seen;
  const replacement = path.join(f.dir, 'replacement'); await fs.mkdir(replacement); await fs.writeFile(path.join(replacement, 'file.bin'), 'content');
  f.config.projects[0].materials.installer.root = replacement; await f.save();
  gate.release(); const result = await running; gate.restore();
  assert.equal(result.json.associationCurrent, false); assert.equal(result.json.integrity, 'changed'); assert.equal(result.json.sha256, null); f.noLeak(result);
  const old = await f.request(route('remap')); assert.equal(old.json.associationCurrent, false); assert.equal(old.json.historical, true);
  assert.equal((await f.confirm(unused, 'stale-remap')).json.error.code, 'SOURCE_CHANGED');
  assert.equal(await fs.readFile(f.configPath, 'utf8'), JSON.stringify(f.config));
});

test('historical matched is timestamped even when same-root source later changes', async t => {
  const f = await fixture(t); const r = await f.confirm(await f.preview({ baseline }));
  await fs.writeFile(path.join(f.root, 'file.bin'), 'new content');
  const q = await f.request(route('op')); assert.equal(q.json.integrity, 'matched');
  assert.equal(q.json.historical, true); assert.equal(q.json.checkedAt, r.json.updatedAt);
  assert.equal(q.json.sourceFresh, undefined); assert.equal(q.json.verified, undefined);
});

test('copy failure truthful nonpublication and no raw syscall error or absolute paths', async t => {
  const f = await fixture(t); const p = await f.preview({ action: 'archive', targetRoot: f.target });
  const original = fs.open;
  fs.open = async function(file, ...args) { if (String(file).startsWith(f.target + path.sep) && path.basename(file) === 'payload') throw Object.assign(new Error(`SECRET ${f.target}`), { code: 'EIO' }); return original.call(this, file, ...args); };
  t.after(() => { fs.open = original; });
  const r = await f.confirm(p, 'copy-failure'); fs.open = original;
  assert.equal(r.json.archive.state, 'not_published'); assert.equal(r.json.integrity, 'unreadable'); assert.equal(r.json.reason, 'MATERIAL_OPERATION_UNKNOWN'); f.noLeak(r); assert.ok(!r.text.includes('SECRET'));
  await assert.rejects(fs.stat(path.join(f.target, 'file.bin')), { code: 'ENOENT' });
});

test('result persistence failure returns partial and restart only queries unknown', async t => {
  const f = await fixture(t); const p = await f.preview(); const original = fs.rename;
  fs.rename = async function(from, to) { if (to === path.join(f.operationsDir, 'failed.json')) throw new Error(`SECRET ${f.configPath}`); return original.call(this, from, to); };
  t.after(() => { fs.rename = original; });
  const r = await f.confirm(p, 'failed'); fs.rename = original;
  assert.equal(r.status, 409); assert.equal(r.json.status, 'partial'); assert.equal(r.json.durable, false); assert.equal(r.json.reason, 'RESULT_NOT_PERSISTED'); f.noLeak(r);
  await f.stop(); await f.start();
  assert.equal((await f.request(route('failed'))).json.status, 'unknown');
});

test('store corruption/creation errors fail closed with original operation ID and no leaked internals', async t => {
  const f = await fixture(t); await fs.writeFile(f.operationsDir, 'not a directory');
  const p = await f.preview(); const failed = await f.confirm(p, 'failure');
  assert.equal(failed.status, 409); assert.equal(failed.json.status, 'unknown'); assert.equal(failed.json.operationId, 'failure'); f.noLeak(failed);
  await fs.unlink(f.operationsDir); await f.stop(); await f.start();
  await f.confirm(await f.preview(), 'corrupt'); await fs.writeFile(path.join(f.operationsDir, 'corrupt.json'), 'broken');
  const corrupt = await f.request(route('corrupt')); assert.equal(corrupt.json.error.code, 'STORE_CORRUPT'); f.noLeak(corrupt);
});

test('target binding changes and protected target/source symlinks never create operation records', async t => {
  const f = await fixture(t);
  const p = await f.preview({ action: 'archive', targetRoot: f.target });
  await fs.rename(f.target, f.target + '-old'); await fs.mkdir(f.target);
  assert.equal((await f.confirm(p)).json.error.code, 'TARGET_CHANGED'); await f.noStore();
  for (const targetRoot of [f.root, f.repo, f.dir]) {
    const r = await f.request(route('preview'), { method: 'POST', body: { action: 'archive', relativePath: 'file.bin', targetRoot } });
    assert.equal(r.json.error.code, 'UNSAFE_TARGET'); f.noLeak(r);
  }
  await fs.symlink(path.join(f.root, 'file.bin'), path.join(f.root, 'link.bin'));
  assert.equal((await f.request(route('preview'), { method: 'POST', body: { action: 'integrity', relativePath: 'link.bin' } })).json.error.code, 'UNSAFE_PATH');
  await f.noStore();
});


test('confirm and cancel independently require exact Origin, material intent, JSON and allowlists', async t => {
  const f = await fixture(t); await fs.writeFile(f.configPath, 'broken');
  for (const [endpoint, body] of [['confirm', { ticketId: crypto.randomUUID(), operationId: 'safe-id' }], ['safe-id/cancel', {}]]) {
    for (const [headers, expected] of [[{ origin: null }, 403], [{ 'x-local-intent': 'project-onboarding' }, 400], [{ 'content-type': 'text/plain' }, 415]]) {
      const r = await f.request(route(endpoint), { method: 'POST', body, headers }); assert.equal(r.status, expected); f.noLeak(r);
    }
    const oversized = await f.request(route(endpoint), { method: 'POST', raw: ' '.repeat(8193), headers: { 'transfer-encoding': 'chunked' } });
    assert.equal(oversized.status, 413);
  }
  await f.noStore();
});

test('material operations never acquire or alter an existing global config lock', async t => {
  const f = await fixture(t), lock = path.join(f.dataRoot, 'projects.lock');
  await fs.writeFile(lock, 'owned by another config writer');
  const result = await f.confirm(await f.preview()); assert.equal(result.json.integrity, 'no_baseline');
  assert.equal((await f.request(route('op'))).status, 200);
  assert.equal(await fs.readFile(lock, 'utf8'), 'owned by another config writer');
});

test('transport allowlist drops nested record internals and inconsistent matched result fails closed', async t => {
  const f = await fixture(t); await f.confirm(await f.preview({ baseline }));
  const file = path.join(f.operationsDir, 'op.json'), envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  const record = JSON.parse(envelope.payload);
  Object.assign(record, { arbitrary: f.configPath, reason: `raw error ${f.root}`, stack: f.repo,
    archive: { state: 'unknown', targetPath: f.target, stagingPath: f.dir, arbitrary: f.repo, checkedAt: null, stagingRetained: true } });
  const save = async () => { const payload = JSON.stringify(record); await fs.writeFile(file, JSON.stringify({ payload, sha256: sha(payload) })); };
  await save(); const response = await f.request(route('op')); f.noLeak(response);
  assert.equal(response.json.reason, 'MATERIAL_OPERATION_UNKNOWN'); assert.equal(response.json.archive.basename, 'file.bin');
  record.baseline = null; await save(); const inconsistent = await f.request(route('op'));
  assert.equal(inconsistent.status, 409); assert.equal(inconsistent.json.status, 'unknown'); assert.equal(inconsistent.json.integrity, null);
});

test('archive cooperative cancellation retains evidence without publishing or deleting old target', async t => {
  const f = await fixture(t), p = await f.preview({ action: 'archive', targetRoot: f.target });
  const gate = await gateSource(t, f), running = f.confirm(p, 'cancel-copy'); await gate.seen;
  const cancelled = await f.request(route('cancel-copy/cancel'), { method: 'POST', body: {} });
  assert.equal(cancelled.json.status, 'running'); gate.release();
  const result = await running; gate.restore();
  assert.equal(result.json.integrity, 'cancelled'); assert.equal(result.json.archive.state, 'not_published');
  assert.equal(result.json.archive.stagingRetained, true); f.noLeak(result);
  await assert.rejects(fs.stat(path.join(f.target, 'file.bin')), { code: 'ENOENT' });
});

test('failure after archive publication returns partial unknown and preserves actual target', async t => {
  const f = await fixture(t), p = await f.preview({ action: 'archive', targetRoot: f.target });
  const original = fs.unlink;
  fs.unlink = async function(file, ...args) {
    if (String(file).startsWith(f.target + path.sep) && path.basename(file) === 'payload') throw Object.assign(new Error(`SECRET ${file}`), { code: 'EIO' });
    return original.call(this, file, ...args);
  };
  t.after(() => { fs.unlink = original; });
  const result = await f.confirm(p, 'published-uncertain'); fs.unlink = original;
  assert.equal(result.status, 409); assert.equal(result.json.status, 'partial'); assert.equal(result.json.archive.state, 'unknown');
  assert.equal(result.json.archive.stagingRetained, true); f.noLeak(result);
  assert.equal(await fs.readFile(path.join(f.target, 'file.bin'), 'utf8'), 'content');
  const query = await f.request(route('published-uncertain')); assert.equal(query.json.archive.state, 'unknown');
});


test('archive HTTP rejects the entire default tool-data root and sibling P3 store without writes', async t => {
  const f = await fixture(t), nested = path.join(f.commitOperationsDir, 'nested'), sibling = path.join(f.dataRoot, 'unrelated-tool-data');
  await fs.mkdir(nested, { recursive: true }); await fs.mkdir(sibling);
  const sentinel = path.join(f.commitOperationsDir, 'file.bin'); await fs.writeFile(sentinel, 'existing P3 operation evidence');
  const beforeConfig = await fs.readFile(f.configPath), beforeStore = await fs.readFile(sentinel);
  const beforeEntries = await fs.readdir(f.commitOperationsDir);
  for (const targetRoot of [f.dataRoot, f.commitOperationsDir, nested, sibling]) {
    const res = await f.request(route('preview'), { method: 'POST', body: { action: 'archive', relativePath: 'file.bin', targetRoot } });
    assert.equal(res.status, 409, res.text); assert.equal(res.json.error.code, 'UNSAFE_TARGET'); f.noLeak(res);
  }
  await f.noStore(); assert.deepEqual(await fs.readFile(f.configPath), beforeConfig);
  assert.deepEqual(await fs.readFile(sentinel), beforeStore); assert.deepEqual(await fs.readdir(f.commitOperationsDir), beforeEntries);
  assert.deepEqual(await fs.readdir(nested), []); assert.deepEqual(await fs.readdir(sibling), []);
});

test('trusted custom P3 store outside config parent is protected along with ancestors and descendants', async t => {
  const f = await fixture(t, { customCommitStore: true }), nested = path.join(f.commitOperationsDir, 'nested');
  await fs.mkdir(nested, { recursive: true });
  const sentinel = path.join(f.commitOperationsDir, 'file.bin'); await fs.writeFile(sentinel, 'custom P3 operation evidence');
  const beforeConfig = await fs.readFile(f.configPath), beforeStore = await fs.readFile(sentinel);
  for (const targetRoot of [f.commitOperationsDir, nested, path.dirname(f.commitOperationsDir)]) {
    const res = await f.request(route('preview'), { method: 'POST', body: { action: 'archive', relativePath: 'file.bin', targetRoot } });
    assert.equal(res.status, 409, res.text); assert.equal(res.json.error.code, 'UNSAFE_TARGET'); f.noLeak(res);
  }
  await f.noStore(); assert.deepEqual(await fs.readFile(f.configPath), beforeConfig); assert.deepEqual(await fs.readFile(sentinel), beforeStore);
  assert.deepEqual(await fs.readdir(f.commitOperationsDir), ['file.bin', 'nested']); assert.deepEqual(await fs.readdir(nested), []);
  // The protection override is startup-only, never a client-controlled request field.
  await fs.writeFile(f.configPath, 'broken');
  const injected = await f.request(route('preview'), { method: 'POST', body: { action: 'archive', relativePath: 'file.bin', targetRoot: f.target, commitOperationsDir: f.target } });
  assert.equal(injected.json.error.code, 'INVALID_INPUT'); await f.noStore();
});
for (const scenario of ['unrelated-repo', 'unrelated-material', 'own-root']) test(`historical HTTP query and cancel survive missing ${scenario} after restart without writes`, async t => {
  const f = await fixture(t), unrelatedRepo = path.join(f.dir, 'other-repo'), unrelatedMaterial = path.join(f.dir, 'other-material');
  await fs.mkdir(unrelatedRepo); await fs.mkdir(unrelatedMaterial);
  f.config.projects[1].repositoryPath = unrelatedRepo;
  f.config.projects[1].materials = { installer: { root: unrelatedMaterial } }; await f.save();
  const completed = await f.confirm(await f.preview({ baseline }), 'history'); assert.equal(completed.status, 200);
  const missing = scenario === 'unrelated-repo' ? unrelatedRepo : scenario === 'unrelated-material' ? unrelatedMaterial : f.root;
  await fs.rename(missing, missing + '-old');
  const originalRoot = scenario === 'own-root' ? f.root + '-old' : f.root;
  const protectedFiles = [f.configPath, path.join(f.operationsDir, 'history.json'), path.join(originalRoot, 'file.bin'), path.join(originalRoot, 'material-records.json')];
  const before = await Promise.all(protectedFiles.map(p => fs.readFile(p))), entries = await fs.readdir(f.operationsDir);
  await f.stop(); await f.start();
  for (const method of ['query', 'cancel']) {
    const response = method === 'query' ? await f.request(route('history')) : await f.request(route('history/cancel'), { method: 'POST', body: {} });
    assert.equal(response.status, 200, response.text); assert.equal(response.json.status, 'completed');
    assert.equal(response.json.integrity, 'matched'); assert.equal(response.json.historical, true);
    assert.equal(response.json.checkedAt, completed.json.checkedAt);
    assert.equal(response.json.associationCurrent, scenario !== 'own-root'); f.noLeak(response);
    const missingProject = method === 'query' ? await f.request(route('history', 'absent')) : await f.request(route('history/cancel', 'absent'), { method: 'POST', body: {} });
    assert.equal(missingProject.status, 404); assert.equal(missingProject.json.error.code, 'PROJECT_NOT_FOUND');
  }
  assert.equal((await f.request(route('never-started'))).json.status, 'not_started');
  assert.equal((await f.request(route('never-started/cancel'), { method: 'POST', body: {} })).json.status, 'not_started');
  assert.deepEqual(await Promise.all(protectedFiles.map(p => fs.readFile(p))), before);
  assert.deepEqual(await fs.readdir(f.operationsDir), entries);
});
