$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$node = Join-Path $packageRoot 'runtime\node.exe'

function Invoke-PackageScript([string]$Name, [string[]]$ExtraArguments = @()) {
    $script = Join-Path $PSScriptRoot $Name
    if (!(Test-Path -LiteralPath $script -PathType Leaf)) { throw "缺少文件：$script，请完整解压安装包。" }
    & $powerShell -NoProfile -ExecutionPolicy Bypass -File $script @ExtraArguments
    if ($LASTEXITCODE -ne 0) { throw "操作失败（退出码 $LASTEXITCODE）。请查看上方错误信息。" }
}
function Find-DesktopShortcut() {
    $shell = New-Object -ComObject WScript.Shell
    $roots = @(
        (Join-Path (Join-Path (Join-Path (Join-Path $env:APPDATA 'Microsoft') 'Windows') 'Start Menu') 'Programs'),
        (Join-Path (Join-Path (Join-Path (Join-Path $env:ProgramData 'Microsoft') 'Windows') 'Start Menu') 'Programs')
    )
    foreach ($root in $roots) {
        if (!(Test-Path -LiteralPath $root)) { continue }
        foreach ($shortcut in (Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
            if ($shortcut.BaseName -notmatch 'DeepSeek.*Harness|Harness.*DeepSeek') { continue }
            $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
            if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) { return $target }
        }
    }
    return $null
}
function Invoke-InstallAndOpen() {
    if (!(Test-Path -LiteralPath $node -PathType Leaf)) { throw '缺少内置运行时，请完整解压安装包。' }
    $desktop = Find-DesktopShortcut
    Invoke-PackageScript 'install.ps1' @('-NodePath', $node)
    if (!$desktop) {
        Write-Host '扩展已安装。请从开始菜单启动 DSH Desktop，再选择菜单 2 打开金宝设置。' -ForegroundColor Yellow
        return
    }
    $startedAt = [DateTime]::UtcNow
    Start-Process -FilePath $desktop
    $linkPath = Join-Path $env:USERPROFILE '.dsh/jinbao/settings-link.txt'
    $url = $null
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        Start-Sleep -Seconds 1
        if (!(Test-Path -LiteralPath $linkPath -PathType Leaf)) { continue }
        $item = Get-Item -LiteralPath $linkPath
        if ($item.LastWriteTimeUtc -lt $startedAt.AddSeconds(-2)) { continue }
        $candidate = [IO.File]::ReadAllText($linkPath).Trim()
        if ($candidate -match '^http://127.0.0.1:[0-9]+/#[a-f0-9]{64}$') { $url = $candidate; break }
    }
    if ($url) {
        Start-Process $url
        Write-Host '扩展已安装，DSH 已重启，金宝设置页已打开。' -ForegroundColor Green
    } else {
        Write-Host 'DSH 已启动，但暂未检测到设置页。请稍等后选择菜单 2。' -ForegroundColor Yellow
    }
}
function Invoke-Collector([string]$RelativePath) {
    $collector = Join-Path $packageRoot $RelativePath
    if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $collector -PathType Leaf)) {
        throw '运行文件不完整，请完整解压安装包后重试。'
    }
    Invoke-PackageScript 'start-overlay.ps1'
    & $node $collector
    if ($LASTEXITCODE -ne 0) { throw "采集器退出（退出码 $LASTEXITCODE）。请查看上方错误信息。" }
}
while ($true) {
    Write-Host ''
    Write-Host '金宝 DSH 游戏扩展'
    Write-Host '1. 一键安装并重启 DSH（请先保存工作并关闭）'
    Write-Host '2. 打开设置和实时策略（先启动 DSH Desktop）'
    Write-Host '3. 启动 LoL 采集和策略悬浮窗'
    Write-Host '4. 启动王者采集和策略悬浮窗'
    Write-Host '5. 打开 DSH Desktop 官方下载页'
    Write-Host '6. 单独打开策略悬浮窗'
    Write-Host 'Q. 退出'
    $selection = Read-Host '请选择'
    if ($null -eq $selection) { exit 0 }
    try {
        switch ($selection.Trim().ToUpperInvariant()) {
            '1' {
                Invoke-InstallAndOpen
            }
            '2' { Invoke-PackageScript 'open-settings.ps1' }
            '3' { Invoke-Collector 'tools\lol-companion\collector.mjs' }
            '4' { Invoke-Collector 'tools\desktop-release\capture-wzry.mjs' }
            '5' { Start-Process 'https://deepseek.com/harness/' }
            '6' { Invoke-PackageScript 'start-overlay.ps1' }
            'Q' { exit 0 }
            default { Write-Host '请输入 1–6 或 Q。' }
        }
    } catch {
        Write-Host ("操作未完成：" + $_.Exception.Message) -ForegroundColor Red
        Write-Host '请保留上方错误信息；可以重新选择菜单操作。'
    }
}
