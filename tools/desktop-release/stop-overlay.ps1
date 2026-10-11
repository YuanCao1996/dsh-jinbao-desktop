param([string]$StateDir=(Join-Path $env:USERPROFILE '.dsh/jinbao'))
$ErrorActionPreference='Stop'
$StateDir=[IO.Path]::GetFullPath($StateDir)
[IO.Directory]::CreateDirectory($StateDir) | Out-Null
$command=@{action='exit';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-control.json'),$command,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $StateDir 'overlay-stopped'),'closed',[Text.UTF8Encoding]::new($false))
Start-Sleep -Seconds 2
# Only terminate our overlay script using this state directory. This fallback also
# supports older releases, which do not yet poll the exit command.
$escaped=[regex]::Escape($StateDir)
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
 Where-Object { $_.CommandLine -match '-File\s+"[^"\r\n]*[\\/]strategy-overlay\.ps1"' -and $_.CommandLine -match ('-StateDir\s+"'+$escaped+'"') } |
 ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
Write-Output 'Strategy overlay stopped.'
