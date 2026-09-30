import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadMaterialRecords, isSafeRelativePath } from '../server/materials/records.js';
import { parseComparableVersion, compareVersions, evaluateCompatibility } from '../server/materials/versions.js';

describe('P2-T02: 材料记录解析与升级兼容测试', () => {
  describe('版本解析与比较模块 (versions.js)', () => {
    test('合法的 v?MAJOR.MINOR.PATCH 规范化解析', () => {
      const validCases = [
        { in: 'v1.2.3', expected: { major: 1, minor: 2, patch: 3, normalized: 'v1.2.3' } },
        { in: '1.2.3', expected: { major: 1, minor: 2, patch: 3, normalized: 'v1.2.3' } },
        { in: 'v0.0.0', expected: { major: 0, minor: 0, patch: 0, normalized: 'v0.0.0' } },
        { in: 'v999999.999999.999999', expected: { major: 999999, minor: 999999, patch: 999999, normalized: 'v999999.999999.999999' } },
      ];

      for (const c of validCases) {
        const parsed = parseComparableVersion(c.in);
        assert.ok(parsed, `应当合法: ${c.in}`);
        assert.equal(parsed.major, c.expected.major);
        assert.equal(parsed.minor, c.expected.minor);
        assert.equal(parsed.patch, c.expected.patch);
        assert.equal(parsed.normalized, c.expected.normalized);
      }
    });

    test('非法或超出格式的版本判定为不可比较 (null)', () => {
      const invalidCases = [
        'v1.2', // 缺补丁位
        'V1.2.3', // 大写 V
        'v1.2.3-rc.1', // 预发布
        'v1.2.3+build1', // 构建标识
        '>=v1.2.0', // 范围
        'v1.02.3', // 前导零
        'v01.2.3',
        'v1.2.03',
        'v1000000.1.1', // 超过 999999
        'random_string',
        '',
        null,
        undefined,
      ];

      for (const inv of invalidCases) {
        assert.equal(parseComparableVersion(inv), null, `应当不可比较: ${inv}`);
      }
    });

    test('三元组比较规则', () => {
      const v1 = parseComparableVersion('v1.2.0');
      const v2 = parseComparableVersion('v1.3.0');
      const v3 = parseComparableVersion('v2.0.0');
      const v4 = parseComparableVersion('1.2.0');

      assert.equal(compareVersions(v1, v2), -1);
      assert.equal(compareVersions(v2, v1), 1);
      assert.equal(compareVersions(v1, v3), -1);
      assert.equal(compareVersions(v1, v4), 0);
    });

    test('evaluateCompatibility 计算升级包来源与最低值', () => {
      // 1. 安装包返回 not-applicable
      const instRes = evaluateCompatibility({ kind: 'installer', targetVersion: 'v1.4.0', directFrom: ['v1.2.0'] });
      assert.equal(instRes.state, 'not-applicable');
      assert.equal(instRes.minimumDirectSource, null);

      // 2. 升级包缺 directFrom 字段返回 unknown
      const unkRes = evaluateCompatibility({ kind: 'upgrade', targetVersion: 'v1.4.0', directFrom: undefined });
      assert.equal(unkRes.state, 'unknown');
      assert.equal(unkRes.minimumDirectSource, null);

      // 3. directFrom 为空数组返回 none
      const noneRes = evaluateCompatibility({ kind: 'upgrade', targetVersion: 'v1.4.0', directFrom: [] });
      assert.equal(noneRes.state, 'none');
      assert.deepEqual(noneRes.directFrom, []);
      assert.equal(noneRes.minimumDirectSource, null);

      // 4. 合法列表取最低版本
      const validRes = evaluateCompatibility({
        kind: 'upgrade',
        targetVersion: 'v1.4.0',
        directFrom: ['v1.3.0', '1.2.0'],
      });
      assert.equal(validRes.state, 'available');
      assert.equal(validRes.minimumDirectSource, 'v1.2.0');

      // 5. 非连续列表只列原项并取最低
      const jumpRes = evaluateCompatibility({
        kind: 'upgrade',
        targetVersion: 'v2.0.0',
        directFrom: ['v1.0.0', 'v1.8.0'],
      });
      assert.equal(jumpRes.state, 'available');
      assert.equal(jumpRes.minimumDirectSource, 'v1.0.0');

      // 6. 包含非法/预发布/范围版本，整份列表为 invalid，绝不取合法子集
      const invalidMixedRes = evaluateCompatibility({
        kind: 'upgrade',
        targetVersion: 'v1.4.0',
        directFrom: ['v1.2.0', '>=v1.1.0'],
      });
      assert.equal(invalidMixedRes.state, 'invalid');
      assert.equal(invalidMixedRes.minimumDirectSource, null);

      // 7. 来源版本不早于目标版本，标为 invalid
      const notEarlierRes = evaluateCompatibility({
        kind: 'upgrade',
        targetVersion: 'v1.4.0',
        directFrom: ['v1.4.0'],
      });
      assert.equal(notEarlierRes.state, 'invalid');
      assert.equal(notEarlierRes.minimumDirectSource, null);

      // 8. 目标版本本身不可比较，整份标为 invalid
      const badTargetRes = evaluateCompatibility({
        kind: 'upgrade',
        targetVersion: 'v1.4.0-rc.1',
        directFrom: ['v1.2.0'],
      });
      assert.equal(badTargetRes.state, 'invalid');
      assert.equal(badTargetRes.minimumDirectSource, null);
    });
  });

  describe('安全相对路径校验 (isSafeRelativePath)', () => {
    test('允许安全根内相对路径，拒绝越界、反斜杠、绝对路径与空段', () => {
      assert.equal(isSafeRelativePath('releases/setup-r1.exe'), true);
      assert.equal(isSafeRelativePath('pkg.zip'), true);
      assert.equal(isSafeRelativePath('a/b/c/d.tar.gz'), true);

      // 越界与非法符号
      assert.equal(isSafeRelativePath('../outside.zip'), false);
      assert.equal(isSafeRelativePath('a/../../outside.zip'), false);
      assert.equal(isSafeRelativePath('releases\\setup.exe'), false); // 反斜杠
      assert.equal(isSafeRelativePath('/releases/setup.exe'), false); // 绝对路径
      assert.equal(isSafeRelativePath('C:/releases/setup.exe'), false); // 盘符
      assert.equal(isSafeRelativePath('releases//setup.exe'), false); // 双斜杠/空分段
      assert.equal(isSafeRelativePath('releases/./setup.exe'), false); // 当前目录分段
      assert.equal(isSafeRelativePath(''), false);
      assert.equal(isSafeRelativePath('   '), false);
      assert.equal(isSafeRelativePath('a'.repeat(1025)), false); // 超过 1024 字符
    });
  });

  describe('material-records.json 文件与记录解析', () => {
    test('无 material-records.json 时正常返回 hasRecordFile: false', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-none-'));
      try {
        const res = await loadMaterialRecords(tempDir, 'installer');
        assert.equal(res.hasRecordFile, false);
        assert.equal(res.recordFileError, null);
        assert.equal(res.recordsMap.size, 0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('文件损坏或超过 256 KiB 返回 record-invalid 错误', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-err-'));
      const recFile = path.join(tempDir, 'material-records.json');

      try {
        // 1. 非法 JSON
        await fs.writeFile(recFile, 'BROKEN JSON {]');
        const resBroken = await loadMaterialRecords(tempDir, 'installer');
        assert.equal(resBroken.hasRecordFile, true);
        assert.ok(resBroken.recordFileError);
        assert.equal(resBroken.recordFileError.code, 'record-invalid');

        // 2. 超过 256 KiB
        const largeContent = JSON.stringify({
          schemaVersion: 1,
          records: [],
          padding: 'x'.repeat(260 * 1024),
        });
        await fs.writeFile(recFile, largeContent);
        const resLarge = await loadMaterialRecords(tempDir, 'installer');
        assert.equal(resLarge.hasRecordFile, true);
        assert.equal(resLarge.recordFileError.code, 'record-invalid');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('完整合法记录解析与冲突条目处理', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-valid-'));
      const recFile = path.join(tempDir, 'material-records.json');

      const sampleData = {
        schemaVersion: 1,
        records: [
          {
            kind: 'installer',
            file: 'releases/setup-r1.exe',
            targetVersion: 'v1.4.0',
            revision: 'r1',
            platform: 'Windows x64',
            sourceCommit: '0123456789abcdef0123456789abcdef01234567',
            recordedFile: { sizeBytes: 123456, mtimeMs: 1790000000000 },
            integrityRecord: {
              result: 'passed',
              recordedAt: '2026-09-25T10:00:00Z',
              method: 'SHA-256',
            },
            installationRecord: {
              result: 'passed',
              recordedAt: '2026-09-26T11:00:00Z',
              environment: 'Windows 10 x64',
            },
          },
          // 产生冲突的重复条目：同一 kind + file 出现两次
          {
            kind: 'installer',
            file: 'releases/conflict.zip',
            targetVersion: 'v1.0.0',
            revision: 'r1',
          },
          {
            kind: 'installer',
            file: 'releases/conflict.zip',
            targetVersion: 'v1.0.1',
            revision: 'r2',
          },
        ],
      };

      await fs.writeFile(recFile, JSON.stringify(sampleData, null, 2), 'utf-8');

      try {
        const res = await loadMaterialRecords(tempDir, 'installer');
        assert.equal(res.hasRecordFile, true);
        assert.equal(res.recordFileError, null);

        // 正常记录校验
        const validItem = res.recordsMap.get('releases/setup-r1.exe');
        assert.ok(validItem);
        assert.equal(validItem.state, 'available');
        assert.equal(validItem.targetVersion, 'v1.4.0');
        assert.equal(validItem.revision, 'r1');
        assert.equal(validItem.platform, 'Windows x64');
        assert.equal(validItem.recordedFile.sizeBytes, 123456);
        assert.equal(validItem.integrityRecord.result, 'passed');
        assert.equal(validItem.installationRecord.result, 'passed');
        assert.equal(validItem.installationRecord.environment, 'Windows 10 x64');

        // 冲突记录校验
        const conflictItem = res.recordsMap.get('releases/conflict.zip');
        assert.ok(conflictItem);
        assert.equal(conflictItem.state, 'record-conflict');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('Spec 2 [高]: 记录中未知额外私密字段绝不泄露，非法引用绝不作为条目输出', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-leak-'));
      const recFile = path.join(tempDir, 'material-records.json');

      const sampleData = {
        schemaVersion: 1,
        records: [
          {
            kind: 'installer',
            file: 'releases/valid.exe',
            targetVersion: 'v1.0.0',
            revision: 'r1',
            privatePath: 'C:/private/never-disclose', // 未知额外私密字段
            unknownMeta: { secret: 12345 },
          },
          // 非法越界与绝对路径引用
          {
            kind: 'installer',
            file: 'C:/private/secret.bin',
            targetVersion: 'v1.0.0',
            revision: 'r2',
          },
          {
            kind: 'installer',
            file: '../outside.bin',
            targetVersion: 'v1.0.0',
            revision: 'r3',
          },
        ],
      };

      await fs.writeFile(recFile, JSON.stringify(sampleData, null, 2), 'utf-8');

      try {
        const res = await loadMaterialRecords(tempDir, 'installer');
        assert.equal(res.hasRecordFile, true);
        assert.equal(res.hasInvalidPaths, true);

        // 1. 验证合法记录只包含白名单字段，绝不输出 raw 或 privatePath
        const validItem = res.recordsMap.get('releases/valid.exe');
        assert.ok(validItem);
        assert.equal(validItem.privatePath, undefined);
        assert.equal(validItem.unknownMeta, undefined);
        assert.equal(validItem.raw, undefined);
        assert.equal(validItem.sourceOrigin, 'material-records.json');
        assert.equal(validItem.recordIndex, 0);

        // 2. 验证非法路径绝未作为条目放入 recordsMap
        assert.equal(res.recordsMap.has('C:/private/secret.bin'), false);
        assert.equal(res.recordsMap.has('../outside.bin'), false);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

test('超过单次读取缓冲区的合法记录仍可完整解析', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-multichunk-'));
  try {
    const recordPath = path.join(root, 'material-records.json');
    const content = JSON.stringify({
      schemaVersion: 1,
      records: [{ kind: 'installer', file: 'pkg.bin', targetVersion: 'v1.0.0', revision: 'r1' }],
      padding: 'x'.repeat(20000),
    });
    await fs.writeFile(recordPath, content);
    const result = await loadMaterialRecords(root, 'installer');
    assert.equal(result.recordFileError, null);
    assert.equal(result.recordsMap.get('pkg.bin')?.state, 'available');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('非法 directFrom 对象不进入兼容性 API 数据', () => {
  const result = evaluateCompatibility({
    kind: 'upgrade',
    targetVersion: 'v2.0.0',
    directFrom: [{ privatePath: 'C:/private/secret' }],
  });
  assert.equal(result.state, 'invalid');
  assert.equal(result.directFrom, null);
  assert.equal(JSON.stringify(result).includes('C:/private/secret'), false);
});

test('错误类型或非法 kind 的记录会产生可见警告', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-invalid-shape-'));
  try {
    await fs.writeFile(path.join(root, 'pkg.bin'), 'x');
    await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify({
      schemaVersion: 1,
      records: [42, { kind: 'other', file: 'pkg.bin', targetVersion: 'v1.0.0', revision: 'r1' }],
    }));
    const result = await loadMaterialRecords(root, 'installer');
    assert.equal(result.hasInvalidRecords, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('P2-T04: 统一记录字段扩展与向后兼容契约测试', () => {
  test('releaseStatus 校验：仅接受 candidate/released，非法值报 record-invalid', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-status-'));
    try {
      await fs.writeFile(path.join(root, 'pkg1.bin'), 'x');
      await fs.writeFile(path.join(root, 'pkg2.bin'), 'x');
      await fs.writeFile(path.join(root, 'pkg3.bin'), 'x');
      await fs.writeFile(path.join(root, 'pkg4.bin'), 'x');

      await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify({
        schemaVersion: 1,
        records: [
          { kind: 'installer', file: 'pkg1.bin', targetVersion: 'v1.0.0', revision: 'r1', releaseStatus: 'candidate' },
          { kind: 'installer', file: 'pkg2.bin', targetVersion: 'v1.0.0', revision: 'r1', releaseStatus: 'released' },
          { kind: 'installer', file: 'pkg3.bin', targetVersion: 'v1.0.0', revision: 'r1' }, // 未声明
          { kind: 'installer', file: 'pkg4.bin', targetVersion: 'v1.0.0', revision: 'r1', releaseStatus: 'invalid_status' },
        ],
      }));

      const res = await loadMaterialRecords(root, 'installer');
      assert.equal(res.recordsMap.get('pkg1.bin')?.releaseStatus, 'candidate');
      assert.equal(res.recordsMap.get('pkg2.bin')?.releaseStatus, 'released');
      assert.equal(res.recordsMap.get('pkg3.bin')?.releaseStatus, null);
      assert.equal(res.recordsMap.get('pkg4.bin')?.state, 'record-invalid');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('targetVersion 与 revision 允许为 null，不从文件名猜测', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-null-ver-'));
    try {
      await fs.writeFile(path.join(root, 'pkg.bin'), 'x');
      await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify({
        schemaVersion: 1,
        records: [
          { kind: 'installer', file: 'pkg.bin', targetVersion: null, revision: null },
        ],
      }));

      const res = await loadMaterialRecords(root, 'installer');
      const item = res.recordsMap.get('pkg.bin');
      assert.equal(item?.state, 'available');
      assert.equal(item?.targetVersion, null);
      assert.equal(item?.revision, null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('evidenceSource 校验：合法相对路径保留，越界/绝对路径报 record-invalid', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-evidence-'));
    try {
      await fs.writeFile(path.join(root, 'pkg1.bin'), 'x');
      await fs.writeFile(path.join(root, 'pkg2.bin'), 'x');
      await fs.writeFile(path.join(root, 'pkg3.bin'), 'x');

      await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify({
        schemaVersion: 1,
        records: [
          { kind: 'installer', file: 'pkg1.bin', targetVersion: 'v1.0.0', revision: 'r1', evidenceSource: 'sub/release-record.json' },
          { kind: 'installer', file: 'pkg2.bin', targetVersion: 'v1.0.0', revision: 'r1', evidenceSource: '../outside.json' },
          { kind: 'installer', file: 'pkg3.bin', targetVersion: 'v1.0.0', revision: 'r1', evidenceSource: 'D:/abs/release.json' },
        ],
      }));

      const res = await loadMaterialRecords(root, 'installer');
      assert.equal(res.recordsMap.get('pkg1.bin')?.evidenceSource, 'sub/release-record.json');
      assert.equal(res.recordsMap.get('pkg2.bin')?.state, 'record-invalid');
      assert.equal(res.recordsMap.get('pkg3.bin')?.state, 'record-invalid');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('recordedFile 支持仅 sizeBytes 与可选 sha256 历史登记摘要', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-sha-'));
    try {
      await fs.writeFile(path.join(root, 'pkg.bin'), 'x');
      const validSha = 'f6a65fb6b81845d61a2dfdf1b1f2888bfb4ab5448f00d8cbc5a6bf4691c88acc';

      await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            kind: 'installer',
            file: 'pkg.bin',
            targetVersion: 'v1.0.0',
            revision: 'r1',
            recordedFile: {
              sizeBytes: 12345,
              sha256: validSha.toUpperCase(), // 支持归一化小写
            },
          },
        ],
      }));

      const res = await loadMaterialRecords(root, 'installer');
      const item = res.recordsMap.get('pkg.bin');
      assert.equal(item?.state, 'available');
      assert.equal(item?.recordedFile?.sizeBytes, 12345);
      assert.equal(item?.recordedFile?.mtimeMs, null);
      assert.equal(item?.recordedFile?.sha256, validSha);
      // 关键断言：仅声明 sha256 绝不自动产生 integrityRecord.result: passed
      assert.equal(item?.integrityRecord?.state, 'not-recorded');
      assert.equal(item?.integrityRecord?.result, null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('platform 支持为 null 或省略；recordedFile 绝不回退解析 mtime 字符串', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-plat-mtime-'));
    try {
      await fs.writeFile(path.join(root, 'pkg1.bin'), 'x');
      await fs.writeFile(path.join(root, 'pkg2.bin'), 'x');

      await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            kind: 'installer',
            file: 'pkg1.bin',
            targetVersion: 'v1.0.0',
            platform: null,
            recordedFile: { sizeBytes: 100, mtime: '2026-09-28T00:00:00Z' }, // 仅提供 mtime 字符串
          },
          {
            kind: 'installer',
            file: 'pkg2.bin',
            targetVersion: 'v1.0.0',
            // 省略 platform
            recordedFile: { sizeBytes: 200, mtimeMs: 1790000000000 },
          },
        ],
      }));

      const res = await loadMaterialRecords(root, 'installer');
      const item1 = res.recordsMap.get('pkg1.bin');
      assert.equal(item1?.platform, null, 'platform 显式为 null 时正确解析为 null');
      assert.equal(item1?.recordedFile?.mtimeMs, null, '契约外 mtime 字符串绝不自动回退为 mtimeMs');

      const item2 = res.recordsMap.get('pkg2.bin');
      assert.equal(item2?.platform, null, 'platform 省略时默认解析为 null');
      assert.equal(item2?.recordedFile?.mtimeMs, 1790000000000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('升级包 directFrom 缺失或为 null 时表示 unknown，与 [] (none) 严格区分', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-directfrom-'));
    try {
      await fs.writeFile(path.join(root, 'pkg1.bin'), 'x');
      await fs.writeFile(path.join(root, 'pkg2.bin'), 'x');

      await fs.writeFile(path.join(root, 'material-records.json'), JSON.stringify({
        schemaVersion: 1,
        records: [
          { kind: 'upgrade', file: 'pkg1.bin', targetVersion: 'v2.0.0', revision: 'r1', directFrom: null },
          { kind: 'upgrade', file: 'pkg2.bin', targetVersion: 'v2.0.0', revision: 'r1', directFrom: [] },
        ],
      }));

      const res = await loadMaterialRecords(root, 'upgrade');
      assert.equal(res.recordsMap.get('pkg1.bin')?.compatibility?.state, 'unknown');
      assert.equal(res.recordsMap.get('pkg1.bin')?.compatibility?.minimumDirectSource, null);

      assert.equal(res.recordsMap.get('pkg2.bin')?.compatibility?.state, 'none');
      assert.equal(res.recordsMap.get('pkg2.bin')?.compatibility?.minimumDirectSource, null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('Spec 4 [硬上限]: material-records.json 在 lstat 之后并发膨胀超过 256 KiB，流式读后校验拦截并返回 record-invalid', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-expand-'));
    const recFile = path.join(root, 'material-records.json');

    // 初始写入 100 字节合法内容
    await fs.writeFile(recFile, JSON.stringify({ schemaVersion: 1, records: [] }));

    const fsPromises = await import('node:fs/promises');
    const origOpen = fsPromises.default.open;

    try {
      // 模拟 fs.open 打开后，返回的分块数据总字节数超过 256 KiB
      fsPromises.default.open = async function (p, ...args) {
        const handle = await origOpen.apply(this, [p, ...args]);
        if (typeof p === 'string' && p.endsWith('material-records.json')) {
          let readCount = 0;
          return {
            async stat(options) {
              return handle.stat(options);
            },
            async read(buffer, offset, length, position) {
              if (readCount < 20) {
                readCount++;
                // 每次填满 16384 字节 (16KB * 20 = 320KB > 256KB)
                buffer.fill(0x20, offset, offset + length);
                return { bytesRead: length, buffer };
              }
              return { bytesRead: 0, buffer };
            },
            async close() {
              return handle.close();
            },
          };
        }
        return handle;
      };

      const res = await loadMaterialRecords(root, 'installer');
      assert.equal(res.hasRecordFile, true);
      assert.ok(res.recordFileError);
      assert.equal(res.recordFileError.code, 'record-invalid');
      assert.ok(res.recordFileError.message.includes('超过 262144 字节上限'));
    } finally {
      fsPromises.default.open = origOpen;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('S1 [审视]: material-records.json 在 lstat 检查后、open 之前被替换为指向外部的链接，拦截并返回 record-invalid', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-s1-swap-'));
    const root = path.join(baseDir, 'mat_root');
    const outsideDir = path.join(baseDir, 'outside');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    const recFile = path.join(root, 'material-records.json');
    const outsideSecretRec = path.join(outsideDir, 'secret-records.json');
    await fs.writeFile(recFile, JSON.stringify({ schemaVersion: 1, records: [] }));
    await fs.writeFile(outsideSecretRec, JSON.stringify({
      schemaVersion: 1,
      records: [{ kind: 'installer', file: 'secret.bin', targetVersion: 'v9.9.9', revision: 'r9', privateKey: 'SECRET_PAYLOAD_LEAK' }],
    }));

    const fsPromises = await import('node:fs/promises');
    const origOpen = fsPromises.default.open;
    let swapped = false;

    try {
      fsPromises.default.open = async function (p, ...args) {
        if (!swapped && typeof p === 'string' && p.endsWith('material-records.json')) {
          swapped = true;
          // 移走普通文件并创建指向外部 secret 文件的符号链接/junction
          await fs.rm(recFile, { force: true });
          await fs.symlink(outsideSecretRec, recFile, 'file');
        }
        return origOpen.apply(this, [p, ...args]);
      };

      const res = await loadMaterialRecords(root, 'installer');
      assert.equal(res.hasRecordFile, true);
      assert.ok(res.recordFileError);
      assert.equal(res.recordFileError.code, 'record-invalid');
      // 验证绝未解析出外部文件中的记录
      assert.equal(res.recordsMap.size, 0);
      assert.equal(res.recordsMap.has('secret.bin'), false);
    } finally {
      fsPromises.default.open = origOpen;
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('S1 [短暂替换]: open 取得外部文件句柄后恢复原路径，读取前拒绝该句柄', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-transient-handle-'));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    const recordFile = path.join(root, 'material-records.json');
    const saved = path.join(root, 'record-saved.json');
    const externalRecord = path.join(outside, 'external-records.json');
    await fs.writeFile(recordFile, JSON.stringify({ schemaVersion: 1, records: [] }));
    await fs.writeFile(externalRecord, JSON.stringify({
      schemaVersion: 1,
      records: [{ kind: 'installer', file: 'outside-only.key', targetVersion: '9.9.9', revision: 'r9' }],
    }));
    const originalOpen = fs.open;
    try {
      fs.open = async function (p, ...args) {
        if (p !== recordFile) return originalOpen.call(this, p, ...args);
        await fs.rename(recordFile, saved);
        try {
          await fs.symlink(externalRecord, recordFile, 'file');
          return await originalOpen.call(this, p, ...args);
        } finally {
          await fs.unlink(recordFile);
          await fs.rename(saved, recordFile);
        }
      };
      const result = await loadMaterialRecords(root, 'installer');
      assert.equal(result.recordFileError?.code, 'record-invalid');
      assert.equal(result.recordsMap.size, 0);
    } finally {
      fs.open = originalOpen;
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});


