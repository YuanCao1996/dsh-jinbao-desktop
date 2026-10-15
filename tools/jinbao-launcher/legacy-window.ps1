function Show-JinbaoLegacyOverlay {
    param([object[]]$Legacy)
    if(!$Legacy.Count){return $false}
    if(-not ('JinbaoLegacyWindow' -as [type])) {
        Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class JinbaoLegacyWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  delegate bool Callback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect bounds);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
  public static IntPtr[] Windows(int targetPid) {
    var result = new List<IntPtr>();
    EnumWindows((handle, parameter) => {
      uint pid; GetWindowThreadProcessId(handle, out pid);
      var name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
      Rect bounds; GetWindowRect(handle, out bounds);
      if(pid == targetPid && name.ToString().StartsWith("HwndWrapper") && bounds.Right-bounds.Left>=60 && bounds.Bottom-bounds.Top>=30) result.Add(handle);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static void Show(IntPtr handle) {
    ShowWindow(handle, 9);
    SetWindowPos(handle, new IntPtr(-1), 0, 0, 0, 0, 0x43);
    SetForegroundWindow(handle);
  }
}
'@
    }
    $item=$Legacy[0]
    # Revalidate the exact script and session immediately before touching its UI.
    $current=@(Find-JinbaoLegacyOverlay | Where-Object {$_.pid -eq $item.pid -and $_.script -eq $item.script})
    if(!$current.Count){return $false}
    $windows=@([JinbaoLegacyWindow]::Windows([int]$item.pid))
    $visible=@($windows | Where-Object {[JinbaoLegacyWindow]::IsWindowVisible($_)})
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$item.pid) -ErrorAction Stop
    if($visible.Count -and $process.CommandLine -match '(?i)(?:^|\s)-AlwaysShow(?:\s|$)'){[JinbaoLegacyWindow]::Show($visible[0]);return $true}
    # The old UI hides outside the game. ShowWindow alone lasts only until its
    # next poll, so restart only that UI with its supported always-show flag.
    $source=[IO.File]::ReadAllText($item.script)
    if($source -notmatch '\[switch\]\s*\$AlwaysShow'){throw 'Existing overlay has no supported always-show option.'}
    $arguments='-NoProfile -STA -ExecutionPolicy Bypass -File "'+$item.script+'" -AlwaysShow -Interactive -ResetBounds'
    foreach($option in @('Port','Width','Height','PollMs','Opacity')) {
        if($process.CommandLine -match ('(?i)(?:^|\s)-'+$option+'\s+(\d+)')){$arguments+=' -'+$option+' '+$matches[1]}
    }
    if(!$windows.Count){throw 'Existing overlay window is not ready. Please retry.'}
    foreach($handle in $windows){[JinbaoLegacyWindow]::PostMessage($handle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null}
    $old=Get-Process -Id $item.pid -ErrorAction SilentlyContinue
    if($old -and !$old.WaitForExit(5000)){throw 'Existing overlay did not close; no duplicate was started.'}
    $next=Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    for($attempt=0;$attempt -lt 30;$attempt++){
        Start-Sleep -Milliseconds 300
        $visible=@([JinbaoLegacyWindow]::Windows($next.Id) | Where-Object {[JinbaoLegacyWindow]::IsWindowVisible($_)})
        if($visible.Count){[JinbaoLegacyWindow]::Show($visible[0]);return $true}
        if($next.HasExited){break}
    }
    throw 'Existing overlay could not be restored.'
}
