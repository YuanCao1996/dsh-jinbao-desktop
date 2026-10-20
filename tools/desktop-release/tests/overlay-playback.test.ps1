param([string]$StateDir,[string]$ScreenshotDir)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$main=Join-Path $root 'strategy-overlay.ps1';$module=Join-Path $root 'overlay-modes.ps1'
foreach($file in @($main,$module)){
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'Invalid production PowerShell'}
 foreach($fn in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){Invoke-Expression $fn.Extent.Text}
}
$source=[IO.File]::ReadAllText($main)
$match=[regex]::Match($source,"(?s)\[xml\]\`$xaml=@'\r?\n(.*?)\r?\n'@")
if(!$match.Success){throw 'Production XAML not found'}
[xml]$xaml=$match.Groups[1].Value
$window=[Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$window.Left=100;$window.Top=100
$controls=@{}
# Enumerate the original XAML names without binding production timers or native windows.
foreach($nameMatch in [regex]::Matches($match.Groups[1].Value,'x:Name="([^"]+)"')){$name=$nameMatch.Groups[1].Value;$controls[$name]=$window.FindName($name)}
$settingsMenu=[pscustomobject]@{IsOpen=$false};$quickConfirm=[pscustomobject]@{IsOpen=$false};$SelfTest=$true
$script:windowHandle=[IntPtr]::Zero;$script:interactiveMode=$false;$script:dragging=$false;$script:collapsed=$false;$script:closing=$false
$script:expandedWidth=580;$script:expandedHeight=600;$script:narrowWidth=600;$area=New-Object Windows.Rect(0,0,1920,1080)
$script:displayMode='large';$script:subtitleMode=$true;$script:subtitleLines=@();$script:subtitleIndex=0
$script:playbackQueue=New-Object 'Collections.Generic.List[object]'
$script:seenPlayback=New-Object 'Collections.Generic.HashSet[string]';$script:seenPlaybackOrder=New-Object 'Collections.Generic.Queue[string]'
$script:snapshot=[pscustomobject]@{game='lol';match='test';keywords=@();summary='';playback=@();confirmation=$null;ended=$false}
$script:playbackMatch='lol:test';$script:speakEnabled=$false;$script:unread=0
$modeClock=New-Object psobject;$modeClock|Add-Member ScriptMethod Start {};$modeClock|Add-Member ScriptMethod Stop {}
. (Join-Path $root 'overlay-playback.ps1')
$script:playbackTestNow=100000.0
function Layout { $window.Content.Measure((New-Object Windows.Size($window.Width,$window.Height)));$window.Content.Arrange((New-Object Windows.Rect(0,0,$window.Width,$window.Height)));$window.Content.UpdateLayout() }
function Advance([double]$ms){$script:playbackTestNow+=$ms;Playback-Tick}
function Check([string]$name,[bool]$ok){if(!$ok){throw ('Playback regression: '+$name)};$results[$name]=$true}
function Message([string]$id,[string]$text,[int]$priority=0){return [pscustomobject]@{id=$id;text=$text;priority=$priority;at=$script:playbackTestNow}}
function Save-Frame([string]$name){
 if(!$ScreenshotDir){return};[IO.Directory]::CreateDirectory($ScreenshotDir)|Out-Null;Layout
 $bitmap=New-Object Windows.Media.Imaging.RenderTargetBitmap([int]$window.Width,[int]$window.Height,96,96,[Windows.Media.PixelFormats]::Pbgra32)
 $bitmap.Render($window.Content);$encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder;$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
 $stream=[IO.File]::Create((Join-Path $ScreenshotDir ($name+'.png')));try{$encoder.Save($stream)}finally{$stream.Dispose()}
}
$results=@{}
try{
 Set-DisplayMode 'narrow';Layout
 Add-PlaybackMessage (Message 'long' ('A'*600));Advance 31000
 Check 'activeMessageSurvivesThirtySeconds' ($script:activePlayback.id -eq 'long')
 Add-PlaybackMessage (Message 'normal' 'normal advice' 1)
 Check 'ordinaryAdviceDoesNotInterrupt' ($script:activePlayback.id -eq 'long' -and $script:playbackAccelerated)
 1..10|ForEach-Object{Add-PlaybackMessage (Message ('queued-'+$_) ('queued advice '+$_))}
 Check 'queueDoesNotDropOldMessages' ($script:playbackQueue.Count -eq 11 -and $script:playbackQueue[0].id -eq 'normal')
 $pending=$script:playbackQueue.Count;Set-DisplayMode 'large';Advance 100000;Set-DisplayMode 'narrow';Layout;Playback-Tick
 Check 'modeSwitchPreservesActiveAndQueue' ($script:activePlayback.id -eq 'long' -and $script:playbackQueue.Count -eq $pending)
 Add-PlaybackMessage (Message 'urgent' 'urgent warning' 2)
 Check 'onlyUrgentPreempts' ($script:activePlayback.id -eq 'urgent' -and $script:playbackQueue.Count -eq $pending)
 Reset-Playback;$script:subtitleMode=$false;Set-NarrowMetrics;Layout
 Add-PlaybackMessage (Message 'scroll' ('A'*600));Advance 31000
 Check 'longScrollNotCutOff' ($script:activePlayback.id -eq 'scroll' -and $script:playbackPhase -eq 'playing')
 $offset=$script:scrollOffset;Add-PlaybackMessage (Message 'scroll-next' 'next advice');Advance 100
 Check 'scrollAccelerationKeepsPosition' ($script:scrollOffset -gt $offset)
 Save-Frame 'scroll'
 $script:playbackQueue.Clear();Advance 500000
 Check 'scrollStopsAtLastVisibleScreen' ($script:playbackPhase -eq 'linger' -and $script:scrollOffset -eq $script:scrollEnd -and $controls.NarrowText.RenderTransform.X -eq -$script:scrollEnd)
 Advance 2999;Check 'endLingersForReading' (!$script:collapsed -and $script:playbackPhase -eq 'linger')
 Advance 1;Advance 280
 Check 'idleCollapseKeepsMode' ($script:collapsed -and $script:displayMode -eq 'narrow' -and !$script:subtitleMode)
 Add-PlaybackMessage (Message 'wake' 'fresh advice')
 Check 'newMessageWakesIdleBubble' (!$script:collapsed -and $script:activePlayback.id -eq 'wake' -and $controls.NarrowPanel.Visibility -eq 'Visible')
 Reset-Playback;$script:subtitleMode=$true;Set-NarrowMetrics;Layout
 Add-PlaybackMessage (Message 'subtitle' ('abcdefghijklmnopqrstuv '*20));Advance 4000
 Check 'subtitlesKeepTwoVisibleRows' ($script:subtitleIndex -gt 0 -and $controls.PreviousSubtitle.Text.Length -gt 0 -and $controls.NarrowText.Text.Length -gt 0)
 Check 'subtitleBackgroundTransparent' ($controls.MainBorder.Background.Color.A -eq 0 -and $controls.MainBorder.BorderThickness.Left -eq 0)
 Save-Frame 'subtitle'
 $line=$script:subtitleIndex;$settingsMenu.IsOpen=$true;Advance 60000;Check 'menuPausesTimeline' ($script:subtitleIndex -eq $line)
 $settingsMenu.IsOpen=$false;Advance 1;Check 'menuResumeDoesNotSkipLines' ($script:subtitleIndex -eq $line)
 $controls.FontSlider.Value=20;Set-BodyFontSize;Layout;Playback-Tick
 Check 'fontSettingAppliesToSubtitleRows' ($controls.NarrowText.FontSize -eq 20 -and $controls.PreviousSubtitle.FontSize -eq 20 -and $window.Height -ge 2*$script:subtitleRowHeight)
 $before=$window.Width;Resize-Window 80 0;Set-NarrowMetrics;Layout
 Check 'narrowWidthCanResize' ($window.Width -eq $before+80 -and $script:narrowWidth -eq $window.Width)
 Reset-Playback;$script:subtitleMode=$false;Set-NarrowMetrics;Layout
 Add-PlaybackMessage (Message 'first' 'first');Add-PlaybackMessage (Message 'second' 'second');Add-PlaybackMessage (Message 'third' 'third')
 Advance 1000
 Check 'queueHandoffKeepsFifo' ($script:activePlayback.id -eq 'second' -and $script:playbackQueue[0].id -eq 'third')
 Advance 1000;Advance 80
 Check 'everyQueuedMessagePlays' ($script:activePlayback.id -eq 'third' -and !$script:playbackQueue.Count)
 $results|ConvertTo-Json -Compress
}finally{$window.Close()}
