# overlay-categories.regression.ps1 —— 标签判定回归（真实播报语料）
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'overlay-categories.ps1')
function Get-OverlayCategoryColor { return @{ '出装'='#FFD166';'团战'='#F0876B';'符文'='#B79CF0';'撤退'='#7FB3D5';'进攻'='#7FD1A0';'阵容'='#C8A6FF';'技能'='#E0B341';'胜率'='#8FBF7F';'局势'='#93A3B4';'提问'='#8FB4D8';'回答'='#93A3B4';'夸奖'='#DFA0C8' } }
$script:snapshot = @{ itemKeywords=@('虚空之杖','法师靴','中娅沙漏'); augmentKeywords=@('珠光护手','炼狱导管'); heroKeywords=@('锐雯','凯隐') }
$fail = 0
$row = @{ text = "先退到塔后等锐雯大招落空再上前，血量低于四成先拉开。"; role = "assistant" }
$got = (Get-OverlayTagCategory $row).label
if ($got -ne "撤退") { Write-Output ("  FAIL 期望 撤退 实得 " + $got + " ← " + $row.text); $script:fail++ } else { Write-Output ("  OK   " + $got) }
$row = @{ text = "先补虚空之杖，锐雯的魔抗会被吃穿；下次回城再做法师靴。"; role = "assistant" }
$got = (Get-OverlayTagCategory $row).label
if ($got -ne "出装") { Write-Output ("  FAIL 期望 出装 实得 " + $got + " ← " + $row.text); $script:fail++ } else { Write-Output ("  OK   " + $got) }
$row = @{ text = "开团前等队友控制，集火对方后排，别追残血。"; role = "assistant" }
$got = (Get-OverlayTagCategory $row).label
if ($got -ne "团战") { Write-Output ("  FAIL 期望 团战 实得 " + $got + " ← " + $row.text); $script:fail++ } else { Write-Output ("  OK   " + $got) }
$row = @{ text = "海克斯首选珠光护手，和炼狱导管联动最稳。"; role = "assistant" }
$got = (Get-OverlayTagCategory $row).label
if ($got -ne "符文") { Write-Output ("  FAIL 期望 符文 实得 " + $got + " ← " + $row.text); $script:fail++ } else { Write-Output ("  OK   " + $got) }
$row = @{ text = "对面双前排，我们阵容缺乏开团手段，改打反手。"; role = "assistant" }
$got = (Get-OverlayTagCategory $row).label
if ($got -ne "阵容") { Write-Output ("  FAIL 期望 阵容 实得 " + $got + " ← " + $row.text); $script:fail++ } else { Write-Output ("  OK   " + $got) }
$row = @{ text = "对面已三件成装，输出压制明显，先把兵线推出去再回城。"; role = "assistant" }
$got = (Get-OverlayTagCategory $row).label
if ($got -ne "出装") { Write-Output ("  FAIL 期望 出装 实得 " + $got + " ← " + $row.text); $script:fail++ } else { Write-Output ("  OK   " + $got) }
if ($fail -gt 0) { Write-Output ("回归失败 " + $fail + " 条"); exit 1 }
Write-Output '标签判定回归通过'