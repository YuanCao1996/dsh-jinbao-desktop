# Presentation only: Agent state, history and tools continue to live in DSH.
function New-OverlayLabel([string]$value,[double]$size,[string]$color){
 $label=New-Object Windows.Controls.TextBlock;$label.Text=$value;$label.FontSize=$size;$label.Foreground=$color;$label.TextWrapping='Wrap';$label.LineHeight=[Math]::Ceiling($size*1.65)
 return $label
}
function New-OverlaySurfaceBrush([string]$hex){
 $color=[Windows.Media.ColorConverter]::ConvertFromString($hex);$color.A=[byte][Math]::Round(255*$controls.OpacitySlider.Value/100*0.45)
 return New-Object Windows.Media.SolidColorBrush($color)
}
function Update-OverlayComposer {
 if(!$controls.ComposerPlaceholder){return}
 $controls.ComposerPlaceholder.Visibility=if($controls.QuestionBox.Text){'Collapsed'}else{'Visible'}
 $teamMode=$script:snapshot.teamChatMode -eq 'team'
 if($controls.TeamModeButton){
  $controls.TeamModeButton.Visibility=if($script:snapshot.teamSupported){'Visible'}else{'Collapsed'}
  $controls.TeamManageButton.Visibility=$controls.TeamModeButton.Visibility
  $controls.TeamModeButton.Content=if($teamMode){'队伍'}else{'个人'}
  $controls.ComposerPlaceholder.Text=if($teamMode){'队伍消息 · @金宝 提问'}else{'问问教练 · Enter 发送'}
 }
 $controls.SendButton.Content=if($script:job){'思考中'}else{'发送'}
 $controls.SendButton.ToolTip=if($script:job){'教练正在回复，请稍候'}else{'Enter 发送；Shift+Enter 换行'}
 # 推荐追问不再做成按钮：直接作为输入框里的提示问题自动出现；没有具体建议时用"看画面"兜底。
 $suggestion=[string]$script:snapshot.suggestedQuestion
 if(!$teamMode -and !$suggestion -and $script:snapshot.match -and !$script:snapshot.ended){$suggestion='看看当前画面，我现在该注意什么？'}
 $base=if($teamMode){'队伍消息 · @金宝 提问'}else{'问问教练 · Enter 发送'}
 if($controls.ComposerPlaceholder){
  $controls.ComposerPlaceholder.Text=if($teamMode -or !$suggestion){$base}else{$base+'　例如：'+$suggestion}
  $controls.ComposerPlaceholder.ToolTip=$suggestion
 }
 $progress=if($script:job){if($script:snapshot.status){[string]$script:snapshot.status}else{'教练正在分析…'}}else{''}
 $controls.ChatStatusText.Text=$progress
 if($teamMode){$progress=[string]$script:snapshot.teamChatStatus;$controls.ChatStatusText.Text=$progress}
 $controls.ChatStatusText.Visibility=if($progress){'Visible'}else{'Collapsed'}
}
function Show-OverlayModeMenu {
 $menu=New-Object Windows.Controls.ContextMenu;$menu.Background='#19212A';$menu.Foreground='#E8EEF5';$menu.BorderBrush='#394A59'
 foreach($entry in @(@('large','大框'),@('subtitle','两行字幕'),@('scroll','横向滚动'),@('silent','静默小球'))){
  $item=New-Object Windows.Controls.MenuItem;$item.Header=$entry[1];$item.Tag=$entry[0];$item.IsCheckable=$true
  $item.IsChecked=($entry[0] -eq $script:displayMode) -or ($script:displayMode -eq 'narrow' -and (($entry[0] -eq 'subtitle' -and $script:subtitleMode) -or ($entry[0] -eq 'scroll' -and !$script:subtitleMode)))
  $item.Add_Click({param($sender,$eventArgs) if($sender.Tag -eq 'subtitle'){$script:subtitleMode=$true;Set-DisplayMode 'narrow'}elseif($sender.Tag -eq 'scroll'){$script:subtitleMode=$false;Set-DisplayMode 'narrow'}else{Set-DisplayMode ([string]$sender.Tag)}});$menu.Items.Add($item)|Out-Null
 }
 $script:overlayModeMenu=$menu;$menu.PlacementTarget=$controls.SettingsButton;$menu.IsOpen=!$SelfTest
}
# 战况页顶部只留稳定信息，KDA 与金币是会变的经济数据，放到右侧小徽章里。
function Get-OverlayMetaHead([string]$line){
 if(!$line){return ''}
 $keep=@($line -split ' · ' | Where-Object {$_ -notmatch '^\d+/\d+/\d+$' -and $_ -notmatch '^金币 '})
 return ($keep -join ' · ')
}
function Get-OverlayMetaBadges([string]$line){
 if(!$line){return ''}
 $keep=@($line -split ' · ' | Where-Object {$_ -match '^\d+/\d+/\d+$' -or $_ -match '^金币 '})
 return ($keep -join ' · ')
}
# 时间线里每条消息带上小时:分钟，回看历史时能分清新旧。
function Format-OverlayBubbleTime($at){
 try{$n=[int64]$at}catch{return ''}
 if($n -le 0){return ''}
 try{return [DateTimeOffset]::FromUnixTimeMilliseconds($n).LocalDateTime.ToString('HH:mm')}catch{return ''}
}
# 标题栏状态点：一眼看出在采集、在生成、还是没对局。
function Get-OverlayStatus($snapshot){
 if(!$snapshot){return [pscustomobject]@{state='idle';label='等待对局';color='#6B7280'}}
 if($snapshot.agentError){return [pscustomobject]@{state='error';label='模型异常';color='#F87171'}}
 if($snapshot.status){return [pscustomobject]@{state='busy';label=[string]$snapshot.status;color='#60A5FA'}}
 if($snapshot.ended){return [pscustomobject]@{state='ended';label='对局结束';color='#6B7280'}}
 $phase=[string]$snapshot.phase
 if($snapshot.match -and $phase -eq 'InProgress'){return [pscustomobject]@{state='playing';label='采集中';color='#34D399'}}
 if($snapshot.match -and $phase -eq 'ChampSelect'){return [pscustomobject]@{state='select';label='英雄选择';color='#A78BFA'}}
 if($snapshot.match){return [pscustomobject]@{state='loading';label='加载中';color='#FBBF24'}}
 return [pscustomobject]@{state='idle';label='等待对局';color='#6B7280'}
}
function Update-StatusDot {
 if(-not $controls.StatusDot){return}
 $s=Get-OverlayStatus $script:snapshot
 $script:statusState=$s.state
 try{$controls.StatusDot.Fill=New-OverlaySurfaceBrush $s.color}catch{}
 if($controls.StatusText){$controls.StatusText.Text=$s.label;$controls.StatusText.ToolTip=('状态：'+$s.label)}
}

