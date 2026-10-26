param([string]$StateDir)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JinbaoInputProbe {
 [StructLayout(LayoutKind.Sequential)] public struct Keyboard {public ushort key,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit,Size=40)] public struct Input {[FieldOffset(0)]public uint type;[FieldOffset(8)]public Keyboard keyboard;}
 [DllImport("user32.dll",SetLastError=true)]public static extern uint SendInput(uint count,Input[] input,int size);
 public static bool Shortcut(ushort key){return Shortcut(key,false);}
 public static bool Shortcut(ushort key,bool alt){Input[] input=new Input[6];ushort modifier=(ushort)(alt?18:16);ushort[] keys={17,modifier,key,key,modifier,17};for(int i=0;i<6;i++){input[i].type=1;input[i].keyboard.key=keys[i];input[i].keyboard.flags=i>=3?2u:0u;}return SendInput(6,input,40)==6;}
}
'@
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
[IO.Directory]::CreateDirectory($StateDir)|Out-Null
[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-state.json'),'{}')
$arguments='-NoProfile -STA -ExecutionPolicy Bypass -File "'+(Join-Path $root 'strategy-overlay.ps1')+'" -StateDir "'+$StateDir+'"'
$child=Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
function Wait-Condition([scriptblock]$check){for($i=0;$i -lt 200;$i++){if(&$check){return};if($child.HasExited){throw 'Overlay exited unexpectedly'};Start-Sleep -Milliseconds 20};throw 'Native overlay condition timed out'}
try{
 Wait-Condition {Test-Path (Join-Path $StateDir 'overlay-hotkeys.json')}
 $keys=[IO.File]::ReadAllText((Join-Path $StateDir 'overlay-hotkeys.json'))|ConvertFrom-Json
 foreach($id in @(702,703,704,705,712,713,714,715)){if(!($keys.bindings|Where-Object {$_.id -eq $id -and $_.registered})){throw 'Physical-key test combination is occupied'}}
 if(![JinbaoInputProbe]::Shortcut(119)){throw 'Native SendInput failed'}
 Wait-Condition {try{$d=[IO.File]::ReadAllText((Join-Path $StateDir 'overlay-hotkeys.json'))|ConvertFrom-Json;return $d.lastReceived.id -eq 703}catch{return $false}}
 if(![JinbaoInputProbe]::Shortcut(118)){throw 'Native SendInput failed'}
 Wait-Condition {try{$d=[IO.File]::ReadAllText((Join-Path $StateDir 'overlay-hotkeys.json'))|ConvertFrom-Json;return $d.lastReceived.id -eq 702}catch{return $false}}
 foreach($binding in @(@(120,704),@(121,705))){
  if(![JinbaoInputProbe]::Shortcut($binding[0])){throw 'Native page shortcut input failed'}
  $expected=$binding[1];Wait-Condition {try{$d=[IO.File]::ReadAllText((Join-Path $StateDir 'overlay-hotkeys.json'))|ConvertFrom-Json;return $d.lastReceived.id -eq $expected}catch{return $false}}
 }
 foreach($binding in @(@(40,703),@(38,702),@(37,704),@(39,705))){
  if(![JinbaoInputProbe]::Shortcut($binding[0],$true)){throw 'Native arrow shortcut input failed'}
  $expected=$binding[1];Wait-Condition {try{$d=[IO.File]::ReadAllText((Join-Path $StateDir 'overlay-hotkeys.json'))|ConvertFrom-Json;return $d.lastReceived.id -eq $expected}catch{return $false}}
 }
 Wait-Condition {Test-Path (Join-Path $StateDir 'overlay-capture-host.json')}
 . (Join-Path $root 'capture-coordination.ps1')
 $lease=Enter-JinbaoCapture $StateDir
 if(!$lease){throw 'No capture lease acknowledged'}
 $ack=[IO.File]::ReadAllText((Join-Path $StateDir 'overlay-capture-ready.json'))|ConvertFrom-Json
 if($ack.id -ne $lease.id){throw 'Wrong capture receipt'}
 Exit-JinbaoCapture $lease
 if(Test-Path (Join-Path $StateDir 'overlay-capture-request.json')){throw 'Capture lease not released'}
 Write-Output '{"physicalShortcutCollapse":true,"physicalShortcutExpand":true,"physicalShortcutPreviousPage":true,"physicalShortcutNextPage":true,"physicalArrowShortcuts":true,"captureLeaseAcknowledged":true,"captureLeaseReleased":true}'
}finally{
 [IO.File]::WriteAllText((Join-Path $StateDir 'overlay-control.json'),(@{action='exit';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
 if(!$child.WaitForExit(5000)){$child.Kill()}
 $child.Dispose()
}
