import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import fsSync from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { createAppServer } from '../server/app.js';
import { clearAllCommitPreviewTickets } from '../server/git/commit-preview.js';
import { acquireCommitLock, releaseCommitLock } from '../server/git/commit-operations.js';

let base, repo, configPath, operationsDir, app, port;
const originalSpawn = childProcess.spawn;
function git(args, cwd = repo) {
  assert.ok(path.isAbsolute(cwd) && cwd.startsWith(os.tmpdir() + path.sep));
  const result = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function start() {
  app = createAppServer({ configPath, operationsDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  port = app.server.address().port;
  app.setListeningPort(port);
}
async function stop() { await new Promise((resolve) => app.server.close(resolve)); }
async function config(repositoryPath = repo, id = 'test') {
  await fs.writeFile(configPath, JSON.stringify({ projects: [{ id, name: 'Fixture', repositoryPath }] }));
}
async function init(dir) {
  await fs.mkdir(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.name', 'API Test'], dir);
  git(['config', 'user.email', 'api@example.com'], dir);
  await fs.writeFile(path.join(dir, 'base.txt'), 'baseline\n');
  git(['add', 'base.txt'], dir);
  git(['commit', '-m', 'baseline'], dir);
}
async function request(route, { method = 'GET', body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const defaults = { host: `127.0.0.1:${port}` };
    if (method === 'POST') Object.assign(defaults, { origin: `http://127.0.0.1:${port}`, 'x-local-intent': 'git-commit', 'content-type': 'application/json' });
    const finalHeaders = { ...defaults, ...headers };
    for (const key of Object.keys(finalHeaders)) if (finalHeaders[key] === null) delete finalHeaders[key];
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: Array.isArray(finalHeaders.host) ? Object.entries(finalHeaders).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).flatMap((v) => [key, v])) : finalHeaders }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text, headers: res.headers }));
    });
    req.on('error', reject); req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
const route = (action, id = 'test') => `/api/projects/${id}/commit/${action}`;
async function preview(file = 'base.txt') {
  const candidates = await request(route('candidates'));
  assert.equal(candidates.status, 200, candidates.text);
  const candidate = candidates.json.candidates.find((c) => c.path === file);
  assert.ok(candidate);
  const response = await request(route('preview'), { method: 'POST', body: { candidateIds: [candidate.id], message: 'API commit' } });
  assert.equal(response.status, 200, response.text);
  return response.json;
}
async function confirm(ticket, operationId = 'op-1', id = 'test') {
  return request(route('confirm', id), { method: 'POST', body: { ticketId: ticket.ticketId, operationId } });
}
async function snapshot(dir = repo) {
  const entries = [];
  async function walk(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const location = path.join(current, name), stat = await fs.lstat(location);
      if (stat.isDirectory()) await walk(location);
      else entries.push([path.relative(dir, location), crypto.createHash('sha256').update(await fs.readFile(location)).digest('hex')]);
    }
  }
  await walk(dir); return entries;
}
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-api-'));
  repo = path.join(base, 'repo'); configPath = path.join(base, 'projects.json'); operationsDir = path.join(base, 'operations');
  await init(repo); await config();
  await fs.writeFile(path.join(repo, 'base.txt'), 'changed secret-file-body\n');
  clearAllCommitPreviewTickets(); await start();
});
afterEach(async () => {
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  clearAllCommitPreviewTickets(); await stop(); await fs.rm(base, { recursive: true, force: true });
});

