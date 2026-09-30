import fs from 'node:fs/promises';
import path from 'node:path';

const STATIC_WHITELIST = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
]);

const HTTP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none';";

/**
 * 判断请求路径是否在静态白名单内
 * @param {string} pathname 
 * @returns {boolean}
 */
export function isStaticPath(pathname) {
  return STATIC_WHITELIST.has(pathname);
}

/**
 * 处理静态白名单请求
 * @param {import('node:http').IncomingMessage} req 
 * @param {import('node:http').ServerResponse} res 
 * @param {string} pathname 
 * @param {string} frontendDir 
 */
export async function serveStatic(req, res, pathname, frontendDir) {
  const asset = STATIC_WHITELIST.get(pathname);
  if (!asset) {
    return false;
  }

  // 仅允许 GET 和 HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Allow': 'GET, HEAD',
    });
    res.end(JSON.stringify({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `静态资源不支持 ${req.method} 方法`,
      },
    }));
    return true;
  }

  const filePath = path.join(frontendDir, asset.file);

  try {
    let content = await fs.readFile(filePath);
    if (asset.file === 'index.html') {
      let html = content.toString('utf-8');
      html = html.replace(
        '<meta name="app-mode" content="preview">',
        '<meta name="app-mode" content="real">'
      );
      content = Buffer.from(html, 'utf-8');
    }
    res.writeHead(200, {
      'Content-Type': asset.contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': HTTP_CSP,
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({
      error: {
        code: 'STATIC_SERVE_FAILED',
        message: '读取前端静态资源失败',
      },
    }));
  }

  return true;
}
