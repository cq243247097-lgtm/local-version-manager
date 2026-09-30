import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSamePath } from './materials/association.js';

const ID_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

export class ConfigError extends Error {
  constructor(message, code = 'CONFIG_INVALID', statusCode = 500) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * 校验并解析 projects 配置对象
 * @param {any} rawData 
 * @returns {{ configured: boolean, projects: Array<{ id: string, name: string }>, projectMap: Map<string, { id: string, name: string, repositoryPath: string }> }}
 */
export function validateAndParseProjects(rawData) {
  if (typeof rawData !== 'object' || rawData === null || Array.isArray(rawData)) {
    throw new ConfigError('配置文件根节点必须是 JSON 对象');
  }

  if (!('projects' in rawData)) {
    throw new ConfigError('配置文件缺少 "projects" 字段');
  }

  if (!Array.isArray(rawData.projects)) {
    throw new ConfigError('"projects" 字段必须是数组');
  }

  if (rawData.projects.length === 0) {
    return {
      configured: false,
      projects: [],
      projectMap: new Map(),
    };
  }

  const seenIds = new Set();
  const projects = [];
  const projectMap = new Map();

  for (let i = 0; i < rawData.projects.length; i++) {
    const item = rawData.projects[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ConfigError(`第 ${i + 1} 个项目必须是对象`);
    }

    const { id, name, repositoryPath, materials: rawMaterials, ...extra } = item;

    if (typeof id !== 'string' || !ID_REGEX.test(id)) {
      throw new ConfigError(`项目 ID "${id}" 不合法，必须为小写字母开头且仅含字母、数字、下划线、中划线，长度 1-32 位`);
    }

    if (seenIds.has(id)) {
      throw new ConfigError(`项目 ID "${id}" 重复，ID 必须全局唯一`);
    }
    seenIds.add(id);

    if (typeof name !== 'string') {
      throw new ConfigError(`项目 "${id}" 的名称必须是字符串`);
    }
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 80) {
      throw new ConfigError(`项目 "${id}" 的名称去空格后长度必须在 1 到 80 个字符之间`);
    }

    if (typeof repositoryPath !== 'string' || repositoryPath.trim() === '') {
      throw new ConfigError(`项目 "${id}" 的仓库路径必须是非空字符串`);
    }

    if (!path.isAbsolute(repositoryPath)) {
      throw new ConfigError(`项目 "${id}" 的仓库路径必须是当前主机的绝对路径`);
    }

    let parsedMaterials = undefined;
    if ('materials' in item) {
      const mats = item.materials;
      if (typeof mats !== 'object' || mats === null || Array.isArray(mats)) {
        throw new ConfigError(`项目 "${id}" 的 "materials" 必须是对象`);
      }

      parsedMaterials = {};
      const allowedKinds = ['installer', 'upgrade'];
      for (const key of Object.keys(mats)) {
        if (!allowedKinds.includes(key)) {
          throw new ConfigError(`项目 "${id}" 的 materials 包含未知类型 "${key}"`);
        }
        const kindObj = mats[key];
        if (typeof kindObj !== 'object' || kindObj === null || Array.isArray(kindObj)) {
          throw new ConfigError(`项目 "${id}" 的 materials.${key} 必须是对象`);
        }
        const kindKeys = Object.keys(kindObj);
        if (kindKeys.length !== 1 || kindKeys[0] !== 'root') {
          throw new ConfigError(`项目 "${id}" 的 materials.${key} 必须且仅包含 "root" 字段`);
        }
        const rootVal = kindObj.root;
        if (typeof rootVal !== 'string' || rootVal.trim() === '') {
          throw new ConfigError(`项目 "${id}" 的 materials.${key}.root 必须是非空字符串`);
        }
        if (!path.isAbsolute(rootVal)) {
          throw new ConfigError(`项目 "${id}" 的 materials.${key}.root 必须是当前主机的绝对路径`);
        }
        parsedMaterials[key] = {
          root: path.normalize(rootVal),
        };
      }
    }

    // 格式化并保留项目信息
    projects.push({
      id,
      name: trimmedName,
    });

    projectMap.set(id, {
      ...extra,
      id,
      name: trimmedName,
      repositoryPath: path.normalize(repositoryPath),
      ...(parsedMaterials ? { materials: parsedMaterials } : {}),
    });
  }

  return {
    configured: true,
    projects,
    projectMap,
  };
}

