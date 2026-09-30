import { runGit, GitError } from './exec.js';

/**
 * 解析 for-each-ref 的输出，严格确保只保留指向 commit 的有效引用
 * @param {Buffer} rawBuf 
 * @returns {Array<{ name: string, oid: string, kind: 'local-branch' | 'remote-tracking' | 'tag' }>}
 */
export function parseRefs(rawBuf) {
  const str = rawBuf.toString('utf-8');
  const lines = str.split('\n').filter(Boolean);
  const refs = [];

  for (const line of lines) {
    const parts = line.split('\0');
    if (parts.length < 5) continue;

    const [refname, objectname, objecttype, peeledOid, peeledType] = parts;

    if (refname.startsWith('refs/heads/')) {
      if (objecttype === 'commit') {
        refs.push({
          name: refname.slice('refs/heads/'.length),
          oid: objectname,
          kind: 'local-branch',
        });
      }
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice('refs/remotes/'.length);
      // 忽略 HEAD 指针别名 (例如 origin/HEAD)
      if (!name.endsWith('/HEAD') && objecttype === 'commit') {
        refs.push({
          name,
          oid: objectname,
          kind: 'remote-tracking',
        });
      }
    } else if (refname.startsWith('refs/tags/')) {
      const name = refname.slice('refs/tags/'.length);
      let commitOid = null;

      if (objecttype === 'tag') {
        // 附注标签：必须剥离到最终提交 (排除指向 blob/tree 的标签)
        if (peeledType === 'commit' && peeledOid) {
          commitOid = peeledOid;
        }
      } else if (objecttype === 'commit') {
        // 轻量标签直接指向 commit
        commitOid = objectname;
      }

      if (commitOid) {
        refs.push({
          name,
          oid: commitOid,
          kind: 'tag',
        });
      }
    }
  }

  return refs;
}

/**
 * 解析 git log 格式化输出
 * @param {Buffer} rawBuf 
 * @returns {Array<{ oid: string, parents: string[], subject: string, committedAt: string }>}
 */
export function parseCommits(rawBuf) {
  const str = rawBuf.toString('utf-8');
  const records = str.split('\x1e');
  const commits = [];

  for (const record of records) {
    const trimmedRecord = record.trim();
    if (!trimmedRecord) continue;
    const parts = trimmedRecord.split('\0');
    if (parts.length < 4) continue;

    const [oid, parentsStr, rawDate, subject] = parts;
    const parents = parentsStr ? parentsStr.trim().split(/\s+/).filter(Boolean) : [];

    let committedAt;
    try {
      committedAt = new Date(rawDate).toISOString();
    } catch {
      committedAt = rawDate;
    }

    commits.push({
      oid,
      parents,
      subject: subject || '',
      committedAt,
    });
  }

  return commits;
}

/**
 * 读取指定工作树的历史和引用
 * 契约：只遍历 HEAD、refs/heads/、refs/remotes/、refs/tags/ 可达的提交并集。
 * 当当前 HEAD 未出生但其它分支有提交时，如实展示其它分支历史。
 * @param {string} cwd 
 * @returns {Promise<{ scannedAt: string, commits: Array<any>, refs: Array<any>, truncated: boolean }>}
 */
export async function getRepositoryHistory(cwd) {
  const scannedAt = new Date().toISOString();

  // 1. 检查是否为合法的 Git 工作树
  const isBareBuf = await runGit(['rev-parse', '--is-bare-repository'], { cwd });
  const isBareStr = isBareBuf.toString('utf-8').trim();
  if (isBareStr === 'true') {
    throw new GitError('NOT_REPOSITORY', '暂不支持接入裸仓库', 400);
  }

  // 2. 读取引用列表 (heads, remotes, tags)
  // 获取每个引用的类型与剥离后的类型，排除指向 blob/tree 的标签
  const refsBuf = await runGit([
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ], { cwd });

  const refs = parseRefs(refsBuf);

  // 3. 检查 HEAD 是否存在提交
  let hasHead = false;
  let headOid = null;
  try {
    const headBuf = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd });
    headOid = headBuf.toString('utf-8').trim();
    if (headOid) {
      hasHead = true;
    }
  } catch (err) {
    if (err instanceof GitError) {
      if (['GIT_TIMEOUT', 'GIT_OUTPUT_LIMIT', 'GIT_UNAVAILABLE', 'GIT_UNSAFE_DIRECTORY', 'NOT_REPOSITORY', 'PATH_UNAVAILABLE'].includes(err.code)) {
        throw err;
      }
    }
    // 确认是否确实是因为未出生分支 (unborn)
    try {
      await runGit(['symbolic-ref', '-q', 'HEAD'], { cwd });
      hasHead = false;
    } catch {
      throw new GitError('GIT_READ_FAILED', '无法解析仓库 HEAD 引用', 500);
    }
  }

  // 如果 HEAD 存在合法提交，将其置于 refs 最前
  if (hasHead && headOid) {
    refs.unshift({
      name: 'HEAD',
      oid: headOid,
      kind: 'head',
    });
  }

  // 4. 检查全库是否彻底空历史（HEAD 未出生且无任何其它分支/标签）
  if (!hasHead && refs.length === 0) {
    return {
      scannedAt,
      commits: [],
      refs: [],
      truncated: false,
    };
  }

  // 5. 组装历史遍历 targets：当 HEAD 未出生时不包含 HEAD，避免 Ambiguous HEAD 错误
  const logTargets = hasHead
    ? ['HEAD', '--branches', '--remotes', '--tags']
    : ['--branches', '--remotes', '--tags'];

  // 读取至多 101 条拓扑+日期排序历史
  const logBuf = await runGit([
    'log',
    '--topo-order',
    '--date-order',
    '-n', '101',
    '--format=%H%x00%P%x00%cI%x00%s%x1e',
    ...logTargets,
  ], { cwd });

  const allCommits = parseCommits(logBuf);
  const truncated = allCommits.length > 100;
  const commits = truncated ? allCommits.slice(0, 100) : allCommits;

  return {
    scannedAt,
    commits,
    refs,
    truncated,
  };
}
