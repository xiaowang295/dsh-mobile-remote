/**
 * dsh-mobile-remote —— DSH 插件：手机端远程遥控界面
 *
 * 挂载在 dsh web 的 webserver 上，独占 /m 命名空间：
 *   GET  /m/*             手机界面静态文件（登录页无需鉴权）
 *   POST /m/api/login     密码登录（签发 HttpOnly Cookie 令牌）
 *   GET  /m/api/auth      鉴权状态检查
 *   POST /m/api/logout    退出登录
 *   POST /m/api/<method>  密码保护 → 反代到本机 /api/<method>
 *   WS   /m/events.mux    密码保护 → 反代到本机 /api/events.mux（事件流）
 *
 * 反代要点（与 DSH 的防跨站/信任篱笆兼容）：
 *   - Host/Origin 重写为 127.0.0.1:本机端口（通过回环信任检查）
 *   - session.history 响应剥离 assistant/chunk 等过程事件（载荷缩小约 50 倍）
 *   - gzip 压缩 JSON/文本响应（再缩小约 10 倍）
 *
 * 安全模型：本插件只保护 /m/*。DSH 的 /api 信任篱笆保持"仅回环"（建议在
 * profile patch 里把 connection.trustedHosts 置空），远程只能通过带密码的
 * /m/* 访问；官方 GUI 的 /api 调用在远程会被 403 拒绝。
 */
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createGzip } from 'node:zlib';
import z from '@deepseek-ai/schemastery';

const name = 'dsh-mobile-remote';
const inject = ['webServer'];

const Config = z.object({
  password: z.string().required(),
  sessionDays: z.natural().default(30),
  loginMaxFails: z.natural().default(5),
  loginLockMs: z.natural().default(60000),
});