# 每条消息左侧独立一列：上面时间、下面两字类别标签，颜色区分类别（像语法高亮）。
# 类别固定两字，颜色区分（像语法高亮）；懒初始化，任何加载方式都能用。
function Get-OverlayCategoryColor {
 if(!$script:overlayCategoryColor){
  $script:overlayCategoryColor=@{
   '出装'='#FFD166';'团战'='#F0876B';'符文'='#B79CF0';'进攻'='#7FD1A0';'撤退'='#7FB3D5';
   '阵容'='#C8A6FF';'技能'='#E0B341';'胜率'='#8FBF7F';'局势'='#93A3B4';'开局'='#CBA86C';
   '阵亡'='#E07A7A';'威胁'='#EF9C6B';'地图'='#9AA8B8';'夸奖'='#DFA0C8';'提问'='#8FB4D8';'回答'='#93A3B4'
  }
 }
 return $script:overlayCategoryColor
}
function Get-OverlayCategory($row){
 $stages=@{purchase='出装';enemyChange='威胁';augment='符文';postAugment='符文';death='阵亡';ultimate='技能';ace='团战';turret='进攻';inhib='进攻';objective='进攻';opening='开局';situation='局势'}
 $stage=[string]$row.stage
 $label=''
 if($stage -and $stages.ContainsKey($stage)){$label=$stages[$stage]}
 elseif($row.kind -eq 'praise'){$label='夸奖'}
 elseif($row.dimension){$dims=@{build='出装';risk='威胁';augment='符文';map='地图';now='局势';plan='局势'};$dim=[string]$row.dimension;if($dims.ContainsKey($dim)){$label=$dims[$dim]}}
 # 玩家自己的消息统一标"提问"，关键词归类只用于教练的播报。
 if($row.role -eq 'user'){$label='提问'}
 if(!$label){
  $text=[string]$row.text
  $rules=@(
   @('出装','出装|装备|成装|出什么|补一件|法穿鞋|虚空之杖|大件'),
   @('团战','开团|团战|打团|接团|集火|先手'),
   @('符文','海克斯|强化|质变'),
   @('撤退','撤退|先退|回城|后撤|别追'),
   @('进攻','推塔|压线|越塔|推进|进攻'),
   @('阵容','阵容|对线|换线'),
   @('技能','技能|大招|连招|闪现|控制'),
   @('胜率','胜率|强度|T0|T1')
  )
  foreach($rule in $rules){if($text -match $rule[1]){$label=$rule[0];break}}
 }
 if(!$label){$label=if($row.role -eq 'user'){'提问'}else{'回答'}}

 $colors=Get-OverlayCategoryColor
 # 一个标签不够时补第二个（例如"出装 + 符文"），最多两个。
 $labels=@($label)
 if($row.role -ne 'user' -and $label -ne '回答' -and $label -ne '夸奖'){
  $text=[string]$row.text
  foreach($rule in @(
   @('出装','出装|装备|成装|出什么|补一件|法穿鞋|虚空之杖|大件'),
   @('团战','开团|团战|打团|接团|集火|先手'),
   @('符文','海克斯|强化|质变'),
   @('撤退','撤退|先退|回城|后撤|别追'),
   @('进攻','推塔|压线|越塔|推进|进攻'),
   @('阵容','阵容|对线|换线'),
   @('技能','技能|大招|连招|闪现|控制'),
   @('胜率','胜率|强度|T0|T1')
  )){
   if($labels.Count -ge 2){break}
   if($labels -notcontains $rule[0] -and $text -match $rule[1]){$labels+=$rule[0]}
  }
 }
 $tags=@($labels|ForEach-Object {[pscustomobject]@{label=$_;color=$colors[$_]}})
 [pscustomobject]@{label=$labels[0];labels=$labels;tags=$tags;color=$colors[$labels[0]]}
}
function Update-ChatJump {
 if(!$controls.LatestMessageButton){return}
 $scroll=$controls.PageScroll
 $gap=$scroll.ScrollableHeight-$scroll.VerticalOffset
 # 记住每页是否停在底部：用户一旦上滑就不再自动跟随，回到底部则恢复。
 if($script:scrollFollow){$script:scrollFollow[$script:tab]=$gap -le 24}
 $controls.LatestMessageButton.Visibility=if(($script:tab -eq 'advice' -or $script:tab -eq 'chat') -and $gap -gt 32){'Visible'}else{'Collapsed'}
}
function Update-OverlaySurface([bool]$force=$false){
 Update-StatusDot
 if(!$controls.RichContent){return}
 Update-OverlayComposer
 $font=[double]$controls.FontSlider.Value
 $rows=@($script:snapshot.chatRows|Where-Object {$_ -and $_.text})
 # 战况页把教练建议与对话合并成一条时间线：先取 thread，缺失时退回 chatRows。
 $thread=@($script:snapshot.thread|Where-Object {$_ -and $_.text})
 $key=$script:tab+'|'+$font+'|'+$controls.OpacitySlider.Value+'|'+$controls.PageText.Text+'|'+(ConvertTo-Json -InputObject $rows -Compress -Depth 3)+'|'+(ConvertTo-Json -InputObject $thread -Compress -Depth 3)
 if($force -or $script:surfaceKey -ne $key){
  $script:surfaceKey=$key;$controls.RichContent.Children.Clear()
  # 单条消息时 PowerShell 会把数组摊平成单个对象，.Count 取不到，战况页就会退化成纯文本；强制成数组。
  $bubbles=@(if($script:tab -eq 'advice'){ if($thread.Count){$thread}else{$rows} }else{ $rows })
  if($bubbles.Count){
   if($script:tab -eq 'advice'){
    $metaLine=([string]$controls.PageText.Text -split "`r?`n" | Where-Object {$_ -match '^对局 '} | Select-Object -First 1)
    if($metaLine){
     $metaGrid=New-Object Windows.Controls.Grid
     $metaGrid.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
     $metaGrid.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
     $metaGrid.ColumnDefinitions[1].Width='Auto'
     $metaHead=Get-OverlayMetaHead $metaLine;if(!$metaHead){$metaHead=$metaLine}
     $metaText=New-OverlayLabel $metaHead 11 '#9CAABA';$metaText.VerticalAlignment='Center'
     $metaGrid.Children.Add($metaText)|Out-Null
     $badgeText=Get-OverlayMetaBadges $metaLine
     if($badgeText){
      $badge=New-OverlayLabel $badgeText 11 '#C6A46E';$badge.HorizontalAlignment='Right';$badge.VerticalAlignment='Center'
      $badge.Padding='7,1';$badge.Background=New-OverlaySurfaceBrush '#1F2A36';$badge.Margin='8,0,0,0'
      [Windows.Controls.Grid]::SetColumn($badge,1);$metaGrid.Children.Add($badge)|Out-Null
     }
     $metaGrid.Margin='2,0,2,8'
     $controls.RichContent.Children.Add($metaGrid)|Out-Null
    }
   }
   # 连续同一说话人只显示一次名字（时间仍然每条都有）。
   $lastSpeaker=''
   foreach($row in $bubbles){
    $user=$row.role -eq 'user'
    $category=Get-OverlayCategory $row
    # 符文是本局要当场用的，保留金色竖线强调。
    $highlight=(@($category.labels) -contains '符文')
    $card=New-Object Windows.Controls.Border;$card.CornerRadius=0
    $card.Padding='0,2,0,8'
    $card.Background='Transparent'
    $card.BorderBrush=if($highlight){'#E7BE79'}else{'#1F2A36'}
    $card.BorderThickness=if($highlight){'2,0,0,1'}else{'0,0,0,1'}
    $grid=New-Object Windows.Controls.Grid
    $grid.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
    $grid.ColumnDefinitions[0].Width=62
    $grid.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
    # 左列：上面时间、下面两字类别。
    $gutter=New-Object Windows.Controls.StackPanel;$gutter.Margin='0,0,8,0'
    $when=Format-OverlayBubbleTime $row.at
    $timeText=New-OverlayLabel $(if($when){$when}else{'--:--'}) ([Math]::Max(10,$font-3)) '#63727F'
    $gutter.Children.Add($timeText)|Out-Null
    foreach($tagInfo in @($category.tags)){
     # 标签比正文还大一点，扫一眼就能看清。
     $tag=New-OverlayLabel $tagInfo.label ([Math]::Max(13,$font+1)) $tagInfo.color;$tag.FontWeight='SemiBold'
     $gutter.Children.Add($tag)|Out-Null
    }
    $grid.Children.Add($gutter)|Out-Null
    # 右列：说话人（同一个人连续说话时只说一次）+ 正文。
    $column=New-Object Windows.Controls.StackPanel
    $speakerName=if($row.origin -eq 'team' -and $row.displayName){[string]$row.displayName}elseif($user){if($row.origin -eq 'phone'){'你 · 手机'}else{'你 · 电脑'}}elseif($row.failed){'本次未完成'}else{'金宝'}
    $speakerColor=if($row.failed){'#F5AD91'}elseif($highlight){'#E7BE79'}else{'#8FA0B0'}
    $repeatSpeaker=(-not $highlight) -and ($speakerName -eq $lastSpeaker)
    $lastSpeaker=if($highlight){''}else{$speakerName}
    if(-not $repeatSpeaker){
     $speaker=New-OverlayLabel $speakerName 11 $speakerColor;$speaker.FontWeight='SemiBold';$speaker.Margin='0,0,0,2'
     $column.Children.Add($speaker)|Out-Null
    }
    $body=New-OverlayLabel ([string]$row.text) $font $(if($user){'#CBD5E1'}elseif($row.failed){'#F5AD91'}else{'#EBF0F5'})
    Set-HighlightedText $body ([string]$row.text)
    $column.Children.Add($body)|Out-Null
    [Windows.Controls.Grid]::SetColumn($column,1);$grid.Children.Add($column)|Out-Null
    $card.Child=$grid;$controls.RichContent.Children.Add($card)|Out-Null
    $copyMenu=New-Object Windows.Controls.ContextMenu;$copyMenu.Background='#19212A';$copyMenu.Foreground='#E8EEF5';$copyItem=New-Object Windows.Controls.MenuItem;$copyItem.Header='复制这条消息';$copyItem.Tag=[string]$row.text;$copyItem.Add_Click({param($sender,$eventArgs) try{[Windows.Clipboard]::SetText([string]$sender.Tag)}catch{}});$copyMenu.Items.Add($copyItem)|Out-Null;$card.ContextMenu=$copyMenu
   }
  }elseif($script:tab -eq 'events'){
   foreach($line in ($controls.PageText.Text -split "`r?`n"|Where-Object {$_})){
    $row=New-Object Windows.Controls.Grid;$row.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition));$row.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition));$row.ColumnDefinitions[0].Width=58;$row.ColumnDefinitions[1].Width='*'
    $clock='';$value=$line;if($line -match '^(\d{2,3}:\d{2}|时间未知)\s+(.+)$'){$clock=$matches[1];$value=$matches[2]}
    $time=New-OverlayLabel $clock 11 '#C6A46E';$time.Margin='0,2,8,0';$row.Children.Add($time)|Out-Null
    $body=New-OverlayLabel $value $font '#DDE5EE';Set-HighlightedText $body $value;[Windows.Controls.Grid]::SetColumn($body,1);$row.Children.Add($body)|Out-Null
    $edge=New-Object Windows.Controls.Border;$edge.BorderBrush='#26313D';$edge.BorderThickness='0,0,0,1';$edge.Padding='0,9';$edge.Child=$row;$controls.RichContent.Children.Add($edge)|Out-Null
   }
  }elseif($script:tab -ne 'chat' -and $script:tab -ne 'players'){
   $index=0
   foreach($part in ($controls.PageText.Text -split "`r?`n`r?`n"|Where-Object {$_.Trim()})){
    if($script:tab -eq 'advice' -and $index -eq 0 -and $part -match '^对局 '){$meta=New-OverlayLabel $part 11 '#9CAABA';$meta.Margin='2,0,2,12';$controls.RichContent.Children.Add($meta)|Out-Null;$index++;continue}
    $card=New-Object Windows.Controls.Border;$card.Background=New-OverlaySurfaceBrush '#293747';$card.BorderBrush='#293541';$card.BorderThickness=1;$card.CornerRadius=10;$card.Padding=12;$card.Margin='0,0,0,10'
    $column=New-Object Windows.Controls.StackPanel;$lines=$part -split "`r?`n",2
    if($lines.Count -gt 1 -and $lines[0].Length -lt 70){$heading=New-OverlayLabel $lines[0] 12 '#E7BE79';$heading.FontWeight='SemiBold';$heading.Margin='0,0,0,8';$column.Children.Add($heading)|Out-Null;$value=$lines[1]}else{$value=$part}
    $body=New-OverlayLabel $value $font '#E8EEF5';Set-HighlightedText $body $value;$column.Children.Add($body)|Out-Null;$card.Child=$column;$controls.RichContent.Children.Add($card)|Out-Null;$index++
   }
  }
 }
 if($controls.EventTicker){
  # Events stay a single updating line instead of a page of their own.
  $tick=[string]$script:snapshot.eventTicker
  $controls.EventTicker.Text=$tick
  $controls.EventTicker.Visibility=if($tick -and $script:tab -eq 'advice'){'Visible'}else{'Collapsed'}
  $controls.EventTickerPanel.Visibility=$controls.EventTicker.Visibility
 }
 $rich=$controls.RichContent.Children.Count -gt 0 -and $controls.PlayersTable.Visibility -ne 'Visible'
 $controls.RichContent.Visibility=if($rich){'Visible'}else{'Collapsed'}
 if($rich){$controls.PageText.Visibility='Collapsed'}
}
$controls.QuestionBox.Add_TextChanged({Update-OverlayComposer})

$controls.PageScroll.Add_ScrollChanged({Update-ChatJump})
$controls.LatestMessageButton.Add_Click({$controls.PageScroll.ScrollToEnd()})
