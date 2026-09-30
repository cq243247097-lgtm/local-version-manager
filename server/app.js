import http from 'node:http';
import path from 'node:path';
import { loadProjectsConfig, confirmAndSaveProject, confirmAndSaveMaterialAssociation, acquireConfigLock, releaseConfigLock, ConfigError } from './config.js';
import { validateRequestSecurity, validateAndParseJsonPost, SecurityError } from './security.js';
import { isStaticPath, serveStatic } from './static.js';
import { getRepositorySource } from './git/status.js';
import { getRepositoryHistory } from './git/history.js';
import { inspectRepository, getInspectionTicket, verifyRepositoryIdentity } from './git/inspect.js';
import { inspectMaterialDirectory, getMaterialInspectionTicket, verifyMaterialDirectoryIdentity, MaterialError } from './materials/association.js';
import { scanMaterialDirectory, generateScanPreviewSummary } from './materials/scan.js';
import { GitError } from './git/exec.js';
import { getCommitCandidates, createCommitPreview, removeCommitPreviewTicket, COMMIT_PREVIEW_ERRORS } from './git/commit-preview.js';
import { executeCommit, queryCommitOperation, COMMIT_WRITE_ERRORS } from './git/commit-write.js';
import { COMMIT_OPERATION_ERRORS } from './git/commit-operations.js';

const COMMIT_CODES = new Set([...Object.keys(COMMIT_PREVIEW_ERRORS), ...Object.keys(COMMIT_WRITE_ERRORS),
  ...Object.keys(COMMIT_OPERATION_ERRORS), 'PROJECT_NOT_FOUND', 'CONFIG_INVALID', 'CONFIG_BUSY', 'CONFIG_SAVE_FAILED', 'GIT_TIMEOUT', 'GIT_OUTPUT_LIMIT', 'GIT_UNAVAILABLE']);
const operationIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
function validCommitBody(body, action) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = action === 'preview' ? ['candidateIds', 'message'] : ['ticketId', 'operationId'];
  if (Object.keys(body).length !== 2 || Object.keys(body).some((key) => !keys.includes(key))) return false;
  if (action === 'confirm') return typeof body.ticketId === 'string' && /^[a-f0-9]{64}$/.test(body.ticketId) &&
    typeof body.operationId === 'string' && operationIdPattern.test(body.operationId);
  return typeof body.message === 'string' && body.message.length <= 500 && body.message.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/.test(body.message) && Array.isArray(body.candidateIds) &&
    body.candidateIds.length > 0 && body.candidateIds.length <= 500 &&
    body.candidateIds.every((id) => typeof id === 'string' && /^cand_[a-f0-9]{16}$/.test(id)) &&
    new Set(body.candidateIds).size === body.candidateIds.length;
}
// Explicit transport DTO: never serialize core internals or exception messages.
function commitResultDto(projectId, result) {
  const output = { projectId };
  for (const key of ['success', 'status', 'operationId', 'reason', 'commitOid', 'treeOid', 'branch',
    'message', 'indexChange', 'idempotent', 'durable', 'retired', 'blockedByOperationId', 'persistenceGuarantee']) {
    if (result[key] !== undefined) output[key] = result[key];
  }
  // T02 emits this complete delta only after proving partial against the current
  // index. Never reconstruct it from the selection or expose stale/invalid paths.
  if (result.status === 'partial' && Array.isArray(result.stagedFiles) && result.stagedFiles.length > 0 &&
      new Set(result.stagedFiles).size === result.stagedFiles.length && result.stagedFiles.every((name) => {
        if (typeof name !== 'string' || !name || name.includes('\0') || path.isAbsolute(name)) return false;
        if (process.platform === 'win32' && /^[a-zA-Z]:/.test(name)) return false;
        return !name.split(process.platform === 'win32' ? /[\\/]/ : '/').some((part) => part === '.' || part === '..');
      })) output.stagedFiles = [...result.stagedFiles];
  output.resultUrl = `/api/projects/${projectId}/commit/operations/${result.operationId}`;
  output.sourceUrl = `/api/projects/${projectId}/source`;
  if (result.status !== 'completed') output.error = {
    code: result.reason || 'COMMIT_UNKNOWN',
    message: result.status === 'stale' ? '预览已失效，请重新预览' : result.message || '请先查询并核对提交操作状态',
  };
  return output;
}


