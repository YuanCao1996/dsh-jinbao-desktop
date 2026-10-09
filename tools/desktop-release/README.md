# 金宝 DSH 游戏扩展
正式 ZIP 自带 Node 和 ADB，只需先安装兼容的 DSH Desktop。当前验证宿主：DSH 0.1.5-rc.2。
1. 关闭 DSH Desktop，双击 install.cmd。安装器备份配置并保留其他模型和插件。
2. 重启 DSH Desktop，双击 settings.cmd。
3. 配对微信账号后选择云端模型，或填写自己的 OpenAI 兼容模型地址、模型 ID 和 API Key。
4. LoL 双击 lol.cmd；王者手机开启 USB 调试并授权电脑后双击 wzry.cmd。
日志目录默认为用户目录/.dsh/jinbao/logs，设置页提供启动诊断。安装包不含完整攻略数据库。
攻略检索与模型权限独立；权限不足时不会用演示数据冒充攻略。
恢复安装前的 cordis.patch.yml.jinbao-*.bak 并重启，可回退配置。
现阶段内置王者、LoL 适配器；任意游戏自动识别尚未实现。
Go 云端采用完整回复后转换 SSE，不是上游逐 token 输出。
源码开发可运行 install.ps1，需要 Node 22+；构建发布包需设置 JINBAO_BUILD_ADB_DIR 为 platform-tools 目录。