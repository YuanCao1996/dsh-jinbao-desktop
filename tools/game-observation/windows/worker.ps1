$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.action -eq 'specialized_activity') {
        $processes = [System.Diagnostics.Process]::GetProcessesByName('League of Legends')
        $active = @($processes).Count -gt 0
        foreach ($process in $processes) { $process.Dispose() }
        [Console]::WriteLine((@{ ok = $true; active = $active } | ConvertTo-Json -Compress))
        exit 0
    }
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowCapture.cs') -ReferencedAssemblies System.Drawing
    [GenericGameCapture.Native]::Initialize()
    if ($request.action -eq 'list') {
        $result = @{ ok = $true; windows = @([GenericGameCapture.Native]::List()) }
    } elseif ($request.action -eq 'capture' -and $request.authorized -eq $true) {
        $p = $request.plan
        $r = $p.pixel_roi
        $size = $p.output_size
        $frame = [GenericGameCapture.Native]::Capture(
            [string]$request.target_id, [int]$request.width, [int]$request.height,
            [int]$r.x, [int]$r.y, [int]$r.width, [int]$r.height, [int]$size.width, [int]$size.height)
        $result = @{ ok = $true; frame = $frame }
    } else {
        throw 'invalid_worker_request'
    }
    [Console]::WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
} catch {
    $reason = $_.Exception.GetBaseException().Message
    if ($reason -notmatch '^[a-z_]+$') { $reason = 'native_capture_failed' }
    [Console]::WriteLine((@{ ok = $false; reason = $reason } | ConvertTo-Json -Compress))
    exit 1
}
