# 开发与结构
tools/dsh-onboarding：本机设置、独立激活码登录、可选电脑配对、诊断、实时建议、模型路由。
tools/dsh-game-services：site_datasets/site_query，商业服务只返回有界的 rows 数组。
tools/dsh-coach-server：日志尾读、王者/LoL 适配、原生 Agent 循环和回复工具。
tools/lol-companion：只读本机游戏接口的轻量采集器。
tools/desktop-release：安装与运行时打包。
android-pairing：App 电脑配对 Activity 的独立源码及集成说明。

npm ci --ignore-scripts --legacy-peer-deps
npm test

Windows 构建时设置 JINBAO_BUILD_ADB_DIR 为已安装的 Android platform-tools 目录，然后 npm run build -- workspace/client-releases/local。
构建器白名单包括插件、必需库、Node 和 ADB，排除开发数据、日志、密钥及商业后端。下载包通过 manifest.json 记录 SHA-256；Release 提供 SHA256SUMS.txt。
云端服务复用 App 的 OpenCode Go。所有 API Key 留在各自凭据边界，客户端服务凭据由 DSH 原生 credentials 管理。

Windows ZIP 已做仓库外安装与依赖导入验证；设置与日志测试覆盖密钥不回显、新文件首事件、UTF-8 半行、截断及暂停恢复。
原生 DSH 宿主已验证快路径、Agent coach_reply、SSE，以及日志进入 Agent 后生成建议；集成模型使用本地模拟服务。
