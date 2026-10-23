# Display and input policies; the Agent/session implementation remains in DSH.
foreach($name in @('NarrowPanel','NarrowCanvas','NarrowText','NarrowExpand','NarrowMenu','NarrowClose','BubbleLabel','PreviousSubtitle','OutgoingSubtitle')){$controls[$name]=$window.FindName($name)}
$script:narrowWidth=360.0;
$script:displayMode='large';$script:subtitleMode=$true;$script:speakEnabled=$false;$script:unread=0
$script:playbackMatch='';$script:seenPlayback=New-Object 'Collections.Generic.HashSet[string]'
$script:seenPlaybackOrder=New-Object 'Collections.Generic.Queue[string]'
$script:playbackQueue=New-Object 'Collections.Generic.List[object]';$script:activePlayback=$null
$script:subtitleLines=@();$script:subtitleIndex=0;$script:confirmationJob=$null;$script:speechJob=$null;$script:synth=$null
$displayFile=Join-Path $StateDir 'overlay-display.json'
. (Join-Path $PSScriptRoot 'overlay-playback.ps1')
$quickConfirm=New-Object Windows.Controls.Primitives.Popup;$quickConfirm.Placement='Bottom';$quickConfirm.PlacementTarget=$controls.NarrowPanel;$quickConfirm.AllowsTransparency=$true;$quickConfirm.StaysOpen=$true
$script:popupConfirmId=''
function Show-QuickConfirmation($confirmation){
 $quickConfirm.IsOpen=$false
 if(!$confirmation){$script:popupConfirmId='';return}
 if($script:displayMode -eq 'narrow' -and $script:collapsed){Wake-NarrowPlayback}
 $script:popupConfirmId=[string]$confirmation.id
 $script:popupConfirmKey=Get-ConfirmationChoiceKey $confirmation
 $border=New-Object Windows.Controls.Border;$border.Background='#F0172033';$border.CornerRadius='8';$border.Padding='8';$border.Width=360
 $stack=New-Object Windows.Controls.StackPanel;$title=New-Object Windows.Controls.TextBlock;$title.Text=[string]$confirmation.title+' · 10 秒后默认确认';$title.TextWrapping='Wrap';$title.Foreground='#FBBF24';$title.Margin='4';$stack.Children.Add($title)|Out-Null
 $script:quickConfirmationTitle=$title;$choiceIndex=0
 foreach($option in $confirmation.options){
  $button=New-Object Windows.Controls.Button;$button.Content=[string]$option.label;$button.Margin='3';$button.Padding='6';$button.Background='#29364E';$button.Foreground='#E2E8F0';$button.Tag=@{id=$script:popupConfirmId;name=[string]$option.name}
  Set-ConfirmationChoiceStyle $button $option ($choiceIndex -eq 0);$choiceIndex++
  $button.Add_Click({param($s,$e) Start-Confirmation $s.Tag;$quickConfirm.IsOpen=$false});$stack.Children.Add($button)|Out-Null
 }
 $skip=New-Object Windows.Controls.Button;$skip.Content='都不是 / 暂不确认';$skip.Margin='3';$skip.Tag=@{id=$script:popupConfirmId;dismiss=$true};$skip.Add_Click({param($s,$e) Start-Confirmation $s.Tag;$quickConfirm.IsOpen=$false});$stack.Children.Add($skip)|Out-Null
 $border.Child=$stack;$quickConfirm.Child=$border;$quickConfirm.IsOpen=!$SelfTest
}
function Save-DisplayMode {
 if($SelfTest){return}
 [IO.File]::WriteAllText($displayFile,(@{mode=$script:displayMode;subtitle=$script:subtitleMode;speech=$script:speakEnabled;width=$script:narrowWidth;widthVersion=1}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
function Set-DisplayMode([string]$mode){
 if($mode -notin @('large','narrow','silent')){return}
 $quickConfirm.IsOpen=$false;$script:popupConfirmId=''
 $modeClock.Stop()
 if($script:displayMode -eq 'large' -and !$script:collapsed){$script:expandedWidth=$window.Width;$script:expandedHeight=$window.Height}
 if($script:collapsed){Set-Collapsed $false -PreserveMode}
 $controls.NarrowPanel.Visibility='Collapsed';$controls.Expanded.Visibility='Visible'
 $window.MinWidth=420;$window.MinHeight=220;$window.Width=$script:expandedWidth;$window.Height=$script:expandedHeight
 $script:displayMode=$mode
 $controls.MainBorder.Padding='12';$controls.MainBorder.BorderThickness=1;Set-BackgroundOpacity
 if($mode -eq 'narrow'){
  $script:awaitingPlayback=$true
  Set-Interaction $false
  $window.ResizeMode='NoResize';$controls.Expanded.Visibility='Collapsed';$controls.NarrowPanel.Visibility='Visible';$controls.ResizeGrip.Visibility='Visible';$controls.ResizeGrip.Cursor='SizeWE';$controls.ResizeGrip.Width=14;$controls.ResizeGrip.Height=14;$controls.ResizeGrip.Margin=0
  Set-NarrowMetrics;$window.UpdateLayout();$script:playbackLastTick=Get-PlaybackNow
  if(!$script:activePlayback -and !$script:playbackQueue.Count -and !$script:snapshot.ended){$latest=@($script:snapshot.playback)|Select-Object -Last 1;if($latest -and (Get-PlaybackNow)-[double]$latest.at -lt 30000 -and (!$latest.expiresAt -or (Get-PlaybackNow) -lt [double]$latest.expiresAt)){$script:playbackQueue.Add($latest)}}
  $modeClock.Start()
 }elseif($mode -eq 'silent'){Set-Collapsed $true -PreserveMode}
 else{$controls.ResizeGrip.Visibility='Visible';$controls.ResizeGrip.Cursor='SizeNWSE';$controls.ResizeGrip.Width=26;$controls.ResizeGrip.Height=26;$controls.ResizeGrip.Margin='0,0,-8,-8';$window.ResizeMode='CanResize';$script:unread=0;$controls.BubbleLabel.Text='金宝'}
 $window.Left=[Math]::Max($area.Left,[Math]::Min($window.Left,$area.Right-$window.Width))
 Save-DisplayMode
}
function Set-HighlightedText($view,[string]$value){
 if($view.Tag -eq $value){return};$view.Tag=$value
 $view.Inlines.Clear();$words=@($script:snapshot.keywords|Where-Object {$_ -and $_.Length -ge 2}|Sort-Object Length -Descending|Select-Object -First 64)
 if(!$words.Count){$view.Text=$value;return}
 $pattern=($words|ForEach-Object {[regex]::Escape($_)}) -join '|';$position=0;$count=0
 foreach($hit in [regex]::Matches($value,$pattern)){
  if($count++ -ge 16){break}
  if($hit.Index -gt $position){$view.Inlines.Add((New-Object Windows.Documents.Run($value.Substring($position,$hit.Index-$position))))}
  $heroPrefix=([string]$script:snapshot.summary).Split('·')[0].Trim()
  $run=New-Object Windows.Documents.Run($hit.Value);$run.Foreground=if($hit.Value -eq $heroPrefix){'#C8A6FF'}else{'#FFD166'}
  $view.Inlines.Add($run);$position=$hit.Index+$hit.Length
 }
 if($position -lt $value.Length){$view.Inlines.Add((New-Object Windows.Documents.Run($value.Substring($position))))}
}
function Start-Confirmation([hashtable]$payload){
 if($script:confirmationJob){return}
 $script:confirmationHandledId=[string]$payload.id
 try{
  $url=[Uri]([IO.File]::ReadAllText((Join-Path $StateDir 'settings-link.txt')).Trim())
  if($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.Fragment -notmatch '^#[a-f0-9]{64}$'){throw 'invalid local link'}
  $script:confirmationJob=Start-Job -ArgumentList ($url.GetLeftPart([UriPartial]::Authority)+'/api/overlay/confirm'),$url.Fragment.Substring(1),($payload|ConvertTo-Json -Compress) -ScriptBlock {
   param($endpoint,$nonce,$body)
   try{Invoke-RestMethod -Uri $endpoint -Method Post -Headers @{'x-jinbao-setup'=$nonce} -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10|Out-Null;@{ok=$true}}catch{@{ok=$false}}
  }
  $controls.ConfirmationChoices.IsEnabled=$false
 }catch{$controls.HintText.Text='确认未提交，请重新打开金宝后重试。'}
}
function Update-OverlayPlayback {
 Update-ConfirmationCountdown
 if($script:confirmationJob -and $script:confirmationJob.State -in @('Completed','Failed','Stopped')){
  $result=Receive-Job $script:confirmationJob -ErrorAction SilentlyContinue;Remove-Job $script:confirmationJob -Force;$script:confirmationJob=$null;$controls.ConfirmationChoices.IsEnabled=$true
  $controls.HintText.Text=if($result.ok){'已保存确认，正在更新建议'}else{'确认已过期或提交失败，请按当前选项重试'}
  if(!$result.ok){$script:popupConfirmId='';$controls.ConfirmationPanel.Visibility='Visible';$controls.ConfirmationTitle.Text='确认未提交，请手动选择'}
 }
 if($script:speechJob -and $script:speechJob.State -in @('Completed','Failed','Stopped')){
  $result=Receive-Job $script:speechJob -ErrorAction SilentlyContinue;Remove-Job $script:speechJob -Force;$script:speechJob=$null;$mic.Content='语音'
  if($result.text){$controls.QuestionBox.Text+=[string]$result.text}else{$controls.HintText.Text='未识别到语音，或系统未安装中文语音识别组件；可继续输入文字。'}
 }
 $key=[string]$script:snapshot.game+':'+[string]$script:snapshot.match
 if($key -ne $script:playbackMatch){
  $script:playbackMatch=$key;$script:seenPlayback.Clear();$script:seenPlaybackOrder.Clear();Reset-Playback;$script:playbackInitialized=$false;$script:unread=0
  if($script:synth){$script:synth.SpeakAsyncCancelAll()}
  if($script:speechJob){Stop-Job $script:speechJob;Remove-Job $script:speechJob -Force;$script:speechJob=$null;$mic.Content='语音'}
 }
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 Remove-InvalidPlayback @($script:snapshot.revokedPlayback) $now
 foreach($message in @($script:snapshot.playback)){
  if(!$message -or !$script:seenPlayback.Add([string]$message.id)){continue}
  $script:seenPlaybackOrder.Enqueue([string]$message.id)
  if($script:seenPlaybackOrder.Count -gt 128){$null=$script:seenPlayback.Remove($script:seenPlaybackOrder.Dequeue())}
  if(!$script:playbackInitialized -and $now-[double]$message.at -gt 30000){continue}
  if($script:displayMode -eq 'silent'){$script:unread=[Math]::Min(99,$script:unread+1)}
  if($script:displayMode -eq 'narrow'){
   Add-PlaybackMessage $message
  }
  if($script:speakEnabled){try{if(!$script:synth){Add-Type -AssemblyName System.Speech;$script:synth=New-Object Speech.Synthesis.SpeechSynthesizer;$voice=$script:synth.GetInstalledVoices()|Where-Object {$_.VoiceInfo.Culture.Name -like 'zh*'}|Select-Object -First 1;if(!$voice){throw 'Chinese voice unavailable'};$script:synth.SelectVoice($voice.VoiceInfo.Name)};$script:synth.SpeakAsyncCancelAll();$script:synth.SpeakAsync([string]$message.text)|Out-Null}catch{if($script:synth){try{$script:synth.Dispose()}catch{};$script:synth=$null};$script:speakEnabled=$false;$controls.HintText.Text='本机中文语音不可用，已保留文字播报'}}
 }
 $script:playbackInitialized=$true
 $controls.BubbleLabel.Text=if($script:snapshot.confirmation){'金宝 !'}elseif($script:unread){'金宝 '+$script:unread}else{'金宝'}
 $controls.NarrowExpand.Content=if($script:snapshot.confirmation){'!'}else{'▣'}
 if(!$script:snapshot.confirmation){$quickConfirm.IsOpen=$false;$script:popupConfirmId=''}
 elseif($script:displayMode -eq 'narrow' -and !$script:confirmationJob -and $script:confirmationHandledId -ne [string]$script:snapshot.confirmation.id -and ($script:popupConfirmId -ne [string]$script:snapshot.confirmation.id -or $script:popupConfirmKey -ne (Get-ConfirmationChoiceKey $script:snapshot.confirmation))){Show-QuickConfirmation $script:snapshot.confirmation}
 if($script:displayMode -eq 'narrow' -and !$script:activePlayback -and !$script:playbackQueue.Count -and !$script:snapshot.confirmation){$modeClock.Start()}
}
$modeClock=New-Object Windows.Threading.DispatcherTimer;$modeClock.Interval=[TimeSpan]::FromMilliseconds(16);$modeClock.Add_Tick({Playback-Tick})
$modeMenu=New-Object Windows.Controls.MenuItem;$modeMenu.Header='显示与播报'
foreach($entry in @(@('large','大框'),@('narrow','窄条'),@('silent','静默小球'))){$item=New-Object Windows.Controls.MenuItem;$item.Header=$entry[1];$item.Tag=$entry[0];$item.Add_Click({param($s,$e) Set-DisplayMode ([string]$s.Tag)});$modeMenu.Items.Add($item)|Out-Null}
$subtitleItem=New-Object Windows.Controls.MenuItem;$subtitleItem.Header='字幕：两行向上推进';$subtitleItem.Add_Click({$script:subtitleMode=$true;Save-DisplayMode;Set-DisplayMode 'narrow'});$modeMenu.Items.Add($subtitleItem)|Out-Null
$scrollItem=New-Object Windows.Controls.MenuItem;$scrollItem.Header='窄条：横向滚动';$scrollItem.Add_Click({$script:subtitleMode=$false;Save-DisplayMode;Set-DisplayMode 'narrow'});$modeMenu.Items.Add($scrollItem)|Out-Null
$speechItem=New-Object Windows.Controls.MenuItem;$speechItem.Header='语音播报（本机中文语音）';$speechItem.IsCheckable=$true;$speechItem.Add_Click({$script:speakEnabled=$speechItem.IsChecked;if(!$script:speakEnabled -and $script:synth){$script:synth.SpeakAsyncCancelAll()};Save-DisplayMode});$modeMenu.Items.Add($speechItem)|Out-Null
$settingsMenu.Items.Add($modeMenu)|Out-Null
$controls.NarrowExpand.Add_Click({Set-DisplayMode 'large'})
$controls.NarrowClose.Add_Click({$window.Close()})
$controls.NarrowMenu.Add_Click({$settingsMenu.PlacementTarget=$controls.NarrowMenu;$settingsMenu.IsOpen=$true})
$controls.NarrowPanel.Add_PreviewMouseLeftButtonDown({param($s,$e) Start-Drag $s $e})
$mic=New-Object Windows.Controls.Button;$mic.Content='语音';$mic.ToolTip='点击开始，最长20秒，识别后可编辑再发送；再次点击取消'
$controls.ChatPanel.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
$controls.ChatPanel.ColumnDefinitions[2].Width=[Windows.GridLength]::Auto
[Windows.Controls.Grid]::SetColumn($controls.SendButton,2);[Windows.Controls.Grid]::SetColumn($mic,1);$controls.ChatPanel.Children.Add($mic)|Out-Null
$mic.Add_Click({
 if($script:speechJob){Stop-Job $script:speechJob;Remove-Job $script:speechJob -Force;$script:speechJob=$null;$mic.Content='语音';return}
 $script:speechJob=Start-Job -ScriptBlock {try{Add-Type -AssemblyName System.Speech;$info=[Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()|Where-Object {$_.Culture.Name -eq 'zh-CN'}|Select-Object -First 1;if(!$info){throw 'Chinese recognizer unavailable'};$recognizer=[Speech.Recognition.SpeechRecognitionEngine]::new($info);try{$recognizer.LoadGrammar((New-Object Speech.Recognition.DictationGrammar));$recognizer.SetInputToDefaultAudioDevice();$result=$recognizer.Recognize([TimeSpan]::FromSeconds(20));@{text=[string]$result.Text}}finally{$recognizer.Dispose()}}catch{@{text=''}}}
 $mic.Content='取消';$controls.HintText.Text='正在听，请说话；完成后可编辑再发送。'
})
if(!$SelfTest){try{$savedDisplay=[IO.File]::ReadAllText($displayFile)|ConvertFrom-Json;$script:subtitleMode=$savedDisplay.subtitle -ne $false;$script:speakEnabled=$savedDisplay.speech -eq $true;if($savedDisplay.width -ge 260 -and $savedDisplay.width -le 1200){$script:narrowWidth=if(!$savedDisplay.widthVersion -and $savedDisplay.width -eq 600){360.0}else{[double]$savedDisplay.width}};Set-DisplayMode ([string]$savedDisplay.mode)}catch{}}
