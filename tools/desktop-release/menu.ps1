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
    Write-Host '1. 安装扩展（先关闭 DSH Desktop）'
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
                if (!(Test-Path -LiteralPath $node -PathType Leaf)) { throw '缺少内置运行时，请完整解压安装包。' }
                Invoke-PackageScript 'install.ps1' @('-NodePath', $node)
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
