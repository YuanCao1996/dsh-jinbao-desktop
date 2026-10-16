# 开发与结构
tools/dsh-onboarding：本机设置、独立激活码登录、可选电脑配对、诊断、实时建议、模型路由。
tools/dsh-game-services：site_datasets/site_query，商业服务只返回有界的 rows 数组。
tools/dsh-coach-server：日志尾读、王者/LoL 适配、原生 Agent 循环和回复工具。
tools/lol-companion：只读本机游戏接口的轻量采集器。
tools/jinbao-launcher：一键入口、宿主检测、快捷方式、登录恢复、游戏采集监督与退出清理。
自动更新独立放在 update.mjs / extract-update.ps1：校验固定官方来源的 Ed25519 签名和包内完整性，缓存到用户状态目录 updates，下一次启动路由到新版本；原始目录不覆盖，用户配置不搬迁。签名私钥仅在发布服务器，源码中只保留公钥。
tools/desktop-release：安装与运行时打包，独立 WPF 策略悬浮窗。窗口读取用户状态目录的 overlay-state.json，不依赖旧 LoL companion 或完整攻略库。
android-pairing：App 电脑配对 Activity 的独立源码及集成说明。
website/index.html：官网首页源码，部署到现有站点目录，沿用该站点的 assets、统一 APK 和条款页面；不随 Windows 包分发。

npm ci --ignore-scripts --legacy-peer-deps
npm test

Windows 构建时设置 JINBAO_BUILD_ADB_DIR 为已安装的 Android platform-tools 目录，然后 npm run build -- workspace/client-releases/local。
构建器白名单包括插件、必需库、Node 和 ADB，排除开发数据、日志、密钥及商业后端。下载包通过 manifest.json 记录 SHA-256；Release 提供 SHA256SUMS.txt。
发布 ZIP 后运行 `node tools/desktop-release/update-metadata.mjs PACKAGE_DIR ZIP_PATH OUTPUT_JSON` 生成签名载荷。服务器对载荷原始 UTF-8 字节做 Ed25519 签名，将载荷和签名分别 base64 编码为 `{payload,signature}`，原子发布到 `/downloads/dsh/latest.json`。索引禁用缓存，版本 ZIP 保持不可变；先上传并验证安装包，再发布索引。更换私钥前须兼容已发布客户端中的固定公钥。
下载包只提供“开始使用”和“高级维护”两个操作入口，不再生成独立安装、设置、窗口、LoL 和王者脚本。日常启动和采集统一由启动器管理，维护菜单复用同一启动器。仅将 QUICKSTART 作为包内 README 分发，开发文档留在源码仓库。
云端服务复用 App 的 OpenCode Go。所有 API Key 留在各自凭据边界，客户端服务凭据由 DSH 原生 credentials 管理。

Windows ZIP 已做仓库外安装与依赖导入验证；设置与日志测试覆盖密钥不回显、新文件首事件、UTF-8 半行、截断及暂停恢复。
悬浮窗已验证原生 WPF 渲染、置顶、鼠标穿透和交互切换、热键注册；PowerShell 文件使用 UTF-8 BOM，兼容 Windows PowerShell 5.1。
原生 DSH 宿主已验证快路径、Agent coach_reply、SSE，以及日志进入 Agent 后生成建议；集成模型使用本地模拟服务。
