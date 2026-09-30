const MAX_POST_BODY_BYTES = 8192; // 8 KiB

export class SecurityError extends Error {
  constructor(message, statusCode = 403, code = 'FORBIDDEN') {
    super(message);
    this.name = 'SecurityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 校验基础请求头：Host、Origin、Sec-Fetch-Site
 * @param {import('node:http').IncomingMessage} req 
 * @param {number} actualPort 
 */
export function validateRequestSecurity(req, actualPort) {
  const expectedHost = `127.0.0.1:${actualPort}`;
  const expectedOrigin = `http://127.0.0.1:${actualPort}`;

  // 1. Host 校验：必须且只能包含一个 Host 头，且精确为 127.0.0.1:<actualPort>
  const rawHeaders = req.rawHeaders || [];
  let hostCount = 0;
  let rawHostValue = null;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'host') {
      hostCount++;
      rawHostValue = rawHeaders[i + 1];
    }
  }

  if (hostCount !== 1) {
    throw new SecurityError(`Host 请求头必须且只能出现一次 (实际: ${hostCount})`, 403, 'HOST_FORBIDDEN');
  }

  if (!rawHostValue || typeof rawHostValue !== 'string' || rawHostValue.toLowerCase() !== expectedHost) {
    throw new SecurityError(`非法或不匹配的 Host: "${rawHostValue}"`, 403, 'HOST_FORBIDDEN');
  }

  // 2. Sec-Fetch-Site 校验：跨站请求一律拒绝
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site') {
    throw new SecurityError('拒绝跨站请求 (Sec-Fetch-Site: cross-site)', 403, 'CROSS_SITE_FORBIDDEN');
  }

  // 3. Origin 校验
  const origin = req.headers['origin'];
  if (origin !== undefined) {
    // 带有 Origin 头时，必须严格等于 expectedOrigin，null 与外域均拒绝
    if (typeof origin !== 'string' || origin.toLowerCase() !== expectedOrigin) {
      throw new SecurityError(`非法 Origin: "${origin}"`, 403, 'ORIGIN_FORBIDDEN');
    }
  }
}

/**
 * POST 请求前置校验（必须精确同源 Origin、Content-Type: application/json、X-Local-Intent 意图头、上限 8 KiB）
 * @param {import('node:http').IncomingMessage} req 
 * @param {number} actualPort 
 * @param {string} [expectedIntent='project-onboarding']
 * @returns {Promise<any>} 解析后的 JSON 对象
 */
export async function validateAndParseJsonPost(req, actualPort, expectedIntent = 'project-onboarding') {
  const expectedOrigin = `http://127.0.0.1:${actualPort}`;

  // 1. Origin 必须存在且精确同源
  const origin = req.headers['origin'];
  if (!origin || origin.toLowerCase() !== expectedOrigin) {
    throw new SecurityError('POST 请求必须携带合法的同源 Origin 头', 403, 'ORIGIN_FORBIDDEN');
  }

  // 2. X-Local-Intent 意图头校验
  const localIntent = req.headers['x-local-intent'];
  if (localIntent !== expectedIntent) {
    throw new SecurityError('缺少或不匹配的 X-Local-Intent 头', 400, 'INTENT_HEADER_INVALID');
  }

  // 3. Content-Type 校验：application/json (可选带 utf-8 charset)
  const contentType = req.headers['content-type'];
  if (!contentType || typeof contentType !== 'string') {
    throw new SecurityError('缺少 Content-Type 请求头', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const [mediaType, ...params] = contentType.split(';').map((s) => s.trim().toLowerCase());
  if (mediaType !== 'application/json') {
    throw new SecurityError('Content-Type 必须为 application/json', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  for (const param of params) {
    if (param.startsWith('charset=')) {
      const charset = param.slice('charset='.length).trim();
      if (charset !== 'utf-8' && charset !== 'utf8') {
        throw new SecurityError('JSON 请求 charset 仅支持 utf-8', 415, 'UNSUPPORTED_CHARSET');
      }
    }
  }

  // 4. Content-Length 预检（如果存在）
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    const len = parseInt(contentLength, 10);
    if (!Number.isNaN(len) && len > MAX_POST_BODY_BYTES) {
      req.resume();
      throw new SecurityError(`请求体超过 ${MAX_POST_BODY_BYTES} 字节上限`, 413, 'PAYLOAD_TOO_LARGE');
    }
  }

  // 5. 流式读取 Body 并设防 8 KiB 上限
  const bodyBuffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let exceeded = false;

    const onData = (chunk) => {
      if (exceeded) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_POST_BODY_BYTES) {
        exceeded = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        req.resume();
        reject(new SecurityError(`请求体超过 ${MAX_POST_BODY_BYTES} 字节上限`, 413, 'PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (!exceeded) {
        resolve(Buffer.concat(chunks));
      }
    };

    const onError = (err) => {
      reject(err);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });

  // 6. JSON 解析
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString('utf-8'));
  } catch {
    throw new SecurityError('请求体不是合法的 JSON 格式', 400, 'JSON_SYNTAX_ERROR');
  }

  return parsed;
}
