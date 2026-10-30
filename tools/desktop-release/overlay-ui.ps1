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
 $suggestion=[string]$script:snapshot.suggestedQuestion
 $controls.SuggestButton.Visibility=if($suggestion){'Visible'}else{'Collapsed'}
 $controls.SuggestButton.ToolTip=if($suggestion){$suggestion}else{'当前没有可用建议问题'}
 $controls.ScreenButton.IsEnabled=!!($script:snapshot.match -and !$script:snapshot.ended)
 $controls.ScreenButton.Visibility=if($teamMode){'Collapsed'}else{'Visible'}
 if($teamMode){$controls.SuggestButton.Visibility='Collapsed'}
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
function Update-ChatJump {
 if(!$controls.LatestMessageButton){return}
 $scroll=$controls.PageScroll
 $controls.LatestMessageButton.Visibility=if($script:tab -eq 'chat' -and $scroll.ScrollableHeight-$scroll.VerticalOffset -gt 32){'Visible'}else{'Collapsed'}
}
function Update-OverlaySurface([bool]$force=$false){
 if(!$controls.RichContent){return}
 Update-OverlayComposer
 $font=[double]$controls.FontSlider.Value
 $rows=@($script:snapshot.chatRows|Where-Object {$_ -and $_.text})
 $key=$script:tab+'|'+$font+'|'+$controls.OpacitySlider.Value+'|'+$controls.PageText.Text+'|'+(ConvertTo-Json -InputObject $rows -Compress -Depth 3)
 if($force -or $script:surfaceKey -ne $key){
  $script:surfaceKey=$key;$controls.RichContent.Children.Clear()
  if($script:tab -eq 'chat' -and $rows.Count){
   foreach($row in $rows){
    $user=$row.role -eq 'user';$card=New-Object Windows.Controls.Border;$card.CornerRadius=10;$card.Padding='12,10';$card.Margin=if($user){'40,0,0,10'}else{'0,0,20,10'};$card.Background=New-OverlaySurfaceBrush $(if($user){'#3F6278'}else{'#293747'});$card.BorderBrush=if($user){'#354C58'}else{'#2B3642'};$card.BorderThickness=1
    $column=New-Object Windows.Controls.StackPanel
    $speakerName=if($row.origin -eq 'team' -and $row.displayName){[string]$row.displayName}elseif($user){if($row.origin -eq 'phone'){'你 · 手机'}else{'你 · 电脑'}}elseif($row.failed){'本次未完成'}else{'金宝'}
    $speaker=New-OverlayLabel $speakerName 11 $(if($row.failed){'#F5AD91'}elseif($user){'#ACBFCE'}else{'#E7BE79'});$speaker.Margin='0,0,0,5';$speaker.FontWeight='SemiBold';$column.Children.Add($speaker)|Out-Null
    $body=New-OverlayLabel ([string]$row.text) $font '#EBF0F5';Set-HighlightedText $body ([string]$row.text);$column.Children.Add($body)|Out-Null;$card.Child=$column;$controls.RichContent.Children.Add($card)|Out-Null
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
 $rich=$controls.RichContent.Children.Count -gt 0 -and $controls.PlayersTable.Visibility -ne 'Visible'
 $controls.RichContent.Visibility=if($rich){'Visible'}else{'Collapsed'}
 if($rich){$controls.PageText.Visibility='Collapsed'}
}
$controls.QuestionBox.Add_TextChanged({Update-OverlayComposer})
[Windows.Controls.Grid]::SetRow($mic,1)
$controls.SuggestButton.Add_Click({
 $suggestion=[string]$script:snapshot.suggestedQuestion
 if(!$suggestion){return}
 $controls.QuestionBox.Text=$suggestion;$controls.QuestionBox.Focus()|Out-Null
})
$controls.ScreenButton.Add_Click({
 if($script:job){return}
 $question=$controls.QuestionBox.Text.Trim()
 $controls.QuestionBox.Text=if($question){'请先查看当前游戏画面，再回答：'+$question}else{'请查看当前游戏画面，结合本局日志说出下一步最重要的决策。'}
 Send-Question
})
$controls.PageScroll.Add_ScrollChanged({Update-ChatJump})
$controls.LatestMessageButton.Add_Click({$controls.PageScroll.ScrollToEnd()})
