import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
// Deliverable-only copy: no .local, .git, dependencies, private fixtures or docs.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvm-portability-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = path.join(root, 'moved tool 中文');
  const cwd = path.join(root, 'unrelated caller');
  await fs.mkdir(tool); await fs.mkdir(cwd);
  for (const entry of ['package.json', 'preview.mjs', 'server', 'frontend']) {
    await fs.cp(path.join(sourceRoot, entry), path.join(tool, entry), {
      recursive: true,
      filter: (file) => !file.includes(`${path.sep}.local`) && !file.includes(`${path.sep}.git`) &&
        (['server', 'frontend'].includes(path.basename(file)) ||
          path.extname(file) === '' || ['.js', '.mjs', '.json', '.html', '.css'].includes(path.extname(file))),
    });
  }
  return { root, tool, cwd };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function launch(t, fixture, entry, env = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.PORT; delete cleanEnv.LVM_CONFIG_PATH;
  const child = spawn(process.execPath, [path.join(fixture.tool, entry)], {
    cwd: fixture.cwd, env: { ...cleanEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', ended = false;
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  t.after(async () => { if (!ended) child.kill('SIGKILL'); await done; });
  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; },
    async ready() {
      for (let i = 0; i < 200; i++) {
        // stdout chunks need not align with console.log calls. Wait for the
        // final startup line before assertions inspect the complete banner.
        const marker = entry === 'preview.mjs' ? '真实服务默认端口为 4189。' : '失效时请重新选定关联。';
        if (stdout.includes('http://127.0.0.1:') && stdout.includes(marker)) return;
        if (ended) assert.fail(`Launch exited: ${stderr}`);
        await delay(25);
      }
      assert.fail(`Launch timed out: ${stderr}`);
    },
    async stop(signal = 'SIGTERM') {
      child.kill(signal);
      assert.deepEqual(await done, { code: 0, signal: null });
    },
  };
}
async function get(port, resource = '/', options) {
  return fetch(`http://127.0.0.1:${port}${resource}`, options);
}
async function writeConfig(f, content) {
  const config = path.join(f.tool, '.local/projects.json');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, content);
  return config;
}

test('copied install starts from unrelated cwd, defaults stay distinct, modes stay isolated', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const real = launch(t, f, 'server/index.js');
  const preview = launch(t, f, 'preview.mjs');
  await Promise.all([real.ready(), preview.ready()]);
  assert.match(real.stdout, /127\.0\.0\.1:4189\//);
  assert.match(preview.stdout, /127\.0\.0\.1:4191\//);
  assert.match(real.stdout, /moved tool 中文.*\.local/);
  assert.match(await (await get(4189)).text(), /name="app-mode" content="real"/);
  assert.match(await (await get(4191)).text(), /name="app-mode" content="preview"/);
  assert.equal((await get(4189, '/styles.css')).status, 200);
  assert.equal((await get(4191, '/app.js')).status, 200);
  const projects = await (await get(4189, '/api/projects')).json();
  assert.equal(projects.configured, false);
  assert.deepEqual(projects.projects, []);
  assert.equal((await get(4191, '/api/projects')).status, 404);
  assert.equal((await get(4191, '/api/projects', { method: 'POST' })).status, 404);
  for (const port of [4189, 4191]) {
    assert.equal((await get(port, '/server/index.js')).status, 404);
    assert.equal((await get(port, '/.local/projects.json')).status, 404);
  }
  await real.stop('SIGINT'); await preview.stop('SIGTERM');
  assert.match(real.stdout, /服务已停止/);
  assert.match(preview.stdout, /演示已停止/);
  assert.deepEqual(await fs.readdir(f.cwd), []);
  await assert.rejects(fs.access(path.join(f.tool, '.local')));
});

test('config faults and moved associations remain visible without rewriting data or operation records', { timeout: 15000 }, async (t) => {
  const f = await fixture(t), port = await freePort();
  const config = await writeConfig(f, '{broken');
  const record = path.join(f.tool, '.local/commit-operations/retained.json');
  await fs.mkdir(path.dirname(record)); await fs.writeFile(record, 'retained history');
  const run = launch(t, f, 'server/index.js', { PORT: String(port) });
  await run.ready();
  const bad = await get(port, '/api/projects');
  assert.equal(bad.status, 500);
  assert.equal((await bad.json()).error.code, 'CONFIG_INVALID');
  assert.equal(await fs.readFile(config, 'utf8'), '{broken');
  const content = JSON.stringify({ projects: [{ id: 'moved', name: 'Moved',
    repositoryPath: path.join(f.root, 'missing repo'),
    materials: { installer: { root: path.join(f.root, 'missing materials') } },
  }] });
  await fs.writeFile(config, content);
  assert.equal((await (await get(port, '/api/projects/moved/source')).json()).error.code, 'PATH_UNAVAILABLE');
  assert.equal((await (await get(port, '/api/projects/moved/materials/installer')).json()).error.code, 'MATERIAL_ROOT_UNAVAILABLE');
  await run.stop();
  assert.equal(await fs.readFile(config, 'utf8'), content);
  assert.equal(await fs.readFile(record, 'utf8'), 'retained history');
  assert.deepEqual(await fs.readdir(f.cwd), []);
});

test('explicit absolute config override wins without moving or rewriting tool data', { timeout: 15000 }, async (t) => {
  const f = await fixture(t), port = await freePort();
  const original = await writeConfig(f, '{broken original');
  const alternate = path.join(f.root, 'chosen config.json');
  await fs.writeFile(alternate, '{"projects":[]}');
  const run = launch(t, f, 'server/index.js', { PORT: String(port), LVM_CONFIG_PATH: alternate });
  await run.ready();
  assert.equal((await get(port, '/api/projects')).status, 200);
  await run.stop();
  assert.equal(await fs.readFile(original, 'utf8'), '{broken original');
  assert.equal(await fs.readFile(alternate, 'utf8'), '{"projects":[]}');
});

for (const entry of ['server/index.js', 'preview.mjs']) {
  test(`${entry}: strict PORT rejects invalid values`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    for (const PORT of ['', '0', '-1', '65536', '4189suffix', '1.5', ' 4191', 'Infinity']) {
      const run = launch(t, f, entry, { PORT });
      assert.equal((await run.done).code, 1);
      assert.match(run.stderr, /PORT.*1–65535/);
      assert.equal(run.stdout, '');
    }
  });
  test(`${entry}: occupied port fails actionably and leaves owner running`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t), blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => blocker.close(resolve)));
    const run = launch(t, f, entry, { PORT: String(blocker.address().port) });
    assert.equal((await run.done).code, 1);
    assert.match(run.stderr, /已被占用.*PORT/);
    assert.equal(blocker.listening, true);
  });
}
test('relative or empty explicit config paths fail instead of silently using cwd', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const LVM_CONFIG_PATH of ['', '.local/projects.json']) {
    const run = launch(t, f, 'server/index.js', { LVM_CONFIG_PATH });
    assert.equal((await run.done).code, 1);
    assert.match(run.stderr, /LVM_CONFIG_PATH.*绝对路径/);
  }
});
