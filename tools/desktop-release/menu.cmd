@echo off
setlocal
if not exist "%~dp0tools\desktop-release\menu.ps1" (
  echo Please extract the entire ZIP before starting.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\desktop-release\menu.ps1"
if errorlevel 1 (
  echo Startup failed. Please keep this error message for troubleshooting.
  pause
  exit /b 1
)
