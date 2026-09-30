import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadMaterialRecords } from '../server/materials/records.js';
import { scanMaterialDirectory } from '../server/materials/scan.js';

describe('P2-T04: 旧包迁移草稿格式与解析器兼容校验', () => {
  const installerDraftPath = path.resolve('drafts/installer/material-records.json');
  const upgradeDraftPath = path.resolve('drafts/upgrade/material-records.json');

  test('drafts/installer/material-records.json 经解析器校验 100% 合法且字段完备', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-installer-draft-'));
    try {
      await fs.copyFile(installerDraftPath, path.join(tempDir, 'material-records.json'));
      const res = await loadMaterialRecords(tempDir, 'installer');

      assert.equal(res.hasRecordFile, true);
      assert.equal(res.recordFileError, null);
      assert.equal(res.hasInvalidRecords, false);
      assert.equal(res.hasInvalidPaths, false);
      assert.equal(res.recordsMap.size, 2);

      const item1 = res.recordsMap.get('install-v0.2.6-r2-fix1/inventory-ai-v0.2.6-installer-r2-fix1.zip');
      assert.ok(item1);
      assert.equal(item1.state, 'available');
      assert.equal(item1.targetVersion, '0.2.6');
      assert.equal(item1.revision, 'r2-fix1');
      assert.equal(item1.platform, null, '未声明平台应为 null');
      assert.equal(item1.releaseStatus, 'candidate');
      assert.equal(item1.evidenceSource, 'install-v0.2.6-r2-fix1/release-record.json');
      assert.equal(item1.recordedFile.sizeBytes, 827978577);
      assert.equal(item1.recordedFile.sha256, 'f6a65fb6b81845d61a2dfdf1b1f2888bfb4ab5448f00d8cbc5a6bf4691c88acc');
      assert.equal(item1.integrityRecord.state, 'not-recorded');
      assert.equal(item1.installationRecord.state, 'not-recorded');

      const item2 = res.recordsMap.get('install-0.2.6-c4-20260926-r2/inventory-ai-v0.2.6-installer-r2.zip');
      assert.ok(item2);
      assert.equal(item2.state, 'available');
      assert.equal(item2.targetVersion, '0.2.6');
      assert.equal(item2.revision, 'r2');
      assert.equal(item2.platform, null, '未声明平台应为 null');
      assert.equal(item2.releaseStatus, 'candidate');
      assert.equal(item2.evidenceSource, 'install-0.2.6-c4-20260926-r2/release-record.json');
      assert.equal(item2.recordedFile.sizeBytes, 827962406);
      assert.equal(item2.recordedFile.sha256, '3729c4eaf73e82a7f6591b7b4bd155b18f82a9b2a1e6de190adbbcf08f0c2d11');
      assert.equal(item2.integrityRecord.state, 'not-recorded');
      assert.equal(item2.installationRecord.state, 'not-recorded');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('drafts/upgrade/material-records.json 经解析器校验 100% 合法且 revision 为 null、directFrom 准确声明未知', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-upgrade-draft-'));
    try {
      await fs.copyFile(upgradeDraftPath, path.join(tempDir, 'material-records.json'));
      const res = await loadMaterialRecords(tempDir, 'upgrade');

      assert.equal(res.hasRecordFile, true);
      assert.equal(res.recordFileError, null);
      assert.equal(res.hasInvalidRecords, false);
      assert.equal(res.hasInvalidPaths, false);
      assert.equal(res.recordsMap.size, 1);

      const item = res.recordsMap.get('upgrade-rc9-to-c4-20260924-d/inventory-ai-v0.2.6-upgrade-rc9-to-c4-d.zip');
      assert.ok(item);
      assert.equal(item.state, 'available');
      assert.equal(item.targetVersion, '0.2.6');
      assert.equal(item.revision, null, '升级包无可靠修订声明时必须为 null');
      assert.equal(item.platform, null, '未声明平台应为 null');
      assert.equal(item.releaseStatus, 'candidate');
      assert.equal(item.evidenceSource, 'upgrade-rc9-to-c4-20260924-d/release-record.json');
      assert.equal(item.recordedFile.sizeBytes, 5779379);
      assert.equal(item.recordedFile.sha256, '35798a02b314cac9b7049a7b71d9b39a968117f5931788ae4b71db92598a0291');
      assert.equal(item.compatibility.state, 'unknown');
      assert.equal(item.compatibility.minimumDirectSource, null);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('临时夹具结合草稿扫描：仅登记 sizeBytes 且文件大小匹配时判定 normal，不比较时间', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-scan-with-draft-'));
    try {
      // 模拟升级包目录结构
      const subDir = path.join(tempDir, 'upgrade-rc9-to-c4-20260924-d');
      await fs.mkdir(subDir, { recursive: true });
      const dummyZip = path.join(subDir, 'inventory-ai-v0.2.6-upgrade-rc9-to-c4-d.zip');
      // 创建与草稿 recordedFile.sizeBytes (5779379) 大小完全一致的测试文件（稀疏/填充）
      const fh = await fs.open(dummyZip, 'w');
      await fh.truncate(5779379);
      await fh.close();

      await fs.copyFile(upgradeDraftPath, path.join(tempDir, 'material-records.json'));

      const scanRes = await scanMaterialDirectory({ normRoot: tempDir, kind: 'upgrade' });
      assert.equal(scanRes.scan.status, 'complete');
      assert.equal(scanRes.items.length, 1);

      const scannedItem = scanRes.items[0];
      assert.equal(scannedItem.relativePath, 'upgrade-rc9-to-c4-20260924-d/inventory-ai-v0.2.6-upgrade-rc9-to-c4-d.zip');
      assert.equal(scannedItem.physical.exists, true);
      assert.equal(scannedItem.physical.status, 'normal', '大小一致判定为 normal');
      assert.equal(scannedItem.declaration.releaseStatus, 'candidate');
      assert.equal(scannedItem.declaration.evidenceSource, 'upgrade-rc9-to-c4-20260924-d/release-record.json');
      assert.equal(scannedItem.compatibility.state, 'unknown');
      assert.equal(scannedItem.compatibility.minimumDirectSource, null);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
