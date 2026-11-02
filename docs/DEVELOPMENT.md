# 开发与结构

本文档面向**二次开发**：说明桌面客户端的结构、运行链路、构建与测试方式，以及扩展时应该改哪里。
配套阅读：[`EXTENDING.md`](EXTENDING.md)（扩展点与配方）。

> 本文档只描述桌面客户端。官方云端服务的实现不在本仓库，也不在此说明；客户端与云端之间只通过本机设置服务代理交互（见「运行链路」）。

## 两种运行形态

同一套源码支持两种形态，共享 `tools/` 下的绝大部分模块：

| 形态 | 宿主 | 入口 | 状态目录 |
|---|---|---|---|
| **宿主内插件**（0.1.x） | 需要已安装 DSH Desktop | 包内 `开始使用.cmd` → `tools/jinbao-launcher/main.mjs` | `<用户>/.dsh/jinbao` |
| **独立预览版**（0.2.x） | 不需要 DSH Desktop，自带 `runtime/node.exe` | `jinbao.exe`（`Launcher.cs` 编译）→ `tools/cloud-desktop/entry.mjs` | `<用户>/.jinbao-cloud-preview` |

## 环境要求

- Node.js **>= 22**（`package.json` 的 `engines`）；**打包**时构建器额外要求 **Node 24 >= 24.22.1**（`tools/desktop-release/runtime-policy.mjs`），用发布包自带的 runtime。
- 仅 Windows 支持悬浮窗与游戏采集（WPF + PowerShell）。
- 安装依赖：`npm ci --ignore-scripts --legacy-peer-deps`

## 快速开始

```powershell
npm ci --ignore-scripts --legacy-peer-deps
npm test              # 设置页 / 教练后端 / 启动器
npm run test:generic  # 通用游戏观察与实验插件
npm run test:all      # 两者都跑
```

构建（Windows，需先设置 ADB 目录）：

```powershell
$env:JINBAO_BUILD_ADB_DIR = '<Android platform-tools 目录>'
npm run build -- workspace/client-releases/local
```

独立版另走预构建脚本：`node tools/cloud-desktop/build-preview.mjs <输出目录>`。

## 模块地图（`tools/`）

| 模块 | 职责 |
|---|---|
| `dsh-onboarding` | 本机设置页与设置服务（HTTP）、登录与额度展示、诊断、实时建议、模型路由、新手引导页 |
| `dsh-coach-server` | 日志尾读、LoL/王者适配、原生 Agent 循环、`coach_reply` 回复工具、上下文预算 |
| `lol-companion` | 只读本机游戏接口的轻量采集器（LCU/HUD/OCR、聊天日志解析） |
| `jinbao-launcher` | 一键入口、宿主检测与安装、快捷方式、登录恢复、采集监督与退出清理 |
| `desktop-release` | 安装与运行时打包（`build.mjs`）、独立 WPF 策略悬浮窗脚本 |
| `cloud-desktop` | 独立版核心：`entry.mjs` / `main.mjs` / `Launcher.cs`、云端与本机两种模型路由、语音、更新、诊断 |
| `team-room` | 群聊（队伍房间）客户端：受控上报、页面、本机主机运行器、缓存与用量补传 |
| `game-observation` | 通用游戏窗口观察策略与采集契约（实验） |
| `generic-game-assistant` | 通用游戏助手实验插件，默认关闭，不进入生产启动器 |
| `agent-activity` | 智能体执行过程的采集与流式整理（`activity.mjs`、`openai-stream.mjs`）；界面渲染在 `desktop-release/agent-activity.ps1` |
| `dsh-game-services` | `site_query` / `site_datasets` 的有界客户端，只返回受控结果 |
| `shared` | 跨模块共享常量（如游戏角色表） |

其他目录：`android-pairing/`（App 电脑配对 Activity 源码与集成说明）、`website/`（官网首页源码，不随 Windows 包分发）。

## 运行链路

### A. 宿主内插件

```
开始使用.cmd
  └─ tools/jinbao-launcher/main.mjs      宿主检测、安装、快捷方式
       ├─ tools/dsh-onboarding/plugin.mjs  DSH 宿主内扩展（注册设置工具、起设置服务）
       └─ tools/dsh-coach-server          教练后端
```

### B. 独立预览版

