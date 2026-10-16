$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$node = Join-Path $packageRoot 'runtime\node.exe'
function Invoke-PackageScript([string]$RelativePath, [string[]]$ExtraArguments = @()) {
    $script = Join-Path $packageRoot $RelativePath
    if (!(Test-Path -LiteralPath $script -PathType Leaf)) { throw '运行文件不完整，请重新完整解压安装包。' }
    & $powerShell -NoProfile -ExecutionPolicy Bypass -File $script @ExtraArguments
    if ($LASTEXITCODE -ne 0) { throw "操作失败（退出码 $LASTEXITCODE），请保留上方错误信息。" }
}
while ($true) {
    Write-Host ''
    Write-Host '金宝 · 高级维护（日常使用请双击“开始使用”）'
    Write-Host '1. 启动金宝'
    Write-Host '2. 打开设置'
    Write-Host '3. 修复安装（请先保存工作并关闭 DSH）'
    Write-Host '4. 退出金宝悬浮窗和采集'
    Write-Host 'Q. 关闭维护菜单'
    $selection = Read-Host '请选择'
    if ($null -eq $selection) { exit 0 }
    try {
        switch ($selection.Trim().ToUpperInvariant()) {
            '1' { Invoke-PackageScript 'tools\jinbao-launcher\start.ps1' }
            '2' { Invoke-PackageScript 'tools\desktop-release\open-settings.ps1' }
            '3' {
                if (!(Test-Path -LiteralPath $node -PathType Leaf)) { throw '缺少内置运行时，请重新完整解压安装包。' }
                Invoke-PackageScript 'tools\desktop-release\install.ps1' @('-NodePath', $node)
                Write-Host '安装完成。请选择 1 启动金宝。'
            }
            '4' { Invoke-PackageScript 'tools\desktop-release\stop-overlay.ps1' }
            'Q' { exit 0 }
            default { Write-Host '请输入 1–4 或 Q。' }
        }
    } catch { Write-Host ("操作未完成：" + $_.Exception.Message) -ForegroundColor Red }
}
