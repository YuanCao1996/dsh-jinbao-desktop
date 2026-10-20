param([string]$StateDir)
$ErrorActionPreference='Stop'
if(!$StateDir){$StateDir=Join-Path $(if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}) 'jinbao'}
$linkPath=Join-Path $StateDir 'settings-link.txt'
if(!(Test-Path -LiteralPath $linkPath)){throw 'Start DSH Desktop with the Jinbao plugin first.'}
$url=[IO.File]::ReadAllText($linkPath).Trim()
if($url -notmatch '^http://127\.0\.0\.1:[0-9]+/#[a-f0-9]{64}$'){throw 'Invalid local settings link.'}
Start-Process $url
