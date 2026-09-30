import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runGit, assertNoConfiguredFilters } from '../server/git/exec.js';
import { runPreviewGit, getCommitCandidates, createCommitPreview, recalculateAndCompareCommitPreview, clearAllCommitPreviewTickets } from '../server/git/commit-preview.js';

const posixFixture = { skip: process.platform === 'win32' ? 'POSIX-only fixture uses /bin/sh and newline filenames; no Windows execution evidence' : false };

// All homes, config scopes, scripts and repositories belong to this fixture.
// The wrapper supplies a fixture system config after the production GIT_* scrub.
async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvm-filter-security-'));
  const repo = path.join(root, 'repo with spaces'), home = path.join(root, 'home');
  const bin = path.join(root, 'bin'), system = path.join(root, 'system.config');
  const marker = path.join(root, 'marker');
  const previous = { ...process.env };
  try {
    for (const dir of [repo, home, bin]) await fs.mkdir(dir);
    await fs.writeFile(system, '');
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    await fs.writeFile(path.join(bin, 'git'), `#!/bin/sh\nexport GIT_CONFIG_SYSTEM='${system}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, PATH: `${bin}:${previous.PATH}` });
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: process.env });
      assert.equal(result.status, 0, result.stderr);
    };
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
    const file = '-odd [中文]\nname.txt';
    await fs.writeFile(path.join(repo, file), 'initial');
    git(['add', '--', file]); git(['commit', '-m', 'initial']);
    await fs.writeFile(path.join(repo, file), 'modified');
    const script = path.join(root, 'filter.sh');
    await fs.writeFile(script, `#!/bin/sh\nprintf invoked > '${marker}'\ncat\n`, { mode: 0o755 });
    await action({ root, repo, home, system, git, script, marker });
  } finally {
    clearAllCommitPreviewTickets();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const scope of ['local', 'global', 'system', 'global-include', 'conditional-include', 'system-include']) {
  for (const driver of ['clean', 'process']) {
    test(`${scope} ${driver} rejects before P1 status, candidates, preview and confirm; marker never runs`, posixFixture, async () => fixture(async ({ root, repo, home, system, git, script, marker }) => {
      const candidates = await getCommitCandidates(repo);
      const params = { candidateIds: candidates.candidates.map(c => c.id), message: 'safe fixture' };
      const preview = await createCommitPreview(repo, params);
      await fs.writeFile(path.join(repo, '.gitattributes'), '* filter=fixture\n');
      const config = `[filter "fixture"]\n ${driver} = '${script}'\n`;
      if (scope === 'local') git(['config', `filter.fixture.${driver}`, `'${script}'`]);
      else if (scope === 'global') await fs.writeFile(path.join(home, '.gitconfig'), config);
      else if (scope === 'system') await fs.writeFile(system, config);
      else {
        const included = path.join(root, 'included config');
        await fs.writeFile(included, config);
        const header = scope === 'conditional-include' ? `[includeIf "gitdir:${repo}/"]` : '[include]';
        await fs.writeFile(scope === 'system-include' ? system : path.join(home, '.gitconfig'), `${header}\n path = ${included}\n`);
      }
      for (const action of [
        () => runGit(['status', '--porcelain=v2', '-z'], { cwd: repo }),
        () => runPreviewGit(['hash-object', '--', '-odd [中文]\nname.txt'], { cwd: repo }),
        () => getCommitCandidates(repo),
        () => createCommitPreview(repo, params),
      ]) {
        await assert.rejects(action, { code: 'FILTER_UNSUPPORTED' });
        assert.equal(await fs.stat(marker).then(() => true, () => false), false);
      }
      const confirmed = await recalculateAndCompareCommitPreview(preview.ticketId);
      assert.equal(confirmed.valid, false);
      assert.equal(confirmed.reason, 'PREVIEW_STALE'); // Preserve the confirmation contract.
      assert.equal(await fs.stat(marker).then(() => true, () => false), false);
    }));
  }
}

test('NUL config parser preserves multiline values and effective overrides', () => {
  assert.throws(() => assertNoConfiguredFilters(Buffer.from('filter.fixture.process\ncommand\nnext\0')), { code: 'FILTER_UNSUPPORTED' });
  assert.doesNotThrow(() => assertNoConfiguredFilters(Buffer.from('filter.fixture.clean\nold\0filter.fixture.clean\n\0')));
  assert.doesNotThrow(() => assertNoConfiguredFilters(Buffer.from('user.name\nSafe\0')));
});

test('invalid inherited config fails closed without running marker', posixFixture, async () => fixture(async ({ repo, home, marker }) => {
  await fs.writeFile(path.join(home, '.gitconfig'), '[invalid');
  await assert.rejects(() => runGit(['status', '--porcelain=v2', '-z'], { cwd: repo }), { code: 'GIT_READ_FAILED' });
  await assert.rejects(() => runPreviewGit(['status', '--porcelain=v2', '-z'], { cwd: repo }), { code: 'GIT_READ_FAILED' });
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
}));

test('preview Git routes small and large stdin only to the content command', posixFixture, async () => fixture(async ({ repo }) => {
  const { createHash } = await import('node:crypto');
  for (const content of [Buffer.from('small input\n'), Buffer.alloc(4 * 1024 * 1024, 97)]) {
    const expected = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    const result = await runPreviewGit(['hash-object', '--stdin'], { cwd: repo, stdin: content });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString().trim(), expected);
  }
}));

test('early Git exit with large stdin returns command failure without crashing', posixFixture, async () => fixture(async ({ repo }) => {
  const result = await runPreviewGit(['hash-object', '--definitely-invalid-option'], { cwd: repo, stdin: Buffer.alloc(4 * 1024 * 1024, 97) });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr.toString(), /unknown option/);
  const healthy = await runPreviewGit(['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  assert.equal(healthy.code, 0);
}));
