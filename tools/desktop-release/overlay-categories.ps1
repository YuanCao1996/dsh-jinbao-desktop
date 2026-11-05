# overlay-categories.ps1 —— 播报标签判定（与语法高亮同源，按词长与位置打分）
#
# 旧实现的问题：首个正则命中就定主标签，且规则表把"出装/装备"排在最前，几乎任何建议都会
# 命中它；第二标签只是同一条文本再盲扫一次。标签与语法高亮用的是两套完全不同的来源，
# 于是会出现"文字里高亮了某件装备、标签却是技能"。
#
# 新规则：
#   1) 实体词与高亮同源：命中 itemKeywords→出装、augmentKeywords→符文、英雄名→阵容；
#   2) 类别得分 = Σ(词长权重 × 位置权重)，句首与首句内的命中权重更高；
#   3) 句首动作词（先/立刻/别/等 + 退/上/推/开）把类别推到撤退/进攻/团战；
#   4) 结构化 stage 作为先验加分，但文本证据明显更强时以文本为准。

function Get-OverlayTagScoring {
  param([string]$text)
  $scores = @{ 出装=0.0; 团战=0.0; 符文=0.0; 撤退=0.0; 进攻=0.0; 阵容=0.0; 技能=0.0; 胜率=0.0 }
  if (!$text) { return $scores }
  $rules = @(
    @('出装', '出装|装备|成装|出什么|补一件|法穿鞋|虚空之杖|大件|无尽|中娅|沙漏|鬼书|帽子|法穿|鞋子|复活甲|兰顿|帽兜'),
    @('团战', '开团|团战|打团|接团|集火|先手|切后|绕后|集火目标'),
    @('符文', '海克斯|强化|质变|棱彩|银色|金色'),
    @('撤退', '撤退|先退|回城|后撤|别追|拉开|脱战|撤出'),
    @('进攻', '推塔|压线|越塔|推进|进攻|拔塔|吃线|带线'),
    @('阵容', '阵容|对线|换线|搭配|体系'),
    @('技能', '技能|大招|连招|闪现|控制|位移|禁锢|减速|沉默|护盾'),
    @('胜率', '胜率|强度|T0|T1|T2')
  )
  # 位置权重：整段开头 2.0，第一句内 1.4，其余 1.0；词长权重 1 + 长度/8（长词更具体）
  $firstStop = $text.IndexOf('。'); if ($firstStop -lt 0) { $firstStop = $text.Length }
  foreach ($rule in $rules) {
    $label = [string]$rule[0]; $pattern = [string]$rule[1]
    $matches = [regex]::Matches($text, $pattern)
    foreach ($m in $matches) {
      $factor = if ($m.Index -le 3) { 2.0 } elseif ($m.Index -le $firstStop) { 1.4 } else { 1.0 }
      # 否定词紧邻时降权：「缺乏开团手段」「没有位移」不该被标成团战/技能
      $lookback = $text.Substring([Math]::Max(0, $m.Index - 4), [Math]::Min(4, $m.Index))
      if ($lookback -match '缺乏|缺少|没有|缺少|不|没|缺|少|无') { $factor *= 0.3 }
      $scores[$label] += $factor * (1.0 + [Math]::Min(1.0, $m.Length / 8.0))
    }
  }
  # 句首动作词：把"先退/立刻推/开团前"这类指令归到动作类
  $head = $text.Substring(0, [Math]::Min(12, $text.Length))
  if ($head -match '先[\u4e00-\u9fa5]{0,3}(退|撤|走|回)|立刻(退|撤)|别(追|上)|拉开|脱战') { $scores['撤退'] += 1.6 }
  if ($head -match '先[\u4e00-\u9fa5]{0,3}(上|推|压|进)|立刻(上|推|进)|开团|集火') { $scores['团战'] += 1.2; $scores['进攻'] += 1.0 }
  return $scores
}

function Get-OverlayTagCategory {
  param($row)
  $snapshot = $script:snapshot
  $text = [string]$row.text
  $scores = Get-OverlayTagScoring $text

  # 1) 实体词：与语法高亮同源，权重最高
  $entity = @{}
  foreach ($word in @($snapshot.itemKeywords)) {
    if ($word -and $text.Contains([string]$word)) { $entity['出装'] = 1 + ([Math]::Min(1.0, ([string]$word).Length / 8.0)) }
  }
  foreach ($word in @($snapshot.augmentKeywords)) {
    if ($word -and $text.Contains([string]$word)) { $entity['符文'] = 1 + ([Math]::Min(1.0, ([string]$word).Length / 8.0)) }
  }
  foreach ($word in @($snapshot.heroKeywords)) {
    if ($word -and $text.Contains([string]$word)) { $entity['阵容'] = 0.8 + ([Math]::Min(0.8, ([string]$word).Length / 10.0)) }
  }
  foreach ($key in $entity.Keys) { $scores[$key] += 2.2 * $entity[$key] }

  # 2) 结构化先验：真实阶段判定，但只作为加分
  $prior = @{}
  $stages = @{purchase='出装';enemyChange='威胁';augment='符文';postAugment='符文';death='阵亡';ultimate='技能';ace='团战';turret='进攻';inhib='进攻';objective='进攻';opening='开局';situation='局势'}
  $stage = [string]$row.stage
  if ($stage -and $stages.ContainsKey($stage)) { $prior[$stages[$stage]] = 2.4 }
  elseif ($row.dimension) {
    $dims = @{build='出装';risk='威胁';augment='符文';map='地图';now='局势';plan='局势'}
    $dim = [string]$row.dimension
    if ($dims.ContainsKey($dim)) { $prior[$dims[$dim]] = 2.0 }
  }
  foreach ($key in $prior.Keys) { if ($scores.ContainsKey($key)) { $scores[$key] += $prior[$key] } }

  # 3) 排序取主/次标签
  $ranked = $scores.GetEnumerator() | Where-Object { $_.Value -gt 0 } | Sort-Object -Property Value -Descending
  $labels = @()
  if ($ranked) {
    $labels += $ranked[0].Key
    if ($ranked.Count -gt 1 -and $ranked[1].Value -ge 1.4) { $labels += $ranked[1].Key }
  }
  # 4) 保底
  if ($row.role -eq 'user') { $labels = @('提问') }
  elseif (!$labels -or ($labels.Count -eq 0)) { $labels = @(if ($row.kind -eq 'praise') { '夸奖' } else { '回答' }) }
  elseif ($row.kind -eq 'praise' -and $labels[0] -ne '夸奖') { $labels = @('夸奖') + $labels | Select-Object -First 2 }

  $colors = Get-OverlayCategoryColor
  $tags = @($labels | ForEach-Object { [pscustomobject]@{ label = $_; color = $colors[$_] } })
  [pscustomobject]@{ label = $labels[0]; labels = $labels; tags = $tags; color = $colors[$labels[0]] }
}