```
jinbao.exe（Launcher.cs 编译，转发 --headless / --team-rooms / --team-byok-host / --state）
  └─ runtime/node.exe tools/cloud-desktop/entry.mjs --collect --coach
       └─ main.mjs
            ├─ 凭据（DPAPI）、游戏内存与窗口观察、外部日志源、语音、诊断、更新
            ├─ dsh-onboarding/server.mjs   设置页服务（nonce 门禁）
            ├─ runtime-router.mjs          cloud-agent（官方）/ local-agent（自有 Key）
            ├─ auto-coach.mjs / supervisor.mjs
            └─ overlay-supervisor.mjs → tools/desktop-release/start-overlay.ps1
                                        → strategy-overlay.ps1（WPF，读 overlay-state.json）
```

关闭是有序链（`createShutdown`），新增常驻资源时必须挂到关闭步骤里，否则进程无法正常退出。

## 两条线必须同步开发（硬性要求）

产品同时以**宿主内插件**（`dsh-coach-server` + `dsh-onboarding` 装进 DSH 的 profile）和**独立预览版**（`tools/cloud-desktop`）交付。**任何改动都必须同时落在两条线上，不允许只改一条。**

### 共享与分叉

| 模块 | 宿主内 | 独立版 | 说明 |
|---|---|---|---|
| `dsh-coach-server/lib/*`（日志解析、记忆、教练计划、上下文预算） | ✅ | ✅ 部分 | 独立版通过 `auto-coach` / `game-memory` / 事件工具间接使用 |
| `dsh-onboarding/overlay-state.mjs`、`progress-events.mjs` | ✅ | ✅ | 悬浮窗投影与事件流，两条线同源 |
| `dsh-onboarding/server.mjs`、`settings.html` | ✅ | ✅ | 设置页与本地服务，同一份代码两种宿主 |
| `cloud-desktop/*` | ❌ 不装 | ✅ | 独立版专属：进程编排、模型路由、语音、更新、诊断 |
| `desktop-release/*.ps1` | 悬浮窗由启动器按包调用 | ✅ | WPF 悬浮窗脚本，两条线共用同一份 |
| `jinbao-launcher`、`game-observation`、`generic-game-assistant` | ❌ | ✅ | 独立版/实验线 |

判据：**改动落在上表前四行时，两条线都要开发、都要测、都要能构建**；落在独立版专属行时，只需保证不破坏宿主内插件的加载。

### 每轮改动的最低同步清单

1. `npm test` + `npm run test:generic` 通过。
2. `node --test tools/cloud-desktop/tests/*.test.mjs` 与 `tools/team-room/tests` 通过（不在 npm 脚本里）。
3. **独立版**：`node tools/cloud-desktop/build-preview.mjs <新目录>` 构建成功，产物逐文件与仓库哈希一致。
4. **宿主内**：把 `tools/dsh-coach-server`、`tools/dsh-onboarding` 同步进 DSH profile（排除 `tests`、`.bak*`），并确认 `dsh-onboarding/plugin.mjs` 与 `dsh-coach-server/lib/index.js` 都能在子进程里 `import()` 成功。
5. 两条线的**行为差异**要写进提交说明：同一功能在两侧的触发时机、上下文窗口、可用工具是否等价。

### 两条线已知差异（改动时要主动对齐）

| 能力 | 宿主内 | 独立版 |
|---|---|---|
| 回合内上下文热更新 | ❌ 回合开始拍一次快照 | ✅ 每 2 s `POST /context` |
| 上下文投影 | `turn-context.js` 含英雄 `tier/winRate` | `cloud-agent.mjs` 的 `player` **不含** `tier/winRate` |
| 自动建议闸门 | 单闸门 | 按主题（advice / equipment）独立计时 |
| 知识库/胜率数据 | 随上下文带 `knowledge` | 只能通过工具检索 |

新增上下文字段时，两条线的投影必须一起改，否则同一场比赛两侧建议质量会不一致。

### 版本与交付

- 独立版版本号必须**严格大于**更新源当前版本，否则启动时会被自动更新换成缓存里的旧包（`update.mjs` 只在 `compareVersions(release, current) > 0` 时应用）。
- 宿主内插件没有独立版本号，按 profile 目录内容同步；**同步后必须重启 DSH 才生效**。

## 端口与状态目录

| 项 | 值 |
|---|---|
| 教练后端 | `127.0.0.1:3081` |
| 设置服务 | `127.0.0.1:3084`（URL 带 nonce，见 `settings-link.txt`） |
| 状态目录 | 宿主内 `<用户>/.dsh/jinbao`；独立版 `<用户>/.jinbao-cloud-preview` |

状态目录里的关键文件：`settings.json`（调用方式）、`overlay-state.json`（悬浮窗投影）、`agent-status.json`（本回合状态与失败原因）、`coach-server.log`、`logs/`（对局日志）、`diagnostics/`（诊断会话）。