const MAX_SERIALIZED_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB

export function sendJson(res, statusCode, data, extraHeaders = {}) {
  const jsonString = JSON.stringify(data);
  const byteLength = Buffer.byteLength(jsonString, 'utf-8');
  if (byteLength > MAX_SERIALIZED_RESPONSE_BYTES) {
    const errorPayload = JSON.stringify({
      error: {
        code: 'RESPONSE_TOO_LARGE',
        message: `响应大小 (${byteLength} 字节) 超过系统硬上限 8 MiB`,
      },
    });
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    });
    res.end(errorPayload);
    return;
  }

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(jsonString);
}

function handlePostSecurityError(err, req, res) {
  req.resume(); // 丢弃未读数据，防止客户端连接挂起
  if (err instanceof SecurityError) {
    sendJson(
      res,
      err.statusCode,
      {
        error: {
          code: err.code,
          message: err.message,
        },
      },
      err.statusCode === 413 ? { Connection: 'close' } : {}
    );
    return;
  }
  sendJson(res, 400, {
    error: {
      code: 'BAD_REQUEST',
      message: 'POST 请求校验失败',
    },
  });
}

/**
 * 创建应用请求处理函数
 * @param {object} options
 * @param {string} [options.configPath]
 * @param {string} [options.frontendDir]
 * @param {string} [options.operationsDir] Trusted absolute operation-store path; defaults beside config.
 * @param {() => number} options.getPort
 */
