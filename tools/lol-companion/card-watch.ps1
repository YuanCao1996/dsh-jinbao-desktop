# 卡片选择视觉判定：连续采样三张强化卡，找出"只有它在变"的那张。
#
# 原理（见 handoff/15-强化选择视觉判定方案.md）：
#   面板打开时三张卡像素静止；悬停或点击只让**那一张**出现动画；
#   面板关闭时三张一起淡出。所以判据是"存在唯一一张相对自身基线偏离、另两张不动"。
#
# 抓屏函数可注入，便于用合成帧离线验证判定逻辑，不依赖真实对局。

if(-not('JinbaoCardWatch' -as [type])){
 Add-Type -AssemblyName System.Drawing
 Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class JinbaoCardWatch {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

 // 32x12 灰度缩略图：足以体现缩放/发光动画，又便宜到可以 20Hz 跑。
 public static byte[] Signature(Bitmap source) {
  int w = 32, h = 12;
  using (Bitmap small = new Bitmap(w, h, PixelFormat.Format32bppArgb))
  using (Graphics g = Graphics.FromImage(small)) {
   g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
   g.DrawImage(source, 0, 0, w, h);
   BitmapData data = small.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
   try {
    int stride = Math.Abs(data.Stride);
    byte[] raw = new byte[stride * h];
    Marshal.Copy(data.Scan0, raw, 0, raw.Length);
    byte[] grey = new byte[w * h];
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
     int at = y * stride + x * 4;
     grey[y * w + x] = (byte)((raw[at] * 29 + raw[at + 1] * 150 + raw[at + 2] * 77) >> 8);
    }
    return grey;
   } finally { small.UnlockBits(data); }
  }
 }

 // 平均绝对差：0 表示完全相同，越大变化越剧烈。
 public static double Difference(byte[] a, byte[] b) {
  if (a == null || b == null || a.Length != b.Length) return 255.0;
  long sum = 0;
  for (int i = 0; i < a.Length; i++) sum += Math.Abs(a[i] - b[i]);
  return (double)sum / a.Length;
 }
}
'@
}

# 三张卡的矩形：与 OCR 裁剪同一套系数，完全由窗口尺寸推导。
function Get-JinbaoCardRects([int]$width,[int]$height){
 $w=[int]($height*0.302);$h=[int]($height*0.11);$y=[int]($height*0.35)
 $rects=New-Object System.Collections.ArrayList
 for($slot=0;$slot -lt 3;$slot++){
  $x=[int]($width/2+$height*(-0.4713+0.3413*$slot))
  [void]$rects.Add([pscustomobject]@{slot=$slot;x=$x;y=$y;width=$w;height=$h})
 }
 return ,$rects.ToArray()
}

# 抓一帧的三张卡片。$Copy 可注入（测试用），默认直接 CopyFromScreen。
function Get-JinbaoCardFrame {
 param([int]$width,[int]$height,[int]$originX,[int]$originY,[scriptblock]$Copy)
 $frame=New-Object System.Collections.ArrayList
 foreach($rect in (Get-JinbaoCardRects $width $height)){
  $bmp=[Drawing.Bitmap]::new($rect.width,$rect.height)
  if($Copy){ & $Copy $bmp ($originX+$rect.x) ($originY+$rect.y) }
  else{
   $graphics=[Drawing.Graphics]::FromImage($bmp)
   try{$graphics.CopyFromScreen($originX+$rect.x,$originY+$rect.y,0,0,$bmp.Size)}finally{$graphics.Dispose()}
  }
  [void]$frame.Add($bmp)
 }
 return ,$frame.ToArray()
}

