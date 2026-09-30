import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../server/app.js';
import { clearAllCommitPreviewTickets } from '../server/git/commit-preview.js';

// Browser plugin not available. Reuse existing Playwright; never install dependencies.
let chromium;
for (const module of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(module.startsWith('/') ? pathToFileURL(module).href : module)); break; } catch {}
}
const browserSkipReason = process.env.T04_SKIP_BROWSER || (!chromium ? 'Playwright unavailable; set PLAYWRIGHT_MODULE' : null);
const enabled = !browserSkipReason;
const evidenceDir = path.resolve('.local/p3-review');
const originalSpawn = cp.spawn;
let browser, base, repo, other, app, port, page, configPath, operationsDir, errors, requests, responses;
const evidence = [];
function git(args, cwd = repo) {
  assert.ok(path.isAbsolute(cwd) && cwd.startsWith(os.tmpdir() + path.sep), 'Git must target an explicit temporary repo');
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
async function init(dir) {
  await fs.mkdir(dir); git(['init', '-b', 'main'], dir);
  git(['config', 'user.name', 'Browser QA'], dir); git(['config', 'user.email', 'qa@example.test'], dir);
  await fs.writeFile(path.join(dir, 'base.txt'), 'baseline\n'); git(['add', 'base.txt'], dir); git(['commit', '-m', 'baseline'], dir);
  await fs.writeFile(path.join(dir, 'base.txt'), 'selected change\n');
}
async function snapshot(dir = repo) {
  const result = [];
  async function walk(root) { for (const name of (await fs.readdir(root)).sort()) {
    const file = path.join(root, name), stat = await fs.lstat(file);
    if (stat.isDirectory()) await walk(file);
    else result.push([path.relative(dir, file), crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
  } }
  await walk(dir); return result;
}
async function start(reusePort = 0) {
  app = createAppServer({ configPath, operationsDir });
  await new Promise(resolve => app.server.listen(reusePort, '127.0.0.1', resolve));
  port = app.server.address().port; app.setListeningPort(port);
}
async function stop() { if (app) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app = null; } }
async function load() { await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#open-real-commit'); }
async function open() { await page.click('#open-real-commit'); await page.waitForSelector('#commit-dialog[open]'); }
async function preview(file = 'base.txt') {
  await open();
  await page.waitForSelector('[data-commit-candidate]');
  assert.equal(await page.locator('[data-commit-candidate]:checked').count(), 0);
  const candidate = page.locator('label').filter({ hasText: file }).locator('[data-commit-candidate]');
  await candidate.check(); await page.fill('#real-commit-message', 'Browser verified local commit');
  await page.click('#preview-real-commit'); await page.waitForSelector('#confirm-real-commit');
}
async function waitText(text) { await page.waitForFunction(t => document.querySelector('#commit-dialog')?.textContent.includes(t), text); }
async function record(name) {
  await page.screenshot({ path: path.join(evidenceDir, `t04-${name}.png`) });
  evidence.push({ name, viewport: page.viewportSize(), title: await page.title(), url: page.url(), head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), index: git(['ls-files', '--stage']), worktree: git(['status', '--porcelain=v1']), dialog: await page.locator('#commit-dialog').textContent(), errors: [...errors] });
}
before(async () => {
  if (!enabled) return;
  await fs.mkdir(evidenceDir, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox'] });
});
after(async () => { if (browser) await browser.close(); if (enabled) await fs.writeFile(path.join(evidenceDir, 't04-browser-evidence.json'), JSON.stringify({ browserPath: '/usr/bin/chromium', fallback: 'Browser plugin not available', evidence }, null, 2)); });
beforeEach(async () => {
  if (!enabled) return;
  base = await fs.mkdtemp(path.join(os.tmpdir(), 't04-browser-')); repo = path.join(base, 'repo'); other = path.join(base, 'other');
  configPath = path.join(base, 'projects.json'); operationsDir = path.join(base, 'operations');
  await init(repo); await init(other);
  await fs.writeFile(configPath, JSON.stringify({ projects: [{ id: 'first', name: 'First QA', repositoryPath: repo }, { id: 'second', name: 'Second QA', repositoryPath: other }] }));
  clearAllCommitPreviewTickets(); await start();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(10000);
  errors = []; requests = []; responses = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/commit/')) requests.push({ url: r.url(), method: r.method(), body: r.postData() }); });
  page.on('response', async r => { if (r.url().includes('/commit/')) { try { responses.push({ url: r.url(), body: await r.json() }); } catch {} } });
  await load();
});
afterEach(async () => {
  if (!enabled) return;
  cp.spawn = originalSpawn; syncBuiltinESMExports();
  if (page) await page.close(); await stop(); clearAllCommitPreviewTickets();
  await fs.rm(base, { recursive: true, force: true }); assert.deepEqual(errors, [], 'No uncaught browser errors');
});
const qa = (name, fn) => test(name, { skip: browserSkipReason || false }, fn);

qa('P3-T04 preview and cancellation are zero-write; normal double-click preserves unselected staged work', async () => {
  await fs.writeFile(path.join(repo, 'keep.txt'), 'unselected staged\n'); git(['add', 'keep.txt']);
  const keepIndex = git(['ls-files', '--stage', 'keep.txt']), before = await snapshot();
  await preview(); assert.deepEqual(await snapshot(), before); await record('preview');
  await page.click('#cancel-real-commit'); assert.deepEqual(await snapshot(), before);
  await preview();
  await page.locator('#confirm-real-commit').evaluate(button => { button.click(); button.click(); });
  await waitText('本地提交已完成');
  assert.equal(git(['rev-list', '--count', 'HEAD']), '2'); assert.equal(git(['ls-files', '--stage', 'keep.txt']), keepIndex);
  assert.equal(git(['show', 'HEAD:base.txt']), 'selected change'); assert.equal(git(['ls-tree', '--name-only', 'HEAD']), 'base.txt');
  assert.equal(requests.filter(r => r.url.endsWith('/confirm')).length, 1);
  assert.ok((await page.textContent('#commit-dialog')).includes(git(['rev-parse', 'HEAD']))); await record('completed');
});
qa('P3-T04 post-preview file change clears confirmation and keeps Git unchanged', async () => {
  await preview(); await fs.writeFile(path.join(repo, 'base.txt'), 'changed after preview\n'); const before = await snapshot();
  await page.click('#confirm-real-commit'); await waitText('预览已失效');
  assert.equal(await page.locator('#confirm-real-commit').count(), 0); assert.deepEqual(await snapshot(), before); await record('stale');
});
for (const [name, setup, code] of [
  ['identity', () => git(['config', 'user.email', '']), 'IDENTITY_MISSING'],
  ['signing', () => git(['config', 'commit.gpgsign', 'true']), 'SIGNING_UNSUPPORTED'],
  ['hooks', () => fs.writeFile(path.join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n'), 'HOOKS_UNSUPPORTED'],
  ['conflict', () => { const oid = git(['rev-parse', 'HEAD:base.txt']); const r = cp.spawnSync('git', ['update-index', '--index-info'], { cwd: repo, input: `0 ${'0'.repeat(40)}\tbase.txt\n100644 ${oid} 1\tbase.txt\n100644 ${oid} 2\tbase.txt\n100644 ${oid} 3\tbase.txt\n`, encoding: 'utf8' }); assert.equal(r.status, 0); }, 'GIT_CONFLICT'],
]) qa(`P3-T04 ${name} is blocked without Git writes`, async () => {
  await setup(); const before = await snapshot(); await open(); await waitText(code);
  assert.equal(await page.locator('#confirm-real-commit').count(), 0); assert.deepEqual(await snapshot(), before); await record(name);
});
qa('P3-T04 dropped confirm response queries same operation ID without repeating write, then survives server restart', async () => {
  await preview();
  await page.route('**/commit/confirm', async route => { await route.fetch(); await route.abort('failed'); });
  await page.click('#confirm-real-commit'); await waitText('本地提交已完成');
  const confirm = requests.find(r => r.url.endsWith('/confirm')), operationId = JSON.parse(confirm.body).operationId;
  assert.ok(requests.some(r => r.url.endsWith('/operations/' + operationId))); assert.equal(requests.filter(r => r.url.endsWith('/confirm')).length, 1);
  assert.equal(git(['rev-list', '--count', 'HEAD']), '2'); await record('network-reconciled');
  const oldPort = port; await stop(); clearAllCommitPreviewTickets(); await start(oldPort); await page.reload();
  await page.waitForSelector('#open-real-commit'); await open(); await waitText('本地提交已完成');
  assert.equal(git(['rev-list', '--count', 'HEAD']), '2'); await record('restart-recovery');
});
qa('P3-T04 unknown real outcome never becomes success or retry, and queries preserve Git', async () => {
  await preview();
  cp.spawn = (command, args, options) => {
    const child = originalSpawn(command, args, options);
    if (command === 'git' && args.includes('commit')) child.once('close', () => { fsSync.writeFileSync(path.join(repo, 'interference.txt'), 'external change'); git(['add', 'interference.txt']); });
    return child;
  }; syncBuiltinESMExports();
  await page.click('#confirm-real-commit'); await waitText('结果未知');
  assert.equal(await page.locator('#confirm-real-commit').count(), 0); const before = await snapshot();
  await page.click('#query-real-commit'); await waitText('结果未知'); assert.deepEqual(await snapshot(), before); await record('unknown');
});
qa('P3-T04 switching projects clears selection and ignores delayed candidate response', async () => {
  let release, arrived; const started = new Promise(r => { arrived = r; }); const gate = new Promise(r => { release = r; });
  await page.route('**/first/commit/candidates', async route => { const result = await route.fetch(); arrived(); await gate; await route.fulfill({ response: result }); });
  await open(); await started;
  await page.locator('#project-select').evaluate(select => { select.value = 'second'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  release(); await page.waitForSelector('#commit-dialog', { state: 'hidden' }); await page.waitForTimeout(100);
  await open(); await page.waitForSelector('[data-commit-candidate]');
  assert.equal(await page.locator('[data-commit-candidate]:checked').count(), 0);
  assert.equal(await page.locator('#confirm-real-commit').count(), 0); assert.equal(git(['rev-list', '--count', 'HEAD']), '1'); assert.equal(git(['rev-list', '--count', 'HEAD'], other), '1'); await record('project-isolation');
});
qa('P3-T04 partial result discloses staging and does not claim success', async () => {
  await fs.writeFile(path.join(repo, 'new.txt'), 'new file body\n');
  git(['add', 'base.txt']); // Existing staged change is selected but not newly staged by this operation.
  const baseIndex = git(['ls-files', '--stage', 'base.txt']);
  await open(); await page.waitForSelector('[data-commit-candidate]');
  for (const file of ['base.txt', 'new.txt']) await page.locator('label').filter({ hasText: file }).locator('[data-commit-candidate]').check();
  await page.fill('#real-commit-message', 'Mixed partial precise list');
  await page.click('#preview-real-commit'); await page.waitForSelector('#confirm-real-commit');
  cp.spawn = (command, args, options) => command === 'git' && args.includes('commit')
    ? originalSpawn(process.execPath, ['-e', 'process.exit(1)'], { ...options, cwd: repo })
    : originalSpawn(command, args, options);
  syncBuiltinESMExports(); await page.click('#confirm-real-commit'); await waitText('部分');
  assert.equal(git(['rev-list', '--count', 'HEAD']), '1'); assert.ok(git(['ls-files', '--stage', 'new.txt']));
  assert.equal(await page.locator('#confirm-real-commit').count(), 0);
  assert.equal(git(['ls-files', '--stage', 'base.txt']), baseIndex);
  assert.deepEqual(await page.locator('#proven-staged-files li').allTextContents(), ['new.txt']);
  await record('partial');
  // An external index change makes the next actual server reconciliation unknown.
  await fs.writeFile(path.join(repo, 'interference.txt'), 'external stage after partial'); git(['add', 'interference.txt']);
  await page.click('#query-real-commit'); await waitText('结果未知');
  assert.equal(await page.locator('#proven-staged-files').count(), 0); await record('partial-to-unknown');
});
qa('P3-T04 source/history/material pages remain read-only and preview remains isolated', async () => {
  const before = await snapshot();
  assert.equal(await page.getAttribute('meta[name="app-mode"]', 'content'), 'real');
  await page.click('#btn-refresh-real'); await page.waitForSelector('#open-real-commit');
  await page.click('[data-real-commit="0"]'); await page.waitForSelector('#dialog[open]');
  await page.keyboard.press('Escape');
  for (const view of ['installer', 'upgrade']) {
    await page.click(`button[data-view="${view}"]`); await page.waitForSelector('.material-unlinked-box');
    await page.click('#btn-open-material-dialog'); await page.waitForSelector('#material-dialog[open]');
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(await snapshot(), before);
  await page.route(`http://127.0.0.1:${port}/`, route => fs.readFile(path.resolve('frontend/index.html'), 'utf8').then(body => route.fulfill({ status: 200, contentType: 'text/html', body })));
  const startRequests = requests.length; await page.reload();
  assert.equal(await page.getAttribute('meta[name="app-mode"]', 'content'), 'preview');
  await page.click('[data-action="commit"]'); await page.fill('#commit-message', 'Memory only');
  await page.click('#commit-form button[type="submit"]');
  assert.equal(requests.length, startRequests); assert.deepEqual(await snapshot(), before);
  await page.screenshot({ path: path.join(evidenceDir, 't04-demo-isolation.png') });
});
qa('P3-T04 candidate request failure offers safe read retry without Git writes', async () => {
  const before = await snapshot();
  await page.route('**/commit/candidates', route => route.abort('failed'));
  await open(); await page.waitForSelector('#retry-commit-candidates');
  assert.equal(await page.locator('#confirm-real-commit').count(), 0);
  await page.unroute('**/commit/candidates'); await page.click('#retry-commit-candidates');
  await page.waitForSelector('[data-commit-candidate]');
  assert.deepEqual(await snapshot(), before); await record('candidate-retry');
});
