param([ValidateSet('lol','wzry')][string]$Game='lol',[ValidateSet('game','augments')][string]$Area='game',[string]$ImagePath,[string]$StateDir=$env:JINBAO_STATE_DIR)
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try{
 Add-Type -AssemblyName System.Drawing
 Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JinbaoGameFrame {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
 [JinbaoGameFrame]::SetProcessDPIAware()|Out-Null
 $bitmap=$null;$scaled=$null;$memory=$null
 if($ImagePath){$bitmap=[Drawing.Bitmap]::new([IO.Path]::GetFullPath($ImagePath))}else{
  $name=if($Game -eq 'lol'){'League of Legends'}else{'scrcpy'}
  $games=@(Get-Process -Name $name -ErrorAction SilentlyContinue|Where-Object {$_.MainWindowHandle -ne [IntPtr]::Zero -and ![JinbaoGameFrame]::IsIconic($_.MainWindowHandle)})
  if($games.Count -ne 1){Write-Output '{"available":false,"reason":"game_window_unavailable"}';exit 0}
  $handle=$games[0].MainWindowHandle;$front=[JinbaoGameFrame]::GetForegroundWindow()
  $title=[Text.StringBuilder]::new(256);[JinbaoGameFrame]::GetWindowText($front,$title,256)|Out-Null
  if($front -ne $handle -and $title.ToString() -ne ([char]0x91D1+[string][char]0x5B9D+[string][char]0x7B56+[string][char]0x7565+[string][char]0x60AC+[string][char]0x6D6E+[string][char]0x7A97)){
   Write-Output '{"available":false,"reason":"game_not_visible"}';exit 0
  }
  $rect=New-Object JinbaoGameFrame+Rect;$origin=New-Object JinbaoGameFrame+Point
  if(![JinbaoGameFrame]::GetClientRect($handle,[ref]$rect) -or ![JinbaoGameFrame]::ClientToScreen($handle,[ref]$origin)){throw 'bounds'}
  $w=$rect.Right-$rect.Left;$h=$rect.Bottom-$rect.Top
  if($w -lt 320 -or $h -lt 200){throw 'bounds'}
  $bitmap=[Drawing.Bitmap]::new($w,$h)
  . (Join-Path $PSScriptRoot '../desktop-release/window-pixels.ps1')
  $captureBackend=Copy-JinbaoGamePixels $handle $bitmap $origin.X $origin.Y $StateDir
 }
 try{
  if($Area -eq 'augments'){
   $region=[Drawing.Rectangle]::new([int]($bitmap.Width*0.10),[int]($bitmap.Height*0.12),[int]($bitmap.Width*0.8),[int]($bitmap.Height*0.75))
   $cropped=$bitmap.Clone($region,$bitmap.PixelFormat);$bitmap.Dispose();$bitmap=$cropped
  }
  $ratio=[Math]::Min(1,[Math]::Min(1280.0/$bitmap.Width,1280.0/$bitmap.Height));$scaled=[Drawing.Bitmap]::new($bitmap,[Drawing.Size]::new([int]($bitmap.Width*$ratio),[int]($bitmap.Height*$ratio)))
  $memory=[IO.MemoryStream]::new();$codec=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object MimeType -eq 'image/jpeg'
  $parameters=[Drawing.Imaging.EncoderParameters]::new(1);$parameters.Param[0]=[Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality,[long]75)
  try{$scaled.Save($memory,$codec,$parameters)}finally{$parameters.Dispose()}
  $bytes=$memory.ToArray();if($bytes.Length -gt 524288){throw 'image_budget'}
  @{available=$true;game=$Game;area=$Area;capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();width=$scaled.Width;height=$scaled.Height;mediaType='image/jpeg';data=[Convert]::ToBase64String($bytes)}|ConvertTo-Json -Compress
 }finally{if($memory){$memory.Dispose()};if($scaled){$scaled.Dispose()};if($bitmap){$bitmap.Dispose()}}
}catch{Write-Output '{"available":false,"reason":"capture_failed"}'}
