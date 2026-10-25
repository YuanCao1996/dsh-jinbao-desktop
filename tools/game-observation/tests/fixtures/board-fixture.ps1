$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot '../../windows/WindowCapture.cs') -ReferencedAssemblies System.Drawing
[GenericGameCapture.Native]::Initialize()
Add-Type -Path (Join-Path $PSScriptRoot 'BoardFixture.cs') -ReferencedAssemblies System.Drawing,System.Windows.Forms
[GenericBoardFixture]::Run()
