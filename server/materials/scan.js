import fs from 'node:fs/promises';
import path from 'node:path';
import { loadMaterialRecords } from './records.js';
import { evaluateCompatibility } from './versions.js';
import { isSamePath } from './association.js';

const MAX_DEPTH = 5;
const MAX_TOTAL_ENTRIES = 5000;
const MAX_DIR_ENTRIES = 1000;
const SCAN_TIMEOUT_MS = 5000;
export const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * 校验规范化根路径物理目标是否可用且未漂移
 * @param {string} normRoot 规范化真实根路径
 */
async function assertRootIntegrity(normRoot) {
  let currentReal;
  try {
    currentReal = await fs.realpath(normRoot);
  } catch (err) {
    const error = new Error(`材料根目录不可访问: ${err.message}`);
    error.code = 'MATERIAL_ROOT_UNAVAILABLE';
    throw error;
  }

  if (!isSamePath(currentReal, normRoot)) {
    const error = new Error(`材料根目录物理目标已漂移或已被更改: ${normRoot} -> ${currentReal}`);
    error.code = 'MATERIAL_ROOT_UNAVAILABLE';
    throw error;
  }

  let rootLstat;
  try {
    rootLstat = await fs.lstat(normRoot);
  } catch (err) {
    const error = new Error(`材料根目录不可访问: ${err.message}`);
    error.code = 'MATERIAL_ROOT_UNAVAILABLE';
    throw error;
  }

  if (rootLstat.isSymbolicLink()) {
    const error = new Error('材料根目录不能为符号链接');
    error.code = 'MATERIAL_ROOT_UNAVAILABLE';
    throw error;
  }

  if (!rootLstat.isDirectory()) {
    const error = new Error('材料根路径不是目录');
    error.code = 'MATERIAL_ROOT_UNAVAILABLE';
    throw error;
  }
}

/**
 * 字符串代码点稳定比较函数
 * @param {string} a 
 * @param {string} b 
 * @returns {number}
 */
