param([string]$StateDir)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../capture-coordination.ps1')
[IO.Directory]::CreateDirectory($StateDir)|Out-Null
if($null -ne (Enter-JinbaoCapture $StateDir)){throw 'No overlay must not require a lease'}
$hostPath=Join-Path $StateDir 'overlay-capture-host.json'
[IO.File]::WriteAllText($hostPath,(@{pid=$PID;at=0}|ConvertTo-Json -Compress))
if($null -ne (Enter-JinbaoCapture $StateDir)){throw 'Stale PID without overlay mutex must not block capture'}
$holder=Join-Path $StateDir 'holder.ps1'
$source=@'
param([string]$StateDir)
$ErrorActionPreference='Stop'
$sha=[Security.Cryptography.SHA256]::Create()
try{$key=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($StateDir).ToLowerInvariant())))).Replace('-','').Substring(0,16)}finally{$sha.Dispose()}
$mutex=[Threading.Mutex]::new($false,('Local\JinbaoStrategyOverlay-'+$key));$owned=$mutex.WaitOne(0)
if(!$owned){throw 'Fixture overlay mutex occupied'}
try{
 [IO.File]::WriteAllText((Join-Path $StateDir 'overlay-capture-host.json'),(@{pid=$PID;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
 [IO.File]::WriteAllText((Join-Path $StateDir 'holder-ready'),'ready')
 while($true){
  try{$request=[IO.File]::ReadAllText((Join-Path $StateDir 'overlay-capture-request.json'))|ConvertFrom-Json;[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-capture-ready.json'),(@{id=$request.id;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))}catch{}
  Start-Sleep -Milliseconds 15
 }
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
'@
[IO.File]::WriteAllText($holder,$source)
$child=Start-Process powershell.exe -ArgumentList ('-NoProfile -File "'+$holder+'" -StateDir "'+$StateDir+'"') -WindowStyle Hidden -PassThru
try{
 for($i=0;$i -lt 100 -and !(Test-Path (Join-Path $StateDir 'holder-ready'));$i++){Start-Sleep -Milliseconds 30}
 if(!(Test-JinbaoOverlayOwned $StateDir)){throw 'Owned fixture mutex not detected'}
 [IO.File]::WriteAllText($hostPath,'{')
 $blocked=$false;try{Enter-JinbaoCapture $StateDir|Out-Null}catch{$blocked=$_.Exception.Message -eq 'capture_host_unavailable'}
 if(!$blocked){throw 'Corrupt heartbeat must never skip overlay exclusion'}
 [IO.File]::WriteAllText($hostPath,(@{pid=$child.Id;at=0}|ConvertTo-Json -Compress))
 $blocked=$false;try{Enter-JinbaoCapture $StateDir|Out-Null}catch{$blocked=$_.Exception.Message -eq 'capture_host_unresponsive'}
 if(!$blocked){throw 'Stale active overlay must block uncoordinated pixels'}
 [IO.File]::WriteAllText($hostPath,(@{pid=$child.Id;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
 $lease=Enter-JinbaoCapture $StateDir
 if(!$lease){throw 'Fresh host did not acknowledge lease'}
 Exit-JinbaoCapture $lease
 if(Test-Path (Join-Path $StateDir 'overlay-capture-request.json')){throw 'Capture request not removed'}
 @{corruptHeartbeatBlocked=$true;staleActiveBlocked=$true;stalePidIgnored=$true;leaseReleased=$true}|ConvertTo-Json -Compress
}finally{if(!$child.HasExited){$child.Kill();$child.WaitForExit()};$child.Dispose()}
