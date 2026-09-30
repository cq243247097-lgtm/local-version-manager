import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class MaterialError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'MaterialError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 判断两个路径在当前操作系统下是否指向同一物理路径规范化表示
 * @param {string} pathA 
 * @param {string} pathB 
 * @returns {boolean}
 */
export function isSamePath(pathA, pathB) {
  if (typeof pathA !== 'string' || typeof pathB !== 'string') return false;
  const normA = path.normalize(pathA);
  const normB = path.normalize(pathB);
  if (process.platform === 'win32') {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}

const TICKET_TTL_MS = 10 * 60 * 1000; // 10 分钟
const MAX_TICKETS = 128;
const inspectionTickets = new Map();

function cleanStaleTickets() {
  const now = Date.now();
  for (const [id, ticket] of inspectionTickets.entries()) {
    if (now - ticket.createdAt > ticket.ttlMs) {
      inspectionTickets.delete(id);
    }
  }
  if (inspectionTickets.size >= MAX_TICKETS) {
    // 移除最早创建的一批
    const sorted = [...inspectionTickets.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = sorted.slice(0, Math.floor(MAX_TICKETS / 4));
    for (const [id] of toRemove) {
      inspectionTickets.delete(id);
    }
  }
}

/**
 * 获取材料检查票据
 * @param {string} inspectionId 
 * @returns {object|null}
 */
export function getMaterialInspectionTicket(inspectionId) {
  if (!inspectionId || typeof inspectionId !== 'string') return null;
  const ticket = inspectionTickets.get(inspectionId);
  if (!ticket) return null;
  if (Date.now() - ticket.createdAt > ticket.ttlMs) {
    inspectionTickets.delete(inspectionId);
    return null;
  }
  return ticket;
}

/**
 * 清理全部材料票据（供测试隔离使用）
 */
export function clearMaterialInspectionTickets() {
  inspectionTickets.clear();
}

/**
 * 对材料目录执行浅检查并签发票据
 * @param {object} params
 * @param {string} params.rootPath 用户输入的根目录
 * @param {string} params.projectId 项目 ID
 * @param {'installer'|'upgrade'} params.kind 材料种类
 * @param {string|null} [params.existingRoot] 检查时配置中已存在的关联根
 * @returns {Promise<object>}
 */
export async function inspectMaterialDirectory({ rootPath, projectId, kind, existingRoot = null }) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw new MaterialError('rootPath 必须为非空字符串', 400, 'INVALID_INPUT');
  }

  if (rootPath.includes('\0')) {
    throw new MaterialError('rootPath 包含非法字符', 400, 'INVALID_INPUT');
  }

  // 拒绝 URL (如 file://, http://, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rootPath)) {
    throw new MaterialError('rootPath 不能为 URL 格式', 400, 'INVALID_INPUT');
  }

  // 必须是当前主机的绝对路径
  if (!path.isAbsolute(rootPath)) {
    throw new MaterialError('rootPath 必须是当前主机的绝对路径', 400, 'INVALID_INPUT');
  }

  // 浅检查：lstat 检查存在性
  let lstat;
  try {
    lstat = await fs.lstat(rootPath);
  } catch (err) {
    throw new MaterialError('材料目录不存在或无法访问', 400, 'INVALID_INPUT');
  }

  // 获取真实路径与身份
  let normRoot;
  let stat;
  try {
    normRoot = await fs.realpath(rootPath);
    stat = await fs.stat(normRoot);
  } catch (err) {
    throw new MaterialError('材料目录无法解析真实路径', 400, 'INVALID_INPUT');
  }

  if (!stat.isDirectory()) {
    throw new MaterialError('指定的路径不是目录', 400, 'INVALID_INPUT');
  }

  cleanStaleTickets();

  const isSymlink = !isSamePath(path.resolve(rootPath), normRoot);
  const inspectionId = crypto.randomBytes(32).toString('hex');

  const ticket = {
    inspectionId,
    projectId,
    kind,
    inputPath: rootPath,
    normRoot,
    directoryIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    },
    existingRootAtInspection: existingRoot || null,
    createdAt: Date.now(),
    ttlMs: TICKET_TTL_MS,
  };

  inspectionTickets.set(inspectionId, ticket);

  return {
    inspectionId,
    projectId,
    kind,
    inputPath: rootPath,
    normalizedRoot: normRoot,
    isSymlink,
    hasExistingAssociation: Boolean(existingRoot),
    existingRoot: existingRoot || null,
  };
}

/**
 * 确认前复核真实目录身份
 * @param {object} ticket 
 */
export async function verifyMaterialDirectoryIdentity(ticket) {
  if (!ticket || !ticket.normRoot || !ticket.inputPath) {
    throw new MaterialError('检查票据无效', 400, 'INSPECTION_STALE');
  }

  // 1. 复核用户输入路径当前仍解析到检查时的规范化真实根
  let currentInputReal;
  try {
    currentInputReal = await fs.realpath(ticket.inputPath);
  } catch (err) {
    throw new MaterialError('输入材料路径不存在或已被移除', 400, 'INSPECTION_STALE');
  }

  if (!isSamePath(currentInputReal, ticket.normRoot)) {
    throw new MaterialError('输入材料路径的目标已发生变化，请重新检查', 400, 'INSPECTION_STALE');
  }

  // 2. 复核规范化真实根目录本身的存在性、目录类型与物理身份
  try {
    const real = await fs.realpath(ticket.normRoot);
    if (!isSamePath(real, ticket.normRoot)) {
      throw new MaterialError('材料目录真实路径已被更改', 400, 'INSPECTION_STALE');
    }

    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      throw new MaterialError('材料路径已不是目录', 400, 'INSPECTION_STALE');
    }

    if (ticket.directoryIdentity) {
      if (ticket.directoryIdentity.dev !== undefined && stat.dev !== ticket.directoryIdentity.dev) {
        throw new MaterialError('材料目录设备身份已发生变化', 400, 'INSPECTION_STALE');
      }
      if (ticket.directoryIdentity.ino && stat.ino && stat.ino !== ticket.directoryIdentity.ino) {
        throw new MaterialError('材料目录节点身份已发生变化', 400, 'INSPECTION_STALE');
      }
    }
  } catch (err) {
    if (err instanceof MaterialError) throw err;
    throw new MaterialError('材料目录已失效或已被替换', 400, 'INSPECTION_STALE');
  }
}
