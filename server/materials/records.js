import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateCompatibility } from './versions.js';
import { isSamePath } from './association.js';

const MAX_RECORD_FILE_BYTES = 256 * 1024; // 256 KiB
const MAX_RECORDS_COUNT = 1000;
const MAX_TEXT_LENGTH = 512;

/**
 * 校验路径是否为安全的根内相对路径（/ 分隔，无盘符、绝对路径、反斜杠、空/. /..分段）
 * @param {string} rel 
 * @returns {boolean}
 */
export function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') return false;
  if (rel.length > 1024) return false;
  if (rel.includes('\\') || rel.includes('\0')) return false;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;

  const parts = rel.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      return false;
    }
  }
  return true;
}

/**
 * 读取并解析根目录下的 material-records.json
 * @param {string} rootPath 规范化物理根
 * @param {'installer'|'upgrade'} expectedKind 当前查询材料类型
 * @param {number} [deadline] 逻辑截止时间戳
 * @returns {Promise<{ recordsMap: Map<string, object>, recordFileError: { code: string, message: string } | null, hasRecordFile: boolean, hasInvalidPaths: boolean }>}
 */
export async function loadMaterialRecords(rootPath, expectedKind, deadline = Infinity) {
  if (Date.now() > deadline) {
    return {
      recordsMap: new Map(),
      recordFileError: { code: 'timeout', message: '读取记录超时' },
      hasRecordFile: false,
      hasInvalidPaths: false,
    };
  }

  const recordFilePath = path.join(rootPath, 'material-records.json');

  let stat;
  try {
    const lstat = await fs.lstat(recordFilePath, { bigint: true });
    if (lstat.isSymbolicLink()) {
      return {
        recordsMap: new Map(),
        recordFileError: { code: 'record-invalid', message: 'material-records.json 不能为符号链接' },
        hasRecordFile: true,
        hasInvalidPaths: false,
      };
    }
    if (!lstat.isFile()) {
      return {
        recordsMap: new Map(),
        recordFileError: { code: 'record-invalid', message: 'material-records.json 必须是普通文件' },
        hasRecordFile: true,
        hasInvalidPaths: false,
      };
    }
    if (lstat.size > BigInt(MAX_RECORD_FILE_BYTES)) {
      return {
        recordsMap: new Map(),
        recordFileError: { code: 'record-invalid', message: `material-records.json 超过 ${MAX_RECORD_FILE_BYTES} 字节上限` },
        hasRecordFile: true,
        hasInvalidPaths: false,
      };
    }
    stat = lstat;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        recordsMap: new Map(),
        recordFileError: null,
        hasRecordFile: false,
        hasInvalidPaths: false,
      };
    }
    return {
      recordsMap: new Map(),
      recordFileError: { code: 'record-invalid', message: '无法访问 material-records.json' },
      hasRecordFile: true,
      hasInvalidPaths: false,
    };
  }

  // 流式读取并在读后严格校验字节上限，防止 lstat 后文件被修改膨胀
  let fileHandle = null;
  let buffer;
  try {
    fileHandle = await fs.open(recordFilePath, 'r');

    // 路径可能在 open 期间被短暂换成外部链接后恢复；路径复查无法证明
    // fileHandle 的来源。先核对打开对象与获准普通文件的物理身份，再读字节。
    const openedStat = await fileHandle.stat({ bigint: true });
    if (!openedStat.isFile() || typeof stat.ino !== 'bigint' || stat.ino === 0n || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino || openedStat.size > BigInt(MAX_RECORD_FILE_BYTES)) {
      return {
        recordsMap: new Map(),
        recordFileError: { code: 'record-invalid', message: 'material-records.json 打开后的文件身份或大小已改变' },
        hasRecordFile: true,
        hasInvalidPaths: false,
      };
    }

    // S1 审视：打开后立即复核文件物理身份，防止 lstat 到 open 之间被替换为指向外部的链接
    const postLstat = await fs.lstat(recordFilePath, { bigint: true });
    if (postLstat.isSymbolicLink() || !postLstat.isFile() || postLstat.dev !== openedStat.dev || postLstat.ino !== openedStat.ino) {
      return {
        recordsMap: new Map(),
        recordFileError: { code: 'record-invalid', message: 'material-records.json 不能为符号链接且必须为普通文件' },
        hasRecordFile: true,
        hasInvalidPaths: false,
      };
    }
    let realRecordPath;
    try {
      realRecordPath = await fs.realpath(recordFilePath);
    } catch {
      return {
        recordsMap: new Map(),
        recordFileError: { code: 'record-invalid', message: '无法解析 material-records.json 真实物理路径' },
        hasRecordFile: true,
        hasInvalidPaths: false,
      };
    }
    const expectedRecordPath = path.resolve(rootPath, 'material-records.json');
    if (!isSamePath(realRecordPath, expectedRecordPath)) {
      return {
        recordsMap: new Map(),
        recordFileError: { code: 'record-invalid', message: 'material-records.json 物理目标已漂移或为外部链接' },
        hasRecordFile: true,
        hasInvalidPaths: false,
      };
    }

    const chunks = [];
    let bytesReadTotal = 0;
    const bufSize = 16384;
    const tempBuf = Buffer.alloc(bufSize);

    while (true) {
      if (Date.now() > deadline) {
        return {
          recordsMap: new Map(),
          recordFileError: { code: 'timeout', message: '读取记录超时' },
          hasRecordFile: true,
          hasInvalidPaths: false,
        };
      }
      const { bytesRead } = await fileHandle.read(tempBuf, 0, bufSize, null);
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > MAX_RECORD_FILE_BYTES) {
        return {
          recordsMap: new Map(),
          recordFileError: { code: 'record-invalid', message: `material-records.json 超过 ${MAX_RECORD_FILE_BYTES} 字节上限` },
          hasRecordFile: true,
          hasInvalidPaths: false,
        };
      }
      // read() 复用 tempBuf；必须复制本次字节，避免后续读取覆盖先前分块。
      chunks.push(Buffer.from(tempBuf.subarray(0, bytesRead)));
    }
    buffer = Buffer.concat(chunks);
  } catch {
    return {
      recordsMap: new Map(),
      recordFileError: { code: 'record-invalid', message: '读取 material-records.json 失败' },
      hasRecordFile: true,
      hasInvalidPaths: false,
    };
  } finally {
    if (fileHandle) {
      try { await fileHandle.close(); } catch {}
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf-8'));
  } catch {
    return {
      recordsMap: new Map(),
      recordFileError: { code: 'record-invalid', message: 'material-records.json 不是合法的 JSON' },
      hasRecordFile: true,
      hasInvalidPaths: false,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      recordsMap: new Map(),
      recordFileError: { code: 'record-invalid', message: 'material-records.json 根节点必须是对象' },
      hasRecordFile: true,
      hasInvalidPaths: false,
    };
  }

  if (parsed.schemaVersion !== 1) {
    return {
      recordsMap: new Map(),
      recordFileError: { code: 'record-invalid', message: 'schemaVersion 必须为 1' },
      hasRecordFile: true,
      hasInvalidPaths: false,
    };
  }

  if (!Array.isArray(parsed.records)) {
    return {
      recordsMap: new Map(),
      recordFileError: { code: 'record-invalid', message: 'records 字段必须是数组' },
      hasRecordFile: true,
      hasInvalidPaths: false,
    };
  }

  if (parsed.records.length > MAX_RECORDS_COUNT) {
    return {
      recordsMap: new Map(),
      recordFileError: { code: 'record-invalid', message: `records 条数超过 ${MAX_RECORDS_COUNT} 上限` },
      hasRecordFile: true,
      hasInvalidPaths: false,
    };
  }

  const recordsMap = new Map();
  const seenFiles = new Set();
  let hasInvalidPaths = false;
  let hasInvalidRecords = false;

  for (let idx = 0; idx < parsed.records.length; idx++) {
    const raw = parsed.records[idx];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      hasInvalidRecords = true;
      continue;
    }

    const { kind, file } = raw;
    if (kind !== 'installer' && kind !== 'upgrade') {
      hasInvalidRecords = true;
      continue;
    }

    if (kind !== expectedKind) {
      continue;
    }

    // 关键契约修复：非法 file 路径（包含越界 ..、绝对路径、反斜杠等）
    // 绝不输出到 recordsMap 中生成条目，绝不泄露非法路径，仅作为记录警告
    if (!isSafeRelativePath(file)) {
      hasInvalidPaths = true;
      continue;
    }

    if (seenFiles.has(file)) {
      recordsMap.set(file, {
        state: 'record-conflict',
        sourceOrigin: 'material-records.json',
        recordIndex: idx,
        error: '同一文件存在多条冲突的记录声明',
      });
      continue;
    }
    seenFiles.add(file);

    // 解析各字段（仅保留白名单字段，坚决不泄露 raw 中的私有未脱敏字段）
    const parsedItem = validateSingleRecord(raw, idx);
    recordsMap.set(file, parsedItem);
  }

  return {
    recordsMap,
    recordFileError: null,
    hasRecordFile: true,
    hasInvalidPaths,
    hasInvalidRecords,
  };
}