function compareCodePoints(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 获取 POSIX 风格的父目录路径，根目录返回 ''
 * @param {string} rel 
 * @returns {string}
 */
function getPosixDirname(rel) {
  const lastSlash = rel.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return rel.slice(0, lastSlash);
}

/**
 * 有界深度只读扫描材料根目录
 * @param {object} params
 * @param {string} params.normRoot 规范化真实根路径
 * @param {'installer'|'upgrade'} params.kind 材料类型
 * @param {string} [params.projectId] 项目 ID
 * @param {number} [params.maxSerializedBytes] 最大序列化输出字节限制
 * @returns {Promise<{ projectId: string, kind: string, state: 'linked', scan: object, tree: Array<object>, items: Array<object> }>}
 */
export async function scanMaterialDirectory({ normRoot, kind, projectId = '', maxSerializedBytes = MAX_SERIALIZED_BYTES }) {
  const startTime = Date.now();
  const deadline = startTime + SCAN_TIMEOUT_MS;

  // 1. 验证规范化根路径物理目标是否漂移（Spec 1 根路径及上级 junction 越界拦截）
  await assertRootIntegrity(normRoot);
  const rootReal = await fs.realpath(normRoot);

  // 2. 加载可选的 material-records.json（覆盖 5 秒逻辑截止时间预算）
  await assertRootIntegrity(normRoot);
  const { recordsMap, recordFileError, hasRecordFile, hasInvalidPaths, hasInvalidRecords } = await loadMaterialRecords(normRoot, kind, deadline);
  await assertRootIntegrity(normRoot);

  // 3. 有界遍历收集目录结构与文件
  let entriesScanned = 0;
  let truncated = false;
  const reasons = [];

  if (hasInvalidPaths) {
    truncated = true;
    if (!reasons.includes('record_invalid_file_path')) {
      reasons.push('record_invalid_file_path');
    }
  }
  if (hasInvalidRecords) {
    truncated = true;
    reasons.push('record-invalid');
  }

/**
 * 依据物理状态判断 exists 三态布尔值 (true / false / null)
 * @param {string} status 
 * @returns {boolean|null}
 */
function determinePhysicalExists(status) {
  if (status === 'normal' || status === 'changed') return true;
  if (status === 'disappeared' || status === 'missing') return false;
  return null; // permission_denied, unavailable, unverified
}

/**
 * 判断指定相对路径文件所在路径树是否被完整扫描且未受截断影响
 * @param {string} relPath 
 * @param {Set<string>} fullyScannedDirs 
 * @param {Set<string>} unscannedDirPrefixes 
 * @returns {boolean}
 */
function isPathFullyScanned(relPath, fullyScannedDirs, unscannedDirPrefixes) {
  for (const prefix of unscannedDirPrefixes) {
    if (prefix === '' || relPath.startsWith(prefix)) {
      return false;
    }
  }

  if (!fullyScannedDirs.has('')) {
    return false;
  }

  const parts = relPath.split('/');
  let currentDir = '';
  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = currentDir ? `${currentDir}/${parts[i]}` : parts[i];
    if (!fullyScannedDirs.has(currentDir)) {
      return false;
    }
  }

  return true;
}

  const treeNodes = [];
  const physicalFiles = new Map(); // relPosixPath -> { sizeBytes, mtimeMs, type, status }
  const fullyScannedDirs = new Set(); // 记录已完整扫描且未截断的目录相对路径
  const unscannedDirPrefixes = new Set(); // 记录被截断未扫描的目录前缀

  // 递归遍历子目录
  async function traverseDir(currentDir, currentRel, depth, parentNodeId) {
    await assertRootIntegrity(normRoot);

    if (Date.now() > deadline) {
      truncated = true;
      if (!reasons.includes('timeout')) reasons.push('timeout');
      unscannedDirPrefixes.add(currentRel ? `${currentRel}/` : '');
      return;
    }

    if (entriesScanned >= MAX_TOTAL_ENTRIES) {
      truncated = true;
      if (!reasons.includes('limit_max_entries')) reasons.push('limit_max_entries');
      unscannedDirPrefixes.add(currentRel ? `${currentRel}/` : '');
      return;
    }

    // S1：针对实际进入和读取的每一级子目录验证物理目标与已检查身份
    let expectedReal = rootReal;
    if (currentRel !== '') {
      expectedReal = path.resolve(rootReal, currentRel);

      let dirStat;
      try {
        dirStat = await fs.lstat(currentDir);
      } catch {
        truncated = true;
        if (!reasons.includes('directory_unreadable')) reasons.push('directory_unreadable');
        unscannedDirPrefixes.add(`${currentRel}/`);
        return;
      }

      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        truncated = true;
        if (!reasons.includes('link_or_drift_detected')) reasons.push('link_or_drift_detected');
        unscannedDirPrefixes.add(`${currentRel}/`);
        const existingNode = treeNodes.find((n) => n.relativePath === currentRel);
        if (existingNode) existingNode.type = 'skipped_link';
        return;
      }

      let dirReal;
      try {
        dirReal = await fs.realpath(currentDir);
      } catch {
        truncated = true;
        if (!reasons.includes('directory_unreadable')) reasons.push('directory_unreadable');
        unscannedDirPrefixes.add(`${currentRel}/`);
        return;
      }

      if (!isSamePath(dirReal, expectedReal)) {
        truncated = true;
        if (!reasons.includes('link_or_drift_detected')) reasons.push('link_or_drift_detected');
        unscannedDirPrefixes.add(`${currentRel}/`);
        const existingNode = treeNodes.find((n) => n.relativePath === currentRel);
        if (existingNode) existingNode.type = 'skipped_link';
        return;
      }
    }

    // Spec 4: 使用 opendir 流式采集至 1001 项，单目录超限时不输出随机半子集
    let preflightHandle = null;
    let dirHandle = null;
    const preflightNames = [];
    const dirEntries = [];
    let dirTruncated = false;

    try {
      // Node 的 Dir 不公开可 stat 的目录句柄。先在同一预算内独立枚举一次，
      // 再与实际遍历的完整名称集合核对；两次来源不一致时整目录丢弃。
      // 这样短暂替换后恢复路径所取得的外部 Dir 不会作为“消失条目”泄露名称。
      preflightHandle = await fs.opendir(currentDir);
      for await (const dirent of preflightHandle) {
        if (Date.now() > deadline) {
          dirTruncated = true;
          truncated = true;
          if (!reasons.includes('timeout')) reasons.push('timeout');
          break;
        }
        if (preflightNames.length >= MAX_DIR_ENTRIES) {
          dirTruncated = true;
          truncated = true;
          if (!reasons.includes('limit_directory_entries')) reasons.push('limit_directory_entries');
          break;
        }
        preflightNames.push(dirent.name);
      }
      if (dirTruncated) {
        unscannedDirPrefixes.add(currentRel ? `${currentRel}/` : '');
        return;
      }

      // 不使用一次性 readdir：先逐项从路径确认名称确实存在于当前目录。
      // 若短暂替换让两次 opendir 都拿到外部句柄，外部独有名称在恢复后的
      // 路径上无法验证，整个目录丢弃。此处最多检查 1000 项且受同一截止时间限制。
      for (const name of preflightNames) {
        if (Date.now() > deadline) {
          dirTruncated = true;
          truncated = true;
          if (!reasons.includes('timeout')) reasons.push('timeout');
          unscannedDirPrefixes.add(currentRel ? `${currentRel}/` : '');
          return;
        }
        try {
          await fs.lstat(path.join(currentDir, name));
        } catch {
          truncated = true;
          if (!reasons.includes('link_or_drift_detected')) reasons.push('link_or_drift_detected');
          unscannedDirPrefixes.add(currentRel ? `${currentRel}/` : '');
          const existingNode = treeNodes.find((node) => node.relativePath === currentRel);
          if (existingNode) existingNode.type = 'unavailable';
          return;
        }
      }

      dirHandle = await fs.opendir(currentDir);

      if (currentRel !== '') {
        // 打开后二次防线：防止 lstat/realpath 与 opendir 之间的极端时序替换
        const postLstat = await fs.lstat(currentDir);
        const postReal = await fs.realpath(currentDir);
        if (postLstat.isSymbolicLink() || !postLstat.isDirectory() || !isSamePath(postReal, expectedReal)) {
          await dirHandle.close();
          dirHandle = null;
          truncated = true;
          if (!reasons.includes('link_or_drift_detected')) reasons.push('link_or_drift_detected');
          unscannedDirPrefixes.add(`${currentRel}/`);
          const existingNode = treeNodes.find((n) => n.relativePath === currentRel);
          if (existingNode) existingNode.type = 'skipped_link';
          return;
        }
      }

      for await (const dirent of dirHandle) {
        if (Date.now() > deadline) {
          dirTruncated = true;
          truncated = true;
          if (!reasons.includes('timeout')) reasons.push('timeout');
          dirEntries.length = 0;
          break;
        }
        if (dirEntries.length >= MAX_DIR_ENTRIES) {
          // 流式读到第 1001 项：立即清空部分条目，标记截断且不下探
          dirTruncated = true;
          truncated = true;
          if (!reasons.includes('limit_directory_entries')) {
            reasons.push('limit_directory_entries');
          }
          dirEntries.length = 0;
          break;
        }
        dirEntries.push(dirent);
      }
    } catch (err) {
      if (err.code === 'MATERIAL_ROOT_UNAVAILABLE') {
        throw err;
      }
      if (currentRel === '') {
        // R1: 根目录不可扫描/列举时必须抛出稳定 MATERIAL_ROOT_UNAVAILABLE
        const rootErr = new Error(`材料根目录无法列举或访问受阻: ${err.code || err.message}`);
        rootErr.code = 'MATERIAL_ROOT_UNAVAILABLE';
        throw rootErr;
      }
      truncated = true;
      if (!reasons.includes('directory_unreadable')) reasons.push('directory_unreadable');
      unscannedDirPrefixes.add(currentRel ? `${currentRel}/` : '');
      return;
    } finally {
      if (preflightHandle) {
        try { await preflightHandle.close(); } catch {}
      }
      if (dirHandle) {
        try { await dirHandle.close(); } catch {}
      }
    }

    if (dirTruncated) {
      unscannedDirPrefixes.add(currentRel ? `${currentRel}/` : '');
      return;
    }

    // 不输出来源不一致的名称。已验证存在的条目若在最终 lstat 前消失，
    // 仍保留 disappeared 事实语义。
    const expectedNames = preflightNames.sort(compareCodePoints);
    const actualNames = dirEntries.map((entry) => entry.name).sort(compareCodePoints);
    if (expectedNames.length !== actualNames.length || expectedNames.some((name, index) => name !== actualNames[index])) {
      truncated = true;
      if (!reasons.includes('link_or_drift_detected')) reasons.push('link_or_drift_detected');
      unscannedDirPrefixes.add(currentRel ? `${currentRel}/` : '');
      const existingNode = treeNodes.find((node) => node.relativePath === currentRel);
      if (existingNode) existingNode.type = 'unavailable';
      return;
    }

    // 目录流式采集成功后，按名称代码点稳定排序
    const sortedDirEntries = dirEntries.slice().sort((a, b) => compareCodePoints(a.name, b.name));
    let hasChildDirTruncated = false;

    for (const ent of sortedDirEntries) {
      if (Date.now() > deadline) {
        truncated = true;
        if (!reasons.includes('timeout')) reasons.push('timeout');
        hasChildDirTruncated = true;
        break;
      }

      if (entriesScanned >= MAX_TOTAL_ENTRIES) {
        truncated = true;
        if (!reasons.includes('limit_max_entries')) reasons.push('limit_max_entries');
        hasChildDirTruncated = true;
        break;
      }

      const fullPath = path.join(currentDir, ent.name);
      const itemRel = currentRel ? `${currentRel}/${ent.name}` : ent.name;

      if (itemRel.length > 1024) {
        truncated = true;
        if (!reasons.includes('path_too_long')) reasons.push('path_too_long');
        continue;
      }

      let itemLstat;
      try {
        itemLstat = await fs.lstat(fullPath);
      } catch (err) {
        // Spec 5: 条目在 readdir 后、lstat 前消失或无权限，保留已安全读到的事实与相对路径
        entriesScanned++;
        truncated = true;
        const nodeId = `tree:${itemRel}`;

        let status = 'unavailable';
        if (err.code === 'ENOENT') {
          status = 'disappeared';
          if (!reasons.includes('entry_disappeared')) reasons.push('entry_disappeared');
        } else if (err.code === 'EACCES' || err.code === 'EPERM') {
          status = 'permission_denied';
          if (!reasons.includes('entry_permission_denied')) reasons.push('entry_permission_denied');
        } else {
          if (!reasons.includes('entry_unavailable')) reasons.push('entry_unavailable');
        }

        treeNodes.push({
          id: nodeId,
          parentId: parentNodeId,
          relativePath: itemRel,
          name: ent.name,
          type: 'unavailable',
        });

        physicalFiles.set(itemRel, {
          sizeBytes: null,
          mtimeMs: null,
          type: 'unavailable',
          status,
        });
        continue;
      }

      entriesScanned++;
      const nodeId = `tree:${itemRel}`;

      if (itemLstat.isSymbolicLink()) {
        // 遇到链接条目，跳过不跟随进入外部
        treeNodes.push({
          id: nodeId,
          parentId: parentNodeId,
          relativePath: itemRel,
          name: ent.name,
          type: 'skipped_link',
        });
        continue;
      }

      if (itemLstat.isDirectory()) {
        treeNodes.push({
          id: nodeId,
          parentId: parentNodeId,
          relativePath: itemRel,
          name: ent.name,
          type: 'directory',
        });

        // 深度限制检查
        if (depth + 1 > MAX_DEPTH) {
          truncated = true;
          if (!reasons.includes('limit_max_depth')) reasons.push('limit_max_depth');
          unscannedDirPrefixes.add(`${itemRel}/`);
          hasChildDirTruncated = true;
          continue;
        }

        // 下探子目录
        await traverseDir(fullPath, itemRel, depth + 1, nodeId);
      } else if (itemLstat.isFile()) {
        treeNodes.push({
          id: nodeId,
          parentId: parentNodeId,
          relativePath: itemRel,
          name: ent.name,
          type: 'file',
        });

        if (itemRel !== 'material-records.json') {
          physicalFiles.set(itemRel, {
            sizeBytes: itemLstat.size,
            mtimeMs: itemLstat.mtimeMs,
            type: 'file',
            status: 'normal',
          });
        }
      }
    }

    if (!hasChildDirTruncated) {
      fullyScannedDirs.add(currentRel);
    }
  }

  await traverseDir(normRoot, '', 0, null);
  await assertRootIntegrity(normRoot);

  // 4. 将物理文件与 recordsMap 结合，生成 items 数组
  const items = [];
  const matchedRecordFiles = new Set();

  for (const [relPath, phys] of physicalFiles.entries()) {
    const itemId = `${kind}:${relPath}`;
    const record = recordsMap.get(relPath);

    if (!record) {
      // 无记录声明的文件
      items.push({
        id: itemId,
        relativePath: relPath,
        physical: {
          exists: determinePhysicalExists(phys.status),
          type: phys.type,
          sizeBytes: phys.sizeBytes,
          mtimeMs: phys.mtimeMs,
          status: phys.status,
        },
        declaration: {
          state: 'no-record',
          targetVersion: null,
          revision: null,
          platform: null,
          sourceCommit: null,
          releaseStatus: null,
          evidenceSource: null,
          recordedFile: null,
        },
        integrityRecord: {
          state: 'not-recorded',
          result: null,
          recordedAt: null,
          method: null,
          note: null,
        },
        installationRecord: {
          state: 'not-recorded',
          result: null,
          recordedAt: null,
          environment: null,
          note: null,
        },
        compatibility: evaluateCompatibility({
          kind,
          targetVersion: null,
          directFrom: null,
        }),
      });
      continue;
    }

    matchedRecordFiles.add(relPath);

    if (record.state === 'record-conflict') {
      items.push({
        id: itemId,
        relativePath: relPath,
        physical: {
          exists: determinePhysicalExists(phys.status),
          type: phys.type,
          sizeBytes: phys.sizeBytes,
          mtimeMs: phys.mtimeMs,
          status: phys.status,
        },
        declaration: {
          state: 'record-conflict',
          sourceOrigin: record.sourceOrigin,
          recordIndex: record.recordIndex,
          targetVersion: null,
          revision: null,
          platform: null,
          sourceCommit: null,
          releaseStatus: null,
          evidenceSource: null,
          recordedFile: null,
        },
        integrityRecord: { state: 'not-recorded', result: null, recordedAt: null, method: null, note: null },
        installationRecord: { state: 'not-recorded', result: null, recordedAt: null, environment: null, note: null },
        compatibility: { state: 'invalid', directFrom: null, minimumDirectSource: null },
      });
      continue;
    }

    if (record.state === 'record-invalid') {
      items.push({
        id: itemId,
        relativePath: relPath,
        physical: {
          exists: determinePhysicalExists(phys.status),
          type: phys.type,
          sizeBytes: phys.sizeBytes,
          mtimeMs: phys.mtimeMs,
          status: phys.status,
        },
        declaration: {
          state: 'record-invalid',
          sourceOrigin: record.sourceOrigin,
          recordIndex: record.recordIndex,
          targetVersion: null,
          revision: null,
          platform: null,
          sourceCommit: null,
          releaseStatus: null,
          evidenceSource: null,
          recordedFile: null,
        },
        integrityRecord: { state: 'not-recorded', result: null, recordedAt: null, method: null, note: null },
        installationRecord: { state: 'not-recorded', result: null, recordedAt: null, environment: null, note: null },
        compatibility: { state: 'invalid', directFrom: null, minimumDirectSource: null },
      });
      continue;
    }

    // 记录合法时，核对 recordedFile 与物理属性一致性
    // 若未登记 mtimeMs，则不比较修改时间；大小相等表示属性相符
    let physicalStatus = phys.status;
    if (physicalStatus === 'normal' && record.recordedFile) {
      const sizeMismatch = typeof record.recordedFile.sizeBytes === 'number' && record.recordedFile.sizeBytes !== phys.sizeBytes;
      const mtimeMismatch = record.recordedFile.mtimeMs !== null && record.recordedFile.mtimeMs !== undefined && record.recordedFile.mtimeMs !== phys.mtimeMs;
      if (sizeMismatch || mtimeMismatch) {
        physicalStatus = 'changed'; // 属性与记录不一致
      }
    }

    items.push({
      id: itemId,
      relativePath: relPath,
      physical: {
        exists: determinePhysicalExists(physicalStatus),
        type: phys.type,
        sizeBytes: phys.sizeBytes,
        mtimeMs: phys.mtimeMs,
        status: physicalStatus,
      },
      declaration: {
        state: 'available',
        sourceOrigin: record.sourceOrigin,
        recordIndex: record.recordIndex,
        targetVersion: record.targetVersion,
        revision: record.revision,
        platform: record.platform,
        sourceCommit: record.sourceCommit,
        releaseStatus: record.releaseStatus || null,
        evidenceSource: record.evidenceSource || null,
        recordedFile: record.recordedFile || null,
      },
      integrityRecord: record.integrityRecord,
      installationRecord: record.installationRecord,
      compatibility: record.compatibility,
    });
  }

  // 5. Spec 3: 检查记录中声明了但物理文件未匹配的条目
  // 严格区分“已完整检查后确认缺失”与“处于未扫描/截断目录中无法确认”
  for (const [relPath, record] of recordsMap.entries()) {
    if (matchedRecordFiles.has(relPath)) continue;

    // 如果所在目录没有被完整安全扫描，绝对不能判定物理缺失
    const canAssertMissing = isPathFullyScanned(relPath, fullyScannedDirs, unscannedDirPrefixes);
    const itemId = `${kind}:${relPath}`;

    if (!canAssertMissing) {
      // 未完整覆盖目录：标记 unverified / unavailable，不可武断判定为 missing
      items.push({
        id: itemId,
        relativePath: relPath,
        physical: {
          exists: null,
          type: 'unverified',
          sizeBytes: null,
          mtimeMs: null,
          status: 'unverified',
        },
        declaration: {
          state: 'unverified',
          sourceOrigin: record.sourceOrigin,
          recordIndex: record.recordIndex,
          targetVersion: record.targetVersion || null,
          revision: record.revision || null,
          platform: record.platform || null,
          sourceCommit: record.sourceCommit || null,
          releaseStatus: record.releaseStatus || null,
          evidenceSource: record.evidenceSource || null,
          recordedFile: record.recordedFile || null,
        },
        integrityRecord: record.integrityRecord || { state: 'not-recorded', result: null, recordedAt: null, method: null, note: null },
        installationRecord: record.installationRecord || { state: 'not-recorded', result: null, recordedAt: null, environment: null, note: null },
        compatibility: record.compatibility || { state: 'unknown', directFrom: null, minimumDirectSource: null },
      });
    } else {
      // 所在目录已被完全扫描，且条目确实不存在：确认缺失
      items.push({
        id: itemId,
        relativePath: relPath,
        physical: {
          exists: false,
          type: 'missing',
          sizeBytes: null,
          mtimeMs: null,
          status: 'missing',
        },
        declaration: {
          state: 'reference-missing',
          sourceOrigin: record.sourceOrigin,
          recordIndex: record.recordIndex,
          targetVersion: record.targetVersion || null,
          revision: record.revision || null,
          platform: record.platform || null,
          sourceCommit: record.sourceCommit || null,
          releaseStatus: record.releaseStatus || null,
          evidenceSource: record.evidenceSource || null,
          recordedFile: record.recordedFile || null,
        },
        integrityRecord: record.integrityRecord || { state: 'not-recorded', result: null, recordedAt: null, method: null, note: null },
        installationRecord: record.installationRecord || { state: 'not-recorded', result: null, recordedAt: null, environment: null, note: null },
        compatibility: record.compatibility || { state: 'unknown', directFrom: null, minimumDirectSource: null },
      });
    }
  }

  // items 稳定排序：按 relativePath 代码点顺序
  items.sort((a, b) => compareCodePoints(a.relativePath, b.relativePath));

  if (recordFileError) {
    truncated = true;
    if (!reasons.includes(recordFileError.code)) {
      reasons.push(recordFileError.code);
    }
  }

  // 6. Spec 4: 8 MiB 序列化响应硬上限控制
  let result = {
    projectId,
    kind,
    state: 'linked',
    scan: {
      status: truncated ? 'partial' : 'complete',
      scannedAt: new Date(startTime).toISOString(),
      truncated,
      reasons,
      entriesScanned,
    },
    tree: treeNodes,
    items,
  };

  if (Date.now() > deadline) {
    truncated = true;
    if (!reasons.includes('timeout')) {
      reasons.push('timeout');
    }
    result.scan.truncated = true;
    result.scan.status = 'partial';
  }

  let jsonLength = Buffer.byteLength(JSON.stringify(result), 'utf-8');
  if (jsonLength > maxSerializedBytes) {
    result.scan.truncated = true;
    if (!result.scan.reasons.includes('response_size_limit')) {
      result.scan.reasons.push('response_size_limit');
    }
    result.scan.status = 'partial';

    // 先二分查找保留的 items 数量（保持稳定代码点排序前缀）
    let low = 0;
    let high = result.items.length;
    let bestItemsCount = 0;
    const origItems = result.items;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      result.items = origItems.slice(0, mid);
      if (Buffer.byteLength(JSON.stringify(result), 'utf-8') <= maxSerializedBytes) {
        bestItemsCount = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    result.items = origItems.slice(0, bestItemsCount);

    // 如果 items 全部剔除后仍然超限，再对 tree 进行二分截断
    if (Buffer.byteLength(JSON.stringify(result), 'utf-8') > maxSerializedBytes) {
      const origTree = result.tree;
      low = 0;
      high = origTree.length;
      let bestTreeCount = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        result.tree = origTree.slice(0, mid);
        if (Buffer.byteLength(JSON.stringify(result), 'utf-8') <= maxSerializedBytes) {
          bestTreeCount = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      result.tree = origTree.slice(0, bestTreeCount);
    }
  }

  // 返回最终结果前，终检根目录物理身份是否在此期间发生漂移
  await assertRootIntegrity(normRoot);

  return result;
}

/**
 * 为 inspect 端点生成同一扫描器的预览摘要
 * @param {object} scanResult 
 * @returns {object}
 */
export function generateScanPreviewSummary(scanResult) {
  const { scan, tree, items } = scanResult;

  let totalFiles = 0;
  let totalDirectories = 0;
  let skippedLinks = 0;

  for (const node of tree) {
    if (node.type === 'file') {
      if (node.relativePath !== 'material-records.json') {
        totalFiles++;
      }
    } else if (node.type === 'directory') {
      totalDirectories++;
    } else if (node.type === 'skipped_link') {
      skippedLinks++;
    }
  }

  let recognizedRecords = 0;
  let unrecognizedFiles = 0;
  let missingReferences = 0;
  let conflictRecords = 0;
  let invalidRecords = 0;

  for (const it of items) {
    const declState = it.declaration.state;
    if (declState === 'available') recognizedRecords++;
    else if (declState === 'no-record') unrecognizedFiles++;
    else if (declState === 'reference-missing') missingReferences++;
    else if (declState === 'record-conflict') conflictRecords++;
    else if (declState === 'record-invalid') invalidRecords++;
  }

  return {
    status: scan.status,
    truncated: scan.truncated,
    reasons: scan.reasons.slice(),
    entriesScanned: scan.entriesScanned,
    summary: {
      totalFiles,
      totalDirectories,
      skippedLinks,
      recognizedRecords,
      unrecognizedFiles,
      missingReferences,
      conflictRecords,
      invalidRecords,
    },
  };
}
