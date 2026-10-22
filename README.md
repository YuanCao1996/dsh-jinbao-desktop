# 金宝游戏教练

读取游戏日志，提供策略建议。当前支持 Windows 上的 LoL，以及通过 Android 手机采集的王者荣耀；Agent、会话和上下文由 DSH Desktop 管理。

[Windows 下载](https://github.com/YuanCao1996/dsh-jinbao-desktop/releases/latest/download/jinbao-desktop-windows.zip) · [手机 App 官网](https://www.jinbaoai.top/#download) · [GitHub 发布记录](https://github.com/YuanCao1996/dsh-jinbao-desktop/releases)

## 开始使用

1. 安装 [DSH Desktop](https://deepseek.com/harness/)，完整解压金宝 ZIP。
2. 双击 `开始使用.cmd`。首次安装或升级如提示关闭 DSH，请先保存工作并关闭，再启动金宝。
3. 默认使用金宝官方服务。启动时打开设置网页，使用邮箱登录后等待进入游戏；也可改用自己的模型 API Key。

官方服务的登录状态、剩余额度和更新进度在设置网页查看；模型 API Key 可在设置中自行配置。电脑默认不启动 ADB；手机采集是可选功能。

以后双击桌面“金宝”即可。LoL 和手机采集自动检测，无需另开游戏脚本。手机查看电脑对局使用配对码，与电脑邮箱和手机微信账号是否一致无关。标题栏可拖动，右下角手柄调整大小；× 退出，收起后点击图标展开。维护入口位于设置网页。

悬浮窗包含战况、装备、海克斯、胜率、事件、聊天。支持背景透明度保存、滚动位置保留及按近期胜率排序的匿名对手表格。从 0.1.10 起支持自动检查、后台下载更新，下次启动自动切换；设置和登录状态保留。0.1.9 及更早版本需先手动下载一次新版。

[使用与排障](docs/QUICKSTART.md) · [开发与结构](docs/DEVELOPMENT.md) · [SHA-256 校验](https://github.com/YuanCao1996/dsh-jinbao-desktop/releases/latest/download/SHA256SUMS.txt)

## 开发

Windows、Node 24 LTS（构建最低 24.22.1）：

```powershell
npm ci --ignore-scripts --legacy-peer-deps
npm test
$env:JINBAO_BUILD_ADB_DIR = '你的 Android platform-tools 目录'
npm run build -- workspace/client-releases/local
```

商业检索服务与完整数据库不公开；自带模型 Key 与检索权限独立。许可见 [LICENSE](LICENSE)，第三方运行时许可随包保留。

安全报告见 [SECURITY.md](SECURITY.md)；第三方服务授权与运营待办见 [合规边界](docs/COMPLIANCE.md)。
