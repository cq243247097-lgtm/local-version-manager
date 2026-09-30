const VERSION_REGEX = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/**
 * 解析可比较版本
 * 严格只接受 v?MAJOR.MINOR.PATCH，三段 0..999999 且无非法前导零
 * @param {string} v 
 * @returns {{ major: number, minor: number, patch: number, normalized: string } | null}
 */
export function parseComparableVersion(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const trimmed = v.trim();
  const match = trimmed.match(VERSION_REGEX);
  if (!match) return null;

  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);

  if (major > 999999 || minor > 999999 || patch > 999999) return null;

  return {
    major,
    minor,
    patch,
    normalized: `v${major}.${minor}.${patch}`,
  };
}

/**
 * 比较两个已解析版本：v1 < v2 返回 -1, v1 > v2 返回 1, 相等返回 0
 * @param {{ major: number, minor: number, patch: number }} v1 
 * @param {{ major: number, minor: number, patch: number }} v2 
 * @returns {number}
 */
export function compareVersions(v1, v2) {
  if (v1.major !== v2.major) return v1.major < v2.major ? -1 : 1;
  if (v1.minor !== v2.minor) return v1.minor < v2.minor ? -1 : 1;
  if (v1.patch !== v2.patch) return v1.patch < v2.patch ? -1 : 1;
  return 0;
}

/**
 * 计算材料条目的兼容性对象
 * @param {object} params
 * @param {'installer'|'upgrade'} params.kind 材料类型
 * @param {string|null} params.targetVersion 声明的目标版本
 * @param {any} params.directFrom 原始 directFrom 字段
 * @returns {{ state: 'available'|'unknown'|'none'|'invalid'|'not-applicable', directFrom: string[]|null, minimumDirectSource: string|null }}
 */
export function evaluateCompatibility({ kind, targetVersion, directFrom }) {
  if (kind !== 'upgrade') {
    return {
      state: 'not-applicable',
      directFrom: null,
      minimumDirectSource: null,
    };
  }

  if (directFrom === undefined || directFrom === null) {
    return {
      state: 'unknown',
      directFrom: null,
      minimumDirectSource: null,
    };
  }

  if (!Array.isArray(directFrom)) {
    return {
      state: 'invalid',
      directFrom: null,
      minimumDirectSource: null,
    };
  }

  if (directFrom.length === 0) {
    return {
      state: 'none',
      directFrom: [],
      minimumDirectSource: null,
    };
  }

  // JSON 记录中的非法元素可能是任意对象；不能把它原样带进 API 响应。
  if (directFrom.some((item) => typeof item !== 'string' || item.length > 512)) {
    return {
      state: 'invalid',
      directFrom: null,
      minimumDirectSource: null,
    };
  }

  // 存在升级来源列表时，必须校验目标版本本身是否为可比较版本
  const parsedTarget = parseComparableVersion(targetVersion);
  if (!parsedTarget) {
    return {
      state: 'invalid',
      directFrom: directFrom.slice(),
      minimumDirectSource: null,
    };
  }

  // 逐项校验来源版本
  let minVersionParsed = null;

  for (const item of directFrom) {
    if (typeof item !== 'string') {
      return {
        state: 'invalid',
        directFrom: directFrom.slice(),
        minimumDirectSource: null,
      };
    }

    const parsedItem = parseComparableVersion(item);
    if (!parsedItem) {
      // 含有不可比较版本（范围、预发布、非法格式等），整份列表 invalid，绝不取合法子集
      return {
        state: 'invalid',
        directFrom: directFrom.slice(),
        minimumDirectSource: null,
      };
    }

    // 来源版本必须严格早于目标版本
    if (compareVersions(parsedItem, parsedTarget) >= 0) {
      return {
        state: 'invalid',
        directFrom: directFrom.slice(),
        minimumDirectSource: null,
      };
    }

    if (!minVersionParsed || compareVersions(parsedItem, minVersionParsed) < 0) {
      minVersionParsed = parsedItem;
    }
  }

  return {
    state: 'available',
    directFrom: directFrom.slice(),
    minimumDirectSource: minVersionParsed ? minVersionParsed.normalized : null,
  };
}
