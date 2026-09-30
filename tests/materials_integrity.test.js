import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { baselineWith, limitsWith, inspectSource, hashSource } from '../server/materials/integrity.js';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t, content = 'fixture') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'file.bin'), content);
  return { root, source: await inspectSource(root, 'file.bin') };
}
test('baseline is explicit, bounded and normalized; limits cannot expand caps', () => {
  assert.equal(baselineWith(), null);
  assert.equal(baselineWith({ sha256: 'A'.repeat(64), source: ' user declaration ' }).sha256, 'a'.repeat(64));
  for (const value of [{ sha256: 'abc', source: 'x' }, { sha256: 'a'.repeat(64), source: '' }, { sha256: 'a'.repeat(64), source: 'x', passed: true }]) assert.throws(() => baselineWith(value));
  for (const value of [{ maxBytes: 2 ** 31 }, { timeoutMs: 0 }, { chunkBytes: 1.5 }, { random: 1 }]) assert.throws(() => limitsWith(value));
});
for (const [name, content] of [['empty', ''], ['large', Buffer.alloc(2 * 1024 * 1024, 41)]]) {
  test(`${name} streaming digest, explicit matched/mismatched/no baseline`, async t => {
    const { source } = await fixture(t, content);
    let blocks = 0;
    const result = await hashSource(source, { onChunk: () => { blocks++; } });
    assert.equal(result.integrity, 'no_baseline'); assert.equal(result.sha256, hash(content));
    assert.equal(result.bytes, content.length);
    if (content.length) assert.ok(blocks > 1);
    assert.equal((await hashSource(source, { baseline: { sha256: hash(content), source: 'declared' } })).integrity, 'matched');
    assert.equal((await hashSource(source, { baseline: { sha256: '0'.repeat(64), source: 'declared' } })).integrity, 'mismatched');
  });
}
test('byte budget, cooperative timeout and cancellation', async t => {
  const { source } = await fixture(t, Buffer.alloc(100));
  assert.equal((await hashSource(source, { limits: limitsWith({ maxBytes: 10 }) })).integrity, 'limit_exceeded');
  const controller = new AbortController();
  assert.equal((await hashSource(source, { limits: limitsWith({ chunkBytes: 1 }), signal: controller.signal, onChunk: () => controller.abort() })).integrity, 'cancelled');
  assert.equal((await hashSource(source, { limits: limitsWith({ timeoutMs: 1, chunkBytes: 1 }), onChunk: () => new Promise(r => setTimeout(r, 5)) })).integrity, 'timeout');
});
test('content alteration and ordinary replacement never yield a digest', async t => {
  const { root, source } = await fixture(t, Buffer.alloc(100));
  const result = await hashSource(source, { limits: limitsWith({ chunkBytes: 1 }), onChunk: async bytes => { if (bytes === 1) await fs.writeFile(path.join(root, 'file.bin'), Buffer.alloc(100, 3)); } });
  assert.equal(result.integrity, 'changed'); assert.equal(result.sha256, null);
  await fs.rename(path.join(root, 'file.bin'), path.join(root, 'old'));
  await fs.writeFile(path.join(root, 'file.bin'), Buffer.alloc(100));
  assert.equal((await hashSource(source)).integrity, 'changed');
});
test('traversal, links, directory source, and parent replacement rejected', async t => {
  const { root, source } = await fixture(t);
  for (const relative of ['../file.bin', '/etc/passwd', 'a\\b', 'a/../b', 'file.bin:stream', './file.bin']) await assert.rejects(inspectSource(root, relative));
  await fs.symlink('file.bin', path.join(root, 'link'));
  await assert.rejects(inspectSource(root, 'link'));
  await fs.mkdir(path.join(root, 'folder'));
  await assert.rejects(inspectSource(root, 'folder'));
  await fs.rename(root, root + '-old');
  t.after(() => fs.rm(root + '-old', { recursive: true, force: true }));
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'file.bin'), 'fixture');
  assert.equal((await hashSource(source)).integrity, 'changed');
});
for (const mode of ['deadline', 'cancel']) {
  test(`final stability I/O rechecks ${mode} before returning a digest`, async t => {
    const { source } = await fixture(t);
    const original = fs.lstat;
    let readingFinished = false, delayed = false;
    const controller = new AbortController();
    t.mock.method(fs, 'lstat', async (...args) => {
      if (readingFinished && !delayed && args[0] === source.file.path) {
        delayed = true;
        if (mode === 'cancel') controller.abort();
        else await new Promise(r => setTimeout(r, 100));
      }
      return original(...args);
    });
    const result = await hashSource(source, {
      limits: limitsWith({ timeoutMs: mode === 'deadline' ? 50 : 60000 }),
      signal: controller.signal,
      onChunk: () => { readingFinished = true; }
    });
    assert.equal(delayed, true);
    assert.equal(result.integrity, mode === 'deadline' ? 'timeout' : 'cancelled');
    assert.equal(result.sha256, null);
  });
}
