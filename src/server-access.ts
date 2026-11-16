import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function serverAccess() {
  const urls = [process.env.APP_PUBLIC_URL, process.env.MATERIAL_PUBLIC_BASE_URL].filter((value): value is string => !!value?.trim()).map(value => new URL(value.trim()));
  for (const url of urls) {
    if (url.username || url.password || !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(url.pathname) || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('公开地址必须使用 HTTPS，可带 /aiVideo 路径前缀');
  }
  const username = process.env.APP_AUTH_USER?.trim() || '', password = process.env.APP_AUTH_PASSWORD || '';
  if ((username && !password) || (!username && password)) throw new Error('APP_AUTH_USER 与 APP_AUTH_PASSWORD 需要成对填写');
  if (urls.some(url => !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) && (!username || password.length < 16)) throw new Error('公开工作台需要配置 APP_AUTH_USER 和至少16位 APP_AUTH_PASSWORD');
  const hosts = new Set(urls.map(url => url.host.toLowerCase())), origins = new Set(urls.map(url => url.origin));
  return {
    allow(req: IncomingMessage, res: ServerResponse, material: boolean) {
      const host = (req.headers.host || '').toLowerCase();
      const local = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);
      if (!local && !hosts.has(host)) { res.writeHead(403); res.end('站点地址不允许'); return false; }
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin).origin; } catch { res.writeHead(403); res.end(); return false; }
        if (!origins.has(origin) && !(local && origin === `http://${host}`)) { res.writeHead(403); res.end('不支持跨站请求'); return false; }
      }
      if (material || !username) return true;
      const auth = req.headers.authorization || '';
      const valid = auth.length <= 4096 && auth.startsWith('Basic ') && timingSafeEqual(digest(auth.slice(6)), digest(Buffer.from(`${username}:${password}`).toString('base64')));
      if (valid) return true;
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="aiVideo", charset="UTF-8"', 'Cache-Control': 'no-store' }); res.end('需要登录'); return false;
    },
  };
}