test('registered candidate/preview/confirm/query, staged protection, idempotence, restart', async () => {
  await fs.writeFile(path.join(repo, 'unselected.txt'), 'keep staged\n'); git(['add', 'unselected.txt']);
  const staged = git(['ls-files', '--stage', 'unselected.txt']);
  const before = await snapshot();
  const ticket = await preview();
  assert.deepEqual(await snapshot(), before);
  assert.ok(!JSON.stringify(ticket).includes('secret-file-body'));
  assert.equal(ticket.diffOverview, undefined);
  const response = await confirm(ticket);
  assert.equal(response.status, 200, response.text); assert.equal(response.json.status, 'completed');
  assert.equal(response.json.persistenceGuarantee, 'service-process-crash-only');
  assert.equal(Object.hasOwn(response.json, 'stagedFiles'), false);
  assert.equal(git(['rev-parse', 'HEAD']), response.json.commitOid);
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), ticket.expectedTreeOid);
  assert.equal(git(['ls-files', '--stage', 'unselected.txt']), staged);
  const again = await confirm(ticket); assert.equal(again.json.commitOid, response.json.commitOid); assert.equal(again.json.idempotent, true);
  await stop(); clearAllCommitPreviewTickets(); await start();
  const allBefore = await snapshot(base);
  const query = await request(response.json.resultUrl);
  assert.equal(query.json.status, 'completed'); assert.equal(query.json.commitOid, response.json.commitOid);
  assert.deepEqual(await snapshot(base), allBefore);
  assert.ok(!query.text.includes(base)); assert.equal(git(['rev-list', '--count', 'HEAD']), '2');
});

test('GET candidate and absent operation never create lock, ticket or store or change Git', async () => {
  const before = await snapshot(base);
  assert.equal((await request(route('candidates'))).status, 200);
  assert.equal((await request(route('operations/missing'))).status, 404);
  assert.deepEqual(await snapshot(base), before);
});

