import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../server/app.js';

// Browser plugin not available. Known task-environment denial: Chromium socket EPERM;
// cloud browser localhost ERR_BLOCKED_BY_CLIENT. Do not retry/bypass that restriction.
// Opt in only on an authorized browser-capable acceptance environment.
const skip = process.env.P4_RUN_BROWSER === '1' ? false : 'Unexecuted: known Chromium socket EPERM / cloud localhost ERR_BLOCKED_BY_CLIENT; run P4_RUN_BROWSER=1 only in an authorized browser-capable environment';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
test('P4 real Chromium 1440×900 temporary-material copy, baseline, conflict, recovery and mode isolation', { skip }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs';
  const { chromium } = await import(module.startsWith('/') ? pathToFileURL(module).href : module);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-browser-'));
  let browser, app;
  t.after(async () => { await browser?.close(); if (app) { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); } await fs.rm(base, { recursive: true, force: true }); });
  const repo = path.join(base, 'repo'), root = path.join(base, 'materials'), target = path.join(base, 'archive'), conflict = path.join(base, 'conflict');
  for (const dir of [repo, root, target, conflict]) await fs.mkdir(dir);
  await fs.writeFile(path.join(root, 'file.bin'), 'fixture material');
  await fs.writeFile(path.join(conflict, 'file.bin'), 'protected old target');
  const records = JSON.stringify({ schemaVersion: 1, records: [{ kind: 'installer', file: 'file.bin', targetVersion: '1.0.0', recordedFile: { sha256: sha('fixture material') } }] });
  await fs.writeFile(path.join(root, 'material-records.json'), records);
  const configPath = path.join(base, 'projects.json');
  const config = JSON.stringify({ projects: [{ id: 'project', name: 'Fixture only', repositoryPath: repo, materials: { installer: { root }, upgrade: { root } } }] });
  await fs.writeFile(configPath, config);
  app = createAppServer({ configPath, materialOperationsDir: path.join(base, 'operations') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const port = app.server.address().port; app.setListeningPort(port);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/operations/')) posts.push(req.url()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  assert.match(await page.title(), /版本管理/); assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.click('[data-view="installer"]'); await page.waitForSelector('[data-material-operation="integrity"]');
  assert.ok((await page.locator('#page').textContent()).includes('file.bin'));
  async function start(action, directory) { await page.click(`[data-material-operation="${action}"]`); assert.equal(await page.inputValue('#operation-baseline'), 'none'); if (directory) await page.fill('#operation-target', directory); }
  async function preview() { await page.click('#preview-material-operation'); await page.waitForSelector('#confirm-material-operation'); }
  async function confirm() { await page.click('#confirm-material-operation'); await page.waitForFunction(() => document.querySelector('#material-operation-body').textContent.includes('本次流程已结束')); }
  async function close() { await page.click('#close-material-operation'); }
  await start('archive', target); await preview(); assert.match(await page.locator('#material-operation-body').textContent(), /目标文件名：file.bin/); await close(); assert.equal(posts.filter(u => u.endsWith('/confirm')).length, 0); assert.deepEqual(await fs.readdir(target), []);
  await start('integrity'); await page.selectOption('#operation-baseline', 'manual'); await page.fill('#operation-sha', '0'.repeat(64)); await page.fill('#operation-source', 'Explicit fixture mismatch'); await preview(); await confirm(); assert.match(await page.locator('#material-operation-body').textContent(), /摘要不匹配/); await close();
  await start('archive', target); await preview(); await confirm(); assert.match(await page.locator('#material-operation-body').textContent(), /已发布归档副本/); assert.match(await page.locator('#material-operation-body').textContent(), /未验证真伪/); assert.equal(await fs.readFile(path.join(target, 'file.bin'), 'utf8'), 'fixture material');
  const beforeReload = await page.evaluate(() => localStorage.getItem('lvm_material_operation_v1:project:installer')); await page.reload(); await page.click('[data-view="installer"]'); await page.click('#recover-material-operation'); await page.waitForFunction(() => document.querySelector('#material-operation-body').textContent.includes('已发布归档副本')); assert.match(await page.locator('#material-operation-body').textContent(), new RegExp(beforeReload)); await close();
  await start('archive', target); await preview(); await confirm(); assert.match(await page.locator('#material-operation-body').textContent(), /已有相同内容/); await close();
  await start('archive', conflict); await preview(); await confirm(); assert.match(await page.locator('#material-operation-body').textContent(), /目标内容冲突/); assert.equal(await fs.readFile(path.join(conflict, 'file.bin'), 'utf8'), 'protected old target');
  const screenshotPath = process.env.P4_SCREENSHOT_PATH || path.join(os.tmpdir(), `p4-material-operations-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false }); t.diagnostic(`Actual browser screenshot: ${screenshotPath}`);
  assert.equal(await fs.readFile(path.join(root, 'file.bin'), 'utf8'), 'fixture material'); assert.equal(await fs.readFile(path.join(root, 'material-records.json'), 'utf8'), records); assert.equal(await fs.readFile(configPath, 'utf8'), config);
  // A non-Git fixture is intentional. Its read-only source status may return 4xx;
  // all page exceptions remain failures; known network console messages are reported.
  assert.deepEqual(errors.filter(e => !e.includes('Failed to load resource: the server responded with a status of 4')), []);
  await close(); await page.click('[data-view="upgrade"]'); await page.waitForSelector('[data-material-operation="integrity"]'); await start('integrity'); await page.keyboard.press('Escape'); assert.equal(await page.locator('#material-operation-dialog').isVisible(), false);
  const demo = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const demoApi = [];
  demo.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) demoApi.push(req.url()); });
  // Fulfill with the unchanged disk preview marker; other static assets use the same origin.
  const previewHtml = await fs.readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  await demo.route(`http://127.0.0.1:${port}/`, route => route.fulfill({ contentType: 'text/html', body: previewHtml }));
  await demo.goto(`http://127.0.0.1:${port}/`); await demo.click('[data-view="installer"]');
  assert.equal(await demo.locator('[data-material-operation]').count(), 0); assert.deepEqual(demoApi, []);
});
