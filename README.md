# 金宝 DSH 游戏 Agent

读取游戏日志，生成策略建议。当前支持 Windows 上的 LoL 和王者日志流。

**[服务器直链：Windows 安装包](https://api.jinbaoai.top/downloads/dsh/v0.1.1/jinbao-desktop-windows.zip)** · **[服务器直链：可选手机 App](https://api.jinbaoai.top/downloads/dsh/v0.1.1/jinbao-app-desktop-pairing.apk)** · **[GitHub 备用下载及版本说明](https://github.com/YuanCao1996/dsh-jinbao-desktop/releases/tag/v0.1.1)**

GitHub 下载缓慢时优先使用服务器直链，支持断点续传。两处发布文件完全一致；[SHA-256 校验文件](https://api.jinbaoai.top/downloads/dsh/v0.1.1/SHA256SUMS.txt)。

普通用户下载上面的安装包即可，不需要克隆源码，也不需要安装 Node、Python 或下载攻略数据库。

## 第一次使用

1. 安装并运行过一次 [DSH Desktop](https://deepseek.com/harness/)，然后关闭它。
2. 下载 `jinbao-desktop-windows.zip`，解压到自己的文件夹；双击 `开始使用.cmd`，选择“安装扩展”。
3. 重启 DSH Desktop；再次打开 `开始使用.cmd`，选择“打开设置”。
4. 在设置页选择模型方式并保存：
   - **自带 API Key**：填写 OpenAI 兼容 API 地址、模型 ID 和 Key。模型调用无需微信登录。
   - **金宝云端**：在电脑设置页输入管理员提供的激活码，登录后选择云端模型，无需安装金宝 App。已有 App 账号也可使用配对码登录。账号需要开通云端额度。
5. 选择游戏采集：
   - **LoL**：打开英雄联盟客户端，选择“启动 LoL 采集”。
   - **王者**：手机通过 USB 连接，开启 USB 调试并授权电脑；在金宝 App 中开启游戏采集，再选择“启动王者采集”。
6. 设置页点击“刷新检测”，确认教练服务正常、日志持续更新。保持设置页打开即可查看实时策略。

已验证宿主：DSH 0.1.5-rc.2。其他版本尚未完成兼容测试。安装器保留其他插件与模型配置；共享依赖版本不一致时会停止安装。

## 安装包包含什么

| 文件 | 用途 |
|---|---|
| `开始使用.cmd` | 统一安装、设置、采集入口 |
| `install.cmd` | 安装扩展到当前用户的 DSH 配置 |
| `settings.cmd` | 打开本机模型、登录和诊断页面 |
| `lol.cmd` / `wzry.cmd` | 启动日志采集 |
| `runtime/` | Node 和 ADB 运行文件 |
| `tools/` | 设置、模型路由、检索和游戏教练插件 |
| `manifest.json` | 每个文件的 SHA-256 清单 |
| `jinbao-app-desktop-pairing.apk` | 在 Release 单独下载，安装在手机 |

激活码是单次使用的账号凭据，24 小时内兑换；电脑会话最长 7 天。退出或丢失会话后需要管理员重新发码。独立电脑账号不按昵称自动合并微信账号，微信网站扫码登录尚未接入。

攻略检索与模型权限独立。自带模型 Key 不会自动获得商业检索权限；新账号的云端模型和检索需要开通。BYOK 请求从电脑直接发往用户配置的模型厂商，密钥由本机 DSH 凭据管理保存。

## 当前范围

- 王者和 LoL 日志流分析、策略建议、Agent 工具调用、SSE 输出。
- 独立电脑激活码登录、可选 App 配对、会话退出、两种模型方案、首次启动诊断。
- LoL 轻量采集读取 LCU/Live API；此下载包不包含海克斯画面 OCR 服务、旧悬浮窗或全部旧 companion 功能。
- 任意游戏自动识别和所有游戏适配尚未实现。Go 云端延续 App 的完整回复后转换 SSE。
- 独立电脑登录已做线上验证；可选的手机微信确认与对局日志质量需要实机验证。

[快速开始与排障](docs/QUICKSTART.md) · [结构与开发](docs/DEVELOPMENT.md)

## 开发

Windows + Node 22+：

```powershell
npm ci --ignore-scripts --legacy-peer-deps
npm test
$env:JINBAO_BUILD_ADB_DIR = '你的 Android platform-tools 目录'
npm run build -- workspace/client-releases/local
```

本仓库包含客户端源代码与 App 配对模块的独立源码。商业检索后端和完整数据不进入本仓库。许可见 [LICENSE](LICENSE)；运行时第三方许可保留在发布包中。
