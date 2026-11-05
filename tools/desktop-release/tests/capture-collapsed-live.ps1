# 抓一张“收起后”的真实截图：给运行中的悬浮窗发它自己注册的折叠热键（WM_HOTKEY 703），
# 用 PrintWindow 抓窗口像素，再发展开热键（702）复原。
param(
  [int]$CollapseHotkey = 703,
  [int]$ExpandHotkey = 702,
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'

if (-not $OutFile) { $OutFile = Join-Path $env:TEMP 'collapsed-live.png' }

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinGrab {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

# 找到悬浮窗：从 overlay-capture-host.json 拿进程，再按进程枚举顶层窗口
$stateDir = Join-Path $env:USERPROFILE '.jinbao-cloud-preview'
$hostFile = Join-Path $stateDir 'overlay-capture-host.json'
if (-not (Test-Path $hostFile)) { throw '没有 overlay-capture-host.json，悬浮窗可能没在运行' }
$hostPid = (Get-Content $hostFile -Raw | ConvertFrom-Json).pid
$proc = Get-Process -Id $hostPid -ErrorAction SilentlyContinue
if (-not $proc) { throw "悬浮窗进程 $hostPid 不在" }

# 用 Add-Type 里的方式拿主窗口句柄
$hwnd = (Get-Process -Id $hostPid).MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) {
  # 有时 MainWindowHandle 为空，退回到枚举该进程的可见窗口
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, p) => {
      uint owner; GetWindowThreadProcessId(hwnd, out owner);
      if (owner == pid && IsWindowVisible(hwnd)) {
        var sb = new StringBuilder(256); GetWindowText(hwnd, sb, 256);
        if (sb.Length > 0) { found = hwnd; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
  $hwnd = [WinEnum]::Find([uint32]$hostPid)
}
if ($hwnd -eq [IntPtr]::Zero) { throw '没找到悬浮窗句柄' }
Write-Host "悬浮窗句柄: $hwnd (pid $hostPid)"

[WinGrab]::SetProcessDPIAware() | Out-Null

function Grab([string]$path) {
  $rect = New-Object WinGrab+RECT
  [WinGrab]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = [Math]::Max(1, $rect.Right - $rect.Left)
  $h = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $bitmap = New-Object System.Drawing.Bitmap($w, $h)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  try { [WinGrab]::PrintWindow($hwnd, $hdc, 2) | Out-Null } finally { $graphics.ReleaseHdc($hdc); $graphics.Dispose() }
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Host "  saved $path ($w x $h)"
}

# 1) 先抓当前（展开）状态，确认抓图链路可用
Grab ($OutFile -replace '\.png$', '-expanded.png')

# 2) 收起 → 抓图 → 展开
[WinGrab]::SendMessage($hwnd, 0x0312, [IntPtr]$CollapseHotkey, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 900
Grab $OutFile
[WinGrab]::SendMessage($hwnd, 0x0312, [IntPtr]$ExpandHotkey, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 600
Write-Host '已复原为展开状态'
