param(
  [string]$OutDir = '',
  [string]$StateDir = ''
)
# Renders the real overlay XAML headless and saves the welcome-guide screenshots.
#
# The guide screenshots were captured on 2026-10-21, when the overlay still had six tabs
# (装备/事件/聊天). The equipment page was removed and the other two were merged into the
# battle page, so the shipped guide showed users a tab bar that no longer exists. Driving
# the production XAML through RenderTargetBitmap keeps the pictures and the code in sync by
# construction — there is no hand-editing of images.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutDir) { $OutDir = Join-Path $root '..\dsh-onboarding\welcome' }
$main = Join-Path $root 'strategy-overlay.ps1'
$module = Join-Path $root 'overlay-modes.ps1'
foreach ($file in @($main, $module, (Join-Path $root 'overlay-ui.ps1'), (Join-Path $root 'confirmation-countdown.ps1'))) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw "Invalid production PowerShell: $file" }
  foreach ($fn in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) { Invoke-Expression $fn.Extent.Text }
}
$source = [IO.File]::ReadAllText($main)
$match = [regex]::Match($source, "(?s)\[xml\]\`$xaml=@'\r?\n(.*?)\r?\n'@")
if (-not $match.Success) { throw 'Production XAML not found' }
[xml]$xaml = $match.Groups[1].Value
$window = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$window.Left = 40; $window.Top = 40
$script:window = $window
$controls = @{}
foreach ($nameMatch in [regex]::Matches($match.Groups[1].Value, 'x:Name="([^"]+)"')) {
  $name = $nameMatch.Groups[1].Value
  $controls[$name] = $window.FindName($name)
}
$script:controls = $controls
$script:SelfTest = $true
$script:windowHandle = [IntPtr]::Zero
$script:interactiveMode = $false
$script:dragging = $false
$script:collapsed = $false
$script:closing = $false
$script:expandedWidth = 580
$script:expandedHeight = 600
$script:narrowWidth = 600
$script:displayMode = 'large'
$script:subtitleMode = $true
$script:subtitleLines = @()
$script:subtitleIndex = 0
$script:tab = 'advice'
$script:renderedTab = $null
$script:scrollPositions = @{}
$script:scrollFollow = @{}
$script:playbackQueue = New-Object 'Collections.Generic.List[object]'
$script:seenPlayback = New-Object 'Collections.Generic.HashSet[string]'
$script:seenPlaybackOrder = New-Object 'Collections.Generic.Queue[string]'
$script:playbackMatch = 'lol:test'
$script:speakEnabled = $false
$script:unread = 0
$script:activityNodes = New-Object 'Collections.Generic.List[object]'
$script:captureAffinity = 0
$script:showInCapture = $true
$script:lastCaptureHeartbeat = 0
$script:lastRefreshAt = 0
$script:refreshBusy = $false
$settingsMenu = [pscustomobject]@{ IsOpen = $false }
$quickConfirm = [pscustomobject]@{ IsOpen = $false }
$area = New-Object Windows.Rect(0, 0, 1920, 1080)
$activity = [pscustomobject]@{ enabled = $false; snapshot = { [pscustomobject]@{ supported = $true; enabled = $false; rows = @(); revision = 0 } } }
$script:snapshot = $null

function Layout {
  $window.Content.Measure((New-Object Windows.Size($window.Width, $window.Height)))
  $window.Content.Arrange((New-Object Windows.Rect(0, 0, $window.Width, $window.Height)))
  $window.UpdateLayout()
}

