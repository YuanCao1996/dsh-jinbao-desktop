param([ValidateSet('inspect','shortcut','open')][string]$Action='inspect',[string]$Target)
$ErrorActionPreference='Stop'
if($Action -eq 'open') { Start-Process -FilePath $Target; exit 0 }
$shell=New-Object -ComObject WScript.Shell
if($Action -eq 'shortcut') {
    $shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '金宝.lnk'))
    $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shortcut.Arguments='"'+$Target+'"'
    $shortcut.WorkingDirectory=[IO.Path]::GetDirectoryName($Target)
    $shortcut.Description='启动金宝游戏教练'
    $shortcut.Save()
    exit 0
}
$desktop=$null
$roots=@((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),(Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'))
foreach($root in $roots) {
    if(!(Test-Path -LiteralPath $root)){continue}
    foreach($link in (Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
        if($link.BaseName -notmatch 'DeepSeek.*Harness|Harness.*DeepSeek'){continue}
        $candidate=$shell.CreateShortcut($link.FullName).TargetPath
        if($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)){$desktop=$candidate;break}
    }
    if($desktop){break}
}
$processes=@(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)
if(!$desktop){foreach($process in $processes){if($process.ExecutablePath){$desktop=$process.ExecutablePath;break}}}
$known=@((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'))
foreach($path in $known){if(!$desktop -and (Test-Path -LiteralPath $path -PathType Leaf)){$desktop=$path}}
@{desktop=$desktop;running=($processes.Count -gt 0)} | ConvertTo-Json -Compress