const invalidCases = [
  ['Host', { headers: { host: 'evil.example' } }, 403],
  ['duplicate Host', { headers: { host: ['127.0.0.1:1', 'evil.example'] } }, 403],
  ['Origin', { headers: { origin: 'https://evil.example' } }, 403],
  ['missing Origin', { headers: { origin: null } }, 403],
  ['null Origin', { headers: { origin: 'null' } }, 403],
  ['cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
  ['intent', { headers: { 'x-local-intent': 'project-onboarding' } }, 400],
  ['material intent', { headers: { 'x-local-intent': 'material-linking' } }, 400],
  ['media', { headers: { 'content-type': 'text/plain' } }, 415],
  ['charset', { headers: { 'content-type': 'application/json;charset=latin1' } }, 415],
  ['oversize', { raw: ' '.repeat(8193) }, 413],
  ['declared oversize', { raw: ' '.repeat(8193), headers: { 'content-length': '8193' } }, 413],
  ['too many candidates', { body: { candidateIds: Array(501).fill('x'), message: 'ok' } }, 400],
  ['invalid JSON', { raw: '{' }, 400],
  ['array body', { body: [] }, 400],
  ['extra path', { body: { candidateIds: ['cand_' + 'a'.repeat(16)], message: 'ok', repositoryPath: '/secret' } }, 400],
  ['command/ref/remote', { body: { command: 'commit', ref: 'HEAD', remote: 'origin' } }, 400],
  ['bad candidate', { body: { candidateIds: ['../../secret'], message: 'ok' } }, 400],
  ['duplicate candidate', { body: { candidateIds: Array(2).fill('cand_' + 'a'.repeat(16)), message: 'ok' } }, 400],
  ['empty candidate', { body: { candidateIds: [], message: 'ok' } }, 400],
  ['long message', { body: { candidateIds: ['cand_' + 'a'.repeat(16)], message: 'a'.repeat(501) } }, 400],
  ['newline', { body: { candidateIds: ['cand_' + 'a'.repeat(16)], message: 'a\nb' } }, 400],
];
for (const [name, options, status] of invalidCases) test(`security ${name} rejected before config/Git/locks`, async () => {
  // A broken configuration proves validation wins over lookup; whole-tree equality proves no writes.
  await fs.writeFile(configPath, 'broken'); const before = await snapshot(base);
  const response = await request(route('preview'), { method: 'POST', body: { candidateIds: ['cand_' + 'a'.repeat(16)], message: 'ok' }, ...options });
  assert.equal(response.status, status, response.text); assert.deepEqual(await snapshot(base), before);
  assert.ok(!response.text.includes('/secret'));
});

test('confirmation allowlist and query parameters rejected before config', async () => {
  await fs.writeFile(configPath, 'broken'); const before = await snapshot(base);
  for (const body of [ { ticketId: 'a'.repeat(64), operationId: 'ok', args: [] }, { ticketId: 'bad', operationId: 'ok' }, { ticketId: 'a'.repeat(64), operationId: '../x' }, { ticketId: 'a'.repeat(64), operationId: 'a'.repeat(65) } ]) {
    assert.equal((await request(route('confirm'), { method: 'POST', body })).status, 400);
  }
  assert.equal((await request(route('candidates') + '?repositoryPath=/secret')).status, 400);
  assert.deepEqual(await snapshot(base), before);
});

test('defined methods, unknown routes, missing project and operation', async () => {
  for (const [action, method] of [['preview', 'GET'], ['confirm', 'GET'], ['candidates', 'POST'], ['operations/op', 'POST']]) {
    assert.equal((await request(route(action), { method })).status, 405);
  }
  assert.equal((await request(route('unknown'))).status, 404);
  assert.equal((await request(route('operations/../secret'))).status, 404);
  assert.equal((await request(route('candidates', 'missing'))).status, 404);
  assert.equal((await request(route('operations/missing'))).status, 404);
});

test('expired or changed preview cannot commit', async () => {
  const ticket = await preview(); const head = git(['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(repo, 'base.txt'), 'changed again\n');
  const stale = await confirm(ticket); assert.equal(stale.status, 409); assert.equal(stale.json.status, 'stale');
  clearAllCommitPreviewTickets();
  assert.equal((await confirm(ticket, 'op-2')).json.status, 'stale');
  assert.equal(git(['rev-parse', 'HEAD']), head);
});

test('project switching and config replacement cannot redirect a ticket', async () => {
  const ticket = await preview(), head = git(['rev-parse', 'HEAD']);
  await config(repo, 'other');
  assert.equal((await confirm(ticket)).status, 404);
  assert.equal((await confirm(ticket, 'op-2', 'other')).json.error.code, 'OPERATION_INVALID');
  const other = path.join(base, 'other'); await init(other); await config(other);
  assert.equal((await confirm(ticket, 'op-3')).json.error.code, 'OPERATION_INVALID');
  assert.equal(git(['rev-parse', 'HEAD']), head); assert.equal(git(['rev-list', '--count', 'HEAD'], other), '1');
});

test('query refuses historical result after project repository remapping', async () => {
  const result = await confirm(await preview());
  const other = path.join(base, 'other'); await init(other); await config(other);
  const before = await snapshot(base);
  const response = await request(result.json.resultUrl);
  assert.equal(response.json.error.code, 'OPERATION_INVALID'); assert.deepEqual(await snapshot(base), before);
});

test('busy repository remains distinct and cannot write Git', async () => {
  const ticket = await preview(), before = await snapshot();
  const identifier = await fs.realpath(path.join(repo, '.git'));
  const lease = await acquireCommitLock(identifier, { operationId: 'held' }, { operationsDir });
  try {
    const response = await confirm(ticket);
    assert.equal(response.status, 409); assert.equal(response.json.error.code, 'REPOSITORY_BUSY'); assert.equal(response.json.status, 'busy');
    assert.deepEqual(await snapshot(), before);
  } finally { await releaseCommitLock(identifier, lease, { operationsDir }); }
});

for (const [name, setup, code] of [
  ['identity', () => git(['config', '--unset', 'user.email']), 'IDENTITY_MISSING'],
  ['hooks', () => fs.writeFile(path.join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n'), 'HOOKS_UNSUPPORTED'],
]) test(`unsupported ${name} is safe and explicit`, async () => {
  await setup(); const before = await snapshot(); const response = await request(route('candidates'));
  assert.equal(response.json.error.code, code); assert.ok(!response.text.includes(base)); assert.deepEqual(await snapshot(), before);
});

function interceptCommit(mode) {
  childProcess.spawn = (command, args, options) => {
    if (command === 'git' && args.includes('commit')) {
      assert.equal(options.cwd, repo);
      return originalSpawn(process.execPath, ['-e', mode === 'fail' ? 'process.stderr.write("secret stderr /private/path"); process.exit(1)' : 'setTimeout(() => {}, 60000)'], { ...options, cwd: repo });
    }
    return originalSpawn(command, args, options);
  };
  syncBuiltinESMExports();
}

test('subprocess failure reports not_started, hides stderr, never repeats ID', async () => {
  const ticket = await preview(); interceptCommit('fail');
  const response = await confirm(ticket); assert.equal(response.status, 409); assert.equal(response.json.status, 'not_started');
  assert.equal(Object.hasOwn(response.json, 'stagedFiles'), false);
  assert.ok(!response.text.includes('secret stderr')); assert.ok(!response.text.includes('/private/path'));
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  assert.equal((await confirm(ticket)).json.status, 'not_started'); assert.equal(git(['rev-list', '--count', 'HEAD']), '1');
});

test('failure after add reports partial, read-only restart query preserves evidence', async () => {
  await fs.writeFile(path.join(repo, 'new.txt'), 'new body\n'); const ticket = await preview('new.txt'); interceptCommit('fail');
  const response = await confirm(ticket); assert.equal(response.json.status, 'partial', response.text);
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  await stop(); clearAllCommitPreviewTickets(); await start(); const before = await snapshot(base);
  assert.equal((await request(response.json.resultUrl)).json.status, 'partial'); assert.deepEqual(await snapshot(base), before);
  assert.equal((await confirm(ticket)).json.status, 'partial'); assert.equal(git(['rev-list', '--count', 'HEAD']), '1');
});

test('real commit subprocess timeout is reconciled, not generically declared failed', async () => {
  await fs.writeFile(path.join(repo, 'new.txt'), 'new body\n'); const ticket = await preview('new.txt'); interceptCommit('timeout');
  const response = await confirm(ticket); assert.equal(response.status, 409); assert.equal(response.json.status, 'partial', response.text);
  assert.equal(git(['rev-list', '--count', 'HEAD']), '1');
});

test('damaged journal fails closed without raw paths and read-only query does not repair', async () => {
  const result = await confirm(await preview());
  await fs.appendFile(path.join(operationsDir, 'operations.journal'), 'torn'); const before = await snapshot(base);
  const response = await request(result.json.resultUrl);
  assert.equal(response.json.error.code, 'OPERATION_STORE_FAILED'); assert.ok(!response.text.includes(base));
  assert.deepEqual(await snapshot(base), before);
});


test('fresh Node process serves persisted result using only read-only HTTP query', async () => {
  const result = await confirm(await preview());
  const before = await snapshot(base);
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../server/app.js', import.meta.url))).href;
  const script = `import { createAppServer } from ${JSON.stringify(moduleUrl)};
    const app = createAppServer(${JSON.stringify({ configPath, operationsDir })});
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    app.setListeningPort(app.server.address().port);
    const response = await fetch('http://127.0.0.1:' + app.getListeningPort() + ${JSON.stringify(result.json.resultUrl)});
    console.log(JSON.stringify({ status: response.status, result: await response.json() }));
    await new Promise(resolve => app.server.close(resolve));`;
  const child = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: base, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.status, 200); assert.equal(output.result.commitOid, result.json.commitOid);
  assert.deepEqual(await snapshot(base), before);
});

test('post-command unselected index interference is unknown, never false completed', async () => {
  const ticket = await preview();
  childProcess.spawn = (command, args, options) => {
    const child = originalSpawn(command, args, options);
    if (command === 'git' && args.includes('commit')) child.once('close', () => {
      fsSync.writeFileSync(path.join(repo, 'unselected.txt'), 'external staged content');
      git(['add', 'unselected.txt']);
    });
    return child;
  };
  syncBuiltinESMExports();
  const response = await confirm(ticket);
  assert.equal(response.status, 409); assert.equal(response.json.status, 'unknown');
  assert.equal(response.json.indexChange, 'unselected_changed');
  const count = git(['rev-list', '--count', 'HEAD']);
  assert.equal((await confirm(ticket)).json.status, 'unknown');
  assert.equal(git(['rev-list', '--count', 'HEAD']), count);
});


test('default operation store derives from config directory, never the managed repository', async () => {
  await stop();
  app = createAppServer({ configPath });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  port = app.server.address().port; app.setListeningPort(port);
  const result = await confirm(await preview());
  assert.equal(result.json.status, 'completed');
  assert.ok((await fs.stat(path.join(base, 'commit-operations/operations.journal'))).isFile());
  await assert.rejects(fs.stat(operationsDir), { code: 'ENOENT' });
});


test('partial DTO reports only proven newly staged paths in a mixed selection; unknown omits old delta', async () => {
  await fs.writeFile(path.join(repo, 'already-staged.txt'), 'preexisting staged body\n');
  git(['add', 'already-staged.txt']);
  await fs.writeFile(path.join(repo, 'fresh.txt'), 'fresh body\n');
  const candidates = await request(route('candidates'));
  const selectedNames = ['base.txt', 'already-staged.txt', 'fresh.txt'];
  const response = await request(route('preview'), { method: 'POST', body: {
    candidateIds: candidates.json.candidates.filter(c => selectedNames.includes(c.path)).map(c => c.id), message: 'Mixed partial',
  } });
  assert.equal(response.status, 200, response.text);
  interceptCommit('fail');
  const partial = await confirm(response.json);
  assert.equal(partial.json.status, 'partial', partial.text);
  assert.deepEqual(partial.json.stagedFiles, ['fresh.txt']);
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  const before = await snapshot(base);
  const query = await request(partial.json.resultUrl);
  assert.deepEqual(query.json.stagedFiles, ['fresh.txt']);
  assert.deepEqual(await snapshot(base), before);
  const repeated = await confirm(response.json);
  assert.deepEqual(repeated.json.stagedFiles, ['fresh.txt']);
  await fs.writeFile(path.join(repo, 'outside-selection.txt'), 'external change\n');
  git(['add', 'outside-selection.txt']);
  const unknown = await request(partial.json.resultUrl);
  assert.equal(unknown.json.status, 'unknown');
  assert.equal(Object.hasOwn(unknown.json, 'stagedFiles'), false);
  const repeatedUnknown = await confirm(response.json);
  assert.equal(repeatedUnknown.json.status, 'unknown');
  assert.equal(Object.hasOwn(repeatedUnknown.json, 'stagedFiles'), false);
});

test('partial DTO preserves literal POSIX colon/backslash filenames without path coercion', { skip: process.platform === 'win32' }, async () => {
  const filename = 'C:\\literal.txt';
  await fs.writeFile(path.join(repo, filename), 'literal filename body\n');
  const ticket = await preview(filename); interceptCommit('fail');
  const partial = await confirm(ticket);
  assert.equal(partial.json.status, 'partial', partial.text);
  assert.deepEqual(partial.json.stagedFiles, [filename]);
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  await stop(); clearAllCommitPreviewTickets(); await start();
  const before = await snapshot(base);
  const query = await request(partial.json.resultUrl);
  assert.equal(query.json.status, 'partial'); assert.deepEqual(query.json.stagedFiles, [filename]);
  assert.deepEqual(await snapshot(base), before);
});