function Save-Frame([string]$name) {
  if (-not (Test-Path $OutDir)) { [IO.Directory]::CreateDirectory($OutDir) | Out-Null }
  Layout
  $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap([int]$window.Width, [int]$window.Height, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($window.Content)
  $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $path = Join-Path $OutDir ($name + '.png')
  $stream = [IO.File]::Create($path)
  try { $encoder.Save($stream) } finally { $stream.Dispose() }
  Write-Host "  saved $path"
}

$advice = '对局 08:32 · 安妮 · Lv11 · 2/3/8 · 金币 1200'

$augments = @'
英雄 Top10 海克斯 · 安妮
#1 · 珠光护手 · T1 · 胜率 61.24%
#2 · 炼狱导管 · T1 · 胜率 59.87%
#3 · 尤里卡 · T1 · 胜率 58.92%
#4 · 灵魂虹吸 · T1 · 胜率 57.65%
#5 · 恶魔之拥 · T1 · 胜率 56.98%
#6 · 快速射击 · T1 · 胜率 56.31%
#7 · 全面强化 · T2 · 胜率 55.84%
#8 · 巨人杀手 · T2 · 胜率 55.12%
#9 · 法力涌现 · T2 · 胜率 54.66%
#10 · 时空扭曲 · T2 · 胜率 54.02%

资料库推荐组合 · 安妮
珠光护手 + 炼狱导管 + 尤里卡 · 样本胜率 63.81%

等待识别游戏内三选一面板

本局已选
珠光护手
'@

$players = @'
加权样本 · 我方 4/5｜敌方 5/5

英雄胜率 ↓
我 安妮 · 58.4% · T1
友 盖伦 · 54.2% · T2
友 拉克丝 · 55.9% · T2
友 赵信 · 53.1% · T3
友 索拉卡 · 56.7% · T1
敌 锐雯 · 52.8% · T3
敌 劫 · 51.4% · T3
敌 薇恩 · 53.9% · T2
敌 锤石 · 55.2% · T2
敌 阿狸 · 52.1% · T3
'@

$script:snapshot = [pscustomobject]@{
  game = 'lol'; mode = 'KIWI'; match = 'welcome-shot'; phase = 'InProgress'; ended = $false
  title = '金宝 · 英雄联盟'; summary = '安妮 · Lv11 · 2/3/8'; gameTime = '08:32'
  selfChampion = '安妮'; dead = $false; respawn = $null
  advice = $advice; augments = $augments; players = $players; equipment = ''; chat = ''
  # 战况页的真实形态是一条时间线：教练播报 + 玩家提问，带时间与类型强调。
  thread = @(
    [pscustomobject]@{role='assistant';origin='coach';text='先清完兵线再跟队友进场，保留控制技能，等对面交出关键位移后再接团。';at=(Get-Date).AddMinutes(-3).ToUniversalTime().Subtract((Get-Date '1970-01-01')).TotalMilliseconds;dimension='now'}
    [pscustomobject]@{role='assistant';origin='coach';text='海克斯首选珠光护手：技能可暴击，和炼狱导管联动最稳。本局已选：珠光护手。';at=(Get-Date).AddMinutes(-2).ToUniversalTime().Subtract((Get-Date '1970-01-01')).TotalMilliseconds;dimension='augment'}
    [pscustomobject]@{role='user';origin='pc';text='对面锐雯有黑切，我下一件出什么？';at=(Get-Date).AddMinutes(-1).ToUniversalTime().Subtract((Get-Date '1970-01-01')).TotalMilliseconds;dimension=''}
    [pscustomobject]@{role='assistant';origin='coach';text='先补虚空之杖，锐雯的魔抗会被吃穿；下次回城再做法穿鞋。';at=(Get-Date).ToUniversalTime().Subtract((Get-Date '1970-01-01')).TotalMilliseconds;dimension='build'}
  )
  knowledgeStatus = ''; teamWinRates = '加权样本 · 我方 4/5｜敌方 5/5'
  playerRows = @(
    [pscustomobject]@{ side = '我'; champion = '安妮'; winRate = 58.4; winRateText = '58.4%'; tierText = 'T1' }
    [pscustomobject]@{ side = '友'; champion = '盖伦'; winRate = 54.2; winRateText = '54.2%'; tierText = 'T2' }
    [pscustomobject]@{ side = '友'; champion = '拉克丝'; winRate = 55.9; winRateText = '55.9%'; tierText = 'T2' }
    [pscustomobject]@{ side = '友'; champion = '赵信'; winRate = 53.1; winRateText = '53.1%'; tierText = 'T3' }
    [pscustomobject]@{ side = '友'; champion = '索拉卡'; winRate = 56.7; winRateText = '56.7%'; tierText = 'T1' }
    [pscustomobject]@{ side = '敌'; champion = '锐雯'; winRate = 52.8; winRateText = '52.8%'; tierText = 'T3' }
    [pscustomobject]@{ side = '敌'; champion = '劫'; winRate = 51.4; winRateText = '51.4%'; tierText = 'T3' }
    [pscustomobject]@{ side = '敌'; champion = '薇恩'; winRate = 53.9; winRateText = '53.9%'; tierText = 'T2' }
    [pscustomobject]@{ side = '敌'; champion = '锤石'; winRate = 55.2; winRateText = '55.2%'; tierText = 'T2' }
    [pscustomobject]@{ side = '敌'; champion = '阿狸'; winRate = 52.1; winRateText = '52.1%'; tierText = 'T3' }
  )
  confirmation = $null; playback = @(); events = ''; chatRows = @()
  keywords = @('安妮'); status = ''; updatedAt = 0
}

# The tab buttons are created in the production main body (not a function), so mirror it
# here or the rendered window would have an empty tab strip.
foreach ($entry in @(@('advice', '战况'), @('augments', '海克斯'), @('players', '胜率'))) {
  $button = New-Object Windows.Controls.Button
  $button.Tag = $entry[0]; $button.Content = $entry[1]; $button.FontSize = 12; $button.Padding = '4,6'; $button.ToolTip = '切换到' + $entry[1]
  $button.Add_Click({ param($sender, $eventArgs) Set-Tab ([string]$sender.Tag) })
  $controls.Tabs.Children.Add($button) | Out-Null
}

Hide-OverlayHint
$window.Width = 580
$window.Height = 600
foreach ($pair in @(@('advice', 'advice'), @('augments', 'augments'), @('players', 'players'))) {
  Set-Tab $pair[0]
  Update-Page
  Layout
  Save-Frame $pair[1]
}
$window.Close()
Write-Host 'done'