# 判定主循环。$Capture 返回长度 3 的 Bitmap 数组。
# 判定失败时把「变化前 / 变化后」两组卡片存成 PNG，供视觉模型兜底。
# 每条 strip 是三张卡横排 2 倍放大：单张卡太小，模型分不清描边与缩放的差异。
function Save-JinbaoCardFrames {
 param([Parameter(Mandatory=$true)]$Result,[Parameter(Mandatory=$true)][string]$Directory)
 if(-not $Result.baselineFrames -or -not $Result.lastFrames){ return $null }
 New-Item -ItemType Directory -Force -Path $Directory | Out-Null
 $saved=@()
 foreach($pair in @(@('baseline',$Result.baselineFrames),@('last',$Result.lastFrames))){
  $frames=$pair[1];if(-not $frames -or $frames.Count -lt 3){ continue }
  $width=0;foreach($bmp in $frames){ $width+=$bmp.Width*2 }
  $height=$frames[0].Height*2
  $strip=[Drawing.Bitmap]::new($width,$height)
  $graphics=[Drawing.Graphics]::FromImage($strip)
  try{
   $graphics.InterpolationMode='HighQualityBicubic'
   $offset=0
   foreach($bmp in $frames){ $graphics.DrawImage($bmp,$offset,0,$bmp.Width*2,$bmp.Height*2);$offset+=$bmp.Width*2 }
  }finally{ $graphics.Dispose() }
  $path=Join-Path $Directory ($pair[0]+'.png')
  $strip.Save($path,[Drawing.Imaging.ImageFormat]::Png);$strip.Dispose();$saved+=$path
 }
 return $saved
}
function Invoke-JinbaoCardWatch {
 param(
  [Parameter(Mandatory=$true)][scriptblock]$Capture,
  [int]$TimeoutMs=20000,
  [double]$Threshold=8.0,
  [int]$SleepMs=50,
  [scriptblock]$Clock={ [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() },
  [scriptblock]$Sleep={ param($ms) Start-Sleep -Milliseconds $ms },
  [switch]$KeepFrames
)
 $baseline=$null;$previous=$null;$picked=$null;$streak=0;$frames=0;$baselineFrames=$null;$lastFrames=$null
 $peak=@(0.0,0.0,0.0)
 $startedAt=& $Clock
 $reason='undecided'

 while(((& $Clock)-$startedAt) -lt $TimeoutMs){
  $frame=$null
  try{
   $frame=& $Capture
   if(-not $frame -or @($frame).Count -lt 3){ $reason='no-frame'; break }
   $frames++
   $signatures=@()
   for($i=0;$i -lt 3;$i++){ $signatures+=,[JinbaoCardWatch]::Signature($frame[$i]) }

   if(-not $baseline){
    # 基线必须取自静止的面板：连续两帧差异都很小才认，避免在动画中间取基线。
    if($previous){
     $settled=$true
     for($i=0;$i -lt 3;$i++){ if([JinbaoCardWatch]::Difference($signatures[$i],$previous[$i]) -gt 2.0){ $settled=$false } }
     if($settled){
    $baseline=$signatures
    if($KeepFrames -and -not $baselineFrames){ $baselineFrames=@(); foreach($bmp in $frame){ $baselineFrames+=,$bmp.Clone() } }
   }
    }
    $previous=$signatures
    continue
   }

   $diff=@(0.0,0.0,0.0)
   for($i=0;$i -lt 3;$i++){
    $diff[$i]=[JinbaoCardWatch]::Difference($signatures[$i],$baseline[$i])
    if($diff[$i] -gt $peak[$i]){ $peak[$i]=$diff[$i] }
   }
   $max=0.0;$argmax=0
   for($i=0;$i -lt 3;$i++){ if($diff[$i] -gt $max){ $max=$diff[$i];$argmax=$i } }
   $quiet=0
   for($i=0;$i -lt 3;$i++){ if($i -ne $argmax -and $diff[$i] -lt ($max/3)){ $quiet++ } }

   if($max -ge $Threshold -and $quiet -eq 2){
    # 唯一一张在动：悬停或点击的动画。
    $picked=$argmax;$streak++
   }elseif($max -ge $Threshold -and $quiet -eq 0){
    # 三张一起大改：面板在关闭/淡出。停止，沿用此前锁定的结果。
    $reason='panel-closed';break
   }else{
    $streak=0
   }
  }finally{
   if($frame){
    if($KeepFrames){ if($lastFrames){ foreach($b in $lastFrames){ if($b){$b.Dispose()} } }; $lastFrames=@(); foreach($bmp in $frame){ $lastFrames+=,$bmp.Clone() } }
    foreach($bmp in $frame){ if($bmp){ $bmp.Dispose() } }
   }
  }
  & $Sleep $SleepMs
 }

 if($picked -ne $null){ $reason='sole-deviation' } elseif($reason -eq 'undecided'){ $reason='timeout' }
 return [pscustomobject]@{picked=$picked;reason=$reason;frames=$frames;peak=$peak;ms=((& $Clock)-$startedAt);baselineFrames=$baselineFrames;lastFrames=$lastFrames}
}

# ---------------------------------------------------------------- 合成帧自检
function New-JinbaoTestCard([int]$shade,[bool]$mark){
 $bmp=[Drawing.Bitmap]::new(64,24)
 $graphics=[Drawing.Graphics]::FromImage($bmp)
 try{
  $graphics.Clear([Drawing.Color]::FromArgb($shade,$shade,$shade))
  if($mark){ $graphics.FillRectangle([Drawing.Brushes]::White,4,4,56,16) }
 }finally{ $graphics.Dispose() }
 return $bmp
}

function Invoke-JinbaoCardWatchSelfTest {
 $results=[ordered]@{}
 $quiet={ param($ms) }

 # 只有中间那张出现动画 → 应判 slot 1
 $script:selfTestFrame=0
 $one=Invoke-JinbaoCardWatch -TimeoutMs 5000 -SleepMs 0 -Sleep $quiet -Capture {
  $script:selfTestFrame++
  $mark=($script:selfTestFrame -ge 3)
  ,@((New-JinbaoTestCard 90 $false),(New-JinbaoTestCard 90 $mark),(New-JinbaoTestCard 90 $false))
 }
 $results.soleDeviationPicked=$one.picked
 $results.soleDeviation=$($one.picked -eq 1)

 # 三张一起变化（面板关闭）→ 不应判定
 $script:selfTestGlobal=0
 $all=Invoke-JinbaoCardWatch -TimeoutMs 5000 -SleepMs 0 -Sleep $quiet -Capture {
  $script:selfTestGlobal++
  $value=if($script:selfTestGlobal -ge 3){200}else{90}
  ,@((New-JinbaoTestCard $value $false),(New-JinbaoTestCard $value $false),(New-JinbaoTestCard $value $false))
 }
 $results.globalChangeUndecided=($null -eq $all.picked)
 $results.globalChangeReason=$all.reason

 # 全程静止 → 不应判定
 $static=Invoke-JinbaoCardWatch -TimeoutMs 400 -SleepMs 0 -Sleep $quiet -Capture {
  ,@((New-JinbaoTestCard 90 $false),(New-JinbaoTestCard 90 $false),(New-JinbaoTestCard 90 $false))
 }
 $results.staticUndecided=($null -eq $static.picked)
 $results.staticReason=$static.reason
 return [pscustomobject]$results
}

if($MyInvocation.InvocationName -ne '.'){
 if($args -contains '-SelfTest'){
  [Console]::Out.WriteLine((Invoke-JinbaoCardWatchSelfTest | ConvertTo-Json -Compress))
  exit 0
 }
 if($args -contains '-Watch'){
  # 独立进程运行：不能占用 capture-augments.ps1 的 worker，否则面板开着的十几秒里
  # 所有采集都会卡住。
  $timeoutMs=12000
  $threshold=8.0
  for($i=0;$i -lt $args.Count;$i++){
   if($args[$i] -eq '-TimeoutMs' -and $i+1 -lt $args.Count){ [int]::TryParse([string]$args[$i+1],[ref]$timeoutMs) | Out-Null }
   if($args[$i] -eq '-Threshold' -and $i+1 -lt $args.Count){ [double]::TryParse([string]$args[$i+1],[ref]$threshold) | Out-Null }
  }
  $payload=[ordered]@{picked=$null;reason='unavailable';frames=0;ms=0}
  try{
   [JinbaoCardWatch]::SetProcessDPIAware() | Out-Null
   $handle=[JinbaoCardWatch]::GetForegroundWindow()
   $gamePid=[uint32]0
   [JinbaoCardWatch]::GetWindowThreadProcessId($handle,[ref]$gamePid) | Out-Null
   $process=Get-Process -Id $gamePid -ErrorAction SilentlyContinue
   if(-not $process -or $process.ProcessName -ne 'League of Legends'){
    $payload.reason='game_not_foreground'
   }else{
    $rect=New-Object JinbaoCardWatch+Rect
    $origin=New-Object JinbaoCardWatch+Point
    if(-not [JinbaoCardWatch]::GetClientRect($handle,[ref]$rect) -or -not [JinbaoCardWatch]::ClientToScreen($handle,[ref]$origin)){
     $payload.reason='bounds_unavailable'
    }else{
     $width=$rect.Right-$rect.Left
     $height=$rect.Bottom-$rect.Top
     if($width -lt 640 -or $height -lt 480){
      $payload.reason='bounds_too_small'
     }else{
      $result=Invoke-JinbaoCardWatch -TimeoutMs $timeoutMs -Threshold $threshold -SleepMs 50 -KeepFrames -Capture {
       Get-JinbaoCardFrame -width $width -height $height -originX $origin.X -originY $origin.Y
      }
      $payload=[ordered]@{picked=$result.picked;reason=$result.reason;frames=$result.frames;ms=$result.ms;peak=$result.peak}
      if($null -eq $result.picked -and $result.baselineFrames){
       try{
        $dir=Join-Path $env:JINBAO_STATE_DIR ('card-watch-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $saved=Save-JinbaoCardFrames -Result $result -Directory $dir
        if($saved -and $saved.Count -eq 2){ $payload.baselineImage=$saved[0];$payload.lastImage=$saved[1] }
       }catch{ $payload.saveError=$_.Exception.Message }
      }
     }
    }
   }
  }catch{
   $payload.reason='error'
   $payload.error=$_.Exception.Message
  }
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
 }
}
