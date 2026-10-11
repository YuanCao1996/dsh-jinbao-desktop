param([string]$ProfilesRoot=(Join-Path $env:USERPROFILE '.dsh/profiles'),[string]$StateDir=(Join-Path $env:USERPROFILE '.dsh/jinbao'),[string]$NodePath,[switch]$DryRun,[switch]$KeepOverlay)
$ErrorActionPreference='Stop'
if(!$NodePath){$command=Get-Command node.exe -ErrorAction SilentlyContinue;if($command){$NodePath=$command.Source}}
if(!$NodePath){throw 'Node.js 22+ is required. Supply -NodePath with the DSH bundled node.exe path, or install Node.js 22+.'}
$argsList=@((Join-Path $PSScriptRoot 'install.mjs'),'--profiles',$ProfilesRoot,'--state',$StateDir)
if($DryRun){$argsList+='--dry-run'}
& $NodePath @argsList
if($LASTEXITCODE -ne 0){throw 'Installation failed. Existing Desktop patch was not replaced.'}
if(!$DryRun -and !$KeepOverlay){& (Join-Path $PSScriptRoot 'stop-overlay.ps1') -StateDir $StateDir}