// ---------------------------------------------------------------- 静态资源
const HERE = fileURLToPath(new URL('../', import.meta.url));
const STATIC_ROOT = join(HERE, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- 鉴权
const AUTH_COOKIE = 'dshgw_auth';
let authKey = null;

function makeKey(password) {
  return createHmac('sha256', 'dshgw:v1').update(password).digest();
}
function signToken(payloadB64) {
  return createHmac('sha256', authKey).update(payloadB64).digest('base64url');
}
function makeToken(config) {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, exp: Date.now() + config.sessionDays * 86400000 })
  ).toString('base64url');
  return `${payload}.${signToken(payload)}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = signToken(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return data.v === 1 && typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
function isAuthed(req) {
  return verifyToken(parseCookies(req)[AUTH_COOKIE]);
}
function loginLocked(fails, ip, config) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (rec.until && rec.until > Date.now()) return true;
  if (rec.until && rec.until <= Date.now()) fails.delete(ip);
  return false;
}
function recordLoginFail(fails, ip, config) {
  const rec = fails.get(ip) ?? { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= config.loginMaxFails) {
    rec.until = Date.now() + config.loginLockMs;
    rec.count = 0;
  }
  fails.set(ip, rec);
}

// ---------------------------------------------------------------- 工具
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);
function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 静态
async function serveStatic(pathname, res) {
  let rel = pathname === '/m' ? 'index.html' : pathname.slice('/m/'.length);
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const target = normalize(join(STATIC_ROOT, rel));
  if (!target.startsWith(STATIC_ROOT) && target !== STATIC_ROOT) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

// ---------------------------------------------------------------- 反代
const HISTORY_NOISE = new Set([
  'assistant/chunk', 'step/start', 'step/end', 'request/header', 'request/context',
  'llm/retry', 'llm/retry-started', 'agent/inbox/spliced', 'session/end-seed',
]);

function proxyTo(req, res, target, newPath) {
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  delete headers.upgrade;
  if (headers.origin) headers.origin = target.origin; // Origin 必须与 Host 一致
  req.on('error', () => {});
  res.on('error', () => {});

  const pathname = new URL(newPath, 'http://x').pathname;
  const isHistory = req.method === 'POST' && pathname === '/api/session.history';
  const wantsGzip = String(req.headers['accept-encoding'] ?? '').toLowerCase().includes('gzip');
  const query = new URL(req.url ?? '/', 'http://x').search;

  const preq = httpRequest(
    {
      hostname: target.hostname,
      port: target.port === '' ? undefined : Number(target.port),
      path: newPath + query,
      method: req.method,
      headers,
    },
    (pres) => {
      pres.on('error', () => {});
      const outHeaders = filterHeaders(pres.headers);
      const contentType = String(pres.headers['content-type'] ?? '').toLowerCase();

      // 历史响应：缓冲 → 剥离 chunk 等过程事件 → gzip
      if (isHistory && (pres.statusCode ?? 0) < 300 && contentType.includes('json')) {
        const chunks = [];
        pres.on('data', (c) => chunks.push(c));
        pres.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const value = body?.result?.value;
            if (value && Array.isArray(value.events)) {
              value.events = value.events.filter((entry) => !HISTORY_NOISE.has(entry?.event?.type));
            }
            let out = JSON.stringify(body);
            if (wantsGzip) {
              outHeaders['content-encoding'] = 'gzip';
              outHeaders['vary'] = 'Accept-Encoding';
            }
            delete outHeaders['content-length'];
            res.writeHead(pres.statusCode ?? 200, outHeaders);
            if (wantsGzip) {
              const gz = createGzip();
              gz.end(out);
              gz.pipe(res);
            } else {
              res.end(out);
            }
          } catch {
            res.writeHead(pres.statusCode ?? 502, outHeaders);
            pres.pipe(res);
          }
        });
        return;
      }

      // 普通响应：可选 gzip
      const streamOnly = pathname.includes('/events.mux') || pathname.includes('/session.export');
      const compressible =
        wantsGzip && !streamOnly && !pres.headers['content-encoding'] &&
        (contentType.includes('json') || contentType.includes('text') ||
          contentType.includes('javascript') || contentType.includes('svg') || contentType.includes('xml'));
      if (compressible) {
        outHeaders['content-encoding'] = 'gzip';
        outHeaders['vary'] = 'Accept-Encoding';
        res.writeHead(pres.statusCode ?? 502, outHeaders);
        const gz = createGzip();
        pres.pipe(gz).pipe(res);
        return;
      }
      res.writeHead(pres.statusCode ?? 502, outHeaders);
      pres.pipe(res);
    }
  );
  preq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`[dsh-mobile-remote] 无法连接 DSH：${e.message}`);
    } else {
      res.destroy();
    }
  });
  req.pipe(preq);
}

// ---------------------------------------------------------------- WebSocket
function handleMobileWs(req, socket, head, deps) {
  socket.on('error', () => socket.destroy());
  if (!isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const target = deps.targetFor();
  const headers = { ...req.headers, host: target.host };
  if (headers.origin) headers.origin = target.origin;
  const preq = httpRequest({
    hostname: target.hostname,
    port: target.port === '' ? undefined : Number(target.port),
    path: '/api/events.mux',
    method: 'GET',
    headers,
  });
  preq.on('upgrade', (pres, psock, phead) => {
    psock.on('error', () => {});
    if (phead && phead.length) psock.unshift(phead);
    const accept = pres.headers['sec-websocket-accept'] ?? '';
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    psock.pipe(socket);
    socket.pipe(psock);
  });
  preq.on('error', () => socket.destroy());
  preq.end();
}

// ---------------------------------------------------------------- 路由
async function handleMobile(req, res, deps) {
  const u = new URL(req.url ?? '/', 'http://x');
  const p = u.pathname;
  const { config, loginFails } = deps;
  const ip = req.socket.remoteAddress ?? '?';
  try {
    if (p === '/m/api/login' && req.method === 'POST') {
      if (loginLocked(loginFails, ip, config)) {
        json(res, 429, { ok: false, error: '尝试次数过多，请稍后再试' });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req, 4096));
      } catch {
        json(res, 400, { ok: false, error: '请求格式错误' });
        return;
      }
      if (typeof body?.password === 'string' && body.password === config.password) {
        loginFails.delete(ip);
        const token = makeToken(config);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionDays * 86400}`,
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        recordLoginFail(loginFails, ip, config);
        json(res, 401, { ok: false, error: '密码错误' });
      }
      return;
    }
    if (p === '/m/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (p === '/m/api/auth' && req.method === 'GET') {
      json(res, 200, { ok: true, authed: isAuthed(req) });
      return;
    }
    if (p.startsWith('/m/api/')) {
      if (!isAuthed(req)) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      proxyTo(req, res, deps.targetFor(), '/api/' + p.slice('/m/api/'.length));
      return;
    }
    await serveStatic(p, res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { ok: false, error: String(e?.message ?? e) });
    else res.destroy();
  }
}

// ---------------------------------------------------------------- 插件
function apply(ctx, config) {
  authKey = makeKey(config.password);
  const deps = {
    config,
    loginFails: new Map(),
    targetFor: () => {
      const port = ctx.webServer?.port ?? 3080;
      return new URL(`http://127.0.0.1:${port}`);
    },
  };
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/m',
      handler: (req, res) => handleMobile(req, res, deps),
    }),
    'dsh-mobile-remote: /m routes'
  );
  ctx.effect(
    () => ctx.webServer.registerUpgrade({
      path: '/m/events.mux',
      handler: (req, socket, head) => handleMobileWs(req, socket, head, deps),
    }),
    'dsh-mobile-remote: /m/events.mux upgrade'
  );
  if (typeof ctx.logger?.info === 'function') ctx.logger.info('[dsh-mobile-remote] 手机遥控界面已挂载: /m/（密码已启用）');
  else console.log('[dsh-mobile-remote] 手机遥控界面已挂载: /m/（密码已启用）');
}

export { Config, apply, inject, name };
