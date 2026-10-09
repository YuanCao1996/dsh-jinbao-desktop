# App 配对模块
这里公开本次新增的 DesktopLoginActivity.java，便于独立维护电脑配对。
电脑配对已纳入现有金宝 App 工程，通过[金宝官网](https://www.jinbaoai.top/#download)统一发布。此目录仅供源码参考，不是独立 Android 工程，不构建或分发专用 APK。

集成到现有 com.example.jinbao App：
1. 将类放在 desktoplogin 包下。
2. Manifest 注册 .desktoplogin.DesktopLoginActivity，exported=false。
3. 在“我”页面添加“连接电脑”按钮，通过 Intent 启动 Activity。
4. 复用现有 GameStateManager.getWxSessionToken()；未登录时引导用户回到原微信登录入口。

Activity 只连接固定 HTTPS 服务，禁止跳转；先 inspect 展示电脑名称，用户明确确认后再 approve。不把手机令牌导出到电脑。
