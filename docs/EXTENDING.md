# 二次开发扩展指南

本文档给出**常见改动应该落在哪个文件**，以及容易被忽略的约束。结构与环境要求见 [`DEVELOPMENT.md`](DEVELOPMENT.md)。

> 所有路径相对仓库根目录。新增能力请附带 `node --test` 可跑的用例。

## 1. 给悬浮窗加一个页面

悬浮窗只做渲染，数据全部来自 state 投影。

1. `tools/dsh-onboarding/overlay-state.mjs` 的 `overlayView(state)` 返回对象里加字段（字符串或结构化数组）。
2. `tools/desktop-release/strategy-overlay.ps1`：
   - 页签表：`foreach($entry in @(@('advice','战况'),@('equipment','装备'),...))`
   - 渲染：`$script:snapshot.<字段>` 绑定到 `PageText`，或像 `PlayersTable` 那样用独立控件
3. 测试：在 `tools/dsh-onboarding/tests/` 里断言 `overlayView(state).<字段>` 的内容与边界（空数据、超长、换局清空）。

注意：

- 页签顺序、快捷键、`$script:testResult.*` 自测项都要同步更新，否则 `overlay-ui` 用例会失败。
- 悬浮窗脚本必须保持 **UTF-8 BOM**。
- 页面内容要有界。正文过长会让用户放弃阅读，也会撑大后续注入。

## 2. 加一个游戏适配

1. 在 `tools/dsh-coach-server/lib/adapters/` 下新增适配器（参考 `wzry.js`）：导出人格、事实投影、事件解析、回复长度等契约。
2. 在 `lib/game-registry.js` 注册，并在 `lib/game-mode-prompt.js` 补充模式提示。
3. 若该游戏有多种模式，把模式差异集中在适配器内，不要散落到 `buildCoachMessage`。
4. 采集侧：日志/画面来源接 `tools/cloud-desktop/log-source.mjs` 或 `tools/game-observation/`，**不要**在适配器里直接读文件。

未适配的游戏保持「待确认」状态，不要用其他模式的数据顶替。

## 3. 调整注入给模型的内容

模型输入必须**有界**，这是硬约束：

- 单条上下文用 `tools/dsh-coach-server/lib/context-budget.js` 的 `boundJsonStringify()`，不要直接 `JSON.stringify`。
- 适配器自己拼的整段 prompt 用 `boundPrompt()` 兜底，并在裁剪时打日志。
- 聊天路径：`lib/chat-bridge.js` 的 `buildGameChatMessage()`。
- 播报路径：`lib/index.js` 的 `buildCoachMessage()`。

新增字段时想清楚：它是**事实**还是**推测**？推测必须显式标注（参考 `assumedAugments` 与 `countdown-default-confirmed` 的处理）。

## 4. 加一个设置项

1. `tools/dsh-onboarding/settings.html`：加控件（沿用现有 `class` 与 `el(id)` 习惯）。
2. `tools/dsh-onboarding/server.mjs`：加 `POST /api/<name>` 路由；**所有 `/api/*` 都要过 setup nonce**（请求头 `x-jinbao-setup`），并校验 `Origin` 与字段类型。
3. 持久化：设置类写 `settings.json`（`saveConfig()`）；状态类写到 `stateDir` 下独立文件，权限 `0o600`。
4. 需要回显的字段加进 `/api/status` 的返回体。
5. 测试：参考 `tests/model-budget.test.mjs` 的写法——用 `createSetupServer({port:0, credentials:{...}})` 起临时实例，断言状态码、返回体与**错误信息不泄漏内部细节**。

## 5. 加一个设置页子页面

参考新手引导页（`welcome.html` + `welcome/` 资源）与探索页（`exploration.html`）：

```js
// server.mjs
if(req.method==='GET'&&req.url==='/your-page'){
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
  res.end(await readFile(new URL('./your-page.html',import.meta.url)));return;
}
```

要点：

- CSP 默认 `default-src 'none'`，需要什么显式放开；图片放 `img-src 'self'`。
- 静态资源路由**必须用文件名白名单**，不能把请求路径直接拼进 `readFile`。
- 页面要拿到 nonce 才能调用 `/api/*`：设置页把 `location.hash` 里的 nonce 传给子页面（`'/welcome#'+nonce`）。
- 在 `settings.html` 里加入口时，可参考现有动态生成链接的写法（`document.querySelector('main')?.prepend(link)`）。

## 6. 群聊（队伍房间）客户端

只改客户端；群聊服务端不在本仓库。

- 上报走白名单投影：`tools/team-room/publisher.mjs`，不传原始日志、截图或玩家账号。
- 默认关闭，加 `--team-rooms` 才启用；群聊全程无语音，界面只显示最终回答。
- 其余客户端模块见 `tools/team-room/README.md`。

## 7. 新增诊断事件

`tools/cloud-desktop/diagnostics.mjs` 只接受白名单字段：

- 字符串字段要加进 `strings` 映射（未知值会降级为 `'other'`）。
- 数值字段要加进 `numbers` 集合，否则会被丢弃。
- 布尔字段加进 `booleans`。

**不要**把聊天正文、昵称、查询词、凭据或路径写进诊断。诊断是给排障用的，不是日志转储。

## 8. 调整智能体过程展示

`tools/desktop-release/agent-activity.ps1`：

- 面板只在大框「战况」页显示，单行随进度替换；行文本为 `时间 + 主题 · 步骤 · 状态 · 耗时`。
- 保留条数、是否折行、是否渲染正文都由该文件决定；改完同步更新 `Test-AgentActivitySurface` 里的断言。
- 菜单文案在同一个文件顶部。

## 测试配方

**页面/接口**（Node）：

```js
const server = await createSetupServer({ port: 0, stateDir, credentials: { resolve: async () => undefined, set: async () => {} } });
t.after(server.close);
const origin = new URL(server.url).origin, nonce = new URL(server.url).hash.slice(1);
```

**PowerShell 原生行为**：脚本提供 `-SelfTest` 返回 JSON，Node 侧用 `execFileSync` 调 `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File <脚本> -SelfTest` 并断言布尔字段。

**纯投影**：直接 `overlayView(initialOverlayState() + applyOverlayEvent(...))`，不启服务。

## 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 脚本中文变乱码 / 解析报错 | 编辑后丢了 UTF-8 BOM | 确认首字节 `EF BB BF` |
| `-File` 执行被拒 | 执行策略 | 调用时加 `-ExecutionPolicy Bypass` |
| 模型回合以 `max-tokens` 结束、无回答 | 注入内容过大，超出模型窗口 | 用 `context-budget.js` 收敛，别调大上限掩盖 |
| 界面显示「等待建议」但其实失败了 | 失败被当成空闲 | 从 `agent-status.json` 的 `phase==='error'` 透出失败文案 |
| 新诊断字段不出现 | 未加入 `diagnostics.mjs` 白名单 | 按类型加入 `strings`/`numbers`/`booleans` |
| 进程退出卡住 | 新增常驻资源未挂到关闭链 | 加入 `createShutdown` 的步骤 |

## 提交前检查

0. **两条线同步**：本次改动是否同时落在宿主内插件与独立版？见 [`DEVELOPMENT.md`](DEVELOPMENT.md#两条线必须同步开发硬性要求) 的同步清单与已知差异表。只改一条线视为未完成。
1. `npm test` 与相关 `node --test` 全绿。
2. 没有真实密钥、令牌、账号、内网地址进入代码或文档。
3. 不提交 `.bak-*`、诊断输出、日志、临时目录。
4. 新增默认开启的能力要有开关，并说明对稳定链路的影响。
