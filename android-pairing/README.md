# App 配对模块
这里公开本次新增的 DesktopLoginActivity.java，便于独立维护电脑配对。
完整手机 App 安装包在 Release 下载。此目录不是完整 Android 工程。

集成到现有 com.example.jinbao App：
1. 将类放在 desktoplogin 包下。
2. Manifest 注册 .desktoplogin.DesktopLoginActivity，exported=false。
3. 在“我”页面添加“连接电脑”按钮，通过 Intent 启动 Activity。
4. 复用现有 GameStateManager.getWxSessionToken()；未登录时引导用户回到原微信登录入口。

Activity 只连接固定 HTTPS 服务，禁止跳转；先 inspect 展示电脑名称，用户明确确认后再 approve。不把手机令牌导出到电脑。
