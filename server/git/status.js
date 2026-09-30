import { runGit } from './exec.js';

/**
 * 查找字符串中第 N 个空格的索引
 * @param {string} str 
 * @param {number} n 
 * @returns {number}
 */
function findNthSpace(str, n) {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === ' ') {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

/**
 * 解析 Git porcelain v2 -z 的输出
 * @param {Buffer} rawBuf 
 * @returns {{ headState: 'attached' | 'detached' | 'unborn', branch: string | null, upstream: { state: 'available' | 'not-configured' | 'unavailable', name: string | null, ahead: number | null, behind: number | null }, changes: Array<{ path: string, oldPath: string | null, indexStatus: string, worktreeStatus: string, conflicted: boolean }> }}
 */
export function parsePorcelainV2(rawBuf) {
  // 按照 NUL 字符分割
  const rawStr = rawBuf.toString('utf-8');
  const chunks = rawStr.split('\0');

  let headOid = null;
  let branchName = null;
  let upstreamName = null;
  let aheadBehind = null;

  const rawChanges = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    if (chunk.startsWith('# ')) {
      // 头部元数据行
      if (chunk.startsWith('# branch.oid ')) {
        headOid = chunk.slice('# branch.oid '.length).trim();
      } else if (chunk.startsWith('# branch.head ')) {
        branchName = chunk.slice('# branch.head '.length).trim();
      } else if (chunk.startsWith('# branch.upstream ')) {
        upstreamName = chunk.slice('# branch.upstream '.length).trim();
      } else if (chunk.startsWith('# branch.ab ')) {
        aheadBehind = chunk.slice('# branch.ab '.length).trim();
      }
      continue;
    }

    const type = chunk[0];

    if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 路径前有 8 个空格
      const spaceIdx = findNthSpace(chunk, 8);
      if (spaceIdx !== -1) {
        const xy = chunk.slice(2, 4);
        const path = chunk.slice(spaceIdx + 1);
        rawChanges.push({
          path,
          oldPath: null,
          indexStatus: xy[0],
          worktreeStatus: xy[1],
          conflicted: false,
        });
      }
    } else if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
      // 路径前有 9 个空格，紧随的下一个 chunk 是 origPath
      const spaceIdx = findNthSpace(chunk, 9);
      if (spaceIdx !== -1) {
        const xy = chunk.slice(2, 4);
        const path = chunk.slice(spaceIdx + 1);
        const oldPath = chunks[++i] || null;
        rawChanges.push({
          path,
          oldPath,
          indexStatus: xy[0],
          worktreeStatus: xy[1],
          conflicted: false,
        });
      }
    } else if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      // 路径前有 10 个空格
      const spaceIdx = findNthSpace(chunk, 10);
      if (spaceIdx !== -1) {
        const xy = chunk.slice(2, 4);
        const path = chunk.slice(spaceIdx + 1);
        rawChanges.push({
          path,
          oldPath: null,
          indexStatus: xy[0],
          worktreeStatus: xy[1],
          conflicted: true,
        });
      }
    } else if (type === '?') {
      // ? <path>
      const path = chunk.slice(2);
      rawChanges.push({
        path,
        oldPath: null,
        indexStatus: '?',
        worktreeStatus: '?',
        conflicted: false,
      });
    }
    // 忽略 '!' (ignored)
  }

  // 计算 headState 与 branch
  let headState;
  let resolvedBranch = null;

  if (headOid === '(initial)' || !headOid) {
    headState = 'unborn';
    resolvedBranch = (branchName && branchName !== '(detached)') ? branchName : null;
  } else if (branchName === '(detached)') {
    headState = 'detached';
    resolvedBranch = null;
  } else {
    headState = 'attached';
    resolvedBranch = branchName || null;
  }

  // 计算 upstream
  let upstream;
  if (!upstreamName || headState === 'detached' || headState === 'unborn') {
    upstream = {
      state: 'not-configured',
      name: null,
      ahead: null,
      behind: null,
    };
  } else {
    // 存在 upstream 配置
    if (aheadBehind) {
      const match = aheadBehind.match(/^\+(\d+)\s+-(\d+)$/);
      if (match) {
        upstream = {
          state: 'available',
          name: upstreamName,
          ahead: parseInt(match[1], 10),
          behind: parseInt(match[2], 10),
        };
      } else {
        upstream = {
          state: 'unavailable',
          name: upstreamName,
          ahead: null,
          behind: null,
        };
      }
    } else {
      upstream = {
        state: 'unavailable',
        name: upstreamName,
        ahead: null,
        behind: null,
      };
    }
  }

  // 按 UTF-8 字节序先排 path 再排 oldPath
  rawChanges.sort((a, b) => {
    const bufA = Buffer.from(a.path, 'utf-8');
    const bufB = Buffer.from(b.path, 'utf-8');
    const cmp = Buffer.compare(bufA, bufB);
    if (cmp !== 0) return cmp;
    const oldA = Buffer.from(a.oldPath || '', 'utf-8');
    const oldB = Buffer.from(b.oldPath || '', 'utf-8');
    return Buffer.compare(oldA, oldB);
  });

  return {
    headState,
    branch: resolvedBranch,
    upstream,
    changes: rawChanges,
  };
}

/**
 * 读取指定工作树的 Source 状态对象
 * @param {string} cwd 
 * @returns {Promise<{ scannedAt: string, branch: string | null, headState: 'attached' | 'detached' | 'unborn', changes: Array<any>, changedCount: number, upstream: any }>}
 */
export async function getRepositorySource(cwd) {
  const stdoutBuf = await runGit([
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
  ], { cwd });

  const scannedAt = new Date().toISOString();
  const parsed = parsePorcelainV2(stdoutBuf);

  return {
    scannedAt,
    branch: parsed.branch,
    headState: parsed.headState,
    changes: parsed.changes,
    changedCount: parsed.changes.length,
    upstream: parsed.upstream,
  };
}
