# 金宝游戏教练

读取游戏日志，提供策略建议。当前支持 Windows 上的 LoL，以及通过 Android 手机采集的王者荣耀；Agent、会话和上下文由 DSH Desktop 管理。

[Windows 下载](https://api.jinbaoai.top/downloads/dsh/v0.1.11/jinbao-desktop-windows.zip) · [手机 App 官网](https://www.jinbaoai.top/#download) · [GitHub 发布记录](https://github.com/YuanCao1996/dsh-jinbao-desktop/releases)

## 开始使用

1. 安装 [DSH Desktop](https://deepseek.com/harness/)，完整解压金宝 ZIP。
2. 双击 `开始使用.cmd`。首次安装或升级如提示关闭 DSH，请先保存工作并关闭，再启动金宝。
3. 默认使用金宝官方服务。在悬浮窗“设置”中开通 IP 体验，随后等待进入游戏；也可改用自己的模型 API Key。

首批 30 个公网 IP 各有累计 1 亿模型 token，同一公网出口共用名额。使用官方服务无需 DeepSeek 账号、API Key 或激活码。王者需要手机授权 USB 调试，并在统一金宝 App 开启采集。

以后双击桌面“金宝”即可。LoL 和手机采集自动检测，无需另开游戏脚本。标题栏可拖动，右下角手柄调整大小；× 退出，收起后点击图标展开。异常时打开 `高级维护.cmd`。

悬浮窗包含战况、装备、海克斯、对手、胜率、团战、事件、聊天。支持背景透明度保存、滚动位置保留及按近期胜率排序的匿名对手表格。从 0.1.10 起支持自动检查、后台下载更新，下次启动自动切换；设置和登录状态保留。0.1.9 及更早版本需先手动下载一次新版。

[使用与排障](docs/QUICKSTART.md) · [开发与结构](docs/DEVELOPMENT.md) · [SHA-256 校验](https://api.jinbaoai.top/downloads/dsh/v0.1.11/SHA256SUMS.txt)

## 开发

Windows、Node 22+：

```powershell
npm ci --ignore-scripts --legacy-peer-deps
npm test
$env:JINBAO_BUILD_ADB_DIR = '你的 Android platform-tools 目录'
npm run build -- workspace/client-releases/local
```

商业检索服务与完整数据库不公开；自带模型 Key 与检索权限独立。许可见 [LICENSE](LICENSE)，第三方运行时许可随包保留。
