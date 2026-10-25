# Hide only Jinbao-owned surfaces during the pixel copy, never during OCR.
function Enter-JinbaoCapture([string]$stateDir){
 if(!$stateDir){return $null}
 try{$hostState=[IO.File]::ReadAllText((Join-Path $stateDir 'overlay-capture-host.json'))|ConvertFrom-Json}catch{return $null}
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 if($now-[double]$hostState.at -gt 3000){
  $hostProcess=Get-Process -Id ([int]$hostState.pid) -ErrorAction SilentlyContinue
  if($hostProcess -and $hostProcess.ProcessName -eq 'powershell'){throw 'capture_host_unresponsive'}
  return $null
 }
 $hash=[Security.Cryptography.SHA256]::Create()
 try{$id=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($stateDir).ToLowerInvariant())))).Replace('-','')}finally{$hash.Dispose()}
 $mutex=New-Object Threading.Mutex($false,('Local\JinbaoCapture-'+$id));$owned=$false
 try{
  try{$owned=$mutex.WaitOne(350)}catch [Threading.AbandonedMutexException]{$owned=$true}
  if(!$owned){throw 'capture_coordination_busy'}
  $requestId=[Guid]::NewGuid().ToString('N');$request=Join-Path $stateDir 'overlay-capture-request.json'
  [IO.File]::WriteAllText($request,(@{id=$requestId;expiresAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+1000}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  for($i=0;$i -lt 25;$i++){
   try{$ack=[IO.File]::ReadAllText((Join-Path $stateDir 'overlay-capture-ready.json'))|ConvertFrom-Json;if($ack.id -eq $requestId){Start-Sleep -Milliseconds 25;return @{mutex=$mutex;request=$request;id=$requestId}}}catch{}
   Start-Sleep -Milliseconds 10
  }
  throw 'capture_coordination_timeout'
 }catch{if($owned){if($request){[IO.File]::Delete($request)};$mutex.ReleaseMutex()};$mutex.Dispose();throw}
}
function Exit-JinbaoCapture($lease){
 if(!$lease){return}
 try{[IO.File]::Delete($lease.request)}finally{$lease.mutex.ReleaseMutex();$lease.mutex.Dispose()}
}
