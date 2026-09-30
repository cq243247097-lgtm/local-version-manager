import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('// P4 single-file operations:'), source.indexOf('// End P4 single-file operations.'));
const sha = 'a'.repeat(64);
function harness({ real = true, storage = new Map() } = {}) {
  const nodes = new Map(), calls = [], replies = [], events = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', open: false, close() { this.open = false; }, showModal() { this.open = true; }, addEventListener(name, fn) { events.set(`${id}:${name}`, fn); } }); return nodes.get(id); };
  const context = vm.createContext({ $, isRealMode: real, currentProjectId: 'project', state: { view: 'installer' }, realActiveMaterialSerial: 1, currentMaterialData: { projectId: 'project', kind: 'installer', items: [{ id: 'file', relativePath: '<file>.bin', physical: { exists: true }, declaration: { state: 'available', recordedFile: { sha256: sha }, sourceOrigin: 'material-records.json', recordIndex: 0 } }] }, selectedMaterialItemId: 'file', notify() {}, formatBytes: String, formatTimestamp: String, escapeHtml: v => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])), window: { crypto: { randomUUID: () => 'unique-op' }, addEventListener: (name, fn) => events.set(name, fn) }, localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) }, AbortController, setTimeout, clearTimeout, apiFetch: async (url, options) => { calls.push({ url, ...options, body: options.body && JSON.parse(options.body) }); const reply = replies.shift(); return typeof reply === 'function' ? await reply() : reply || { ok: false, status: 0, data: null }; } });
  vm.runInContext(section, context);
  const run = expression => vm.runInContext(expression, context);
  const result = (extra = {}) => ({ ok: true, data: { projectId: 'project', kind: 'installer', operationId: 'unique-op', status: 'completed', integrity: 'no_baseline', checkedAt: 20, ...extra } });
  const preview = () => ({ ok: true, data: { projectId: 'project', kind: 'installer', ticketId: 'ticket', action: run('materialOperationView.action'), relativePath: '<file>.bin', basename: '<file>.bin', bytes: 5, baseline: null } });
  async function review(action = 'integrity') { run(`openMaterialOperation('${action}')`); $('#operation-baseline').value = 'none'; $('#operation-target').value = '/temporary/target'; replies.push(preview()); await run('previewMaterialOperation()'); }
  return { run, $, calls, replies, context, events, storage, result, preview, review, html: () => $('#material-operation-body').innerHTML };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('default no-baseline preview, escaped source, explicit confirm and durable ID before POST', async () => {
  const h = harness(); await h.review();
  assert.equal(h.calls[0].body.baseline, undefined); assert.match(h.html(), /无可信基准/); assert.match(h.html(), /&lt;file&gt;/); assert.doesNotMatch(h.html(), /<file>/);
  h.replies.push(() => { assert.equal(h.storage.get('lvm_material_operation_v1:project:installer'), 'unique-op'); return h.result(); }, h.result());
  await h.run('confirmMaterialOperation()'); assert.equal(h.calls.filter(c => c.url.endsWith('/confirm')).length, 1); assert.match(h.html(), /仅计算摘要，未验证真伪/);
  assert.match(h.html(), /安装\/升级验证与完整性独立/); assert.match(h.html(), /上次校验时间：20/); assert.equal(h.storage.size, 1);
});
test('manual trusted digest and source require explicit selection; declared baseline is opt-in', async () => {
  for (const choice of ['manual', 'declared']) { const h = harness(); h.run("openMaterialOperation('integrity')"); h.$('#operation-baseline').value = choice; h.$('#operation-sha').value = sha; h.$('#operation-source').value = 'release note'; h.replies.push(h.preview()); await h.run('previewMaterialOperation()'); assert.equal(h.calls[0].body.baseline.sha256, sha); assert.ok(h.calls[0].body.baseline.source); }
  const h = harness(); h.run("openMaterialOperation('integrity')"); h.$('#operation-baseline').value = 'manual'; h.$('#operation-sha').value = 'bad'; h.$('#operation-source').value = ''; await h.run('previewMaterialOperation()'); assert.equal(h.calls.length, 0);
});
test('archive preview contains intended target and basename, copy/no-overwrite facts; cancel preview does no write', async () => {
  const h = harness(); await h.review('archive'); assert.equal(h.calls[0].body.targetRoot, '/temporary/target'); assert.match(h.html(), /目标文件名/); assert.match(h.html(), /保留源文件/); assert.match(h.html(), /一律不覆盖/); h.run('closeMaterialOperation()'); assert.equal(h.calls.length, 1); assert.equal(h.storage.size, 0);
});
test('double confirmation cannot create multiple IDs or send multiple writes', async () => {
  const h = harness(); await h.review(); const wait = deferred(); h.replies.push(() => wait.promise, h.result()); const first = h.run('confirmMaterialOperation()'); await h.run('confirmMaterialOperation()'); assert.equal(h.calls.filter(c => c.url.endsWith('/confirm')).length, 1); wait.resolve(h.result()); await first;
});
test('lost confirm response queries the same ID and reopening/reload preserves binding only', async () => {
  const h = harness(); await h.review('archive'); h.replies.push({ status: 0, ok: false }, h.result({ status: 'unknown' })); await h.run('confirmMaterialOperation()'); assert.ok(h.calls.at(-1).url.endsWith('/unique-op')); assert.equal(h.calls.filter(c => c.url.endsWith('/confirm')).length, 1);
  const fresh = harness({ storage: h.storage }); fresh.replies.push(fresh.result({ status: 'running' })); fresh.run('openMaterialOperation(null, true)'); await new Promise(r => setImmediate(r)); assert.equal(fresh.calls[0].url, '/api/projects/project/materials/installer/operations/unique-op'); assert.deepEqual([...h.storage.values()], ['unique-op']);
});
test('pending original identity blocks new operation even if query reports not_started', async () => {
  const h = harness({ storage: new Map([['lvm_material_operation_v1:project:installer', 'unique-op']]) }); await h.review(); h.replies.push(h.result({ status: 'not_started' }), h.result({ status: 'not_started' })); await h.run('confirmMaterialOperation()'); assert.equal(h.calls.filter(c => c.url.endsWith('/confirm')).length, 0); assert.match(h.html(), /先前确认仍可能稍后开始/);
});
test('late preview ignored after close, project switch, kind switch, association reload, and back navigation', async () => {
  for (const mutation of ['closeMaterialOperation()', "currentProjectId = 'other'", "state.view = 'upgrade'", '++realActiveMaterialSerial', null]) { const h = harness(); h.run("openMaterialOperation('integrity')"); h.$('#operation-baseline').value = 'none'; const wait = deferred(); h.replies.push(() => wait.promise); const pending = h.run('previewMaterialOperation()'); const before = h.html(); const response = h.preview(); if (mutation) h.run(mutation); else h.events.get('popstate')(); wait.resolve(response); await pending; assert.equal(h.html(), before); }
});
test('late confirmation after close cannot render; ID remains recoverable and scoped', async () => {
  const h = harness(); await h.review(); const wait = deferred(); h.replies.push(() => wait.promise); const pending = h.run('confirmMaterialOperation()'); h.run('closeMaterialOperation()'); const before = h.html(); wait.resolve(h.result()); await pending; assert.equal(h.html(), before); assert.equal(h.run("savedMaterialOperation('project','upgrade')"), null); assert.equal(h.run("savedMaterialOperation('other','installer')"), null); assert.equal(h.run("savedMaterialOperation('project','installer')"), 'unique-op');
});
test('cancel while confirmation runs queries original ID, preserves possible published facts', async () => {
  const h = harness(); await h.review('archive'); const wait = deferred(); h.replies.push(() => wait.promise, h.result({ cancellation: { requested: true } }), h.result({ integrity: 'cancelled', archive: { state: 'published' } })); const pending = h.run('confirmMaterialOperation()'); await h.run('cancelMaterialOperation()'); assert.match(h.html(), /校验已取消/); assert.match(h.html(), /已发布归档副本/); assert.ok(h.calls.some(c => c.url.endsWith('/unique-op/cancel'))); h.replies.push(h.result({ integrity: 'cancelled', archive: { state: 'published' } })); wait.resolve(h.result()); await pending;
});
test('safe truthful rendering of mismatch, timeout, changed, partial, conflict, duplicate and unknown; no raw errors', () => {
  const h = harness(); for (const [integrity, text] of [['mismatched', '摘要不匹配'], ['timeout','校验超时'], ['changed','已变化'], ['no_baseline','未验证真伪']]) { assert.match(h.run(`materialOperationResultHtml(${JSON.stringify({ status: 'completed', integrity })})`), new RegExp(text)); }
  for (const [state, text] of [['conflict','未覆盖目标'], ['duplicate','已有相同内容'], ['unknown','可能已发布']]) assert.match(h.run(`materialOperationResultHtml(${JSON.stringify({ status: 'partial', archive: { state }, error: { message: '/private/root' } })})`), new RegExp(text));
  const html = h.run(`materialOperationResultHtml(${JSON.stringify({ status: 'completed', integrity: 'matched', sha256: sha, error: { message: '/private/root' } })})`); assert.match(html, /依据不足/); assert.doesNotMatch(html, /private/);
});
test('storage failure prevents write, foreign response cannot claim completion, preview mode inert', async () => {
  const h = harness(); await h.review(); h.context.localStorage.setItem = () => { throw new Error('denied'); }; await h.run('confirmMaterialOperation()'); assert.equal(h.calls.length, 1); assert.match(h.html(), /已阻止执行/);
  const p = harness({ real: false }); p.run("openMaterialOperation('integrity')"); assert.equal(p.run('materialOperationView'), null); assert.equal(p.calls.length, 0);
  const other = harness(); await other.review(); other.replies.push(other.result(), other.result({ projectId: 'other', integrity: 'matched', sha256: sha, baseline: { sha256: sha } })); await other.run('confirmMaterialOperation()'); assert.match(other.html(), /结果未知/); assert.doesNotMatch(other.html(), /与明确采用的基准一致/);
});
test('request abort budget is 65 seconds and API contract headers are explicit', async () => {
  const h = harness(); let budget; let aborted = false; h.context.setTimeout = (fn, ms) => { budget = ms; fn(); return 1; }; h.context.clearTimeout = () => {}; h.context.apiFetch = async (url, options) => { aborted = options.signal.aborted; return { ok: false }; }; h.run("openMaterialOperation('integrity')"); await h.run("materialOperationRequest(materialOperationView, 'preview', {})"); assert.equal(budget, 65000); assert.equal(aborted, true);
  const regular = harness(); await regular.review(); assert.equal(regular.calls[0].headers['X-Local-Intent'], 'material-operations'); assert.equal(regular.calls[0].headers['Content-Type'], 'application/json');
});
