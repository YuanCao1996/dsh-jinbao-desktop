# 桌面通用助手第一批验收记录

日期：2026年10月12日。

## 改动范围

新增 `tools/game-observation`、`tools/generic-game-assistant` 及独立测试与文档。
原 `package.json` 仅新增 `test:generic` 和 `test:all`；原 `test`、`build`、依赖和版本保持不变。

通过 Git diff 确认下列目录没有代码改动：

- `tools/lol-companion`
- `tools/dsh-coach-server`
- `tools/jinbao-launcher`
- `tools/dsh-onboarding`
- `tools/desktop-release`

未修改 DSH 宿主配置、未注册新插件、未改发布白名单、未构建或发布新下载包。
未修改 APP、服务端、LoL 模型参数、提示词或采集频率。

## 执行结果

| 验证 | 结果 |
|---|---|
| 修改前 `npm.cmd test` | 24项通过 |
| 修改后 `npm.cmd run test:all`：原有测试 | 24项通过 |
| 修改后 `npm.cmd run test:all`：新增测试 | 28项通过 |
| 合成结构化回放 | 19个场景通过，0失败 |
| 回放模拟分析调用 | 2次，无真实模型流量 |
| `git diff --check` | 无空白错误；仅有现有 Git LF/CRLF 提示 |

回放命令：

```powershell
node tools/generic-game-assistant/replay.mjs tools/generic-game-assistant/tests/fixtures/phase1.json workspace/generic-game/phase1-report.json
```

详细报告：`workspace/generic-game/phase1-report.json`，测试产物不进入版本库。

## 已验证边界

默认关闭零活动；授权窗口与 ROI 边界；五种窗口比例；小图不放大；助手区域排除标记；
未知格子/规则不猜测；状态刷新与局面修订；跨窗口和跨局隔离；单请求并发；
超时、取消及迟到回复丢弃；频率、预算与局面去重；日志故障不影响主流程。

## 尚未验证

这些测试验证协议和控制流，不验证真实像素识别准确率、DSH真实宿主集成或棋步质量。
未执行实际 LoL 对局，因此不能仅凭单测断言所有运行时风险为零。
真实截图排除助手窗口、OCR与棋盘定位、DSH工具注册、棋力引擎、UI和性能实测均为后续批次。
当前真实产品启动路径未引用新增代码，是本批保护海克斯大乱斗的主要隔离措施。
