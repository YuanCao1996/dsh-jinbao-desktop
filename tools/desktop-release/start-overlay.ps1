param([string]$StateDir=(Join-Path $env:USERPROFILE '.dsh/jinbao'))
$ErrorActionPreference='Stop'
$overlay=Join-Path $PSScriptRoot 'strategy-overlay.ps1'
if(!(Test-Path -LiteralPath $overlay)){throw 'Strategy overlay file is missing'}
$arguments='-NoProfile -STA -ExecutionPolicy Bypass -File "'+$overlay+'" -StateDir "'+$StateDir+'"'
Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden | Out-Null
Write-Output 'Strategy overlay started. Ctrl+Alt+J toggles mouse interaction.'
