param([string]$StateDir=(Join-Path $env:USERPROFILE '.dsh/jinbao'))
$ErrorActionPreference='Stop'
$overlay=Join-Path $PSScriptRoot 'strategy-overlay.ps1'
if(!(Test-Path -LiteralPath $overlay)){throw 'Strategy overlay file is missing'}
$StateDir=[IO.Path]::GetFullPath($StateDir)
[IO.Directory]::CreateDirectory($StateDir) | Out-Null
$stopped=Join-Path $StateDir 'overlay-stopped'
if(Test-Path -LiteralPath $stopped){Remove-Item -LiteralPath $stopped}
$command=@{action='show';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-control.json'),$command,[Text.UTF8Encoding]::new($false))
$arguments='-NoProfile -STA -ExecutionPolicy Bypass -File "'+$overlay+'" -StateDir "'+$StateDir+'"'
Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden | Out-Null
Write-Output 'Strategy overlay started. Header/buttons are clickable; Ctrl+Alt+J toggles full interaction. Use stop-overlay.cmd to exit.'