/**
 * 加载配置。缺失文件或空数组视为未配置；格式错误抛出 ConfigError
 * @param {string} configPath 
 * @returns {Promise<{ configured: boolean, projects: Array<{ id: string, name: string }>, projectMap: Map<string, { id: string, name: string, repositoryPath: string }> }>}
 */
export async function loadProjectsConfig(configPath) {
  let fileContent;
  try {
    fileContent = await fs.readFile(configPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        configured: false,
        projects: [],
        projectMap: new Map(),
      };
    }
    throw new ConfigError('无法读取项目配置文件');
  }

  let parsed;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    throw new ConfigError('配置文件不是合法的 JSON 格式');
  }

  return validateAndParseProjects(parsed);
}

const LOCK_TIMEOUT_MS = 2000;
const STALE_LOCK_THRESHOLD_MS = 30000; // 30 秒认定为陈旧锁

/**
 * 获取独占文件锁
 * @param {string} lockPath 
 */
export async function acquireConfigLock(lockPath) {
  const startTime = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    let handle = null;
    let lockCreatedByThisCall = false;

    try {
      handle = await fs.open(lockPath, 'wx');
      lockCreatedByThisCall = true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = await fs.stat(lockPath);
          const age = Date.now() - stat.mtimeMs;
          if (age > STALE_LOCK_THRESHOLD_MS) {
            throw new ConfigError(
              `配置文件锁已被占用超过合理时间，疑似陈旧锁。如确认无其他写入进程，请手动清理锁文件: ${path.basename(lockPath)}`,
              'CONFIG_BUSY',
              409
            );
          }
        } catch (statErr) {
          if (statErr instanceof ConfigError) throw statErr;
          // 文件可能被释放，继续下一轮重试
        }

        if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
          throw new ConfigError('配置文件正被其他操作占用，请稍后重试', 'CONFIG_BUSY', 409);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw new ConfigError('创建配置文件锁失败', 'CONFIG_SAVE_FAILED', 500);
    }

    // 成功通过 wx 创建了锁文件
    try {
      const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      await handle.writeFile(payload, 'utf-8');
      await handle.sync();
      await handle.close();
      handle = null;
      return;
    } catch (initErr) {
      if (handle) {
        try { await handle.close(); } catch {}
      }
      if (lockCreatedByThisCall) {
        try { await fs.unlink(lockPath); } catch {}
      }
      throw new ConfigError('初始化配置文件锁失败', 'CONFIG_SAVE_FAILED', 500);
    }
  }
}

/**
 * 释放独占文件锁
 * @param {string} lockPath 
 */
export async function releaseConfigLock(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 忽略非关键错误
    }
  }
}

/**
 * 确认登记并保存到 projects.json 配置
 * @param {object} params
 * @param {string} params.configPath
 * @param {object} params.ticket
 * @param {string} params.id
 * @param {string} params.name
 * @param {string} params.normRoot
 * @param {boolean} [params._simulateWriteFailure]
 * @returns {Promise<{ project: { id: string, name: string }, alreadyRegistered: boolean }>}
 */