/**
 * 校验单条记录内容（仅输出白名单脱敏字段）
 * @param {object} raw 
 * @param {number} idx 
 * @returns {object}
 */
function validateSingleRecord(raw, idx) {
  const {
    kind,
    file,
    targetVersion,
    revision,
    platform,
    sourceCommit,
    releaseStatus,
    evidenceSource,
    recordedFile,
    integrityRecord,
    installationRecord,
    directFrom,
  } = raw;

  // 1. targetVersion & revision (允许明确为 null 或未提供表示未知)
  let parsedTargetVersion = null;
  if (targetVersion !== undefined && targetVersion !== null) {
    if (typeof targetVersion !== 'string' || targetVersion.trim() === '' || targetVersion.length > MAX_TEXT_LENGTH) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'targetVersion 必须为非空且不超过 512 字符的字符串，或为 null' };
    }
    parsedTargetVersion = targetVersion;
  }

  let parsedRevision = null;
  if (revision !== undefined && revision !== null) {
    if (typeof revision !== 'string' || revision.length < 1 || revision.length > 64 || revision.includes('/') || revision.includes('\\')) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'revision 必须为 1-64 字符且不能含路径分隔符，或为 null' };
    }
    parsedRevision = revision;
  }

  // 2. releaseStatus (可选，只接受 candidate 或 released)
  let parsedReleaseStatus = null;
  if (releaseStatus !== undefined && releaseStatus !== null) {
    if (releaseStatus !== 'candidate' && releaseStatus !== 'released') {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'releaseStatus 必须为 "candidate" 或 "released"，或为 null' };
    }
    parsedReleaseStatus = releaseStatus;
  }

  // 3. platform (可选，允许 null)
  let parsedPlatform = null;
  if (platform !== undefined && platform !== null) {
    if (typeof platform !== 'string' || platform.length > 80) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'platform 必须是不超过 80 字符的字符串，或为 null' };
    }
    parsedPlatform = platform;
  }

  // 4. sourceCommit (可选)
  if (sourceCommit !== undefined && sourceCommit !== null) {
    if (typeof sourceCommit !== 'string' || !/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(sourceCommit)) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'sourceCommit 必须是 40 或 64 位十六进制字符串' };
    }
  }

  // 5. evidenceSource (可选，必须为安全的根内相对路径)
  let parsedEvidenceSource = null;
  if (evidenceSource !== undefined && evidenceSource !== null) {
    if (typeof evidenceSource !== 'string' || !isSafeRelativePath(evidenceSource)) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'evidenceSource 必须为合法的根内相对路径' };
    }
    parsedEvidenceSource = evidenceSource;
  }

  // 6. recordedFile (可选，支持仅登记 sizeBytes 与可选的 mtimeMs、sha256)
  let parsedRecordedFile = null;
  if (recordedFile !== undefined && recordedFile !== null) {
    if (
      typeof recordedFile !== 'object' ||
      Array.isArray(recordedFile) ||
      typeof recordedFile.sizeBytes !== 'number' ||
      !Number.isSafeInteger(recordedFile.sizeBytes) ||
      recordedFile.sizeBytes < 0
    ) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'recordedFile 必须包含非负整数 sizeBytes' };
    }

    let parsedMtimeMs = null;
    if (recordedFile.mtimeMs !== undefined && recordedFile.mtimeMs !== null) {
      if (typeof recordedFile.mtimeMs !== 'number' || recordedFile.mtimeMs <= 0 || !Number.isFinite(recordedFile.mtimeMs)) {
        return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'recordedFile.mtimeMs 必须为正数字时间戳' };
      }
      parsedMtimeMs = recordedFile.mtimeMs;
    }

    let parsedSha256 = null;
    if (recordedFile.sha256 !== undefined && recordedFile.sha256 !== null) {
      if (typeof recordedFile.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(recordedFile.sha256)) {
        return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'recordedFile.sha256 必须为 64 位十六进制哈希字符串' };
      }
      parsedSha256 = recordedFile.sha256.toLowerCase();
    }

    parsedRecordedFile = {
      sizeBytes: recordedFile.sizeBytes,
      mtimeMs: parsedMtimeMs,
      sha256: parsedSha256,
    };
  }

  // 5. integrityRecord (可选)
  let parsedIntegrity = {
    state: 'not-recorded',
    result: null,
    recordedAt: null,
    method: null,
    note: null,
  };

  if (integrityRecord !== undefined) {
    if (typeof integrityRecord !== 'object' || integrityRecord === null || Array.isArray(integrityRecord)) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'integrityRecord 必须是对象' };
    }
    const { result, recordedAt, method, note } = integrityRecord;
    const validResults = ['passed', 'failed', 'not-checked'];
    if (!validResults.includes(result)) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'integrityRecord.result 值不合法' };
    }

    if (result === 'passed' || result === 'failed') {
      if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) {
        return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: '完整性记录为 passed/failed 时必须包含合法 recordedAt 时间' };
      }
    }

    parsedIntegrity = {
      state: 'recorded',
      result,
      recordedAt: recordedAt || null,
      method: (typeof method === 'string' && method.length <= MAX_TEXT_LENGTH) ? method : null,
      note: (typeof note === 'string' && note.length <= MAX_TEXT_LENGTH) ? note : null,
    };
  }

  // 6. installationRecord (可选)
  let parsedInstallation = {
    state: 'not-recorded',
    result: null,
    recordedAt: null,
    environment: null,
    note: null,
  };

  if (installationRecord !== undefined) {
    if (typeof installationRecord !== 'object' || installationRecord === null || Array.isArray(installationRecord)) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'installationRecord 必须是对象' };
    }
    const { result, recordedAt, environment, note } = installationRecord;
    const validResults = ['passed', 'failed', 'not-tested'];
    if (!validResults.includes(result)) {
      return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: 'installationRecord.result 值不合法' };
    }

    if (result === 'passed' || result === 'failed') {
      if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) {
        return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: '安装/升级验证记录为 passed/failed 时必须包含合法 recordedAt 时间' };
      }
      if (typeof environment !== 'string' || environment.trim() === '' || environment.length > MAX_TEXT_LENGTH) {
        return { state: 'record-invalid', sourceOrigin: 'material-records.json', recordIndex: idx, error: '安装/升级验证记录为 passed/failed 时必须包含非空 environment 环境说明' };
      }
    }

    parsedInstallation = {
      state: 'recorded',
      result,
      recordedAt: recordedAt || null,
      environment: environment || null,
      note: (typeof note === 'string' && note.length <= MAX_TEXT_LENGTH) ? note : null,
    };
  }

  // 7. compatibility (通过 evaluateCompatibility 计算)
  const compatibility = evaluateCompatibility({
    kind,
    targetVersion: parsedTargetVersion,
    directFrom,
  });

  return {
    state: 'available',
    sourceOrigin: 'material-records.json',
    recordIndex: idx,
    targetVersion: parsedTargetVersion,
    revision: parsedRevision,
    platform: parsedPlatform,
    sourceCommit: sourceCommit || null,
    releaseStatus: parsedReleaseStatus,
    evidenceSource: parsedEvidenceSource,
    recordedFile: parsedRecordedFile,
    integrityRecord: parsedIntegrity,
    installationRecord: parsedInstallation,
    compatibility,
  };
}
