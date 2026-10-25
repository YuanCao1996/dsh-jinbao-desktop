param([switch]$CheckOnly,[string]$ImagePath,[switch]$Worker,[string]$StateDir=$env:JINBAO_STATE_DIR)
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($Worker){
 while($null -ne ($captureCommand=[Console]::In.ReadLine())){
  if($captureCommand -eq 'exit'){break}
  if($captureCommand -eq 'capture'){$captureResult=if($ImagePath){& $PSCommandPath -ImagePath $ImagePath}else{& $PSCommandPath -StateDir $StateDir};[Console]::Out.WriteLine([string]$captureResult);[Console]::Out.Flush()}
 }
 exit 0
}
$engineReady=$false
try{
 if(-not('JinbaoAugmentCapture' -as [type])){Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JinbaoAugmentCapture {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
 }
 Add-Type -AssemblyName System.Runtime.WindowsRuntime,System.Drawing
 $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
 $null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
 $null=[Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
 $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
 $language=[Windows.Globalization.Language]::new('zh-Hans')
 $engine=$global:JinbaoAugmentOcrEngine
 if(!$engine){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language);$global:JinbaoAugmentOcrEngine=$engine}
 if(!$engine){Write-Output '{"available":false,"reason":"chinese_language_unavailable"}';exit 0}
 $engineReady=$true
 if($CheckOnly){Write-Output '{"available":true}';exit 0}
 if($ImagePath){$bytes=[IO.File]::ReadAllBytes([IO.Path]::GetFullPath($ImagePath))}else{
 [JinbaoAugmentCapture]::SetProcessDPIAware() | Out-Null
 $handle=[JinbaoAugmentCapture]::GetForegroundWindow();$gamePid=[uint32]0
 [JinbaoAugmentCapture]::GetWindowThreadProcessId($handle,[ref]$gamePid) | Out-Null
 $process=Get-Process -Id $gamePid -ErrorAction SilentlyContinue
 if(!$process -or $process.ProcessName -ne 'League of Legends'){Write-Output '{"available":true,"foreground":false}';exit 0}
 $rect=New-Object JinbaoAugmentCapture+Rect;$origin=New-Object JinbaoAugmentCapture+Point
 if(![JinbaoAugmentCapture]::GetClientRect($handle,[ref]$rect) -or ![JinbaoAugmentCapture]::ClientToScreen($handle,[ref]$origin)){throw 'Game bounds unavailable'}
 $w=$rect.Right-$rect.Left;$h=$rect.Bottom-$rect.Top
 if($w -lt 640 -or $h -lt 480){throw 'Game bounds too small'}
 $left=$origin.X;$top=$origin.Y
 $width=$w;$height=$h
 $bitmap=[Drawing.Bitmap]::new($width,$height)
 $graphics=[Drawing.Graphics]::FromImage($bitmap)
 . (Join-Path $PSScriptRoot '../desktop-release/capture-coordination.ps1')
 $lease=$null
 try{$lease=Enter-JinbaoCapture $StateDir;$graphics.CopyFromScreen($left,$top,0,0,$bitmap.Size)}finally{Exit-JinbaoCapture $lease;$graphics.Dispose()}
 $scaled=$null;$memory=[IO.MemoryStream]::new()
 try{
  if($width -gt 2000){$scaled=[Drawing.Bitmap]::new($bitmap,[Drawing.Size]::new(2000,[int]($height*2000/$width)));$width=$scaled.Width;$height=$scaled.Height;$scaled.Save($memory,[Drawing.Imaging.ImageFormat]::Png)}
  else{$bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)}
  $bytes=$memory.ToArray()
 }finally{if($scaled){$scaled.Dispose()};$memory.Dispose();$bitmap.Dispose()}
 }
 $asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1} | Select-Object -First 1
 function Await-Operation($operation,[Type]$type){$task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation));$task.Wait();return $task.Result}
 function Read-OcrImage([byte[]]$imageBytes){
  $stream=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
 $software=$null
 try{
  $writer=[Windows.Storage.Streams.DataWriter]::new($stream)
  $writer.WriteBytes($imageBytes);Await-Operation ($writer.StoreAsync()) ([uint32]) | Out-Null
  $writer.DetachStream() | Out-Null;$writer.Dispose();$stream.Seek(0)
  $decoder=Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $width=$decoder.PixelWidth;$height=$decoder.PixelHeight
  $software=Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result=Await-Operation ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
  $lines=@($result.Lines | ForEach-Object {
   $words=@($_.Words)
   if($words.Count){
    $x=($words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum
    $y=($words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum
    $right=($words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width} | Measure-Object -Maximum).Maximum
    $bottom=($words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
    @{text=$_.Text;x=[double]$x;y=[double]$y;box=@(@($x,$y),@($right,$y),@($right,$bottom),@($x,$bottom))}
   }
  })
  return @{width=$width;height=$height;lines=$lines}
 }finally{if($software){$software.Dispose()};$stream.Dispose()}
 }
 $frame=Read-OcrImage $bytes
 $titleLines=@()
 # Full-screen OCR can skip all three stylized titles even though OCR is available.
 # Independently enlarge each card's title region, preserving full-frame coordinates.
 $inputStream=[IO.MemoryStream]::new($bytes,$false)
 $inputBitmap=$null
 try{
  $inputBitmap=[Drawing.Bitmap]::new($inputStream)
  $w=[int]($inputBitmap.Height*0.302);$h=[int]($inputBitmap.Height*0.11);$gutter=36;$stride=$h*3+$gutter
  $strip=[Drawing.Bitmap]::new($w*3,$stride*3);$stripGraphics=[Drawing.Graphics]::FromImage($strip)
  try{
   $stripGraphics.Clear([Drawing.Color]::Black)
   for($slot=0;$slot -lt 3;$slot++){
   $crop=$null;$enlarged=$null;$encoded=[IO.MemoryStream]::new()
   try{
    $x=[int]($inputBitmap.Width/2+$inputBitmap.Height*(-0.4713+0.3413*$slot));$y=[int]($inputBitmap.Height*0.35)
    $w=[int]($inputBitmap.Height*0.302);$h=[int]($inputBitmap.Height*0.11)
    $rect=[Drawing.Rectangle]::new($x,$y,$w,$h)
    $crop=$inputBitmap.Clone($rect,$inputBitmap.PixelFormat)
    $enlarged=[Drawing.Bitmap]::new($crop,[Drawing.Size]::new($w*3,$h*3))
    $stripGraphics.DrawImage($enlarged,0,$slot*$stride)
   }finally{if($crop){$crop.Dispose()};if($enlarged){$enlarged.Dispose()};$encoded.Dispose()}
  }
   $stripBytes=[IO.MemoryStream]::new()
   try{
    $strip.Save($stripBytes,[Drawing.Imaging.ImageFormat]::Png);$local=Read-OcrImage $stripBytes.ToArray()
    foreach($line in $local.lines){
     $slot=[int][Math]::Floor($line.y/$stride)
     if($slot -ge 0 -and $slot -lt 3 -and ($line.y-$slot*$stride) -lt $h*3){
      $x=[int]($inputBitmap.Width/2+$inputBitmap.Height*(-0.4713+0.3413*$slot));$y=[int]($inputBitmap.Height*0.35)
      $titleLines+=@{text=$line.text;x=($x+$line.x/3);y=($y+($line.y-$slot*$stride)/3);slot=$slot}
     }
    }
   }finally{$stripBytes.Dispose()}
  }finally{$stripGraphics.Dispose();$strip.Dispose()}
 }finally{if($inputBitmap){$inputBitmap.Dispose()};$inputStream.Dispose()}
 @{available=$true;foreground=$true;width=$frame.width;height=$frame.height;lines=$frame.lines;titleLines=$titleLines;method='full-and-card-strip';cardLayout='stacked-title-regions'} | ConvertTo-Json -Depth 5 -Compress

}catch{
 if($engineReady){Write-Output '{"available":true,"foreground":false,"reason":"capture_failed"}'}
 else{Write-Output '{"available":false,"reason":"ocr_runtime_unavailable"}'}
}