## 构建、更新与发布

构建器白名单包括插件、必需库、Node 和 ADB，排除开发数据、日志、密钥及商业后端。下载包通过 `manifest.json` 记录 SHA-256；Release 提供 `SHA256SUMS.txt`。

自动更新独立放在 `update.mjs` / `extract-update.ps1`：校验固定官方来源的 Ed25519 签名和包内完整性，缓存到用户状态目录 `updates`，下一次启动路由到新版本；原始目录不覆盖，用户配置不搬迁。**签名私钥仅在发布服务器，源码中只保留公钥。**

发布 ZIP 后运行：

```powershell
node tools/desktop-release/update-metadata.mjs PACKAGE_DIR ZIP_PATH OUTPUT_JSON
```

生成签名载荷后由发布端签名并原子发布索引。索引禁用缓存，版本 ZIP 保持不可变；**先上传并验证安装包，再发布索引**。更换私钥前须兼容已发布客户端中的固定公钥。

下载包只提供「开始使用」和「高级维护」两个入口，日常启动与采集统一由启动器管理。**仅 `QUICKSTART.md` 作为包内 README 分发，开发文档留在源码仓库。**

## 测试

```powershell
npm test              # dsh-onboarding / dsh-coach-server / jinbao-launcher
npm run test:generic  # game-observation / generic-game-assistant
```

以下两组**不在** npm 脚本里，需要手工执行：

```powershell
node --test tools/cloud-desktop/tests/*.test.mjs
node --test tools/team-room/tests/*.test.mjs
```

约定：

- 每个改动都要有能被 `node --test` 直接跑到的用例；涉及 Windows 原生行为的用例用 `{skip: process.platform !== 'win32'}` 标注。
- PowerShell 脚本的用例通过 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <脚本> -SelfTest` 自测并返回 JSON，Node 侧断言其布尔字段。
- 涉及真实模型、真实对局的用例一律用替身或回放；**不要在测试里连接真实提供者**。

## 代码约定

1. **只读采集**：采集器只读游戏自身接口/日志，不注入、不修改游戏进程。
2. **有界**：注入模型的上下文、工具返回、事件列表都必须有上限（见 `dsh-coach-server/lib/context-budget.js`）。超限要可诊断，不能静默丢失。
3. **失败可见**：模型或采集失败必须让用户在界面上看到原因，不允许伪装成「暂无建议」。
4. **推测与事实分开**：`ownedAugments` 只收已确认项；推测必须标注且不得宣称已拥有。
5. **隐私边界**：原始日志、连续 OCR、截图流、玩家账号、私人聊天不进入模型上下文与群聊上报。
6. **默认关闭**：新增能力走显式开关（如 `--team-rooms`），默认不影响稳定链路。
7. **不落密钥**：密钥只经 DSH 原生 credentials 或 DPAPI 保存，源码与文档中不得出现真实凭据。

## Windows 注意事项

- **PowerShell 脚本必须存为 UTF-8 BOM**。Windows PowerShell 5.1 会把无 BOM 的脚本按 ANSI 读，中文直接变乱码。编辑后请确认首字节是 `EF BB BF`。
- 调用脚本时统一带 `-ExecutionPolicy Bypass`，避免机器策略差异。
- 悬浮窗已验过原生 WPF 渲染、置顶、鼠标穿透、交互切换与热键注册。
- 打包与安装验证在仓库外目录进行，避免覆盖开发树。

## 相关文档

| 文档 | 内容 |
|---|---|
| [`EXTENDING.md`](EXTENDING.md) | 二次开发扩展点与配方 |
| [`QUICKSTART.md`](QUICKSTART.md) | 面向使用者的快速上手 |
| [`STANDALONE_DESKTOP.md`](STANDALONE_DESKTOP.md) | 独立版架构与验收 |
| [`CLOUD_DESKTOP_POC.md`](CLOUD_DESKTOP_POC.md) | 独立版最短链路与构建说明 |
| [`AGENT_ACTIVITY_PREVIEW.md`](AGENT_ACTIVITY_PREVIEW.md) | 智能体执行过程展示 |
| [`GENERIC_GAME_PLAN.md`](GENERIC_GAME_PLAN.md) | 通用游戏接入计划 |
| [`STANDALONE_ACCEPTANCE.md`](STANDALONE_ACCEPTANCE.md) | 独立版验收记录 |
| [`COMPLIANCE.md`](COMPLIANCE.md) | 合规与边界说明 |
| [`../tools/team-room/README.md`](../tools/team-room/README.md) | 群聊客户端预览说明 |
