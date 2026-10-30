# 通用游戏助手：桌面实验基础

> 产品入口已在独立桌面版接入：`tools/cloud-desktop/observation.mjs`。设置页可选择窗口，复用DSH看图、调整观察计划和联网检索；r23新增身份回写、保守分局与手动修正。下文“默认关闭、未注册”描述本目录的历史独立实验宿主，不代表当前独立桌面的通用观察入口缺失。

默认关闭且尚未注册到正式产品。不会随金宝一键启动运行，也不进入原下载包。
包含窗口观察协议、资源策略、五子棋结构状态、解释控制器和合成回放。
第二批已新增真实 Windows 单次窗口截图与有限棋盘像素识别。
第三批已新增受限DSH插件、四项工具与本地自适应调度，但尚未安装到正式宿主。
第四批新增独立实验宿主与控制页，真实AgentLoop和本机HTTP模型协议已验证。
第五批已完成金宝通用接口回归；第六批按最新要求改走服务器 OpenCode Go 路由。
第七批已解除核心的五子棋绑定，默认使用通用观察协议；五子棋为可选识别能力。
第八批新增显式授权的云端画面读取工具。尚无本地文字OCR或棋力引擎，不应当作可用的落子助手。

```powershell
npm.cmd run test:all
node tools/generic-game-assistant/replay.mjs tools/generic-game-assistant/tests/fixtures/phase1.json workspace/generic-game/phase1-report.json
```

回放必须显式指定输出文件，默认不写日志和现有 LoL 状态目录。回放报告标注：
`synthetic_structured_replay`、`image_ocr_executed=false`、`cloud_model_called=false`。

开发计划与阶段验收边界见 `docs/GENERIC_GAME_PLAN.md`。

单次实际窗口观察（目标必须保持前台，失败不抓整桌面）：

```powershell
node tools/generic-game-assistant/observe-window.mjs --list
node tools/generic-game-assistant/observe-window.mjs --target <完整窗口ID> --authorize
```

真实受控窗口测试（会短暂打开并关闭测试窗口，应先获得允许）：

```powershell
node tools/game-observation/tests/native-smoke.mjs --allow-test-window
```

结果保存于工程 `workspace/generic-game/`，不会写入LoL目录。
第二批方法、限制与实测结果见 `docs/GENERIC_GAME_PHASE2_REPORT.md`。

第三批工具权限、资源限额与SDK混载防护见 `docs/GENERIC_GAME_PHASE3_REPORT.md`。
不要为实验模块重装当前LoL的SDK依赖；使用单独实验配置进行下一批联调。

## 独立实验控制页

```powershell
node tools/generic-game-assistant/experiment/launch.mjs
```

打开启动输出中的带授权片段的本机URL，默认端口3094。Ctrl+C只停止实验宿主。
首次准备会复制本机完整SDK所需依赖到独立目录，约20～30秒，无网络安装。
不修改现有DSH依赖、用户配置、模型凭据或LoL启动器。

选择窗口并授权后才允许观察；自动观察需额外勾选。没有配置模型时可观察，提问明确失败，不生成假回复。
默认“通用观察”不猜画面内容，视觉阅读器未连接时明确为`unread`；它不等于已读懂游戏。
选择“五子棋棋盘识别”才启用本地棋盘解析。共同协议、跨画面回归和未完成边界见`docs/GENERIC_GAME_PHASE7_REPORT.md`。
目标必须保持前台；系统桌面窗口不允许作为目标。LoL游戏进程存在时拒绝实验观察。
改变窗口大小、隐藏或最小化会使观察不可用，须重新选择和授权；不能回退抓整个桌面。

无独立模型配置时，使用金宝 `/v1/chat/completions`，客户端模型别名 `game-fast`。
服务器将该别名映射到 OpenCode Go 的 `deepseek-v4.1-flash`，上游 API Key 只留在服务器。
普通桌面登录令牌可通过`GENERIC_JINBAO_SESSION_TOKEN`或原生凭据引用`JINBAO_SERVICE_TOKEN`提供。
开发联调可设置`GENERIC_JINBAO_SESSION_FILE`为受限本机 JSON 文件路径，字段为`sessionToken`和毫秒时间戳`expiresAt`。
每次请求重新读取并检查有效期。缺少凭据时关闭模型，不回退Qwen或管理员令牌。
创建开发会话需要单独授权；实验不会自动注册账号、申请额度或改写现有认证文件。
`GENERIC_MODEL_MODE=off`可关闭复用；也可用启动环境配置独立模型：`GENERIC_MODEL_BASE_URL`、`GENERIC_MODEL_NAME`、`GENERIC_MODEL_API_KEY`。
Key不进入页面、日志或会话文件。支持HTTPS的OpenAI兼容端点；HTTP仅限127.0.0.1的本机路由。
每次问答最多12步、8次工具、2次追加观察、55秒；最终回复最多256字。
默认只在本机观察，不上传截图。通用模式额外勾选“允许云端读图”后，Agent可调用`generic_read_screen`，上传单张不超过32KB的PNG；随时撤销权限会取消在途读取。工具进度只显示动作及完成状态，不显示思考过程。
实验会话和事件在`workspace/generic-game/experiment-*/state/`，详见第四批报告。
第五批报告保留历史Qwen验证结果，不代表当前Go路由已经完成真实云端验证。
当前路由、真实验证结果及额度限制见`docs/GENERIC_GAME_PHASE6_REPORT.md`。
新增读图工具、服务部署与尚未通过的真实端到端测试见`docs/GENERIC_GAME_PHASE8_REPORT.md`。本地122项回归通过不代表真实游戏画面已全部验证。
