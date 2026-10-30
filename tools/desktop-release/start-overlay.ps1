param([string]$StateDir=(Join-Path $env:USERPROFILE '.dsh/jinbao'),[switch]$Recover)
$ErrorActionPreference='Stop'
if(!$PSBoundParameters.ContainsKey('StateDir') -and $env:DSH_HOME){$StateDir=Join-Path $env:DSH_HOME 'jinbao'}
if($Recover -and (Test-Path -LiteralPath (Join-Path $StateDir 'overlay-stopped'))){Write-Output 'Overlay recovery skipped after user exit.';exit 0}
. (Join-Path $PSScriptRoot '..\jinbao-launcher\legacy-overlay.ps1')
$legacy=@(Find-JinbaoLegacyOverlay)
if($legacy.Count -gt 0){
    . (Join-Path $PSScriptRoot '..\jinbao-launcher\legacy-window.ps1')
    if(!(Show-JinbaoLegacyOverlay -Legacy $legacy)){throw 'Existing overlay could not be shown.'}
    Write-Output 'Existing DSH Jinbao overlay restored.';exit 0
}
$overlay=Join-Path $PSScriptRoot 'strategy-overlay.ps1'
if(!(Test-Path -LiteralPath $overlay)){throw 'Strategy overlay file is missing'}
$StateDir=[IO.Path]::GetFullPath($StateDir)
[IO.Directory]::CreateDirectory($StateDir) | Out-Null
$stopped=Join-Path $StateDir 'overlay-stopped'
if(Test-Path -LiteralPath $stopped){if($Recover){exit 0};Remove-Item -LiteralPath $stopped}
$command=@{action='show';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
if(!$Recover){[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-control.json'),$command,[Text.UTF8Encoding]::new($false))}
$arguments='-NoProfile -STA -ExecutionPolicy Bypass -File "'+$overlay+'" -StateDir "'+$StateDir+'"'
$diagnostics=Join-Path $StateDir 'overlay-diagnostics'
[IO.Directory]::CreateDirectory($diagnostics)|Out-Null
$logName=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()+'-'+[Guid]::NewGuid().ToString('N')
Get-ChildItem -LiteralPath $diagnostics -Filter '*.log' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 18 | ForEach-Object {Remove-Item -LiteralPath $_.FullName -ErrorAction SilentlyContinue}
$process=Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError (Join-Path $diagnostics ($logName+'.stderr.log')) -RedirectStandardOutput (Join-Path $diagnostics ($logName+'.stdout.log')) -PassThru
[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-process.json'),(@{pid=$process.Id;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
Write-Output 'Strategy overlay started. Use the close button or Advanced Maintenance to exit.'
