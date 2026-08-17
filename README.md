# dsh-mobile-remote 📱

> Remote-control your DeepSeek Harness from your phone — as a native DSH plugin.
> 把手机远程遥控 DeepSeek Harness 做成原生 DSH 插件：装进 `dsh web`，无需单独进程、无需单独端口。

[English](#english) · [中文](#中文)

---

<a name="english"></a>

## English

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that mounts a
password-protected mobile chat UI on your existing `dsh web` server — no extra process, no extra port.

```
Phone browser ── PgyBox/Tailscale/VPN ──> dsh web (:3080)
                                          ├─ /m/          mobile UI (password protected)
                                          │   ├─ /m/api/login|auth|logout
                                          │   ├─ /m/api/* → proxy to /api/* (gzip + history pruning)
                                          │   └─ /m/events.mux → proxied event stream (WebSocket)
                                          ├─ /api/*       loopback-only trust fence
                                          └─ /            official full GUI (local/LAN only)
```

### Features

- 🔐 Password login (HttpOnly signed cookie, login rate limiting)
- 💬 Chat, session list, live streaming, task/todo progress, approval & question modals, stop/interrupt
- 🚀 Performance: gzip compression (~12x) + `assistant/chunk` pruning in history (~50x smaller payload)
- 🛡️ Security: the DSH `/api` trust fence stays loopback-only — remote access works **only** through the
  password-protected `/m/*` surface (the official GUI's API is rejected remotely)
- 📦 Zero extra process: lives inside `dsh web`

### Install

```powershell
# in the plugin directory (double-click install.bat works too)
powershell -ExecutionPolicy Bypass -File install.ps1
```

The script copies the plugin into `%USERPROFILE%\.dsh\profiles\web\node_modules\` and writes
`cordis.patch.yml` (binds the webserver to `0.0.0.0`, keeps the `/api` fence loopback-only, sets the
plugin password). **Then restart `dsh web`.** Open `http://<PC-IP>:3080/m/` on your phone.

To uninstall: restore `cordis.patch.yml.bak` and delete the copied folder.

### Config

Password lives in `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` →
`mobile-remote.config.password`. Edit and restart `dsh web`.

### Security notes

- Only `/m/*` is protected by the plugin. With `connection.trustedHosts: []`, DSH's `/api` accepts
  loopback only — every remote request must pass the `/m/api/login` password (including WebSocket).
- Use a private tunnel (PgyBox / Tailscale) — belt and suspenders.

### Development

`lib/index.js` handlers can be tested in isolation with `test/harness.mjs` (needs
`@deepseek-ai/cordis` + `@deepseek-ai/schemastery` resolvable, e.g. from the web profile's
`node_modules`).

---

<a name="中文"></a>

## 中文

### 这是什么

一个 **DeepSeek Harness (DSH) 插件**：把"手机远程遥控"做成 `dsh web` 的原生一部分。装好后**不需要再开单独的网关进程**，手机直接访问 `http://<电脑IP>:3080/m/` 即可。

### 功能

- 🔐 密码登录（HttpOnly 签名 Cookie + 登录失败限速）
- 💬 会话列表、聊天、流式回复、思考转圈可打断、任务/待办进度、审批弹窗、提问弹窗
- 🚀 性能优化：gzip 压缩（约 12 倍）+ 历史响应剥离 `assistant/chunk`（载荷再缩约 50 倍）
- 🛡️ 安全：DSH 的 `/api` 信任篱笆保持"仅回环"——远程**只能**通过带密码的 `/m/*` 访问，官方 GUI 的 API 在远程会被拒绝
- 📦 零额外进程：随 `dsh web` 一起启动

### 安装

```powershell
# 在插件目录执行（也可以直接双击 install.bat）
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本会把插件复制到 `%USERPROFILE%\.dsh\profiles\web\node_modules\` 并写入 `cordis.patch.yml`
（webserver 绑定 0.0.0.0、`/api` 篱笆保持仅回环、写入插件密码）。**然后重启 dsh web**，
手机打开 `http://<电脑IP>:3080/m/`。

卸载：恢复 `cordis.patch.yml.bak`，删除复制过去的插件文件夹。

### 配置

密码在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` → `mobile-remote.config.password`，
改完重启 dsh web 生效。

### 安全说明

- 插件只保护 `/m/*`。`connection.trustedHosts: []` 后 DSH 的 `/api` 只信任本机回环——
  远程任何请求（含 WebSocket）都必须先通过 `/m/api/login` 的密码。
- 建议配合蒲公英/Tailscale 等私有组网使用，双保险。

### 开发

`lib/index.js` 的处理器可用 `test/harness.mjs` 隔离测试（需要能解析
`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`，例如放在 web profile 的 `node_modules` 下）。

---

## License

[MIT](LICENSE)
