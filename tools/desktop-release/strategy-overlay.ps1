param(
    [string]$StateDir=(Join-Path $env:USERPROFILE '.dsh/jinbao'),
    [switch]$Interactive,
    [string]$PreviewPath,
    [string]$PreviewTab='advice',
    [switch]$SelfTest
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JinbaoOverlayNative {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr handle,int index);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr handle,int index,int value);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle,IntPtr after,int x,int y,int w,int h,uint flags);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr handle,int id,uint modifiers,uint key);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr handle,int id);
    public static void InputMode(IntPtr handle,bool through,bool focusable) {
        int style=GetWindowLong(handle,-20);
        style=through ? style|0x20 : style&~0x20;
        style=focusable ? style&~0x08000000 : style|0x08000000;
        SetWindowLong(handle,-20,style);
        SetWindowPos(handle,IntPtr.Zero,0,0,0,0,0x37);
    }
}
'@
$StateDir=[IO.Path]::GetFullPath($StateDir)
[IO.Directory]::CreateDirectory($StateDir) | Out-Null
$stateFile=Join-Path $StateDir 'overlay-state.json'
$boundsFile=Join-Path $StateDir 'strategy-overlay-bounds.json'
$controlFile=Join-Path $StateDir 'overlay-control.json'
$hash=[Security.Cryptography.SHA256]::Create()
try{$identity=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($StateDir.ToLowerInvariant())))).Replace('-','').Substring(0,16)}finally{$hash.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Local\JinbaoStrategyOverlay-'+$identity))
$owned=$false
try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
if(!$owned){$mutex.Dispose();Write-Output 'Jinbao strategy overlay is already running.';exit 0}
[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="金宝策略悬浮窗" Width="560" Height="500" MinWidth="420" MinHeight="320" WindowStyle="None" AllowsTransparency="True" Background="Transparent" Topmost="True" ShowInTaskbar="False" ShowActivated="False" ResizeMode="CanResizeWithGrip">
 <Window.Resources>
  <Style TargetType="Button"><Setter Property="Background" Value="#29364E"/><Setter Property="Foreground" Value="#E2E8F0"/><Setter Property="BorderThickness" Value="0"/><Setter Property="Padding" Value="9,6"/><Setter Property="Margin" Value="3"/><Setter Property="Cursor" Value="Hand"/></Style>
 </Window.Resources>
 <Border Background="#E8172033" BorderBrush="#536078" BorderThickness="1" CornerRadius="14" Padding="12">
  <Grid>
   <Grid x:Name="Expanded">
    <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <Grid x:Name="Header" Background="#01000000" Cursor="SizeAll">
     <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
     <TextBlock x:Name="TitleText" Text="金宝 · 游戏教练" Foreground="#F1F5F9" FontSize="17" FontWeight="SemiBold" VerticalAlignment="Center"/>
     <Button x:Name="SettingsButton" Grid.Column="1" Content="设置"/>
     <Button x:Name="CollapseButton" Grid.Column="2" Content="收起"/>
     <Button x:Name="CloseButton" Grid.Column="3" Content="×" FontSize="19" ToolTip="退出悬浮窗"/>
    </Grid>
    <StackPanel Grid.Row="1" Margin="3,8,3,4">
     <TextBlock x:Name="TimeText" Text="等待对局" Foreground="#93C5FD" FontSize="14"/>
     <TextBlock x:Name="SummaryText" Text="启动游戏日志采集后显示对局信息" Foreground="#94A3B8" FontSize="12" TextWrapping="Wrap" Margin="0,4,0,0"/>
    </StackPanel>
    <WrapPanel x:Name="Tabs" Grid.Row="2" Margin="0,4,0,8"/>
    <ScrollViewer x:Name="PageScroll" Grid.Row="3" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
     <TextBlock x:Name="PageText" Text="等待新的游戏日志…" TextWrapping="Wrap" Foreground="#E2E8F0" FontSize="14" LineHeight="24" Margin="4"/>
    </ScrollViewer>
    <Grid x:Name="ChatPanel" Grid.Row="4" Margin="0,8,0,0" Visibility="Collapsed">
     <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
     <TextBox x:Name="QuestionBox" MaxLength="1000" MinHeight="35" AcceptsReturn="True" TextWrapping="Wrap" MaxHeight="85" Padding="8" Background="#111827" Foreground="#F1F5F9" BorderBrush="#536078" ToolTip="Enter 发送；Shift+Enter 换行"/>
     <Button x:Name="SendButton" Grid.Column="1" Content="发送"/>
    </Grid>
    <StackPanel x:Name="Footer" Grid.Row="5" Margin="0,8,0,0">
     <WrapPanel>
      <Button x:Name="InteractionButton" Content="交互模式"/>
      <Button x:Name="RefreshButton" Content="刷新推荐"/>
      <Button x:Name="TacticButton" Content="咨询团战"/>
     </WrapPanel>
     <TextBlock x:Name="HintText" Text="标题和按钮可直接点击 · Ctrl+Alt+J 切换交互" Foreground="#94A3B8" FontSize="11" TextWrapping="Wrap" Margin="4,4,0,0"/>
    </StackPanel>
   </Grid>
   <Grid x:Name="Bubble" Visibility="Collapsed" Background="#01000000" Cursor="SizeAll">
    <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
    <TextBlock Text="金宝" Foreground="#93C5FD" FontSize="14" VerticalAlignment="Center" ToolTip="点击展开；按住拖动"/>
    <Button x:Name="BubbleClose" Grid.Column="1" Content="×" Padding="4,0" Margin="0" ToolTip="退出悬浮窗"/>
   </Grid>
  </Grid>
 </Border>
</Window>
'@
$window=[Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$controls=@{}
foreach($name in @('Expanded','Header','TitleText','TimeText','SummaryText','Tabs','PageScroll','PageText','ChatPanel','QuestionBox','SendButton','Footer','HintText','SettingsButton','CollapseButton','CloseButton','InteractionButton','RefreshButton','TacticButton','Bubble','BubbleClose')){$controls[$name]=$window.FindName($name)}
$script:interactiveMode=[bool]$Interactive
$script:windowHandle=[IntPtr]::Zero
$script:source=$null
$script:hotkeyRegistered=$false
$script:tab=$PreviewTab
$script:collapsed=$false
$script:snapshot=$null
$script:job=$null
$script:dragging=$false
$script:lastThrough=$null
$script:lastFocusable=$null
$script:lastControl=0
$script:closing=$false
$script:expandedWidth=560.0;$script:expandedHeight=500.0
$script:tray=$null
$script:testResult=@{}
$area=[Windows.SystemParameters]::WorkArea
$window.Left=$area.Right-$window.Width-18;$window.Top=$area.Top+30
if(!$SelfTest){
 try{
  $saved=[IO.File]::ReadAllText($boundsFile) | ConvertFrom-Json
  if($saved.width -ge 420 -and $saved.width -le $area.Width){$window.Width=[double]$saved.width}
  if($saved.height -ge 320 -and $saved.height -le $area.Height){$window.Height=[double]$saved.height}
  $window.Left=[Math]::Max($area.Left,[Math]::Min([double]$saved.left,$area.Right-$window.Width))
  $window.Top=[Math]::Max($area.Top,[Math]::Min([double]$saved.top,$area.Bottom-$window.Height))
 }catch{}
}
function Set-PointerMode([bool]$hotzone){
 if($script:windowHandle -eq [IntPtr]::Zero){return}
 $through=!($script:interactiveMode -or $hotzone -or $script:dragging)
 $focusable=$script:interactiveMode -and !$script:collapsed
 if($script:lastThrough -ne $through -or $script:lastFocusable -ne $focusable){
  [JinbaoOverlayNative]::InputMode($script:windowHandle,$through,$focusable)
  $script:lastThrough=$through;$script:lastFocusable=$focusable
 }
}
function Set-Interaction([bool]$enabled){
 $script:interactiveMode=$enabled
 $controls.InteractionButton.Content=if($enabled){'恢复穿透'}else{'交互模式'}
 $controls.HintText.Text=if($enabled){'可滚动和输入 · 标题可拖动 · Ctrl+Alt+J 恢复穿透'}else{'标题和按钮可直接点击 · Ctrl+Alt+J 切换交互'}
 Set-PointerMode $false
}
function Set-Collapsed([bool]$on){
 if($script:collapsed -eq $on){return}
 if($on){
  $script:expandedWidth=$window.Width;$script:expandedHeight=$window.Height
  $window.MinWidth=0;$window.MinHeight=0;$window.Width=110;$window.Height=52
  $window.ResizeMode='NoResize';$controls.Expanded.Visibility='Collapsed';$controls.Bubble.Visibility='Visible'
 }else{
  $window.Width=$script:expandedWidth;$window.Height=$script:expandedHeight
  $window.MinWidth=420;$window.MinHeight=320;$window.ResizeMode='CanResizeWithGrip'
  $controls.Expanded.Visibility='Visible';$controls.Bubble.Visibility='Collapsed'
  $window.Left=[Math]::Min($window.Left,$area.Right-$window.Width)
  $window.Top=[Math]::Min($window.Top,$area.Bottom-$window.Height)
 }
 $script:collapsed=$on;Set-PointerMode $true
}
function Update-Page {
 if($script:snapshot){
  $value=[string]$script:snapshot.($script:tab)
  $controls.PageText.Text=if($value){$value}else{'等待此页面的数据…'}
 }
 $controls.ChatPanel.Visibility=if($script:tab -eq 'chat'){'Visible'}else{'Collapsed'}
 if($script:tab -eq 'chat'){$controls.PageScroll.ScrollToEnd()}else{$controls.PageScroll.ScrollToTop()}
}
function Set-Tab([string]$name){
 $script:tab=$name
 foreach($button in $controls.Tabs.Children){$button.Background=if($button.Tag -eq $name){'#2563EB'}else{'#29364E'}}
 if($name -eq 'chat'){Set-Interaction $true}
 $controls.TacticButton.Content=switch($name){'equipment'{'咨询出装'}'augments'{'咨询海克斯'}default{'咨询团战'}}
 Update-Page
}
foreach($entry in @(@('advice','战况'),@('equipment','装备'),@('augments','海克斯'),@('players','对手'),@('stats','胜率'),@('teamfight','团战'),@('events','事件'),@('chat','聊天'))){
 $button=New-Object Windows.Controls.Button
 $button.Tag=$entry[0];$button.Content=$entry[1];$button.FontSize=12
 $button.Add_Click({param($sender,$eventArgs) Set-Tab ([string]$sender.Tag)})
 $controls.Tabs.Children.Add($button) | Out-Null
}
function Update-State {
 try{
  if((Get-Item -LiteralPath $stateFile -ErrorAction Stop).Length -gt 1048576){return}
  $next=[IO.File]::ReadAllText($stateFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
  $changed=(!$script:snapshot -or [string]$next.($script:tab) -ne [string]$script:snapshot.($script:tab))
  $script:snapshot=$next;$controls.TitleText.Text=[string]$next.title
  $controls.TimeText.Text=if($next.gameTime -and $next.gameTime -ne '等待对局'){'对局 '+$next.gameTime+$(if($next.ended){' · 已结束'}else{''})}else{'等待对局'}
  $controls.SummaryText.Text=[string]$next.summary
  if($changed){Update-Page}
 }catch{}
 if($script:job -and $script:job.State -in @('Completed','Failed','Stopped')){
  $result=Receive-Job $script:job -ErrorAction SilentlyContinue
  $controls.HintText.Text=if($result -and $result.ok){'已完成'}elseif($result -and $result.message){[string]$result.message}else{'请求失败，请检查设置页的模型和服务状态。'}
  Remove-Job $script:job -Force -ErrorAction SilentlyContinue;$script:job=$null
  $controls.SendButton.IsEnabled=$true;$controls.RefreshButton.IsEnabled=$true;$controls.TacticButton.IsEnabled=$true
 }
 try{
  $command=[IO.File]::ReadAllText($controlFile) | ConvertFrom-Json
  if([double]$command.at -gt $script:lastControl){
   $script:lastControl=[double]$command.at
   if($command.action -eq 'exit'){$window.Close()}
   elseif($command.action -eq 'show'){Set-Collapsed $false}
  }
 }catch{}
}
function Start-Request([string]$route,[hashtable]$payload){
 if($script:job){$controls.HintText.Text='正在处理上一个请求…';return}
 try{
  $url=[IO.File]::ReadAllText((Join-Path $StateDir 'settings-link.txt')).Trim()
  if($url -notmatch '^http://127\.0\.0\.1:[0-9]+/#[a-f0-9]{64}$'){throw 'Invalid local URL'}
  $uri=[Uri]$url;$endpoint=$uri.GetLeftPart([UriPartial]::Authority)+'/api/overlay/'+$route;$nonce=$uri.Fragment.Substring(1)
  $body=$payload | ConvertTo-Json -Compress
  $script:job=Start-Job -ArgumentList $endpoint,$nonce,$body -ScriptBlock {
   param($endpoint,$nonce,$body)
   try{
    Invoke-RestMethod -Uri $endpoint -Method Post -Headers @{'x-jinbao-setup'=$nonce} -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 70 | Out-Null
    @{ok=$true}
   }catch{@{ok=$false;message='请求失败，请在设置页检查模型配置和攻略检索权限。'}}
  }
  $controls.SendButton.IsEnabled=$false;$controls.RefreshButton.IsEnabled=$false;$controls.TacticButton.IsEnabled=$false
  $controls.HintText.Text=if($route -eq 'ask'){'教练思考中…'}else{'正在检索推荐…'}
 }catch{$controls.HintText.Text='请先启动 DSH，再打开金宝设置页。'}
}
function Send-Question {
 $question=$controls.QuestionBox.Text.Trim()
 if(!$question -or $script:job){return}
 Start-Request 'ask' @{question=$question}
 if($script:job){$controls.QuestionBox.Text=''}
}
$controls.SendButton.Add_Click({Send-Question})
$controls.QuestionBox.Add_PreviewKeyDown({param($sender,$eventArgs)
 if($eventArgs.Key -eq [Windows.Input.Key]::Return -and ([Windows.Input.Keyboard]::Modifiers -band [Windows.Input.ModifierKeys]::Shift) -eq 0){Send-Question;$eventArgs.Handled=$true}
})
$controls.RefreshButton.Add_Click({Start-Request 'refresh' @{}})
$controls.TacticButton.Add_Click({
 $topic=if($script:tab -in @('equipment','augments')){$script:tab}else{'teamfight'}
 $question=switch($topic){'equipment'{'结合当前英雄、双方装备和金币，推荐下一件装备及购买顺序。'}'augments'{'结合当前英雄和已知强化，推荐海克斯选择思路；没有面板选项时不要假定候选卡片。'}default{'结合当前双方阵容、装备和对局时间，给出本局团战站位、优先目标和进退时机。'}}
 Set-Tab $topic;Start-Request 'ask' @{question=$question;topic=$topic}
})
$controls.InteractionButton.Add_Click({Set-Interaction (!$script:interactiveMode)})
$controls.CollapseButton.Add_Click({Set-Collapsed $true})
$controls.CloseButton.Add_Click({$window.Close()})
$controls.BubbleClose.Add_Click({$window.Close()})
$controls.SettingsButton.Add_Click({
 if($SelfTest){$script:testResult.settings=$true;return}
 try{
  $url=[IO.File]::ReadAllText((Join-Path $StateDir 'settings-link.txt')).Trim()
  if($url -notmatch '^http://127\.0\.0\.1:[0-9]+/#[a-f0-9]{64}$'){throw 'Invalid local URL'}
  Start-Process $url
 }catch{$controls.HintText.Text='请先启动 DSH，再从安装包打开设置。'}
})
function Start-Drag($sender,$eventArgs){
 $node=$eventArgs.OriginalSource
 while($node -and $node -ne $sender){
  if($node -is [Windows.Controls.Button]){return}
  try{$node=[Windows.Media.VisualTreeHelper]::GetParent($node)}catch{break}
 }
 $p=New-Object 'JinbaoOverlayNative+Point'
 [JinbaoOverlayNative]::GetCursorPos([ref]$p) | Out-Null
 $script:dragStartX=$p.X;$script:dragStartY=$p.Y;$script:dragLeft=$window.Left;$script:dragTop=$window.Top
 $script:dragging=$true;$script:moved=$false;$script:bubbleDrag=($sender -eq $controls.Bubble)
 $eventArgs.Handled=$true;Set-PointerMode $true
}
$controls.Header.Add_MouseLeftButtonDown({param($sender,$eventArgs) Start-Drag $sender $eventArgs})
$controls.Bubble.Add_MouseLeftButtonDown({param($sender,$eventArgs) Start-Drag $sender $eventArgs})
function Update-Drag([double]$x,[double]$y,[bool]$pressed){
 if($script:dragging){
  if(!$pressed){
   $script:dragging=$false
   if($script:bubbleDrag -and !$script:moved){Set-Collapsed $false}
  }else{
   $transform=$script:source.CompositionTarget.TransformFromDevice
   $dx=($x-$script:dragStartX)*$transform.M11;$dy=($y-$script:dragStartY)*$transform.M22
   if([Math]::Abs($dx)+[Math]::Abs($dy) -gt 3){$script:moved=$true}
   $window.Left=[Math]::Max($area.Left,[Math]::Min($script:dragLeft+$dx,$area.Right-$window.Width))
   $window.Top=[Math]::Max($area.Top,[Math]::Min($script:dragTop+$dy,$area.Bottom-$window.Height))
  }
 }
}
function Pointer-Tick {
 $p=New-Object 'JinbaoOverlayNative+Point'
 [JinbaoOverlayNative]::GetCursorPos([ref]$p) | Out-Null
 Update-Drag $p.X $p.Y (([JinbaoOverlayNative]::GetAsyncKeyState(1) -band 0x8000) -ne 0)
 $hotzone=$false
 $targets=if($script:collapsed){@($controls.Bubble)}else{@($controls.Header,$controls.Tabs,$controls.Footer)}
 foreach($target in $targets){
  $local=$target.PointFromScreen((New-Object Windows.Point($p.X,$p.Y)))
  if($local.X -ge 0 -and $local.Y -ge 0 -and $local.X -lt $target.ActualWidth -and $local.Y -lt $target.ActualHeight){$hotzone=$true;break}
 }
 Set-PointerMode $hotzone
}
$hook=[Windows.Interop.HwndSourceHook]{
 param($handle,$message,$wParam,$lParam,[ref]$handled)
 if($message -eq 0x0312 -and $wParam.ToInt32() -eq 701){Set-Interaction (!$script:interactiveMode);$handled.Value=$true}
 return [IntPtr]::Zero
}
$window.Add_SourceInitialized({
 $script:windowHandle=(New-Object Windows.Interop.WindowInteropHelper($window)).Handle
 $script:source=[Windows.Interop.HwndSource]::FromHwnd($script:windowHandle);$script:source.AddHook($hook)
 $script:hotkeyRegistered=[JinbaoOverlayNative]::RegisterHotKey($script:windowHandle,701,$(if($SelfTest){7}else{3}),$(if($SelfTest){123}else{74}))
 Set-Interaction $script:interactiveMode
 if(!$SelfTest){
  $script:tray=New-Object Windows.Forms.NotifyIcon
  $script:tray.Icon=[Drawing.SystemIcons]::Application;$script:tray.Text='金宝游戏教练';$script:tray.Visible=$true
  $menu=New-Object Windows.Forms.ContextMenuStrip
  $showItem=$menu.Items.Add('展开悬浮窗');$showItem.Add_Click({Set-Collapsed $false;Set-Interaction $true})
  $exitItem=$menu.Items.Add('退出悬浮窗');$exitItem.Add_Click({$window.Close()})
  $script:tray.ContextMenuStrip=$menu;$script:tray.Add_DoubleClick({Set-Collapsed $false;Set-Interaction $true})
 }
})
$timer=New-Object Windows.Threading.DispatcherTimer;$timer.Interval=[TimeSpan]::FromMilliseconds(1000)
$timer.Add_Tick({Update-State})
$pointerTimer=New-Object Windows.Threading.DispatcherTimer;$pointerTimer.Interval=[TimeSpan]::FromMilliseconds(40)
$pointerTimer.Add_Tick({Pointer-Tick})
$window.Add_Closed({$script:closing=$true;$timer.Stop();$pointerTimer.Stop()})
Set-Tab $PreviewTab;Update-State
try{
 if($PreviewPath){
  $root=$window.Content;$root.Measure((New-Object Windows.Size(560,500)));$root.Arrange((New-Object Windows.Rect(0,0,560,500)));$root.UpdateLayout()
  $bitmap=New-Object Windows.Media.Imaging.RenderTargetBitmap(560,500,96,96,[Windows.Media.PixelFormats]::Pbgra32);$bitmap.Render($root)
  $encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder;$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream=[IO.File]::Create([IO.Path]::GetFullPath($PreviewPath));try{$encoder.Save($stream)}finally{$stream.Dispose()}
  Write-Output 'Overlay preview rendered.'
 }else{
  if($SelfTest){
   $window.Left=-10000;$window.Top=-10000;$window.Opacity=0
   $testing=New-Object Windows.Threading.DispatcherTimer;$testing.Interval=[TimeSpan]::FromMilliseconds(300)
   $testing.Add_Tick({
    $testing.Stop()
    Set-Interaction $false;Set-PointerMode $false
    $script:testResult.clickThrough=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x20) -ne 0
    Set-PointerMode $true
    $script:testResult.headerClickable=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x20) -eq 0
    $script:testResult.headerNoActivate=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x08000000) -ne 0
    $click=New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)
    $controls.SettingsButton.RaiseEvent($click)
    $controls.CollapseButton.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
    $script:testResult.collapsed=$script:collapsed -and $window.Width -eq 110
    Set-Collapsed $false;$script:testResult.expanded=$window.Width -ge 420
    $script:testResult.tabs=$controls.Tabs.Children.Count
    $script:dragStartX=0;$script:dragStartY=0;$script:dragLeft=100;$script:dragTop=100;$script:dragging=$true;$script:bubbleDrag=$false
    Update-Drag 50 40 $true;$script:testResult.dragMoved=$window.Left -gt 100 -and $window.Top -gt 100
    Update-Drag 50 40 $false;$script:testResult.dragReleased=!$script:dragging
    foreach($button in $controls.Tabs.Children){$button.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))}
    $script:testResult.chatInteractive=$script:interactiveMode -and $controls.ChatPanel.Visibility -eq 'Visible'
    $script:testResult.gameTime=$controls.TimeText.Text
    $controls.CloseButton.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
    $script:testResult.closed=$script:closing
   });$testing.Start()
  }
  $timer.Start();if(!$SelfTest){$pointerTimer.Start()}
  $window.ShowDialog() | Out-Null
  if($SelfTest){$script:testResult | ConvertTo-Json -Compress}
  else{
   $bounds=@{left=$window.Left;top=$window.Top;width=$(if($script:collapsed){$script:expandedWidth}else{$window.Width});height=$(if($script:collapsed){$script:expandedHeight}else{$window.Height})}|ConvertTo-Json -Compress
   [IO.File]::WriteAllText($boundsFile,$bounds,[Text.UTF8Encoding]::new($false))
   [IO.File]::WriteAllText((Join-Path $StateDir 'overlay-stopped'),'closed',[Text.UTF8Encoding]::new($false))
  }
 }
}finally{
 $timer.Stop();$pointerTimer.Stop()
 if($script:job){Stop-Job $script:job -ErrorAction SilentlyContinue;Remove-Job $script:job -Force -ErrorAction SilentlyContinue}
 if($script:tray){$script:tray.Visible=$false;$script:tray.Dispose()}
 if($script:hotkeyRegistered){[JinbaoOverlayNative]::UnregisterHotKey($script:windowHandle,701) | Out-Null}
 if($script:source){$script:source.RemoveHook($hook)}
 if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()
}
