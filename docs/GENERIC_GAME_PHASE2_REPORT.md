# 桌面通用助手第二批：窗口采集与棋盘像素识别

日期：2026年10月12日。

## 新增能力

- `game-observation/windows.mjs`：独立、默认关闭的 Windows 观察器。
- `windows/WindowCapture.cs` 与 `worker.ps1`：按窗口句柄、PID、进程创建时间绑定身份。
- 仅用查询权限获取进程身份，不读取游戏内存、不调用 LCU、不注入游戏。
- 截图限定为目标窗口客户区的 PrintWindow 渲染，不使用整桌面抓屏或失败后的整屏回退。
- 前台、最小化、窗口尺寸与采集前后身份均校验；前台不可访问时明确拒绝。
- 针对工作线程设置 Per-Monitor V2 DPI 上下文。实际多显示器/不同DPI还需后续实测。
- 返回真实 PNG、RGB、图片 SHA256、采集时间、窗口内裁剪坐标和输出尺寸。
- 选择/清除目标后丢弃上一目标迟到的采集结果；同时最多一个截图请求，工作进程10秒超时。
- 原生枚举明确排除 LoL/Riot 客户端和金宝窗口；截图不会启动 LoL、OCR或云端模型。
- 五子棋像素识别定位15/19条等距棋盘线，读取黑子、白子、空格；模糊/半落子/不支持配色保留未知。
- 不靠棋子数量猜先后手，不猜玩家执子、规则、禁手、胜负或最佳落点。

## 手动单次观察

```powershell
node tools/generic-game-assistant/observe-window.mjs --list
node tools/generic-game-assistant/observe-window.mjs --target <窗口清单中的完整ID> --authorize
```

清单仅用于用户选定目标，不截图。授权观察只抓该窗口；需保持窗口为前台且未最小化。
截图、完整识别结果、尺寸、时间与耗时保存在工程的 `workspace/generic-game/observation-*`，
不会进入 LoL 日志、共享悬浮窗状态或版本库。没有模型调用。

## 真实窗口验收

经用户明确批准，打开独立 WinForms 棋盘测试窗及一个洋红色遮挡窗；测试完成后关闭。
未读取其他应用画面。此为真实 Windows 采集，但不是用户真实游戏对局。

验收命令：

```powershell
node tools/game-observation/tests/native-smoke.mjs --allow-test-window
```

受限执行环境中 Windows 前台句柄不可访问，测试正确拒绝。未放松前台条件；
在已授权桌面环境重试成功。之前失败报告保留，以便排查环境差异。

已通过的报告：`workspace/generic-game/native-2026-10-12T15-43-45-568Z/report.json`。

| 场景 | 正确格子 | 截图耗时（含一次性PowerShell初始化） | 像素识别 | PNG大小 |
|---|---:|---:|---:|---:|
| 完整客户区 | 225/225 | 457ms | 15ms | 12260字节 |
| 局部裁剪 | 225/225 | 434ms | 11ms | 11936字节 |

这是一组受控窗口结果，不代表真实游戏准确率或P95延迟。裁剪范围差异较小，不据此宣称成本节省比例。
PrintWindow由目标程序渲染客户区，因此测试遮挡窗未被读入。DirectX/浏览器GPU窗口可能不支持或返回黑图；
目前拒绝空图/未渲染图，不声称已支持所有PC游戏。方法依据微软PrintWindow文档：
https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow

移除临时诊断入口后再次复测通过，报告为：
`workspace/generic-game/native-2026-10-12T15-47-11-114Z/report.json`。
完整/局部截图分别451ms/423ms，像素识别16ms/7ms，两帧均225/225格子正确。
已人工查看保存的完整PNG，确认棋盘和棋子完整，无测试遮挡窗内容。

`npm.cmd run test:all`：原有24项测试与实验模块42项测试全部通过。
`git diff`确认LoL采集器、教练服务、设置、启动器及发布构建目录均未改动。

## 尚未完成与边界

- 尚未接入DSH工具、正式设置或悬浮窗；仍是独立手动入口，默认无运行活动。
- 棋盘识别仅支持清晰、平面、近正方网格；未完成真实棋牌皮肤与复杂遮挡数据集验证。
- 没有通用文字OCR与云端视觉补偿，不将像素格子识别测试称作OCR测试。
- 现阶段截图通过短生命周期后台工作进程执行，实测约0.4～0.5秒开销；高频模式需后续评估常驻工作进程。
- 未自动监听窗口变化；持续调度、识别冲突复核和游戏引擎属于后续批次。
- 未改动LoL采集、教练提示词、模型路由、发布白名单、APP或线上服务器。
