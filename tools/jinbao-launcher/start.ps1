param([string]$StateDir,[switch]$CheckOnly)
if(!$StateDir){$dshRoot=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'};$StateDir=Join-Path $dshRoot 'jinbao'}
$ErrorActionPreference='Stop'
$packageRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$node=Join-Path $packageRoot 'runtime\node.exe'
if(!(Test-Path -LiteralPath $node -PathType Leaf)) { throw '请完整解压金宝安装包，缺少内置运行环境。' }
$StateDir=[IO.Path]::GetFullPath($StateDir)
[IO.Directory]::CreateDirectory($StateDir) | Out-Null
$hash=[Security.Cryptography.SHA256]::Create()
try{$identity=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($StateDir.ToLowerInvariant())))).Replace('-','').Substring(0,16)}finally{$hash.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Local\JinbaoLauncher-'+$identity))
$owned=$false
try {
    try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
    if(!$owned){& (Join-Path $packageRoot 'tools\desktop-release\start-overlay.ps1') -StateDir $StateDir;exit 0}
    if($CheckOnly){& $node (Join-Path $PSScriptRoot 'main.mjs') --state $StateDir --check;exit $LASTEXITCODE}
    . (Join-Path $PSScriptRoot 'legacy-overlay.ps1')
    if(@(Find-JinbaoLegacyOverlay).Count -gt 0){
        $status=@{phase='legacy-active';message='正在使用 DSH 已启动的金宝悬浮窗，下载版未接管现有开发配置。';updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $StateDir 'launcher-state.json'),$status,[Text.UTF8Encoding]::new($false))
        exit 0
    }
    $status=@{phase='starting';message='正在启动金宝…';updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $StateDir 'launcher-state.json'),$status,[Text.UTF8Encoding]::new($false))
    & (Join-Path $packageRoot 'tools\desktop-release\start-overlay.ps1') -StateDir $StateDir | Out-Null
    & $node (Join-Path $PSScriptRoot 'main.mjs') --state $StateDir
} catch {
    $status=@{phase='error';message='启动失败，请完整解压安装包，或从高级维护菜单检查安装。';updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $StateDir 'launcher-state.json'),$status,[Text.UTF8Encoding]::new($false))
    throw
} finally { if($owned){$mutex.ReleaseMutex()};$mutex.Dispose() }
