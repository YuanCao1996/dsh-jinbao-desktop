param([switch]$CheckOnly,[string]$ImagePath,[switch]$Worker,[string]$StateDir=$env:JINBAO_STATE_DIR,[ValidateSet('full','titles')][string]$Focus='full')
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($Worker){
 while($null -ne ($captureCommand=[Console]::In.ReadLine())){
  if($captureCommand -eq 'exit'){break}
  if($captureCommand -in @('capture','capture:titles')){$nextFocus=if($captureCommand -eq 'capture:titles'){'titles'}else{'full'};$captureResult=if($ImagePath){& $PSCommandPath -ImagePath $ImagePath -StateDir $StateDir -Focus $nextFocus}else{& $PSCommandPath -StateDir $StateDir -Focus $nextFocus};[Console]::Out.WriteLine([string]$captureResult);[Console]::Out.Flush()}
 }
 exit 0
}
$engineReady=$false
$capturedAt=$null
$captureWatch=[Diagnostics.Stopwatch]::StartNew()
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
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
}
'@
 }
 Add-Type -AssemblyName System.Runtime.WindowsRuntime,System.Drawing
 # Exact pixel compare for the chat region, kept entirely on the native side: passing a
 # 1.3MB byte[] across the PowerShell boundary every frame costs ~40ms, a single bool
 # costs nothing. Returns true only when the pixels actually differ from last time.
 if(-not('JinbaoChatSignature' -as [type])){
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class JinbaoChatSignature {
 static byte[] last; static int lastW, lastH;
 static byte[] Grab(Bitmap bmp, int x, int y, int w, int h) {
  BitmapData d = bmp.LockBits(new Rectangle(x, y, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
  try { int len = Math.Abs(d.Stride) * h; byte[] buf = new byte[len]; Marshal.Copy(d.Scan0, buf, 0, len); return buf; }
  finally { bmp.UnlockBits(d); }
 }
 public static bool Changed(Bitmap bmp, int x, int y, int w, int h) {
  byte[] buf = Grab(bmp, x, y, w, h);
  if (last != null && lastW == w && lastH == h && buf.Length == last.Length) {
   bool same = true;
   for (int i = 0; i < buf.Length; i++) { if (buf[i] != last[i]) { same = false; break; } }
   if (same) { return false; }
  }
  last = buf; lastW = w; lastH = h;
  return true;
 }
 public static void Reset() { last = null; lastW = 0; lastH = 0; }
 // Independent second channel (card-title strip) so both detectors keep their own state.
 static byte[] last2; static int last2W, last2H;
 public static bool Changed2(Bitmap bmp, int x, int y, int w, int h) {
  byte[] buf = Grab(bmp, x, y, w, h);
  if (last2 != null && last2W == w && last2H == h && buf.Length == last2.Length) {
   bool same = true;
   for (int i = 0; i < buf.Length; i++) { if (buf[i] != last2[i]) { same = false; break; } }
   if (same) { return false; }
  }
  last2 = buf; last2W = w; last2H = h;
  return true;
 }
 public static void Reset2() { last2 = null; last2W = 0; last2H = 0; }
}
'@
 }
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
 $engineReady=[bool]$engine
 if($CheckOnly){@{available=$engineReady;reason=$(if($engineReady){''}else{'chinese_language_unavailable'})} | ConvertTo-Json -Compress;exit 0}
 if($ImagePath){$bytes=[IO.File]::ReadAllBytes([IO.Path]::GetFullPath($ImagePath))}else{
 [JinbaoAugmentCapture]::SetProcessDPIAware() | Out-Null
 $handle=[JinbaoAugmentCapture]::GetForegroundWindow();$gamePid=[uint32]0
 [JinbaoAugmentCapture]::GetWindowThreadProcessId($handle,[ref]$gamePid) | Out-Null
 $process=Get-Process -Id $gamePid -ErrorAction SilentlyContinue
 if(!$process -or $process.ProcessName -ne 'League of Legends'){Write-Output '{"available":true,"foreground":false,"reason":"game_not_foreground"}';exit 0}
 if(([JinbaoAugmentCapture]::GetAsyncKeyState(9) -band 0x8000) -ne 0){
  @{available=$true;ocrAvailable=$engineReady;foreground=$true;panelOccluded=$true;capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();focus=$Focus;method='scoreboard-occluded';reason='scoreboard_visible';lines=@();titleLines=@()}|ConvertTo-Json -Compress;exit 0
 }
 $rect=New-Object JinbaoAugmentCapture+Rect;$origin=New-Object JinbaoAugmentCapture+Point
 if(![JinbaoAugmentCapture]::GetClientRect($handle,[ref]$rect) -or ![JinbaoAugmentCapture]::ClientToScreen($handle,[ref]$origin)){throw 'Game bounds unavailable'}
 $w=$rect.Right-$rect.Left;$h=$rect.Bottom-$rect.Top
 if($w -lt 640 -or $h -lt 480){throw 'Game bounds too small'}
 $left=$origin.X;$top=$origin.Y
 $width=$w;$height=$h
 $bitmap=[Drawing.Bitmap]::new($width,$height)
 . (Join-Path $PSScriptRoot '../desktop-release/window-pixels.ps1')
 $captureBackend=Copy-JinbaoGamePixels $handle $bitmap $left $top $StateDir
 $capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 $scaled=$null;$memory=[IO.MemoryStream]::new()
 try{
  if($width -gt 2000){$scaled=[Drawing.Bitmap]::new($bitmap,[Drawing.Size]::new(2000,[int]($height*2000/$width)));$width=$scaled.Width;$height=$scaled.Height;$scaled.Save($memory,[Drawing.Imaging.ImageFormat]::Png)}
  else{$bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)}
  $bytes=$memory.ToArray()
 }finally{if($scaled){$scaled.Dispose()};$memory.Dispose();$bitmap.Dispose()}
 }
 if(!$capturedAt){$capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
 $pixelMs=$captureWatch.ElapsedMilliseconds
 . (Join-Path $PSScriptRoot 'observe-ally-ultimates.ps1')
 $allyHud=if($Focus -eq 'full'){Read-JinbaoAllyHud $bytes $StateDir}else{$null}
 $hudMs=$captureWatch.ElapsedMilliseconds-$pixelMs
 if(!$engineReady){@{available=$true;ocrAvailable=$false;foreground=$true;capturedAt=$capturedAt;reason='chinese_language_unavailable';lines=@();allyHud=$allyHud} | ConvertTo-Json -Depth 6 -Compress;exit 0}
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
 $frame=if($Focus -eq 'full'){Read-OcrImage $bytes}else{$null}
 $titleLines=@()
 $titleReuse=$false
 $titleSigMs=0
 # Full-screen OCR can skip all three stylized titles even though OCR is available.
 # Independently enlarge each card's title region, preserving full-frame coordinates.
 $inputStream=[IO.MemoryStream]::new($bytes,$false)
 $inputBitmap=$null
 try{
  $inputBitmap=[Drawing.Bitmap]::new($inputStream)
  if(!$frame){$frame=@{width=$inputBitmap.Width;height=$inputBitmap.Height;lines=@()}}
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
    # The three card titles stay pixel-identical while the panel is simply displayed,
    # so compare the already-rendered strip and skip its OCR when nothing moved.
    $titleChanged=$true
    $titleSigStart=$captureWatch.ElapsedMilliseconds
    $titleSig="$($inputBitmap.Width)x$($inputBitmap.Height)x$stride"
    $titleSigBmp=$null
    try{
     $titleSigBmp=[Drawing.Bitmap]::new(180,18)
     $titleSigG=[Drawing.Graphics]::FromImage($titleSigBmp)
     try{
      $titleSigG.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
      $titleSigG.DrawImage($strip,[Drawing.Rectangle]::new(0,0,180,18),[Drawing.Rectangle]::new(0,0,$strip.Width,$strip.Height),[Drawing.GraphicsUnit]::Pixel)
     }finally{$titleSigG.Dispose()}
     $titleChanged=[JinbaoChatSignature]::Changed2($titleSigBmp,0,0,180,18)
    }catch{$titleChanged=$true}finally{if($titleSigBmp){$titleSigBmp.Dispose()}}
    $titleSigMs=$captureWatch.ElapsedMilliseconds-$titleSigStart
    $titleCached=$global:JinbaoTitleCache
    if((-not $titleChanged) -and $titleCached -and $titleCached.sig -eq $titleSig){
     $titleLines=$titleCached.lines
     $titleReuse=$true
    } else {
     $strip.Save($stripBytes,[Drawing.Imaging.ImageFormat]::Bmp);$local=Read-OcrImage $stripBytes.ToArray()
     foreach($line in $local.lines){
      $slot=[int][Math]::Floor($line.y/$stride)
      if($slot -ge 0 -and $slot -lt 3 -and ($line.y-$slot*$stride) -lt $h*3){
       $x=[int]($inputBitmap.Width/2+$inputBitmap.Height*(-0.4713+0.3413*$slot));$y=[int]($inputBitmap.Height*0.35)
       $titleLines+=@{text=$line.text;x=($x+$line.x/3);y=($y+($line.y-$slot*$stride)/3);slot=$slot}
      }
     }
     $global:JinbaoTitleCache=@{sig=$titleSig;lines=$titleLines}
    }
   }finally{$stripBytes.Dispose()}
  }finally{$stripGraphics.Dispose();$strip.Dispose()}
  # Chat text is small and low contrast, and whole-frame OCR mangles CJK there
  # ("已终结了" -> "已 终 了", "无人能挡" -> "无人能了"). Crop the chat box and
  # enlarge it exactly like the card titles, then map the boxes back so the
  # parser still sees one full-frame coordinate space.
  $chatLines=@()
  $chatError=''
  $chatReuse=$false
  $chatStart=$captureWatch.ElapsedMilliseconds
  if($Focus -eq 'full'){
   $csx=$inputBitmap.Width/1920.0;$csy=$inputBitmap.Height/1080.0;$k=3
   $ccx=0;$ccy=[int][Math]::Floor(600*$csy);$ccw=[int][Math]::Ceiling(840*$csx);$cch=[int][Math]::Ceiling(400*$csy)
   if($ccx+$ccw -gt $inputBitmap.Width){$ccw=$inputBitmap.Width-$ccx}
   if($ccy+$cch -gt $inputBitmap.Height){$cch=$inputBitmap.Height-$ccy}
   if($ccw -gt 0 -and $cch -gt 0){
    # Skip the upscale+OCR when the chat pixels are byte-identical to the last frame we
    # recognised. Chat is idle most of the time, and reusing the previous lines keeps
    # the parser input identical to what a fresh OCR of the same pixels would produce.
    $chatReuse=$false
    $chatChanged=$true
    $chatT0=$captureWatch.ElapsedMilliseconds
    # Compare a downscaled copy rather than the raw 1.3MB region (LockBits+copy on the
    # full rect costs 30-44ms). The Graphics must be disposed before LockBits runs:
    # locking a bitmap that still has an open Graphics fails and silently forces a
    # re-OCR every frame.
    $sigBmp=$null
    try{
     $sigBmp=[Drawing.Bitmap]::new(105,50)
     $sigG=[Drawing.Graphics]::FromImage($sigBmp)
     try{
      $sigG.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
      $sigG.DrawImage($inputBitmap,[Drawing.Rectangle]::new(0,0,105,50),[Drawing.Rectangle]::new($ccx,$ccy,$ccw,$cch),[Drawing.GraphicsUnit]::Pixel)
     }finally{$sigG.Dispose()}
     $chatChanged=[JinbaoChatSignature]::Changed($sigBmp,0,0,105,50)
    }catch{$chatChanged=$true}finally{if($sigBmp){$sigBmp.Dispose()}}
    $chatSigMs=$captureWatch.ElapsedMilliseconds-$chatT0
    $chatCached=$global:JinbaoChatCache
    if((-not $chatChanged) -and $chatCached -and $chatCached.w -eq $ccw -and $chatCached.h -eq $cch -and $chatCached.k -eq $k){
     $chatLines=$chatCached.lines
     $chatReuse=$true
     $chatDebug="reuse $($ccw)x$($cch) lines=$(@($chatLines).Count)"
    } else {
    $bigChat=$null;$chatStream=[IO.MemoryStream]::new()
    try{
     # Draw straight from the frame through a source rect: no intermediate clone.
     # BMP encodes roughly five times faster than PNG and feeds the OCR engine the
     # exact same pixels (verified byte-identical recognition output).
     $bigChat=[Drawing.Bitmap]::new($ccw*$k,$cch*$k)
     $chatGraphics=[Drawing.Graphics]::FromImage($bigChat)
     try{
      $chatGraphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $chatGraphics.PixelOffsetMode=[Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $chatGraphics.DrawImage($inputBitmap,[Drawing.Rectangle]::new(0,0,$ccw*$k,$cch*$k),[Drawing.Rectangle]::new($ccx,$ccy,$ccw,$cch),[Drawing.GraphicsUnit]::Pixel)
     }finally{$chatGraphics.Dispose()}
     $bigChat.Save($chatStream,[Drawing.Imaging.ImageFormat]::Bmp)
     $localChat=Read-OcrImage $chatStream.ToArray()
     $chatDebug="crop=${ccw}x${cch} big=$($bigChat.Width)x$($bigChat.Height) ocr=$($localChat.width)x$($localChat.height) lines=$(@($localChat.lines).Count)"
     foreach($line in $localChat.lines){
      $b=$line.box
      $ax=$ccx+([double]$b[0][0]/$k);$ay=$ccy+([double]$b[0][1]/$k)
      $bx=$ccx+([double]$b[1][0]/$k);$by=$ccy+([double]$b[1][1]/$k)
      $cx2=$ccx+([double]$b[2][0]/$k);$cy2=$ccy+([double]$b[2][1]/$k)
      $dx=$ccx+([double]$b[3][0]/$k);$dy=$ccy+([double]$b[3][1]/$k)
      $chatLines+=@{text=$line.text;x=($ccx+([double]$line.x/$k));y=($ccy+([double]$line.y/$k));box=@(@($ax,$ay),@($bx,$by),@($cx2,$cy2),@($dx,$dy))}
     }
    }catch{$chatError=$_.Exception.Message}finally{if($bigChat){$bigChat.Dispose()};$chatStream.Dispose()}
    # Cache only a completed run; a failed OCR forces the next frame to retry.
    if(-not $chatError){$global:JinbaoChatCache=@{w=$ccw;h=$cch;k=$k;lines=$chatLines}}else{try{[JinbaoChatSignature]::Reset()}catch{}}
    }
    $wholeLines=$frame.lines
    $mergeT0=$captureWatch.ElapsedMilliseconds
    # Plain arithmetic loop: Measure-Object/ForEach-Object per line cost ~30ms for a
    # full-frame result, which dwarfed the pixel compare on the reuse path.
    $kept=New-Object System.Collections.ArrayList
    $zzLo=$ccy;$zzHi=$ccy+$cch;$zzRight=$ccx+$ccw
    foreach($line in $wholeLines){
     $bb=$line.box
     if(!$bb){[void]$kept.Add($line);continue}
     $minY=[double]::MaxValue;$maxY=[double]::MinValue;$minX=[double]::MaxValue
     foreach($pp in $bb){
      $py=[double]$pp[1];$px=[double]$pp[0]
      if($py -lt $minY){$minY=$py}
      if($py -gt $maxY){$maxY=$py}
      if($px -lt $minX){$minX=$px}
     }
     $midY=($minY+$maxY)/2.0
     if(!($midY -ge $zzLo -and $midY -le $zzHi -and $minX -lt $zzRight)){[void]$kept.Add($line)}
    }
    # Fail open: if the enlarged crop OCR yields nothing, keep the whole-frame lines
    # instead of silently deleting the chat region.
    if(@($chatLines).Count -gt 0){$frame.lines=@($kept)+@($chatLines)}else{$frame.lines=$wholeLines}
    $chatMergeMs=$captureWatch.ElapsedMilliseconds-$mergeT0
   }
  }
  $chatMs=$captureWatch.ElapsedMilliseconds-$chatStart
 }finally{if($inputBitmap){$inputBitmap.Dispose()};$inputStream.Dispose()}
 @{available=$true;ocrAvailable=$true;foreground=$true;capturedAt=$capturedAt;allyHud=$allyHud;focus=$Focus;captureBackend=$captureBackend;timings=@{captureMs=$pixelMs;hudMs=$hudMs;ocrMs=$captureWatch.ElapsedMilliseconds-$pixelMs-$hudMs;chatMs=$chatMs;totalMs=$captureWatch.ElapsedMilliseconds};width=$frame.width;height=$frame.height;lines=$frame.lines;chatLineCount=@($chatLines).Count;chatError=$chatError;chatDebug=$chatDebug;chatReuse=$chatReuse;chatSigMs=$chatSigMs;chatMergeMs=$chatMergeMs;titleReuse=$titleReuse;titleSigMs=$titleSigMs;titleLines=$titleLines;method=$(if($Focus -eq 'titles'){'card-strip-fast'}else{'full-and-card-strip+chat'});cardLayout='stacked-title-regions'} | ConvertTo-Json -Depth 6 -Compress

}catch{
 if($engineReady){Write-Output '{"available":true,"foreground":false,"reason":"capture_failed"}'}
 else{Write-Output '{"available":false,"reason":"ocr_runtime_unavailable"}'}
}
