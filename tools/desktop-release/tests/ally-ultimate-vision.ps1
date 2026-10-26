$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot '../../lol-companion/AllyUltimateVision.cs') -ReferencedAssemblies System.Drawing,System.Core
function New-TestPortrait([int]$seed){
 $bitmap=[Drawing.Bitmap]::new(128,128);$graphics=[Drawing.Graphics]::FromImage($bitmap);$random=[Random]::new($seed)
 try{for($y=0;$y -lt 8;$y++){for($x=0;$x -lt 8;$x++){
  $brush=[Drawing.SolidBrush]::new([Drawing.Color]::FromArgb($random.Next(20,240),$random.Next(20,240),$random.Next(20,240)))
  try{$graphics.FillRectangle($brush,$x*16,$y*16,16,16)}finally{$brush.Dispose()}
 }}}finally{$graphics.Dispose()}
 return $bitmap
}
$portraits=@();$encoded=@();$canvas=[Drawing.Bitmap]::new(1920,1080);$graphics=[Drawing.Graphics]::FromImage($canvas)
try{
 $graphics.Clear([Drawing.Color]::FromArgb(25,30,40))
 for($i=0;$i -lt 4;$i++){
  $portrait=New-TestPortrait (17+$i*101);$portraits+=,$portrait;$stream=[IO.MemoryStream]::new()
  try{$portrait.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$encoded+=[Convert]::ToBase64String($stream.ToArray())}finally{$stream.Dispose()}
  $graphics.DrawImage($portrait,1650+$i*60,730,48,48)
  $pen=[Drawing.Pen]::new([Drawing.Color]::FromArgb(190,160,65),2.5)
  $brush=[Drawing.SolidBrush]::new($(if($i%2 -eq 0){[Drawing.Color]::FromArgb(30,220,70)}else{[Drawing.Color]::FromArgb(8,10,15)}))
  try{$graphics.FillEllipse($brush,1667+$i*60,721,14,14);$graphics.DrawEllipse($pen,1667+$i*60,721,14,14)}finally{$pen.Dispose();$brush.Dispose()}
 }
 $graphics.Dispose();$graphics=$null
 $aliases=@('Alpha','Beta','Gamma','Delta')
 foreach($height in @(1080,810,720)){
  [JinbaoAllyUltimateVision]::Configure($aliases,$encoded)
  $scaled=[Drawing.Bitmap]::new($canvas,[Drawing.Size]::new([int]($height*16/9),$height))
  try{
   $observations=@([JinbaoAllyUltimateVision]::Observe($scaled))
   if($observations.Count -ne 4){throw "Synthetic HUD identity group failed at $height"}
   foreach($item in $observations){$index=[Array]::IndexOf($aliases,$item.Champion);if($index -lt 0 -or $item.Ready -ne ($index%2 -eq 0)){throw 'Synthetic HUD readiness mismatch'}}
   if([JinbaoAllyUltimateVision]::Observe($scaled).Length -ne 4){throw 'Cached layout failed'}
  }finally{$scaled.Dispose()}
 }
 $blank=[Drawing.Bitmap]::new(1920,1080)
 try{if([JinbaoAllyUltimateVision]::Observe($blank).Length){throw 'Hidden HUD cannot produce observations'}}finally{$blank.Dispose()}
 [JinbaoAllyUltimateVision]::Configure(@('One','Two'),@($encoded[0],$encoded[1]))
 if([JinbaoAllyUltimateVision]::Observe($canvas).Length){throw 'Fewer than three allies cannot calibrate'}
 Write-Output '{"identityGroup":true,"readyAndNotReady":true,"scaledHud":true,"cachedLayout":true,"hiddenHud":true,"insufficientRoster":true}'
}finally{if($graphics){$graphics.Dispose()};$canvas.Dispose();foreach($portrait in $portraits){$portrait.Dispose()}}