export async function confirmAndSaveProject({
  configPath,
  ticket,
  id,
  name,
  normRoot,
  _simulateWriteFailure = false,
}) {
  const configDir = path.dirname(configPath);
  const lockPath = path.join(configDir, path.basename(configPath, path.extname(configPath)) + '.lock');

  await acquireConfigLock(lockPath);

  try {
    // 1. 持锁后重新读取最新配置并校验
    let rawConfig;
    let fileExisted = true;
    try {
      const fileContent = await fs.readFile(configPath, 'utf-8');
      try {
        rawConfig = JSON.parse(fileContent);
      } catch {
        throw new ConfigError('配置文件不是合法的 JSON 格式，拒绝覆盖损坏配置', 'CONFIG_INVALID', 500);
      }
      // 校验结构完整性
      validateAndParseProjects(rawConfig);
    } catch (err) {
      if (err.code === 'ENOENT') {
        fileExisted = false;
        rawConfig = { projects: [] };
      } else if (err instanceof ConfigError) {
        throw err;
      } else {
        throw new ConfigError('读取配置文件失败', 'CONFIG_SAVE_FAILED', 500);
      }
    }

    // 若该票据先前已被确认过：必须校验磁盘当前状态，不能把内存态当成功！
    // 1) 配置文件若已被移除，必须报错拒绝，不得凭内存结果返回成功
    if (ticket && ticket.confirmedResult && !fileExisted) {
      throw new ConfigError('配置文件已被移除，无法确认登记状态', 'CONFIG_INVALID', 500);
    }

    const existingProjects = Array.isArray(rawConfig.projects) ? rawConfig.projects : [];
    const isWindows = process.platform === 'win32';

    // 2. 查重：以根 realpath 作为重复键，Windows 比较忽略大小写
    let alreadyRegistered = null;
    for (const proj of existingProjects) {
      if (!proj || typeof proj.repositoryPath !== 'string') continue;

      let sameRoot = false;
      if (isWindows) {
        if (proj.repositoryPath.toLowerCase() === normRoot.toLowerCase()) {
          sameRoot = true;
        }
      } else {
        if (proj.repositoryPath === normRoot) {
          sameRoot = true;
        }
      }

      if (!sameRoot) {
        try {
          const projReal = await fs.realpath(proj.repositoryPath);
          if (isWindows ? projReal.toLowerCase() === normRoot.toLowerCase() : projReal === normRoot) {
            sameRoot = true;
          }
        } catch {}
      }

      if (sameRoot) {
        alreadyRegistered = { id: proj.id, name: proj.name };
        break;
      }
    }

    // 若该票据先前已被确认过：
    if (ticket && ticket.confirmedResult) {
      if (!alreadyRegistered) {
        // 磁盘上该项目已被删除或移走
        throw new ConfigError('已确认的项目在当前配置文件中不存在', 'CONFIG_INVALID', 500);
      }
      if (alreadyRegistered.id !== ticket.confirmedResult.project.id) {
        // 磁盘上的映射关系发生了变化
        throw new ConfigError('项目登记映射与先前确认状态不一致', 'ID_CONFLICT', 409);
      }
      return {
        project: alreadyRegistered,
        alreadyRegistered: true,
      };
    }

    // 若该仓库此前已在磁盘中登记过（例如其他票据登记或人工配置）
    if (alreadyRegistered) {
      const res = {
        project: alreadyRegistered,
        alreadyRegistered: true,
      };
      if (ticket) ticket.confirmedResult = res;
      return res;
    }

    // 3. ID 冲突检查：若提交的 ID 已被另一个根占用，返回 ID_CONFLICT
    const idConflict = existingProjects.find((p) => p && p.id === id);
    if (idConflict) {
      throw new ConfigError(`项目 ID "${id}" 已被占用`, 'ID_CONFLICT', 409);
    }

    // 4. 构造新配置
    const newProject = {
      id,
      name,
      repositoryPath: normRoot,
    };
    const updatedProjects = [...existingProjects, newProject];
    const newConfigObj = {
      ...rawConfig,
      projects: updatedProjects,
    };
    const jsonString = JSON.stringify(newConfigObj, null, 2) + '\n';

    // 5. 写临时文件、刷新到磁盘、原子替换
    const tempFile = path.join(
      configDir,
      `${path.basename(configPath)}.tmp.${crypto.randomBytes(8).toString('hex')}`
    );

    let tempHandle = null;
    try {
      await fs.mkdir(configDir, { recursive: true });
      tempHandle = await fs.open(tempFile, 'w');
      await tempHandle.writeFile(jsonString, 'utf-8');
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = null;

      if (_simulateWriteFailure) {
        throw new Error('Simulated write failure before atomic rename');
      }

      await fs.rename(tempFile, configPath);
    } catch (writeErr) {
      if (tempHandle) {
        try { await tempHandle.close(); } catch {}
      }
      try { await fs.unlink(tempFile); } catch {}
      throw new ConfigError('保存配置文件失败', 'CONFIG_SAVE_FAILED', 500);
    }

    const res = {
      project: { id, name },
      alreadyRegistered: false,
    };
    if (ticket) ticket.confirmedResult = res;
    return res;
  } finally {
    await releaseConfigLock(lockPath);
  }
}

/**
 * 确认并保存项目的材料目录关联
 * @param {object} params
 * @param {string} params.configPath
 * @param {object} params.ticket
 * @param {boolean} [params.replaceExisting=false]
 * @param {boolean} [params._simulateWriteFailure=false]
 * @returns {Promise<{ association: { projectId: string, kind: string, linked: boolean }, alreadyAssociated: boolean }>}
 */