export function createRequestHandler({ configPath, frontendDir, operationsDir, getPort }) {
  const resolvedConfigPath = path.resolve(configPath || '.local/projects.json');
  const commitOptions = { configPath: resolvedConfigPath, operationsDir: operationsDir || path.join(path.dirname(resolvedConfigPath), 'commit-operations') };
  const configLockPath = path.join(path.dirname(resolvedConfigPath), path.basename(resolvedConfigPath, path.extname(resolvedConfigPath)) + '.lock');
  const resolvedFrontendDir = frontendDir || path.resolve('frontend');

  return async function requestHandler(req, res) {
    const actualPort = getPort();

    // 1. 全局请求安全边界校验（Host、Origin、Sec-Fetch-Site）
    try {
      validateRequestSecurity(req, actualPort);
    } catch (err) {
      req.resume();
      if (err instanceof SecurityError) {
        sendJson(res, err.statusCode, {
          error: {
            code: err.code,
            message: err.message,
          },
        });
        return;
      }
      sendJson(res, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: '请求安全检查异常',
        },
      });
      return;
    }

    // 2. URL 解析
    let pathname;
    try {
      const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${actualPort}`);
      pathname = parsedUrl.pathname;
    } catch {
      req.resume();
      sendJson(res, 400, {
        error: {
          code: 'BAD_REQUEST',
          message: '请求 URL 格式不合法',
        },
      });
      return;
    }

    // 3. 静态白名单匹配
    if (isStaticPath(pathname)) {
      await serveStatic(req, res, pathname, resolvedFrontendDir);
      return;
    }

    // Commit routes are closed before any config lookup, lock, ticket or Git work.
    const commitMatch = pathname.match(/^\/api\/projects\/([a-z][a-z0-9_-]{0,31})\/commit\/(candidates|preview|confirm|operations\/([a-zA-Z0-9_-]{1,64}))$/);
    if (commitMatch) {
      const [, projectId, action, operationId] = commitMatch;
      const expectedMethod = action === 'preview' || action === 'confirm' ? 'POST' : 'GET';
      if (req.method !== expectedMethod) {
        req.resume();
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '此提交接口不支持该方法' } }, { Allow: expectedMethod });
        return;
      }
      if (new URL(req.url, `http://127.0.0.1:${actualPort}`).search) {
        req.resume();
        sendJson(res, 400, { error: { code: 'INVALID_INPUT', message: '提交接口不接受查询参数' } });
        return;
      }
      let body;
      if (expectedMethod === 'POST') {
        try {
          if (req.headers.origin !== `http://127.0.0.1:${actualPort}`) throw new SecurityError('提交请求必须携带精确同源 Origin', 403, 'ORIGIN_FORBIDDEN');
          body = await validateAndParseJsonPost(req, actualPort, 'git-commit');
        } catch (err) { handlePostSecurityError(err, req, res); return; }
        if (!validCommitBody(body, action)) {
          sendJson(res, 400, { error: { code: 'INVALID_INPUT', message: '提交请求字段、类型或长度不合法' } });
          return;
        }
      }
      let locked = false;
      let executing = false;
      try {
        // Serialize with registration/material config writers. GET never takes a lock.
        if (expectedMethod === 'POST') { await acquireConfigLock(configLockPath); locked = true; }
        const config = await loadProjectsConfig(resolvedConfigPath);
        const project = config.projectMap.get(projectId);
        if (!project) throw new GitError('PROJECT_NOT_FOUND', '未找到项目', 404);
        let output;
        let statusCode = 200;
        if (action === 'candidates') {
          output = { projectId, ...await getCommitCandidates(project.repositoryPath, { projectId }) };
        } else if (action === 'preview') {
          const preview = await createCommitPreview(project.repositoryPath, { ...body, projectId });
          const latest = await loadProjectsConfig(resolvedConfigPath);
          if (latest.projectMap.get(projectId)?.repositoryPath !== project.repositoryPath) {
            removeCommitPreviewTicket(preview.ticketId);
            throw new GitError('PREVIEW_STALE', '项目配置已改变', 409);
          }
          // No file contents/diff are returned by the HTTP boundary.
          const { ticketId, branch, headOid, expectedTreeOid, message, summary, expiresInSeconds } = preview;
          output = { projectId, ticketId, branch, headOid, expectedTreeOid, message, summary, expiresInSeconds };
        } else {
          executing = action === 'confirm';
          const result = executing ? await executeCommit(projectId, body, commitOptions) :
            await queryCommitOperation(projectId, operationId, commitOptions);
          output = commitResultDto(projectId, result);
          statusCode = result.status === 'completed' ? 200 : 409;
        }
        if (expectedMethod === 'GET') {
          const latest = await loadProjectsConfig(resolvedConfigPath);
          if (latest.projectMap.get(projectId)?.repositoryPath !== project.repositoryPath) throw new GitError('OPERATION_INVALID', '项目配置已改变', 409);
        }
        sendJson(res, statusCode, output);
      } catch (err) {
        const code = COMMIT_CODES.has(err.code) ? err.code : err instanceof ConfigError ? 'CONFIG_INVALID' : 'COMMIT_UNKNOWN';
        const statusCode = ['PROJECT_NOT_FOUND', 'OPERATION_NOT_FOUND'].includes(code) ? 404 :
          code === 'GIT_TIMEOUT' ? 504 : code === 'GIT_UNAVAILABLE' || code === 'CONFIG_INVALID' ? 500 : 409;
        const messages = { REPOSITORY_BUSY: '仓库忙，请稍后查询操作状态', PREVIEW_STALE: '预览已失效，请重新预览',
          IDENTITY_MISSING: '请先在 Git 中配置提交身份', PROJECT_NOT_FOUND: '未找到已登记项目',
          OPERATION_NOT_FOUND: '未找到该提交操作' };
        // An unexpected confirmation exception can occur after a write. Never claim failure/not_started.
        sendJson(res, statusCode, { error: { code, message: messages[code] || '提交请求无法安全完成，请核对配置或查询操作状态' },
          ...(executing ? { status: code === 'REPOSITORY_BUSY' ? 'busy' : code === 'PREVIEW_STALE' ? 'stale' : 'unknown', operationId: body.operationId,
            resultUrl: `/api/projects/${projectId}/commit/operations/${body.operationId}` } : {}) });
      } finally {
        if (locked) await releaseConfigLock(configLockPath);
      }
      return;
    }

    if (/^\/api\/projects\/[^/]+\/commit(?:\/|$)/.test(pathname)) {
      req.resume();
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '提交接口不存在' } });
      return;
    }

    // 4. API 路由
    if (pathname === '/api/projects') {
      if (req.method === 'GET') {
        try {
          const config = await loadProjectsConfig(resolvedConfigPath);
          sendJson(res, 200, {
            projects: config.projects,
            configured: config.configured,
          });
        } catch (err) {
          if (err instanceof ConfigError) {
            sendJson(res, 500, {
              error: {
                code: err.code,
                message: err.message,
              },
            });
            return;
          }
          sendJson(res, 500, {
            error: {
              code: 'CONFIG_INVALID',
              message: '读取项目配置失败',
            },
          });
        }
        return;
      }

      if (req.method === 'POST') {
        let parsedBody;
        try {
          parsedBody = await validateAndParseJsonPost(req, actualPort);
        } catch (err) {
          handlePostSecurityError(err, req, res);
          return;
        }

        // 校验请求体仅包含 inspectionId, id, name
        if (
          typeof parsedBody !== 'object' ||
          parsedBody === null ||
          Array.isArray(parsedBody)
        ) {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: '请求体必须是 JSON 对象',
            },
          });
          return;
        }

        const allowedKeys = new Set(['inspectionId', 'id', 'name']);
        const bodyKeys = Object.keys(parsedBody);
        if (bodyKeys.length !== 3 || bodyKeys.some((k) => !allowedKeys.has(k))) {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: '请求体必须且仅包含 inspectionId, id, name 字段',
            },
          });
          return;
        }

        const { inspectionId, id, name } = parsedBody;

        if (typeof inspectionId !== 'string' || inspectionId.trim() === '') {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: 'inspectionId 必须为非空字符串',
            },
          });
          return;
        }

        const ID_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;
        if (typeof id !== 'string' || !ID_REGEX.test(id)) {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: '项目 ID 必须为小写字母开头且仅含字母、数字、下划线、中划线，长度 1-32 位',
            },
          });
          return;
        }

        if (typeof name !== 'string') {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: '项目名称必须为字符串',
            },
          });
          return;
        }

        const trimmedName = name.trim();
        if (trimmedName.length < 1 || trimmedName.length > 80) {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: '项目名称去空格后长度必须在 1 到 80 个字符之间',
            },
          });
          return;
        }

        // 查找接入票据
        const ticket = getInspectionTicket(inspectionId);
        if (!ticket) {
          sendJson(res, 400, {
            error: {
              code: 'INSPECTION_STALE',
              message: '接入检查票据不存在或已过期，请重新检查',
            },
          });
          return;
        }

        // 重新验证仓库工作树身份
        let normRoot;
        try {
          normRoot = await verifyRepositoryIdentity(ticket);
        } catch (err) {
          if (err instanceof GitError) {
            sendJson(res, err.statusCode, {
              error: {
                code: err.code,
                message: err.message,
              },
            });
            return;
          }
          sendJson(res, 400, {
            error: {
              code: 'INSPECTION_STALE',
              message: '仓库验证失败，请重新检查',
            },
          });
          return;
        }

        // 持锁确认并保存配置
        try {
          const result = await confirmAndSaveProject({
            configPath: resolvedConfigPath,
            ticket,
            id,
            name: trimmedName,
            normRoot,
          });
          sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof ConfigError) {
            sendJson(res, err.statusCode, {
              error: {
                code: err.code,
                message: err.message,
              },
            });
            return;
          }
          sendJson(res, 500, {
            error: {
              code: 'CONFIG_SAVE_FAILED',
              message: '保存项目配置失败',
            },
          });
        }
        return;
      }

      sendJson(res, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: `/api/projects 不支持 ${req.method} 方法`,
        },
      });
      return;
    }

    if (pathname === '/api/projects/inspect') {
      if (req.method === 'POST') {
        let parsedBody;
        try {
          parsedBody = await validateAndParseJsonPost(req, actualPort);
        } catch (err) {
          handlePostSecurityError(err, req, res);
          return;
        }

        // 校验请求体仅允许 repositoryPath 字段
        if (
          typeof parsedBody !== 'object' ||
          parsedBody === null ||
          Array.isArray(parsedBody) ||
          typeof parsedBody.repositoryPath !== 'string' ||
          Object.keys(parsedBody).some((k) => k !== 'repositoryPath')
        ) {
          sendJson(res, 400, {
            error: {
              code: 'PATH_UNAVAILABLE',
              message: '请求体必须且仅包含 repositoryPath 字段',
            },
          });
          return;
        }

        try {
          const result = await inspectRepository(parsedBody.repositoryPath);
          sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof GitError) {
            sendJson(res, err.statusCode, {
              error: {
                code: err.code,
                message: err.message,
              },
            });
            return;
          }
          sendJson(res, 500, {
            error: {
              code: 'GIT_READ_FAILED',
              message: '接入检查读取失败',
            },
          });
        }
        return;
      }

      sendJson(res, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: `/api/projects/inspect 不支持 ${req.method} 方法`,
        },
      });
      return;
    }

    const projectSubMatch = pathname.match(/^\/api\/projects\/([a-z][a-z0-9_-]{0,31})\/(source|history)$/);
    if (projectSubMatch) {
      const [, projectId, subAction] = projectSubMatch;
      if (req.method !== 'GET') {
        sendJson(res, 405, {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: `/api/projects/${projectId}/${subAction} 仅支持 GET 方法`,
          },
        });
        return;
      }

      let config;
      try {
        config = await loadProjectsConfig(resolvedConfigPath);
      } catch (err) {
        if (err instanceof ConfigError) {
          sendJson(res, 500, {
            error: {
              code: err.code,
              message: err.message,
            },
          });
          return;
        }
        sendJson(res, 500, {
          error: {
            code: 'CONFIG_INVALID',
            message: '读取项目配置失败',
          },
        });
        return;
      }

      const project = config.projectMap.get(projectId);
      if (!project) {
        sendJson(res, 404, {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: `未找到 ID 为 "${projectId}" 的项目`,
          },
        });
        return;
      }

      try {
        if (subAction === 'source') {
          const result = await getRepositorySource(project.repositoryPath);
          sendJson(res, 200, result);
        } else {
          const result = await getRepositoryHistory(project.repositoryPath);
          sendJson(res, 200, result);
        }
      } catch (err) {
        if (err instanceof GitError) {
          sendJson(res, err.statusCode, {
            error: {
              code: err.code,
              message: err.message,
            },
          });
          return;
        }
        sendJson(res, 500, {
          error: {
            code: 'GIT_READ_FAILED',
            message: '读取 Git 数据失败',
          },
        });
      }
      return;
    }

    const materialMatch = pathname.match(/^\/api\/projects\/([a-z][a-z0-9_-]{0,31})\/materials\/([^/]+)\/(inspect|confirm)$/);
    if (materialMatch) {
      const [, projectId, kind, action] = materialMatch;

      if (req.method !== 'POST') {
        sendJson(res, 405, {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: `/api/projects/${projectId}/materials/${kind}/${action} 仅支持 POST 方法`,
          },
        });
        return;
      }

      if (kind !== 'installer' && kind !== 'upgrade') {
        sendJson(res, 400, {
          error: {
            code: 'INVALID_INPUT',
            message: `材料类型 "${kind}" 不合法，仅支持 installer 或 upgrade`,
          },
        });
        return;
      }

      let parsedBody;
      try {
        parsedBody = await validateAndParseJsonPost(req, actualPort, 'material-linking');
      } catch (err) {
        handlePostSecurityError(err, req, res);
        return;
      }

      // 请求体严格前置校验：必须早于读配置与查票据，防止在读配置/票据前泄露配置状态
      if (
        typeof parsedBody !== 'object' ||
        parsedBody === null ||
        Array.isArray(parsedBody)
      ) {
        sendJson(res, 400, {
          error: {
            code: 'INVALID_INPUT',
            message: '请求体必须是 JSON 对象',
          },
        });
        return;
      }

      if (action === 'inspect') {
        const keys = Object.keys(parsedBody);
        if (
          keys.length !== 1 ||
          keys[0] !== 'rootPath' ||
          typeof parsedBody.rootPath !== 'string' ||
          parsedBody.rootPath.trim() === ''
        ) {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: '请求体必须且仅包含 rootPath 非空字符串字段',
            },
          });
          return;
        }
      } else if (action === 'confirm') {
        const allowedKeys = new Set(['inspectionId', 'replaceExisting']);
        const keys = Object.keys(parsedBody);
        if (keys.length !== 2 || keys.some((k) => !allowedKeys.has(k))) {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: '请求体必须且仅包含 inspectionId, replaceExisting 字段',
            },
          });
          return;
        }

        const { inspectionId, replaceExisting } = parsedBody;

        if (typeof inspectionId !== 'string' || inspectionId.trim() === '') {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: 'inspectionId 必须为非空字符串',
            },
          });
          return;
        }

        if (typeof replaceExisting !== 'boolean') {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: 'replaceExisting 必须为布尔值',
            },
          });
          return;
        }
      }

      let config;
      try {
        config = await loadProjectsConfig(resolvedConfigPath);
      } catch (err) {
        if (err instanceof ConfigError) {
          sendJson(res, 500, {
            error: {
              code: err.code,
              message: err.message,
            },
          });
          return;
        }
        sendJson(res, 500, {
          error: {
            code: 'CONFIG_INVALID',
            message: '读取项目配置失败',
          },
        });
        return;
      }

      const targetProject = config.projectMap.get(projectId);
      if (!targetProject) {
        sendJson(res, 404, {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: `未找到 ID 为 "${projectId}" 的项目`,
          },
        });
        return;
      }

      if (action === 'inspect') {
        const existingRoot = targetProject.materials?.[kind]?.root || null;

        try {
          const result = await inspectMaterialDirectory({
            rootPath: parsedBody.rootPath,
            projectId,
            kind,
            existingRoot,
          });

          let preview = null;
          try {
            const scanResult = await scanMaterialDirectory({
              normRoot: result.normalizedRoot,
              kind,
              projectId,
            });
            preview = generateScanPreviewSummary(scanResult);
          } catch {
            preview = {
              status: 'partial',
              truncated: true,
              reasons: ['preview_scan_failed'],
              entriesScanned: 0,
              summary: {
                totalFiles: 0,
                totalDirectories: 0,
                skippedLinks: 0,
                recognizedRecords: 0,
                unrecognizedFiles: 0,
                missingReferences: 0,
                conflictRecords: 0,
                invalidRecords: 0,
              },
            };
          }

          sendJson(res, 200, {
            ...result,
            preview,
          });
        } catch (err) {
          if (err instanceof MaterialError) {
            sendJson(res, err.statusCode, {
              error: {
                code: err.code,
                message: err.message,
              },
            });
            return;
          }
          sendJson(res, 500, {
            error: {
              code: 'MATERIAL_INSPECT_FAILED',
              message: '材料目录检查异常',
            },
          });
        }
        return;
      }

      if (action === 'confirm') {
        const { inspectionId, replaceExisting } = parsedBody;

        const ticket = getMaterialInspectionTicket(inspectionId);
        if (!ticket || ticket.projectId !== projectId || ticket.kind !== kind) {
          sendJson(res, 400, {
            error: {
              code: 'INSPECTION_STALE',
              message: '检查票据不存在、已过期或与请求项目/类型不匹配',
            },
          });
          return;
        }

        try {
          await verifyMaterialDirectoryIdentity(ticket);
        } catch (err) {
          if (err instanceof MaterialError) {
            sendJson(res, err.statusCode, {
              error: {
                code: err.code,
                message: err.message,
              },
            });
            return;
          }
          sendJson(res, 400, {
            error: {
              code: 'INSPECTION_STALE',
              message: '材料目录复核失败',
            },
          });
          return;
        }

        try {
          const result = await confirmAndSaveMaterialAssociation({
            configPath: resolvedConfigPath,
            ticket,
            replaceExisting,
          });
          sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof ConfigError) {
            sendJson(res, err.statusCode, {
              error: {
                code: err.code,
                message: err.message,
              },
            });
            return;
          }
          sendJson(res, 500, {
            error: {
              code: 'CONFIG_SAVE_FAILED',
              message: '保存材料目录关联失败',
            },
          });
        }
        return;
      }
    }

    const getMaterialMatch = pathname.match(/^\/api\/projects\/([a-z][a-z0-9_-]{0,31})\/materials\/([^/]+)$/);
    if (getMaterialMatch) {
      const [, projectId, kind] = getMaterialMatch;

      if (req.method !== 'GET') {
        sendJson(res, 405, {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: `/api/projects/${projectId}/materials/${kind} 仅支持 GET 方法`,
          },
        });
        return;
      }

      if (kind !== 'installer' && kind !== 'upgrade') {
        sendJson(res, 400, {
          error: {
            code: 'INVALID_INPUT',
            message: `材料类型 "${kind}" 不合法，仅支持 installer 或 upgrade`,
          },
        });
        return;
      }

      let config;
      try {
        config = await loadProjectsConfig(resolvedConfigPath);
      } catch (err) {
        if (err instanceof ConfigError) {
          sendJson(res, 500, {
            error: {
              code: err.code,
              message: err.message,
            },
          });
          return;
        }
        sendJson(res, 500, {
          error: {
            code: 'CONFIG_INVALID',
            message: '读取项目配置失败',
          },
        });
        return;
      }

      const targetProject = config.projectMap.get(projectId);
      if (!targetProject) {
        sendJson(res, 404, {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: `未找到 ID 为 "${projectId}" 的项目`,
          },
        });
        return;
      }

      const root = targetProject.materials?.[kind]?.root;
      if (!root) {
        sendJson(res, 200, {
          projectId,
          kind,
          state: 'unlinked',
          scan: null,
          tree: [],
          items: [],
        });
        return;
      }

      try {
        const scanResult = await scanMaterialDirectory({
          normRoot: root,
          kind,
          projectId,
        });
        sendJson(res, 200, scanResult);
      } catch (err) {
        if (err.code === 'MATERIAL_ROOT_UNAVAILABLE') {
          sendJson(res, 409, {
            error: {
              code: 'MATERIAL_ROOT_UNAVAILABLE',
              message: '已关联的材料根目录不可访问或已失效',
            },
          });
          return;
        }
        sendJson(res, 500, {
          error: {
            code: 'MATERIAL_SCAN_FAILED',
            message: '扫描材料目录发生异常',
          },
        });
      }
      return;
    }

    // 5. 其它非白名单路径与未知方法一律拒绝
    sendJson(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: `请求的资源不存在: ${pathname}`,
      },
    });
  };
}

/**
 * 创建 HTTP 服务实例
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {string} [options.configPath]
 * @param {string} [options.frontendDir]
 * @param {string} [options.operationsDir] Trusted absolute operation-store path; defaults beside config.
 */
export function createAppServer(options = {}) {
  let listeningPort = options.port || 4189;

  const requestHandler = createRequestHandler({
    configPath: options.configPath,
    frontendDir: options.frontendDir,
    operationsDir: options.operationsDir,
    getPort: () => listeningPort,
  });

  const server = http.createServer(requestHandler);

  return {
    server,
    setListeningPort(port) {
      listeningPort = port;
    },
    getListeningPort() {
      return listeningPort;
    },
  };
}
