# 金宝 DSH 游戏 Agent

读取游戏日志，生成策略建议。当前支持 Windows 上的 LoL 和王者日志流，使用 DSH Desktop 管理 Agent、会话、上下文和工具。

**[服务器直链：Windows 下载包](https://api.jinbaoai.top/downloads/dsh/v0.1.9/jinbao-desktop-windows.zip)** · **[金宝官网：下载统一手机 App](https://www.jinbaoai.top/#download)** · **[GitHub 备用下载及版本说明](https://github.com/YuanCao1996/dsh-jinbao-desktop/releases/tag/v0.1.9)**

完整解压下载包即可使用，不需要安装 Node、Python 或下载攻略数据库。[SHA-256 校验文件](https://api.jinbaoai.top/downloads/dsh/v0.1.9/SHA256SUMS.txt)。请保留解压目录，桌面快捷方式指向其中的启动文件。

## 第一次使用

1. 安装 [DSH Desktop](https://deepseek.com/harness/)。它负责运行 Agent；使用金宝官方服务不需要 DeepSeek 账号或 DeepSeek API Key。
2. 完整解压 Windows ZIP，双击 `开始使用.cmd`。悬浮窗立即出现，启动器检测宿主、安装插件并启动服务，同时创建桌面与开始菜单的“金宝”快捷方式。首次安装或升级如提示关闭已运行的 DSH，请先保存工作并关闭，再重新启动金宝。
3. 新配置默认使用金宝官方服务。当前微信网站扫码尚未开通，设置页保留“一键开通并使用金宝云端”、App 配对和激活码入口。首批十个公网 IP 可试用，每个名额累计 1 亿模型 token；相同公网出口共用名额，换 IP 可能占用新名额。也可在设置中填写自己的 OpenAI 兼容 API 地址、模型和 Key；已有 BYOK 配置会保留。
4. 悬浮窗显示“等待进入游戏”。LoL 采集自动启动；王者需连接一台已授权 USB 调试的 Android 手机，并在统一金宝 App 中开启游戏采集。无需手动选择游戏或启动采集器。

以后双击桌面“金宝”即可启动。关闭悬浮窗会停止本次启动器及其采集进程；DSH Desktop 保留运行，方便继续使用其他功能。

0.1.9 修复与本机既有开发版悬浮窗的冲突：发现同一 Windows 会话中的旧 LoL 悬浮窗时，保留原窗口及 DSH 配置，不启动第二套。若旧窗口稍后才被宿主拉起，下载版会退出自己的窗口及采集器。此兼容处理不会自动迁移旧版的模型配置。

微信网站扫码代码已接入客户端及服务端，但需要审核通过的网站应用和服务器配置后才能开放。当前下载包不会展示可用的微信网站扫码入口。

## 悬浮窗与会话

悬浮窗包含战况、装备、海克斯、对手、胜率、团战、事件和聊天八个页签。标题栏可拖动，设置、收起、关闭和页签可直接点击；`Ctrl+Alt+J` 切换交互与鼠标穿透。收起后点击“金宝”图标展开，也可拖动图标。游戏遮住窗口时可切换无边框或窗口模式。

时间显示对局已进行时长。王者与 LoL 的不同对局使用独立 Agent 会话，宿主重启后通过 DSH 原生持久化恢复上下文。等待游戏时不会主动发送模型请求。缺失的玩家数据显示未知；模型建议不会冒充统计胜率。海克斯选择画面的 OCR 服务尚未包含，可在聊天中输入候选选项。

攻略检索与模型权限独立。自带模型 Key 不会自动获得商业检索权限。商业后端和完整数据库不在下载包或本仓库中；模型 Key 保存在本机 DSH 凭据管理中。

## 下载包包含什么

| 文件 | 用途 |
|---|---|
| `开始使用.cmd` / `start-jinbao.vbs` | 一键启动入口 |
| `高级维护.cmd` | 手动安装、采集和维护菜单 |
| `settings.cmd` | 本机模型、登录和诊断页面 |
| `overlay.cmd` / `stop-overlay.cmd` | 单独打开或关闭悬浮窗 |
| `runtime/` | Node 和 ADB 运行文件 |
| `tools/` | 启动器、模型路由、检索和教练插件 |
| `manifest.json` | 包内文件 SHA-256 清单 |

已验证 DSH Desktop 0.2.0-rc.2，插件 SDK 依赖为 0.1.5-rc.2。安装器保留其他插件和模型配置；共享依赖版本不一致时会停止安装。

验证覆盖 26 项客户端自动测试、真实 DSH 宿主的日志建议与重启上下文恢复，以及中文和空格目录中的完整一键启动、重复启动、等待零请求和退出清理。集成模型使用模拟服务；微信网站扫码和手机完整对局仍需实机验收。任意游戏识别和全部游戏适配尚未实现。

[快速开始与排障](docs/QUICKSTART.md) · [结构与开发](docs/DEVELOPMENT.md) · [一键启动实施记录](docs/ONE_CLICK_START_PLAN.md)

## 开发

Windows + Node 22+：

```powershell
npm ci --ignore-scripts --legacy-peer-deps
npm test
$env:JINBAO_BUILD_ADB_DIR = '你的 Android platform-tools 目录'
npm run build -- workspace/client-releases/local
```

本仓库包含客户端和 App 配对模块的独立源码。许可见 [LICENSE](LICENSE)；运行时第三方许可保留在发布包中。