export async function confirmAndSaveMaterialAssociation({
  configPath,
  ticket,
  replaceExisting = false,
  _simulateWriteFailure = false,
}) {
  const configDir = path.dirname(configPath);
  const lockPath = path.join(configDir, path.basename(configPath, path.extname(configPath)) + '.lock');

  await acquireConfigLock(lockPath);

  try {
    // 1. 持锁重读最新配置
    let rawConfig;
    try {
      const fileContent = await fs.readFile(configPath, 'utf-8');
      try {
        rawConfig = JSON.parse(fileContent);
      } catch {
        throw new ConfigError('配置文件不是合法的 JSON 格式，拒绝覆盖损坏配置', 'CONFIG_INVALID', 500);
      }
      validateAndParseProjects(rawConfig);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new ConfigError('项目配置文件不存在，无法确认材料关联', 'CONFIG_INVALID', 500);
      }
      if (err instanceof ConfigError) {
        throw err;
      }
      throw new ConfigError('读取项目配置文件失败', 'CONFIG_SAVE_FAILED', 500);
    }

    const existingProjects = Array.isArray(rawConfig.projects) ? rawConfig.projects : [];
    const targetIndex = existingProjects.findIndex((p) => p && p.id === ticket.projectId);
    if (targetIndex === -1) {
      throw new ConfigError(`未找到 ID 为 "${ticket.projectId}" 的项目`, 'PROJECT_NOT_FOUND', 404);
    }

    const targetProj = existingProjects[targetIndex];
    const currentMaterials = (targetProj.materials && typeof targetProj.materials === 'object' && !Array.isArray(targetProj.materials))
      ? targetProj.materials
      : {};
    const currentKindObj = currentMaterials[ticket.kind];
    const currentRoot = (currentKindObj && typeof currentKindObj.root === 'string') ? currentKindObj.root : null;

    // 2. 幂等检查：若磁盘上当前关联已经与本次要关联的规范化根相同，直接返回已经关联成功，不重新落盘
    if (currentRoot && isSamePath(currentRoot, ticket.normRoot)) {
      return {
        association: {
          projectId: ticket.projectId,
          kind: ticket.kind,
          linked: true,
        },
        alreadyAssociated: true,
      };
    }

    // 3. 并发冲突检查：若其他实例在检查后修改了关联（当前磁盘关联与检查时不一致）
    const existingAtInspect = ticket.existingRootAtInspection;
    const changedSinceInspect = existingAtInspect ? !isSamePath(currentRoot, existingAtInspect) : currentRoot !== null;
    if (changedSinceInspect) {
      throw new ConfigError('材料目录关联已被其他操作修改，请重新检查', 'MATERIAL_CONFLICT', 409);
    }

    // 4. 显式确认替换：若当前已有不同根，且未显式指定 replaceExisting: true，拒绝
    if (currentRoot && !replaceExisting) {
      throw new ConfigError('该项目已有不同材料目录关联，必须显式确认替换', 'MATERIAL_CONFLICT', 409);
    }

    // 5. 构造新配置对象，必须完整保留该项目及其他项目的所有未知键、已有材料根与 Git 路径
    const updatedProj = {
      ...targetProj,
      materials: {
        ...currentMaterials,
        [ticket.kind]: {
          root: ticket.normRoot,
        },
      },
    };

    const updatedProjects = existingProjects.map((p, idx) => (idx === targetIndex ? updatedProj : p));
    const newConfigObj = {
      ...rawConfig,
      projects: updatedProjects,
    };
    const jsonString = JSON.stringify(newConfigObj, null, 2) + '\n';

    // 6. 原子写入：临时文件 + fsync + 重命名
    const tempFile = path.join(
      configDir,
      `${path.basename(configPath)}.tmp.${crypto.randomBytes(8).toString('hex')}`
    );

    let tempHandle = null;
    try {
      await fs.mkdir(configDir, { recursive: true });
      tempHandle = await fs.open(tempFile, 'w');
      await tempHandle.writeFile(jsonString, 'utf-8');
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = null;

      if (_simulateWriteFailure) {
        throw new Error('Simulated write failure before atomic rename');
      }

      await fs.rename(tempFile, configPath);
    } catch (writeErr) {
      if (tempHandle) {
        try { await tempHandle.close(); } catch {}
      }
      try { await fs.unlink(tempFile); } catch {}
      throw new ConfigError('保存配置文件失败', 'CONFIG_SAVE_FAILED', 500);
    }

    return {
      association: {
        projectId: ticket.projectId,
        kind: ticket.kind,
        linked: true,
      },
      alreadyAssociated: false,
    };
  } finally {
    await releaseConfigLock(lockPath);
  }
}


