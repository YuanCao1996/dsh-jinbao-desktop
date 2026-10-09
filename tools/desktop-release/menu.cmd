@echo off
chcp 65001 >nul
echo 金宝 DSH 游戏扩展
echo.
echo 1. 安装扩展（先关闭 DSH Desktop）
echo 2. 打开设置和实时策略（先启动 DSH Desktop）
echo 3. 启动 LoL 采集和策略悬浮窗
echo 4. 启动王者采集和策略悬浮窗
echo 5. 打开 DSH Desktop 官方下载页
echo 6. 单独打开策略悬浮窗
echo Q. 退出
choice /c 123456Q /n /m "请选择："
if errorlevel 7 exit /b
if errorlevel 6 (
call "%~dp0overlay.cmd"
exit /b
)
if errorlevel 5 (
start "" "https://deepseek.com/harness/"
exit /b
)
if errorlevel 4 (
call "%~dp0wzry.cmd"
exit /b
)
if errorlevel 3 (
call "%~dp0lol.cmd"
exit /b
)
if errorlevel 2 (
call "%~dp0settings.cmd"
exit /b
)
if errorlevel 1 call "%~dp0install.cmd"
