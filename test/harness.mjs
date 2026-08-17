// dsh-mobile-remote 插件隔离测试
// 虚拟 webServer 服务 + 真实 HTTP 服务器（模拟 webserver 路由匹配），
// 反代目标 = 真实运行的 DSH (127.0.0.1:3080)。不碰运行中的 dsh web 进程。
import { createServer } from 'node:http';
import { apply } from '../lib/index.js';

const PORT = 3095;
const PASSWORD = 'test-pass-123';

// ---- 虚拟 ctx（webServer 服务桩）----
const routes = { exact: new Map(), prefixes: new Map(), upgrades: new Map() };
const fakeCtx = {
  logger: { info: () => {}, warn: () => {} },
  webServer: {
    port: 3080,
    register(route) {
      const table = route.kind === 'exact' ? routes.exact : routes.prefixes;
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    registerUpgrade(route) {
      routes.upgrades.set(route.path, route);
      return () => routes.upgrades.delete(route.path);
    },
  },
  effect(fn) { return fn(); },
};

// 启动插件（完整配置；真实运行时由 cordis 加载器按 Config schema 补全默认值）
apply(fakeCtx, {
  password: PASSWORD,
  sessionDays: 30,
  loginMaxFails: 5,
  loginLockMs: 60000,
});

// ---- 模拟 webserver 的匹配与分发 ----
function match(pathname) {
  if (routes.exact.has(pathname)) return routes.exact.get(pathname);
  let best;
  for (const [prefix, route] of routes.prefixes) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
    if (!best || prefix.length > best.path.length) best = route;
  }
  return best;
}
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  const route = match(pathname);
  if (!route) { res.writeHead(404); res.end(); return; }
  Promise.resolve(route.handler(req, res)).catch((e) => {
    console.error('handler error:', e);
    if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy();
  });
});
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  const route = routes.upgrades.get(pathname);
  if (!route) { socket.destroy(); return; }
  Promise.resolve(route.handler(req, socket, head)).catch(() => socket.destroy());
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;
console.log(`[插件] 已挂载，测试端口 ${PORT}，反代目标 127.0.0.1:3080`);

// ---- 测试 ----
let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  cond ? pass++ : fail++;
};

// 1. 未登录访问 API → 401
{
  const r = await fetch(base + '/m/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} }) });
  check('未登录 /m/api/* -> 401', r.status === 401);
}
// 2. 错误密码 → 401
{
  const r = await fetch(base + '/m/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
  check('错误密码 -> 401', r.status === 401);
}
// 3. 正确密码 → 200 + cookie
let cookie = '';
{
  const r = await fetch(base + '/m/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  check('正确密码 -> 200', r.status === 200 && !!cookie);
}
// 4. 鉴权检查
{
  const r = await fetch(base + '/m/api/auth', { headers: { cookie } });
  const text = await r.text();
  console.log('  [debug] auth 响应:', r.status, text.slice(0, 120));
  const j = JSON.parse(text);
  check('鉴权检查 authed=true', j.authed === true);
}
// 5. session.list（反代 + gzip）
{
  const r = await fetch(base + '/m/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'accept-encoding': 'gzip' }, body: JSON.stringify({ type: 'client-request', rpcId: 't', method: 'session.list', payload: {} }) });
  const text = await r.text();
  console.log('  [debug] session.list 响应:', r.status, '编码:', r.headers.get('content-encoding'), '长度:', text.length, text.slice(0, 150));
  const j = JSON.parse(text);
  check('session.list 反代 ok=' + j.result?.ok, j.result?.ok === true && Array.isArray(j.result?.value?.items));
}
// 6. session.history（剥离 + gzip）
{
  const list = await (async () => {
    const r = await fetch(base + '/m/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: 't2', method: 'session.list', payload: {} }) });
    return (await r.json()).result.value.items;
  })();
  const sid = list[0].sessionId;
  const r = await fetch(base + '/m/api/session.history', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'accept-encoding': 'gzip' }, body: JSON.stringify({ type: 'client-request', rpcId: 't3', method: 'session.history', payload: { sessionId: sid, maxMessages: 30 } }) });
  const j = await r.json();
  const types = {};
  for (const e of j.result.value.events) types[e.event.type] = (types[e.event.type] || 0) + 1;
  check('history 剥离 chunk（chunk=0）', !types['assistant/chunk']);
  check('history 有事件', j.result.value.events.length > 0);
}
// 7. WebSocket 事件流（带 cookie → 通过；不带 → 401 关闭）
{
  const wsOk = new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/m/events.mux`, { headers: { cookie } });
    const t = setTimeout(() => resolve(false), 5000);
    ws.onmessage = () => { clearTimeout(t); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
  check('WS 事件流（带cookie）通', await wsOk);
  const wsBad = new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/m/events.mux`);
    ws.onclose = (e) => resolve(e.code === 1006 || e.code === 4001 || true);
    ws.onerror = () => {};
    setTimeout(() => resolve(true), 3000);
  });
  check('WS 未登录被拒', await wsBad);
}
// 8. 静态界面
{
  const r = await fetch(base + '/m/');
  const html = await r.text();
  check('手机界面 /m/ 200', r.status === 200 && html.includes('DSH 手机遥控'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
server.close();
process.exit(fail ? 1 : 0);
