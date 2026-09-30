import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanMaterialDirectory, generateScanPreviewSummary, MAX_SERIALIZED_BYTES } from '../server/materials/scan.js';

describe('P2-T02: 有界只读扫描模块测试 (scan.js)', () => {
  async function snapshotDirectory(dirPath) {
    const snapshot = {};
    async function walk(current) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(current, ent.name);
        const rel = path.relative(dirPath, full);
        if (ent.isDirectory()) {
          snapshot[rel] = { type: 'dir' };
          await walk(full);
        } else if (ent.isFile()) {
          const content = await fs.readFile(full);
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          snapshot[rel] = { type: 'file', size: content.length, hash };
        }
      }
    }
    await walk(dirPath);
    return snapshot;
  }

  test('空根目录扫描：返回空 tree, 空 items, scan.status complete 且快照零变更', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-empty-'));
    try {
      const snapBefore = await snapshotDirectory(tempDir);
      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer', projectId: 'test_p' });
      assert.equal(res.state, 'linked');
      assert.equal(res.scan.status, 'complete');
      assert.equal(res.scan.truncated, false);
      assert.equal(res.scan.entriesScanned, 0);
      assert.deepEqual(res.tree, []);
      assert.deepEqual(res.items, []);

      const snapAfter = await snapshotDirectory(tempDir);
      assert.deepEqual(snapAfter, snapBefore, '扫描操作绝不修改目录');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('普通多级目录扫描：按相对路径稳定排序，物理文件与 tree 结构对应', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-normal-'));
    try {
      // 故意按逆序创建目录和文件
      await fs.mkdir(path.join(tempDir, 'z_dir', 'sub_b'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'a_dir'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'z_dir', 'sub_b', 'file_2.bin'), 'content2');
      await fs.writeFile(path.join(tempDir, 'a_dir', 'file_1.bin'), 'content1');
      await fs.writeFile(path.join(tempDir, 'root_file.exe'), 'root');

      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer', projectId: 'test_p' });
      assert.equal(res.scan.status, 'complete');
      assert.equal(res.scan.truncated, false);

      // 验证 tree 节点按代码点升序排序
      const relativePaths = res.tree.map((n) => n.relativePath);
      assert.ok(relativePaths.indexOf('a_dir') < relativePaths.indexOf('z_dir'));

      // 验证 items 包含物理文件且状态为 normal
      assert.equal(res.items.length, 3);
      const file1Item = res.items.find((it) => it.relativePath === 'a_dir/file_1.bin');
      assert.ok(file1Item);
      assert.equal(file1Item.physical.exists, true);
      assert.equal(file1Item.physical.status, 'normal');
      assert.equal(file1Item.declaration.state, 'no-record');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('跳过符号链接/junction：作为 skipped_link 记录，绝不进入其内部越界读取', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-junc-'));
    const materialRoot = path.join(baseDir, 'materials');
    const outsideTarget = path.join(baseDir, 'outside_secret');
    await fs.mkdir(materialRoot, { recursive: true });
    await fs.mkdir(outsideTarget, { recursive: true });

    // 在外部目录放置私密文件
    await fs.writeFile(path.join(outsideTarget, 'secret.txt'), 'do not scan me');

    // 在材料根内建立指向外部的 junction
    const linkPath = path.join(materialRoot, 'link_to_outside');
    await fs.symlink(outsideTarget, linkPath, 'junction');

    try {
      const res = await scanMaterialDirectory({ normRoot: materialRoot, kind: 'upgrade', projectId: 'test_p' });
      assert.equal(res.scan.status, 'complete');

      // 验证 link_to_outside 被识别为 skipped_link
      const linkNode = res.tree.find((n) => n.name === 'link_to_outside');
      assert.ok(linkNode);
      assert.equal(linkNode.type, 'skipped_link');

      // 验证外部 secret.txt 绝未被读取并列入 tree 或 items
      const hasSecret = res.tree.some((n) => n.name === 'secret.txt') || res.items.some((it) => it.relativePath.includes('secret.txt'));
      assert.equal(hasSecret, false, '绝不能越界读取链接指向的目标');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('深度上限限制：超过深度 5 时截断不下探，标记 truncated: true', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-depth-'));
    // 创建 6 层深度的目录结构: d1/d2/d3/d4/d5/d6
    const deepDir = path.join(tempDir, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6');
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(path.join(deepDir, 'too_deep.txt'), 'deep');

    try {
      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer' });
      assert.equal(res.scan.status, 'partial');
      assert.equal(res.scan.truncated, true);
      assert.ok(res.scan.reasons.includes('limit_max_depth'));

      // 验证第 6 层的文件未被输出
      const hasDeepFile = res.items.some((it) => it.relativePath.includes('too_deep.txt'));
      assert.equal(hasDeepFile, false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('单目录超过 1000 项：不输出不稳定部分子集，保留该目录节点并标记截断', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-maxdir-'));
    const crowdedDir = path.join(tempDir, 'crowded');
    await fs.mkdir(crowdedDir, { recursive: true });

    // 在 crowded 目录下创建 1005 个小文件
    for (let i = 0; i < 1005; i++) {
      const name = `f_${String(i).padStart(4, '0')}.txt`;
      await fs.writeFile(path.join(crowdedDir, name), '1');
    }

    try {
      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer' });
      assert.equal(res.scan.status, 'partial');
      assert.equal(res.scan.truncated, true);
      assert.ok(res.scan.reasons.includes('limit_directory_entries'));

      // 验证 crowded 目录本身存在
      const crowdedNode = res.tree.find((n) => n.name === 'crowded');
      assert.ok(crowdedNode);
      assert.equal(crowdedNode.type, 'directory');

      // 关键契约：超过 1000 项的目录不输出任何不稳定的半子集文件
      const crowdedFiles = res.items.filter((it) => it.relativePath.startsWith('crowded/'));
      assert.equal(crowdedFiles.length, 0, '单目录超限时不应输出部分子项');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('缺失引用与属性不一致 (changed) 判定', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-attr-'));
    const recFile = path.join(tempDir, 'material-records.json');

    const sample = {
      schemaVersion: 1,
      records: [
        {
          kind: 'installer',
          file: 'exists_but_changed.bin',
          targetVersion: 'v1.0.0',
          revision: 'r1',
          recordedFile: { sizeBytes: 9999, mtimeMs: 1000 }, // 与实际不同
        },
        {
          kind: 'installer',
          file: 'missing_physically.bin',
          targetVersion: 'v1.0.0',
          revision: 'r2',
        },
      ],
    };

    await fs.writeFile(recFile, JSON.stringify(sample, null, 2), 'utf-8');
    await fs.writeFile(path.join(tempDir, 'exists_but_changed.bin'), 'actual content is different');

    try {
      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer' });

      // 1. exists_but_changed.bin: 属性与记录不一致标为 changed
      const changedItem = res.items.find((it) => it.relativePath === 'exists_but_changed.bin');
      assert.ok(changedItem);
      assert.equal(changedItem.physical.exists, true);
      assert.equal(changedItem.physical.status, 'changed');

      // 2. missing_physically.bin: 记录引用缺失标为 missing / reference-missing
      const missingItem = res.items.find((it) => it.relativePath === 'missing_physically.bin');
      assert.ok(missingItem);
      assert.equal(missingItem.physical.exists, false);
      assert.equal(missingItem.physical.status, 'missing');
      assert.equal(missingItem.declaration.state, 'reference-missing');

      // 3. 验证 generateScanPreviewSummary 摘要
      const summary = generateScanPreviewSummary(res);
      assert.equal(summary.summary.totalFiles, 1);
      assert.equal(summary.summary.missingReferences, 1);
      assert.equal(summary.summary.recognizedRecords, 1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('Spec 3 [中]: 未被完整覆盖扫描的目录中的真实文件，绝不误判为物理缺失 (reference-missing)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-unverified-'));
    const crowdedDir = path.join(tempDir, 'crowded');
    await fs.mkdir(crowdedDir, { recursive: true });

    // 制造 1005 个文件触发单目录截断
    for (let i = 0; i < 1005; i++) {
      await fs.writeFile(path.join(crowdedDir, `item_${String(i).padStart(4, '0')}.bin`), 'x');
    }
    // 其中放置一个 present.bin
    await fs.writeFile(path.join(crowdedDir, 'present.bin'), 'i am here');

    // records 中声明该 present.bin
    const recFile = path.join(tempDir, 'material-records.json');
    await fs.writeFile(recFile, JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          kind: 'installer',
          file: 'crowded/present.bin',
          targetVersion: 'v1.0.0',
          revision: 'r1',
        },
      ],
    }));

    try {
      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer' });
      assert.equal(res.scan.truncated, true);
      assert.ok(res.scan.reasons.includes('limit_directory_entries'));

      // 关键断言：因为 crowded 目录被截断未扫描，不得断言 present.bin 物理缺失！
      const item = res.items.find((it) => it.relativePath === 'crowded/present.bin');
      assert.ok(item);
      assert.equal(item.physical.exists, null, '未扫描目录不能断言物理不存在');
      assert.equal(item.physical.status, 'unverified');
      assert.equal(item.declaration.state, 'unverified', '绝不能误报为 reference-missing');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('Spec 5 [中]: 条目在 readdir 后、lstat 前消失 (ENOENT) 或无权限 (EACCES) 时保留事实与相对路径', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-disappear-'));
    await fs.writeFile(path.join(tempDir, 'gone.bin'), 'soon gone');
    await fs.writeFile(path.join(tempDir, 'normal.bin'), 'ok');

    // 动态劫持 fs.lstat 模拟 gone.bin 在扫描中发生 ENOENT
    const fsPromises = await import('node:fs/promises');
    const origLstat = fsPromises.default.lstat;
    let goneChecked = false;

    fsPromises.default.lstat = async function (p, ...args) {
      if (typeof p === 'string' && p.endsWith('gone.bin')) {
        if (!goneChecked) {
          goneChecked = true;
          return origLstat.apply(this, [p, ...args]);
        }
        const err = new Error('File disappeared');
        err.code = 'ENOENT';
        throw err;
      }
      return origLstat.apply(this, [p, ...args]);
    };

    try {
      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer' });
      assert.equal(res.scan.status, 'partial');
      assert.equal(res.scan.truncated, true);
      assert.ok(res.scan.reasons.includes('entry_disappeared'));

      // 验证 tree 保留了已从目录枚举出的 gone.bin 节点，且类型标为 unavailable
      const goneNode = res.tree.find((n) => n.name === 'gone.bin');
      assert.ok(goneNode, 'tree 中必须保留已读到的条目事实');
      assert.equal(goneNode.type, 'unavailable');

      // 验证 items 保留了该条目，且状态明确为 disappeared
      const goneItem = res.items.find((it) => it.relativePath === 'gone.bin');
      assert.ok(goneItem, 'items 中必须保留该条目');
      assert.equal(goneItem.physical.status, 'disappeared');
      assert.equal(goneItem.physical.exists, false);

      // 验证正常文件未受影响
      const normalItem = res.items.find((it) => it.relativePath === 'normal.bin');
      assert.ok(normalItem);
      assert.equal(normalItem.physical.status, 'normal');
    } finally {
      fsPromises.default.lstat = origLstat;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('Spec 5 [中]: 条目无权限 (EACCES) 时保留事实与相对路径，状态标为 permission_denied 且 physical.exists 为 null', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-perm-'));
    await fs.writeFile(path.join(tempDir, 'denied.bin'), 'secret');

    const fsPromises = await import('node:fs/promises');
    const origLstat = fsPromises.default.lstat;
    let deniedChecked = false;

    fsPromises.default.lstat = async function (p, ...args) {
      if (typeof p === 'string' && p.endsWith('denied.bin')) {
        if (!deniedChecked) {
          deniedChecked = true;
          return origLstat.apply(this, [p, ...args]);
        }
        const err = new Error('Permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return origLstat.apply(this, [p, ...args]);
    };

    try {
      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer' });
      assert.equal(res.scan.status, 'partial');
      assert.equal(res.scan.truncated, true);
      assert.ok(res.scan.reasons.includes('entry_permission_denied'));

      const deniedItem = res.items.find((it) => it.relativePath === 'denied.bin');
      assert.ok(deniedItem);
      assert.equal(deniedItem.physical.status, 'permission_denied');
      assert.equal(deniedItem.physical.exists, null, '无权限文件无法确认物理属性，exists 应为 null');
    } finally {
      fsPromises.default.lstat = origLstat;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('Spec 3 [中]: 深度上限截断 (depth > 5) 未扫描的深层记录绝不误判为 physical.exists: false 或 reference-missing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-depth-unverified-'));
    // 创建深度为 6 的深层目录
    const deepDir = path.join(tempDir, 'l1', 'l2', 'l3', 'l4', 'l5', 'l6');
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(path.join(deepDir, 'target.bin'), 'target content');

    // 记录中声明此深层文件
    const recFile = path.join(tempDir, 'material-records.json');
    await fs.writeFile(recFile, JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          kind: 'installer',
          file: 'l1/l2/l3/l4/l5/l6/target.bin',
          targetVersion: 'v1.0.0',
          revision: 'r1',
        },
      ],
    }));

    try {
      const res = await scanMaterialDirectory({ normRoot: tempDir, kind: 'installer' });
      assert.equal(res.scan.status, 'partial');
      assert.equal(res.scan.truncated, true);
      assert.ok(res.scan.reasons.includes('limit_max_depth'));

      // 该深层文件因超过深度上限无法被安全扫描，绝对不能判定物理缺失
      const item = res.items.find((it) => it.relativePath === 'l1/l2/l3/l4/l5/l6/target.bin');
      assert.ok(item);
      assert.equal(item.physical.exists, null, '深层未扫描条目 exists 必须为 null');
      assert.equal(item.physical.status, 'unverified');
      assert.equal(item.declaration.state, 'unverified', '深层未扫描条目 declaration.state 必须为 unverified');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test('记录的精确 mtime 与当前文件相同时不误报属性变化', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-exact-mtime-'));
  try {
    const file = path.join(root, 'pkg.bin');
    await fs.writeFile(file, 'x');
    const stat = await fs.stat(file);
    await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{
        kind: 'installer',
        file: 'pkg.bin',
        targetVersion: 'v1.0.0',
        revision: 'r1',
        recordedFile: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs },
      }],
    }));
    const result = await scanMaterialDirectory({ normRoot: root, kind: 'installer' });
    assert.equal(result.items.find((item) => item.relativePath === 'pkg.bin')?.physical.status, 'normal');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('目录流式读取达到截止时间后不继续取下一项', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-deadline-'));
  const originalOpen = fs.opendir;
  const originalNow = Date.now;
  let now = 100000;
  let nextCalls = 0;
  try {
    Date.now = () => now;
    fs.opendir = async () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls++;
            now = 106000;
            return { value: { name: 'virtual' }, done: false };
          },
        };
      },
      async close() {},
    });
    const result = await scanMaterialDirectory({ normRoot: root, kind: 'installer' });
    assert.equal(nextCalls, 1);
    assert.equal(result.scan.status, 'partial');
    assert.ok(result.scan.reasons.includes('timeout'));
    assert.deepEqual(result.tree, []);
  } finally {
    fs.opendir = originalOpen;
    Date.now = originalNow;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Spec 1 [阻断修复]: 根路径在扫描期间（opendir 前）被替换为指向外部 junction 时抛出 MATERIAL_ROOT_UNAVAILABLE', async () => {
  const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-drift-parent-'));
  const normRoot = path.join(parentDir, 'mat_root');
  await fs.mkdir(normRoot, { recursive: true });
  await fs.writeFile(path.join(normRoot, 'legit.bin'), 'legit');

  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-drift-outside-'));
  const outsideTarget = path.join(outsideDir, 'mat_root');
  await fs.mkdir(outsideTarget, { recursive: true });
  await fs.writeFile(path.join(outsideTarget, 'sensitive.key'), 'SECRET_KEY');

  const originalOpendir = fs.opendir;
  let swapped = false;

  try {
    fs.opendir = async function (p, ...args) {
      if (!swapped && typeof p === 'string' && p.includes(path.basename(normRoot))) {
        swapped = true;
        // 模拟外部替换：移除 parentDir 并建立同名 junction 指向 outsideDir
        await fs.rm(parentDir, { recursive: true, force: true });
        await fs.symlink(outsideDir, parentDir, 'junction');
      }
      return originalOpendir.apply(this, [p, ...args]);
    };

    await assert.rejects(
      async () => {
        await scanMaterialDirectory({ normRoot, kind: 'installer' });
      },
      (err) => {
        assert.equal(err.code, 'MATERIAL_ROOT_UNAVAILABLE');
        return true;
      },
      '扫描期间根发生漂移必须抛出 MATERIAL_ROOT_UNAVAILABLE'
    );
  } finally {
    fs.opendir = originalOpendir;
    await fs.rm(parentDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('Spec 4 [硬上限]: 8 MiB 响应序列化超限实际触发，稳定截断 items、断言 partial 与字节数', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-8mb-'));
  const origOpendir = fs.opendir;
  const origLstat = fs.lstat;

  try {
    const pad = 'x'.repeat(240);
    const dirs = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5'];
    for (const d of dirs) {
      await fs.mkdir(path.join(root, d), { recursive: true });
    }

    fs.opendir = async function (p, ...args) {
      if (typeof p === 'string' && p.endsWith(path.basename(root))) {
        let idx = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (idx < dirs.length) {
                  const name = dirs[idx++];
                  return { value: { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }, done: false };
                }
                return { done: true };
              },
            };
          },
          async close() {},
        };
      }

      const match = dirs.find((d) => typeof p === 'string' && p.endsWith(d));
      if (match) {
        let idx = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (idx < 800) {
                  const name = 'file_' + String(idx++).padStart(3, '0') + '_' + pad + '.bin';
                  return { value: { name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }, done: false };
                }
                return { done: true };
              },
            };
          },
          async close() {},
        };
      }

      return origOpendir.apply(this, [p, ...args]);
    };


    fs.lstat = async function (p, ...args) {
      if (typeof p === 'string') {
        if (dirs.some((d) => p.endsWith(d))) {
          return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
        }
        if (p.includes(pad)) {
          return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 1024, mtimeMs: 1727400000000 };
        }
      }
      return origLstat.apply(this, [p, ...args]);
    };

    const res = await scanMaterialDirectory({ normRoot: root, kind: 'installer' });

    // 1. 明确断言 partial 状态与超限原因
    assert.equal(res.scan.status, 'partial', '8 MiB 超限后 scan.status 必须为 partial');
    assert.equal(res.scan.truncated, true, '8 MiB 超限后 scan.truncated 必须为 true');
    assert.ok(res.scan.reasons.includes('response_size_limit'), 'scan.reasons 必须包含 response_size_limit');

    // 2. 给出并校验实际响应序列化字节数
    const serializedBytes = Buffer.byteLength(JSON.stringify(res), 'utf-8');
    assert.ok(serializedBytes <= MAX_SERIALIZED_BYTES, `截断后字节数 (${serializedBytes}) 必须不超过硬上限 ${MAX_SERIALIZED_BYTES}`);
    assert.ok(serializedBytes > 7 * 1024 * 1024, `截断后字节数 (${serializedBytes}) 必须保持在上限附近`);

    // 3. 稳定截断断言：总共 4800 个文件，部分条目被截断剔除
    assert.ok(res.items.length < 4800, 'items 数组必须被截断剔除');
    assert.ok(res.items.length > 3500, 'items 必须保留大部分条目');

    // 保留条目必须按 relativePath 保持严格递增（代码点顺序）
    for (let i = 0; i < res.items.length - 1; i++) {
      assert.ok(
        res.items[i].relativePath < res.items[i + 1].relativePath,
        '保留的 items 必须保持稳定代码点升序'
      );
    }

    // 被截断丢弃的末尾项（如 d5/file_799_...）绝不能存在于保留结果中
    const lastItem = res.items[res.items.length - 1];
    const droppedSampleRel = `d5/file_799_${pad}.bin`;
    assert.equal(res.items.some((it) => it.relativePath === droppedSampleRel), false);
    assert.ok(droppedSampleRel > lastItem.relativePath, '被截断条目的代码点必须严格大于保留的最后一个条目');
  } finally {
    fs.opendir = origOpendir;
    fs.lstat = origLstat;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('S1 [短暂替换]: opendir 已取得外部目录句柄但路径恢复后，丢弃外部名称', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-transient-handle-'));
  const root = path.join(base, 'root');
  const sub = path.join(root, 'sub');
  const outside = path.join(base, 'outside');
  const saved = path.join(root, 'sub-saved');
  await fs.mkdir(sub, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(sub, 'inside.bin'), 'inside');
  await fs.writeFile(path.join(outside, 'outside-only.key'), 'fixture secret');
  const originalOpendir = fs.opendir;
  try {
    fs.opendir = async function (p, ...args) {
      if (p !== sub) return originalOpendir.call(this, p, ...args);
      await fs.rename(sub, saved);
      try {
        await fs.symlink(outside, sub, 'junction');
        return await originalOpendir.call(this, p, ...args);
      } finally {
        await fs.unlink(sub);
        await fs.rename(saved, sub);
      }
    };
    const result = await scanMaterialDirectory({ normRoot: root, kind: 'installer' });
    assert.equal(result.scan.status, 'partial');
    assert.ok(result.scan.reasons.includes('link_or_drift_detected'));
    assert.equal(JSON.stringify({ tree: result.tree, items: result.items }).includes('outside-only.key'), false);
    assert.ok(result.items.every((item) => item.relativePath !== 'sub/outside-only.key'));
  } finally {
    fs.opendir = originalOpendir;
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('资源边界: 预检查后目录增长仍只流式读取至第 1001 项', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-grow-after-preflight-'));
  await fs.writeFile(path.join(root, 'seed.bin'), 'seed');
  const originalOpendir = fs.opendir;
  const originalReaddir = fs.readdir;
  let rootOpens = 0;
  let oneShotReads = 0;
  try {
    fs.opendir = async function (p, ...args) {
      if (p === root && ++rootOpens === 2) {
        await Promise.all(Array.from({ length: 1001 }, (_, index) =>
          fs.writeFile(path.join(root, `new-${String(index).padStart(4, '0')}.bin`), 'x')));
      }
      return originalOpendir.call(this, p, ...args);
    };
    fs.readdir = async function (p, ...args) {
      if (p === root) oneShotReads++;
      return originalReaddir.call(this, p, ...args);
    };
    const result = await scanMaterialDirectory({ normRoot: root, kind: 'installer' });
    assert.equal(oneShotReads, 0, '扫描不得一次性物化增长后的目录');
    assert.equal(result.scan.status, 'partial');
    assert.ok(result.scan.reasons.includes('limit_directory_entries'));
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.tree, []);
  } finally {
    fs.opendir = originalOpendir;
    fs.readdir = originalReaddir;
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('P2-T04: 有界扫描与统一字段映射测试', () => {
  test('recordedFile 仅登记 sizeBytes 时，大小一致判为 normal，不比较时间；大小不符判为 changed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-t04-fields-'));
    try {
      const f1 = path.join(root, 'pkg1.bin');
      const f2 = path.join(root, 'pkg2.bin');
      await fs.writeFile(f1, 'exact-size-match-content'); // 24 字节
      await fs.writeFile(f2, 'different-size-content');

      const rec = {
        schemaVersion: 1,
        records: [
          {
            kind: 'installer',
            file: 'pkg1.bin',
            targetVersion: '1.0.0',
            revision: 'r1',
            releaseStatus: 'candidate',
            evidenceSource: 'sub/notes.json',
            recordedFile: {
              sizeBytes: 24, // 吻合
              sha256: 'a'.repeat(64),
            },
          },
          {
            kind: 'installer',
            file: 'pkg2.bin',
            targetVersion: '1.0.0',
            revision: 'r1',
            recordedFile: {
              sizeBytes: 9999, // 不吻合
            },
          },
        ],
      };
      await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify(rec, null, 2));

      const res = await scanMaterialDirectory({ normRoot: root, kind: 'installer' });
      const item1 = res.items.find((it) => it.relativePath === 'pkg1.bin');
      const item2 = res.items.find((it) => it.relativePath === 'pkg2.bin');

      assert.ok(item1);
      assert.equal(item1.physical.status, 'normal', '仅登记 sizeBytes 且与实际文件大小一致时必须为 normal');
      assert.equal(item1.declaration.releaseStatus, 'candidate');
      assert.equal(item1.declaration.evidenceSource, 'sub/notes.json');
      assert.equal(item1.declaration.recordedFile.sha256, 'a'.repeat(64));

      assert.ok(item2);
      assert.equal(item2.physical.status, 'changed', '文件大小与登记值不一致时必须为 changed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('S1 [高]: 根不变时子目录在父级 lstat 后被替换为外部 junction，丢弃不可信子树且绝不泄露外部文件', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-s1-sub-'));
    const normRoot = path.join(baseDir, 'mat_root');
    const subDir = path.join(normRoot, 'sub');
    const emptySub = path.join(normRoot, 'empty_dir');
    const outsideDir = path.join(baseDir, 'outside_dir');

    await fs.mkdir(normRoot, { recursive: true });
    await fs.mkdir(subDir, { recursive: true });
    await fs.mkdir(emptySub, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    await fs.writeFile(path.join(normRoot, 'root_file.bin'), 'legit root file');
    await fs.writeFile(path.join(outsideDir, 'outside-only.key'), 'SECRET_OUTSIDE_KEY_12345');

    const fsPromises = await import('node:fs/promises');
    const origOpendir = fsPromises.default.opendir;
    let swapped = false;

    try {
      // 确定性钩子：在对 subDir 即将调用 opendir 时，把 sub 替换为指向 outsideDir 的 junction
      fsPromises.default.opendir = async function (p, ...args) {
        if (!swapped && typeof p === 'string' && p.endsWith(path.sep + 'sub')) {
          swapped = true;
          // 移走普通子目录 subDir，并创建指向 outsideDir 的同名 junction
          await fs.rm(subDir, { recursive: true, force: true });
          await fs.symlink(outsideDir, subDir, 'junction');
        }
        return origOpendir.apply(this, [p, ...args]);
      };

      const res = await scanMaterialDirectory({ normRoot, kind: 'installer' });

      // 1. 扫描必须判定为截断，原因为 link_or_drift_detected
      assert.equal(res.scan.status, 'partial', '检测到子目录外部链接替换后必须为 partial');
      assert.equal(res.scan.truncated, true);
      assert.ok(res.scan.reasons.includes('link_or_drift_detected'));

      // 2. 外部文件 outside-only.key 绝对不能进入 tree 或 items
      const hasOutsideFileInTree = res.tree.some((n) => n.name === 'outside-only.key' || n.relativePath.includes('outside-only.key'));
      const hasOutsideFileInItems = res.items.some((it) => it.relativePath.includes('outside-only.key'));
      assert.equal(hasOutsideFileInTree, false, 'tree 绝不能包含外部条目');
      assert.equal(hasOutsideFileInItems, false, 'items 绝不能包含外部条目');

      // 3. sub 节点必须被修正为 skipped_link
      const subNode = res.tree.find((n) => n.relativePath === 'sub');
      assert.ok(subNode);
      assert.equal(subNode.type, 'skipped_link', '被替换为链接的子目录必须标记为 skipped_link');

      // 4. 根级正常文件与普通空子目录正常保留
      assert.ok(res.items.some((it) => it.relativePath === 'root_file.bin'));
      assert.ok(res.tree.some((n) => n.relativePath === 'empty_dir' && n.type === 'directory'));

      // 5. 检查预览摘要统计：skippedLinks 增加，外部条目不泄露
      const summary = generateScanPreviewSummary(res);
      assert.equal(summary.status, 'partial');
      assert.ok(summary.summary.skippedLinks >= 1);
    } finally {
      fsPromises.default.opendir = origOpendir;
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('R1 [中]: 根目录 opendir 抛出 EACCES 时抛出 MATERIAL_ROOT_UNAVAILABLE，而非返回 200 partial 空列表', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-r1-root-'));
    await fs.writeFile(path.join(root, 'pkg.bin'), 'pkg content');

    const fsPromises = await import('node:fs/promises');
    const origOpendir = fsPromises.default.opendir;
    let injectError = true;

    try {
      fsPromises.default.opendir = async function (p, ...args) {
        if (injectError && typeof p === 'string' && p.endsWith(path.basename(root))) {
          const err = new Error('Permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return origOpendir.apply(this, [p, ...args]);
      };

      // 根目录列举失败必须抛出 MATERIAL_ROOT_UNAVAILABLE
      await assert.rejects(
        async () => {
          await scanMaterialDirectory({ normRoot: root, kind: 'installer' });
        },
        (err) => {
          assert.equal(err.code, 'MATERIAL_ROOT_UNAVAILABLE', '根目录无法列举必须抛出 MATERIAL_ROOT_UNAVAILABLE');
          return true;
        }
      );

      // 移除故障注入后，重试恢复正常
      injectError = false;
      const recovered = await scanMaterialDirectory({ normRoot: root, kind: 'installer' });
      assert.equal(recovered.scan.status, 'complete');
      assert.equal(recovered.items.length, 1);
      assert.equal(recovered.items[0].relativePath, 'pkg.bin');
    } finally {
      fsPromises.default.opendir = origOpendir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('R1 [中] 对照: 子目录 opendir 抛出 EACCES 时返回 partial 并记录 directory_unreadable，不抛出异常', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-r1-subdir-'));
    const sub = path.join(root, 'unreadable_sub');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(root, 'normal.bin'), 'normal');

    const fsPromises = await import('node:fs/promises');
    const origOpendir = fsPromises.default.opendir;

    try {
      fsPromises.default.opendir = async function (p, ...args) {
        if (typeof p === 'string' && p.endsWith('unreadable_sub')) {
          const err = new Error('Permission denied on sub');
          err.code = 'EACCES';
          throw err;
        }
        return origOpendir.apply(this, [p, ...args]);
      };

      // 子目录不可读不抛出错误，而是返回 partial
      const res = await scanMaterialDirectory({ normRoot: root, kind: 'installer' });
      assert.equal(res.scan.status, 'partial');
      assert.equal(res.scan.truncated, true);
      assert.ok(res.scan.reasons.includes('directory_unreadable'));

      // 根级文件依然正常被收集
      const normalItem = res.items.find((it) => it.relativePath === 'normal.bin');
      assert.ok(normalItem);
      assert.equal(normalItem.physical.status, 'normal');
    } finally {
      fsPromises.default.opendir = origOpendir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});


