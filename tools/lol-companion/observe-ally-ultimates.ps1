function Read-JinbaoAllyHud([byte[]]$ImageBytes,[string]$StateDir) {
 if(!$StateDir){return @{key='';observations=@();status='catalogue_unavailable'}}
 try {
  if(-not('JinbaoAllyUltimateVision' -as [type])){
   Add-Type -Path (Join-Path $PSScriptRoot 'AllyUltimateVision.cs') -ReferencedAssemblies System.Drawing,System.Core
  }
  $file=Join-Path $StateDir 'ally-hud-catalogue.json'
  $info=Get-Item -LiteralPath $file -ErrorAction Stop
  if($info.Length -gt 600000){throw 'Catalogue too large'}
  $stamp=$file+':'+$info.LastWriteTimeUtc.Ticks+':'+$info.Length
  if($global:JinbaoAllyHudStamp -ne $stamp){
   $catalogue=[IO.File]::ReadAllText($file) | ConvertFrom-Json
   if([string]$catalogue.key -notmatch '^[a-f0-9]{32}$'){throw 'Invalid catalogue key'}
   $portraits=@($catalogue.portraits | Select-Object -First 5)
   [JinbaoAllyUltimateVision]::Configure([string[]]@($portraits | ForEach-Object {$_.alias}),[string[]]@($portraits | ForEach-Object {$_.png}))
   $global:JinbaoAllyHudKey=[string]$catalogue.key
   $global:JinbaoAllyHudStamp=$stamp
  }
  $stream=[IO.MemoryStream]::new($ImageBytes,$false);$bitmap=$null
  try {
   $bitmap=[Drawing.Bitmap]::new($stream)
   $observations=@([JinbaoAllyUltimateVision]::Observe($bitmap) | ForEach-Object {
    @{alias=$_.Champion;ready=$_.Ready;portraitScore=$_.Score;indicatorScore=$_.IndicatorScore}
   })
   return @{key=$global:JinbaoAllyHudKey;observations=$observations;status='observed'}
  }finally{if($bitmap){$bitmap.Dispose()};$stream.Dispose()}
 }catch{return @{key='';observations=@();status='unavailable'}}
}
