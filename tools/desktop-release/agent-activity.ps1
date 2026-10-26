# Display-only trace. No arguments, credentials or private reasoning are rendered.
foreach($name in @('AgentActivityPanel','AgentActivityScroll','AgentActivityRows','AgentActivityLatest')){$controls[$name]=$window.FindName($name)}
$script:activityRevision=-1;$script:activityNodes=@{};$script:activityFollow=$true;$script:activityRendering=$false;$script:activityJob=$null
$controls.ActivityMenuItem=New-Object Windows.Controls.MenuItem
$controls.ActivityMenuItem.Header='直播展示：智能体过程';$controls.ActivityMenuItem.IsCheckable=$true
$controls.ActivityMenuItem.ToolTip='仅在大框战况页显示真实执行过程；网页设置中也可以开启。'
$controls.SettingsButton.ContextMenu.Items.Add($controls.ActivityMenuItem)|Out-Null
function Update-ActivityJump {
 $scroll=$controls.AgentActivityScroll
 $controls.AgentActivityLatest.Visibility=if(!$script:activityFollow -and $scroll.ScrollableHeight-$scroll.VerticalOffset -gt 8){'Visible'}else{'Collapsed'}
}
$controls.AgentActivityScroll.Add_ScrollChanged({param($sender,$e)
 if(!$script:activityRendering -and $e.VerticalChange -ne 0){$script:activityFollow=$sender.ScrollableHeight-$sender.VerticalOffset -lt 12}
 Update-ActivityJump
})
$controls.AgentActivityLatest.Add_Click({$script:activityFollow=$true;$controls.AgentActivityScroll.ScrollToEnd();Update-ActivityJump})
$controls.ActivityMenuItem.Add_Click({
 if($script:activityJob){return}
 try{
  $link=[IO.File]::ReadAllText((Join-Path $StateDir 'settings-link.txt')).Trim()
  if($link -notmatch '^http://127\.0\.0\.1:[0-9]+/#[a-f0-9]{64}$'){throw 'invalid local link'}
  $uri=[Uri]$link;$endpoint=$uri.GetLeftPart([UriPartial]::Authority)+'/api/agent-activity'
  $body=@{enabled=[bool]$controls.ActivityMenuItem.IsChecked}|ConvertTo-Json -Compress
  $script:activityJob=Start-Job -ArgumentList $endpoint,$uri.Fragment.Substring(1),$body -ScriptBlock {
   param($endpoint,$nonce,$body)
   try{Invoke-RestMethod -Uri $endpoint -Method Post -Headers @{'x-jinbao-setup'=$nonce} -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5|Out-Null;@{ok=$true}}catch{@{ok=$false}}
  }
  $controls.ActivityMenuItem.IsEnabled=$false
 }catch{$controls.HintText.Text='设置保存失败，请在网页设置中重试。'}
})
function Update-AgentActivity {
 if($script:activityJob -and $script:activityJob.State -ne 'Running'){
  $result=Receive-Job $script:activityJob -ErrorAction SilentlyContinue;Remove-Job $script:activityJob -Force -ErrorAction SilentlyContinue;$script:activityJob=$null
  if(!$result.ok){$controls.HintText.Text='设置保存失败，请在网页设置中重试。'}
 }
 $activity=$script:snapshot.agentActivity
 $controls.ActivityMenuItem.IsEnabled=($activity.supported -eq $true -and !$script:activityJob)
 if(!$script:activityJob){$controls.ActivityMenuItem.IsChecked=$activity.enabled -eq $true}
 $visible=$activity.enabled -eq $true -and $script:tab -eq 'advice' -and $script:displayMode -eq 'large' -and !$script:collapsed
 $controls.AgentActivityPanel.Visibility=if($visible){'Visible'}else{'Collapsed'}
 $controls.AgentActivityPanel.MaxHeight=[Math]::Min(180,[Math]::Max(48,$window.ActualHeight*0.28))
 if(!$activity.enabled){$controls.AgentActivityRows.Children.Clear();$script:activityNodes=@{};$script:activityRevision=-1;return}
 if(!$visible -or $script:activityRevision -eq $activity.revision){return}
 $script:activityRevision=$activity.revision;$scroll=$controls.AgentActivityScroll;$offset=$scroll.VerticalOffset
 $script:activityRendering=$true
 try{
  $rows=@($activity.rows|Where-Object {$_ -and $_.id}|Select-Object -Last 40);$ids=@{}
  foreach($row in $rows){
   $id=[string]$row.id;$ids[$id]=$true
   if(!$script:activityNodes.ContainsKey($id)){
    $line=New-Object Windows.Controls.TextBlock;$line.TextWrapping='Wrap';$line.FontSize=11;$line.LineHeight=18;$line.Margin='0,2,6,3'
    $script:activityNodes[$id]=$line;$controls.AgentActivityRows.Children.Add($line)|Out-Null
   }
   $line=$script:activityNodes[$id]
   $phase=switch([string]$row.phase){'running'{'进行中'}'queued'{'等待'}'done'{'完成'}'failed'{'失败'}'unavailable'{'不可用'}'cancelled'{'已取消'}'draft'{'草稿'}default{''}}
   $duration=if($null -ne $row.elapsedMs){' · '+([Math]::Round([double]$row.elapsedMs/1000,1))+'秒'}else{''}
   $line.Text=([string]$row.clock)+'  '+([string]$row.topic)+' · '+([string]$row.label)+' · '+$phase+$duration
   if($row.text){$line.Text+="`n"+[string]$row.text}
   $line.Foreground=switch([string]$row.phase){'running'{'#E7BE79'}'failed'{'#F5AD91'}'draft'{'#AEBECE'}default{'#94A3B8'}}
  }
  foreach($id in @($script:activityNodes.Keys)){if(!$ids.ContainsKey($id)){$controls.AgentActivityRows.Children.Remove($script:activityNodes[$id]);$script:activityNodes.Remove($id)}}
  if(!$rows.Count){$line=New-Object Windows.Controls.TextBlock;$line.Text='等待下一次分析；完成后的建议仍显示在上方。';$line.Foreground='#94A3B8';$line.FontSize=11;$line.TextWrapping='Wrap';$controls.AgentActivityRows.Children.Clear();$controls.AgentActivityRows.Children.Add($line)|Out-Null}
  elseif($controls.AgentActivityRows.Children.Count -gt $script:activityNodes.Count){for($i=$controls.AgentActivityRows.Children.Count-1;$i -ge 0;$i--){if($controls.AgentActivityRows.Children[$i] -notin @($script:activityNodes.Values)){$controls.AgentActivityRows.Children.RemoveAt($i)}}}
  $scroll.UpdateLayout();if($script:activityFollow){$scroll.ScrollToEnd()}else{$scroll.ScrollToVerticalOffset($offset)}
 }finally{$script:activityRendering=$false}
 Update-ActivityJump
}
$window.Add_Closed({if($script:activityJob){Stop-Job $script:activityJob -ErrorAction SilentlyContinue;Remove-Job $script:activityJob -Force -ErrorAction SilentlyContinue;$script:activityJob=$null}})
function Test-AgentActivitySurface {
 $before=$script:snapshot
 $script:snapshot=$script:snapshot|ConvertTo-Json -Depth 12|ConvertFrom-Json
 $activity=@{supported=$true;enabled=$true;revision=1;rows=@(1..40|ForEach-Object {@{id="trace-$_";topic='自动教练';clock='08:32';label="读取关键事件 $_";phase='done';elapsedMs=400}})}
 $script:snapshot|Add-Member -Force NoteProperty agentActivity $activity
 Set-DisplayMode 'large';Set-Tab 'advice';Update-AgentActivity;$window.UpdateLayout()
 $script:testResult.activityLargeOnly=$controls.AgentActivityPanel.IsVisible -and $controls.AgentActivityRows.Children.Count -eq 40
 $node=$script:activityNodes['trace-40'];$controls.AgentActivityScroll.ScrollToTop();$window.UpdateLayout();$script:activityFollow=$false
 $activity.rows[-1].label='读取阵容完成';$activity.revision++;Update-AgentActivity;$window.UpdateLayout()
 $script:testResult.activityIncremental=$node -eq $script:activityNodes['trace-40'] -and $node.Text.Contains('读取阵容完成')
 $script:testResult.activityScrollHeld=$controls.AgentActivityScroll.VerticalOffset -lt 1 -and $controls.AgentActivityLatest.Visibility -eq 'Visible'
 $controls.AgentActivityLatest.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)));$window.UpdateLayout()
 $script:testResult.activityLatestWorks=$controls.AgentActivityScroll.ScrollableHeight-$controls.AgentActivityScroll.VerticalOffset -lt 2
 Set-Tab 'chat';$script:testResult.activityHiddenChat=$controls.AgentActivityPanel.Visibility -eq 'Collapsed'
 Set-Tab 'advice';Set-DisplayMode 'narrow';$script:testResult.activityHiddenNarrow=$controls.AgentActivityPanel.Visibility -eq 'Collapsed'
 Set-DisplayMode 'large';$activity.enabled=$false;Update-AgentActivity
 $script:testResult.activityOffClears=$controls.AgentActivityPanel.Visibility -eq 'Collapsed' -and $controls.AgentActivityRows.Children.Count -eq 0
 $script:snapshot=$before;Update-Page
}
