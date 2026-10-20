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
    [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr handle,uint affinity);
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
$preferencesFile=Join-Path $StateDir 'strategy-overlay-preferences.json'
$controlFile=Join-Path $StateDir 'overlay-control.json'
$hash=[Security.Cryptography.SHA256]::Create()
try{$identity=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($StateDir.ToLowerInvariant())))).Replace('-','').Substring(0,16)}finally{$hash.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Local\JinbaoStrategyOverlay-'+$identity))
$owned=$false
try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
if(!$owned){$mutex.Dispose();Write-Output 'Jinbao strategy overlay is already running.';exit 0}
[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="金宝策略悬浮窗" Width="580" Height="600" MinWidth="420" MinHeight="220" WindowStyle="None" AllowsTransparency="True" Background="Transparent" Topmost="True" ShowInTaskbar="False" ShowActivated="False" ResizeMode="CanResize">
 <Window.Resources>
  <Style x:Key="SubtitleText" TargetType="TextBlock"><Setter Property="Foreground" Value="#F8FAFC"/><Setter Property="TextWrapping" Value="NoWrap"/><Setter Property="Effect"><Setter.Value><DropShadowEffect Color="Black" BlurRadius="5" ShadowDepth="1" Opacity="0.9"/></Setter.Value></Setter></Style>
  <Style TargetType="Button"><Setter Property="Background" Value="#29364E"/><Setter Property="Foreground" Value="#E2E8F0"/><Setter Property="BorderThickness" Value="0"/><Setter Property="Padding" Value="8,4"/><Setter Property="Margin" Value="3"/><Setter Property="Cursor" Value="Hand"/></Style>
 </Window.Resources>
 <Border x:Name="MainBorder" Background="#E8172033" BorderBrush="#536078" BorderThickness="1" CornerRadius="14" Padding="12">
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
    <StackPanel Grid.Row="1" Margin="3,4,3,2">
     <WrapPanel Visibility="Collapsed">
     <TextBlock x:Name="TimeText" Text="等待进入游戏" Foreground="#93C5FD" FontSize="14"/>
     <TextBlock x:Name="SummaryText" Text="正在检测游戏和教练服务…" Foreground="#94A3B8" FontSize="12" TextWrapping="Wrap" Margin="8,2,0,0"/>
     </WrapPanel>
     <TextBlock x:Name="LauncherText" Foreground="#FBBF24" FontSize="12" TextWrapping="Wrap" Margin="0,4,0,0"/>
     <TextBlock x:Name="UpdateText" Foreground="#94A3B8" FontSize="11" TextWrapping="Wrap" Margin="0,4,0,0" Visibility="Collapsed"/>
     <Button x:Name="ActionButton" Content="微信登录" HorizontalAlignment="Left" Visibility="Collapsed"/>
    </StackPanel>
    <WrapPanel x:Name="Tabs" Grid.Row="2" Margin="0,2,0,4"/>
    <DockPanel Grid.Row="3">
    <StackPanel x:Name="ConfirmationPanel" DockPanel.Dock="Top" Visibility="Collapsed" Margin="4,2,4,6">
     <TextBlock x:Name="ConfirmationTitle" Foreground="#FBBF24" FontSize="12" TextWrapping="Wrap"/>
     <WrapPanel x:Name="ConfirmationChoices"/>
    </StackPanel>
    <ScrollViewer x:Name="PageScroll" Background="Transparent" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" CanContentScroll="False" PanningMode="VerticalOnly">
     <StackPanel>
     <TextBlock x:Name="PageText" Text="等待新的游戏日志…" TextWrapping="Wrap" Foreground="#E2E8F0" FontSize="14" LineHeight="24" Margin="4"/>
     <StackPanel x:Name="PlayersTable" Visibility="Collapsed" Margin="4"/>
     </StackPanel>
    </ScrollViewer>
    </DockPanel>
    <Grid x:Name="ChatPanel" Grid.Row="4" Margin="0,8,0,0" Visibility="Collapsed">
     <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
     <TextBox x:Name="QuestionBox" MaxLength="1000" MinHeight="35" AcceptsReturn="True" TextWrapping="Wrap" MaxHeight="85" Padding="8" Background="#111827" Foreground="#F1F5F9" BorderBrush="#536078" ToolTip="Enter 发送；Shift+Enter 换行"/>
     <Button x:Name="SendButton" Grid.Column="1" Content="发送"/>
    </Grid>
    <StackPanel x:Name="Footer" Grid.Row="5" Margin="0,8,0,0">
     <StackPanel x:Name="AppearancePanel" Visibility="Collapsed">
     <StackPanel Orientation="Horizontal" Margin="4,5,4,0">
      <TextBlock Text="背景不透明度" Foreground="#94A3B8" FontSize="11" VerticalAlignment="Center"/>
      <Slider x:Name="OpacitySlider" Minimum="20" Maximum="100" Value="91" Width="140" Margin="10,0" IsMoveToPointEnabled="True" SmallChange="1" LargeChange="10" ToolTip="调低后背景更透明，文字保持清晰"/>
      <TextBlock x:Name="OpacityText" Foreground="#E2E8F0" FontSize="11" VerticalAlignment="Center"/>
     </StackPanel>
     <StackPanel Orientation="Horizontal" Margin="4,5,4,4">
      <TextBlock Text="正文大小" Foreground="#94A3B8" FontSize="11" VerticalAlignment="Center"/>
      <Slider x:Name="FontSlider" Minimum="11" Maximum="22" Value="14" Width="140" Margin="32,0,10,0" TickFrequency="1" IsSnapToTickEnabled="True" IsMoveToPointEnabled="True" ToolTip="也可在正文区按住 Ctrl 滚动滚轮"/>
      <TextBlock x:Name="FontText" Foreground="#E2E8F0" FontSize="11" VerticalAlignment="Center"/>
     </StackPanel>
     </StackPanel>
     <TextBlock x:Name="HintText" Text="右下角拖动缩放 · Ctrl+滚轮调整正文" Foreground="#94A3B8" FontSize="10" TextTrimming="CharacterEllipsis" Margin="4,3,18,0"/>
    </StackPanel>
   </Grid>
   <Grid x:Name="NarrowPanel" Visibility="Collapsed" Background="#01000000">
    <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
    <Canvas x:Name="NarrowCanvas" ClipToBounds="True" Margin="0,2,4,0"><TextBlock x:Name="OutgoingSubtitle" Style="{StaticResource SubtitleText}"/><TextBlock x:Name="PreviousSubtitle" Style="{StaticResource SubtitleText}"/><TextBlock x:Name="NarrowText" Style="{StaticResource SubtitleText}" FontSize="14"/></Canvas>
    <Button x:Name="NarrowExpand" Grid.Column="1" Content="▣" ToolTip="展开大框" Padding="5,0" VerticalAlignment="Center" Height="28"/>
    <Button x:Name="NarrowMenu" Grid.Column="2" Content="⋯" ToolTip="显示模式" Padding="5,0" VerticalAlignment="Center" Height="28"/>
    <Button x:Name="NarrowClose" Grid.Column="3" Content="×" ToolTip="退出悬浮窗" Padding="5,0" VerticalAlignment="Center" Height="28"/>
   </Grid>
   <Thumb x:Name="ResizeGrip" Width="26" Height="26" HorizontalAlignment="Right" VerticalAlignment="Bottom" Margin="0,0,-8,-8" Cursor="SizeNWSE" ToolTip="拖动调整窗口大小，会记住你的尺寸">
    <Thumb.Template><ControlTemplate TargetType="Thumb"><Grid Background="#01000000"><Path Data="M 7,22 L 22,7 M 14,22 L 22,14 M 21,22 L 22,21" Stroke="#93C5FD" StrokeThickness="2"/></Grid></ControlTemplate></Thumb.Template>
   </Thumb>
   <Grid x:Name="Bubble" Visibility="Collapsed" Background="#01000000" Cursor="SizeAll">
    <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
    <TextBlock x:Name="BubbleLabel" Text="金宝" Foreground="#93C5FD" FontSize="14" VerticalAlignment="Center" ToolTip="点击展开；按住拖动"/>
    <Button x:Name="BubbleClose" Grid.Column="1" Content="×" Padding="4,0" Margin="0" ToolTip="退出悬浮窗"/>
   </Grid>
  </Grid>
 </Border>
</Window>
'@
$window=[Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$controls=@{}
foreach($name in @('MainBorder','OpacitySlider','OpacityText','Expanded','Header','TitleText','TimeText','SummaryText','LauncherText','ActionButton','Tabs','PageScroll','PageText','ChatPanel','QuestionBox','SendButton','Footer','HintText','SettingsButton','CollapseButton','CloseButton','Bubble','BubbleClose')){$controls[$name]=$window.FindName($name)}
$script:scrollPositions=@{}
$controls.PlayersTable=$window.FindName('PlayersTable')
$controls.UpdateText=$window.FindName('UpdateText')
foreach($name in @('ResizeGrip','AppearancePanel','FontSlider','FontText')){$controls[$name]=$window.FindName($name)}
foreach($name in @('NarrowText','PreviousSubtitle','OutgoingSubtitle')){$controls[$name]=$window.FindName($name)}
foreach($name in @('ConfirmationPanel','ConfirmationTitle','ConfirmationChoices')){$controls[$name]=$window.FindName($name)}
$script:confirmationId=''
$script:renderedTab=$null
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
$script:expandedWidth=580.0;$script:expandedHeight=600.0
$script:tray=$null
$script:testResult=@{}
$area=[Windows.SystemParameters]::WorkArea
$window.Left=$area.Right-$window.Width-18;$window.Top=$area.Top+30
if(!$SelfTest){
 try{
  $saved=[IO.File]::ReadAllText($boundsFile) | ConvertFrom-Json
  if($saved.width -ge 420 -and $saved.width -le $area.Width){$window.Width=[double]$saved.width}
  if($saved.height -ge 220 -and $saved.height -le $area.Height){$window.Height=[double]$saved.height}
  $window.Left=[Math]::Max($area.Left,[Math]::Min([double]$saved.left,$area.Right-$window.Width))
  $window.Top=[Math]::Max($area.Top,[Math]::Min([double]$saved.top,$area.Bottom-$window.Height))
 }catch{}
}
function Set-PointerMode([bool]$hotzone){
 if($script:windowHandle -eq [IntPtr]::Zero){return}
 $through=!($script:interactiveMode -or $hotzone -or $script:dragging -or [Windows.Input.Mouse]::Captured)
 $focusable=$script:interactiveMode -and !$script:collapsed
 if($script:lastThrough -ne $through -or $script:lastFocusable -ne $focusable){
  [JinbaoOverlayNative]::InputMode($script:windowHandle,$through,$focusable)
  $script:lastThrough=$through;$script:lastFocusable=$focusable
 }
}
function Set-Interaction([bool]$enabled){
 $script:interactiveMode=$enabled
 $controls.HintText.Text=if($enabled){'右下角缩放 · Ctrl+滚轮调整正文 · Ctrl+Alt+J 恢复穿透'}else{'右下角拖动缩放 · Ctrl+滚轮调整正文'}
 Set-PointerMode $false
}
function Set-Collapsed([bool]$on,[switch]$PreserveMode){
 if($script:collapsed -eq $on){return}
 if($on){
  if($script:displayMode -eq 'large'){$script:expandedWidth=$window.Width;$script:expandedHeight=$window.Height}
  $window.MinWidth=0;$window.MinHeight=0;$window.Width=110;$window.Height=52
  $window.Left=$area.Right-$window.Width
  $window.Top=[Math]::Max($area.Top,[Math]::Min($window.Top,$area.Bottom-$window.Height))
  $window.ResizeMode='NoResize';$controls.Expanded.Visibility='Collapsed';$controls.Bubble.Visibility='Visible';$controls.ResizeGrip.Visibility='Collapsed'
  if($controls.NarrowPanel){$controls.NarrowPanel.Visibility='Collapsed'}
 }else{
  $window.Width=$script:expandedWidth;$window.Height=$script:expandedHeight
  $window.MinWidth=420;$window.MinHeight=220;$window.ResizeMode='CanResize';$controls.ResizeGrip.Visibility='Visible'
  $controls.Expanded.Visibility='Visible';$controls.Bubble.Visibility='Collapsed'
  if($controls.NarrowPanel){$controls.NarrowPanel.Visibility='Collapsed'}
  $window.Left=[Math]::Min($window.Left,$area.Right-$window.Width)
  $window.Top=[Math]::Min($window.Top,$area.Bottom-$window.Height)
 }
 $script:collapsed=$on
 if($on){$controls.MainBorder.Padding='8';$controls.MainBorder.BorderThickness=1;Set-BackgroundOpacity}
 if($script:displayMode -and !$PreserveMode){if($on){$script:displayMode='silent'}else{$script:displayMode='large';$controls.MainBorder.Padding='12';$controls.MainBorder.BorderThickness=1;$controls.ResizeGrip.Width=26;$controls.ResizeGrip.Height=26;$controls.ResizeGrip.Margin='0,0,-8,-8';Set-BackgroundOpacity};Save-DisplayMode}
 if(!$on -and $PreserveMode -and $script:displayMode -eq 'narrow'){$controls.Expanded.Visibility='Collapsed';$controls.NarrowPanel.Visibility='Visible';$window.ResizeMode='NoResize';Set-NarrowMetrics}
 Set-PointerMode $true
}
function Save-Preferences {
 $json=@{backgroundOpacity=[Math]::Round($controls.OpacitySlider.Value);bodyFontSize=[Math]::Round($controls.FontSlider.Value)} | ConvertTo-Json -Compress
 $temporary=$preferencesFile+'.tmp'
 [IO.File]::WriteAllText($temporary,$json,[Text.UTF8Encoding]::new($false))
 Move-Item -LiteralPath $temporary -Destination $preferencesFile -Force
}
function Set-BackgroundOpacity {
 $percent=[Math]::Round($controls.OpacitySlider.Value)
 $color=[Windows.Media.Color]::FromArgb([byte][Math]::Round(255*$percent/100),23,32,51)
 $controls.MainBorder.Background=if($script:displayMode -eq 'narrow' -and $script:subtitleMode -and !$script:collapsed){[Windows.Media.Brushes]::Transparent}else{New-Object Windows.Media.SolidColorBrush($color)}
 $controls.OpacityText.Text=([string]$percent)+'%'
}
function Set-BodyFontSize {
 $size=[Math]::Round($controls.FontSlider.Value)
 $controls.PageText.FontSize=$size;$controls.PageText.LineHeight=[Math]::Round($size*1.65)
 $controls.FontText.Text=([string]$size)+' px'
 foreach($child in $controls.PlayersTable.Children){if($child -is [Windows.Controls.Border]){foreach($label in $child.Child.Children){$label.FontSize=[Math]::Max(11,$size-2)}}}
 foreach($name in @('NarrowText','PreviousSubtitle','OutgoingSubtitle')){if($controls[$name]){$controls[$name].FontSize=$size}}
 if(Get-Command Set-NarrowMetrics -ErrorAction SilentlyContinue){Set-NarrowMetrics}
}
try{
 $preferences=[IO.File]::ReadAllText($preferencesFile) | ConvertFrom-Json
 if($preferences.backgroundOpacity -ge 20 -and $preferences.backgroundOpacity -le 100){$controls.OpacitySlider.Value=[double]$preferences.backgroundOpacity}
 if($preferences.bodyFontSize -ge 11 -and $preferences.bodyFontSize -le 22){$controls.FontSlider.Value=[double]$preferences.bodyFontSize}
}catch{}
Set-BackgroundOpacity
Set-BodyFontSize
$controls.OpacitySlider.Add_ValueChanged({Set-BackgroundOpacity;Save-Preferences})
$controls.FontSlider.Add_ValueChanged({Set-BodyFontSize;Save-Preferences})
$settingsMenu=New-Object Windows.Controls.ContextMenu
$controls.AppearanceMenuItem=New-Object Windows.Controls.MenuItem
$controls.AppearanceMenuItem.Header='外观'
$controls.AccountMenuItem=New-Object Windows.Controls.MenuItem
$controls.AccountMenuItem.Header='账号与模型设置'
$settingsMenu.Items.Add($controls.AppearanceMenuItem) | Out-Null
$settingsMenu.Items.Add($controls.AccountMenuItem) | Out-Null
$controls.SettingsButton.ContextMenu=$settingsMenu
$controls.AppearanceMenuItem.Add_Click({if($script:displayMode -eq 'narrow'){Set-DisplayMode 'large'};$controls.AppearancePanel.Visibility=if($controls.AppearancePanel.Visibility -eq 'Visible'){'Collapsed'}else{'Visible'}})
$controls.PageScroll.Add_PreviewMouseWheel({param($sender,$eventArgs)
 if(([Windows.Input.Keyboard]::Modifiers -band [Windows.Input.ModifierKeys]::Control) -ne 0){
  $controls.FontSlider.Value=[Math]::Max(11,[Math]::Min(22,$controls.FontSlider.Value+[Math]::Sign($eventArgs.Delta)))
  $eventArgs.Handled=$true
 }
})
function Resize-Window([double]$dx,[double]$dy){
 if($script:collapsed){return}
 if($script:displayMode -eq 'narrow'){$window.Width=[Math]::Max($window.MinWidth,[Math]::Min($window.Width+$dx,$area.Width-20));$script:narrowWidth=$window.Width;$window.Left=[Math]::Min($window.Left,$area.Right-$window.Width);return}
 $window.Width=[Math]::Max($window.MinWidth,[Math]::Min($window.Width+$dx,$area.Width))
 $window.Height=[Math]::Max($window.MinHeight,[Math]::Min($window.Height+$dy,$area.Height))
 $window.Left=[Math]::Min($window.Left,$area.Right-$window.Width)
 $window.Top=[Math]::Min($window.Top,$area.Bottom-$window.Height)
}
function Save-Bounds {
 $bounds=@{left=$window.Left;top=$window.Top;width=$(if($script:collapsed -or $script:displayMode -eq 'narrow'){$script:expandedWidth}else{$window.Width});height=$(if($script:collapsed -or $script:displayMode -eq 'narrow'){$script:expandedHeight}else{$window.Height})}|ConvertTo-Json -Compress
 [IO.File]::WriteAllText($boundsFile,$bounds,[Text.UTF8Encoding]::new($false))
}
$controls.ResizeGrip.Add_DragDelta({param($sender,$eventArgs) Resize-Window $eventArgs.HorizontalChange $eventArgs.VerticalChange})
$controls.ResizeGrip.Add_DragCompleted({if($script:displayMode -eq 'narrow'){Set-NarrowMetrics;Save-DisplayMode};if(!$SelfTest){Save-Bounds}})
function Add-PlayerTableRow($values,[bool]$heading,[int]$index) {
 $grid=New-Object Windows.Controls.Grid
 foreach($width in @('32','*','90','70')){
  $column=New-Object Windows.Controls.ColumnDefinition
  $column.Width=[Windows.GridLengthConverter]::new().ConvertFromString($width)
  $grid.ColumnDefinitions.Add($column)
 }
 for($i=0;$i -lt $values.Count;$i++){
  $label=New-Object Windows.Controls.TextBlock
  $label.Text=[string]$values[$i];$label.FontSize=[Math]::Max(11,$controls.FontSlider.Value-2);$label.Padding='2,8,2,8';$label.TextWrapping='Wrap';$label.VerticalAlignment='Center'
  $label.Foreground=if($heading){'#93C5FD'}else{'#E2E8F0'}
  if($heading){$label.FontWeight='SemiBold'}
  if($i -ge 2){$label.TextAlignment='Right'}
  [Windows.Controls.Grid]::SetColumn($label,$i);$grid.Children.Add($label) | Out-Null
 }
 $border=New-Object Windows.Controls.Border
 $border.BorderBrush='#334155';$border.BorderThickness='0,0,0,1'
 if(!$heading -and $index % 2 -eq 0){$border.Background='#1829364E'}
 $border.Child=$grid;$controls.PlayersTable.Children.Add($border) | Out-Null
}
function Update-Page {
 $scroll=$controls.PageScroll
 $samePage=$script:renderedTab -eq $script:tab
 $offset=$scroll.VerticalOffset
 $followChat=$samePage -and $script:tab -eq 'chat' -and ($scroll.ScrollableHeight-$offset) -lt 24
 if(!$samePage -and $script:renderedTab){$script:scrollPositions[$script:renderedTab]=$offset}
 if($script:snapshot){
  $value=[string]$script:snapshot.($script:tab)
  $controls.PageText.Text=if($value){$value}else{'等待此页面的数据…'}
  if(Get-Command Set-HighlightedText -ErrorAction SilentlyContinue){Set-HighlightedText $controls.PageText $controls.PageText.Text}
 }
 $tableVisible=$script:tab -eq 'players' -and $null -ne $script:snapshot.playerRows -and @($script:snapshot.playerRows).Count -gt 0
 $controls.PlayersTable.Visibility=if($tableVisible){'Visible'}else{'Collapsed'}
 $controls.PageText.Visibility=if($tableVisible){'Collapsed'}else{'Visible'}
 if($tableVisible){
  $controls.PlayersTable.Children.Clear()
  $caption=New-Object Windows.Controls.TextBlock
  $caption.Text=if($script:snapshot.game -eq 'lol'){'大乱斗英雄样本胜率 ↓ · 无数据置后'}else{'英雄样本胜率 ↓ · 无数据置后'};$caption.Foreground='#94A3B8';$caption.FontSize=11;$caption.Margin='0,0,0,8'
  if($script:snapshot.teamWinRates){$caption.Text=[string]$script:snapshot.teamWinRates;if($script:snapshot.knowledgeStatus){$caption.Text+=[string](' · '+$script:snapshot.knowledgeStatus)};$caption.ToolTip=[string]$script:snapshot.teamWinRatesNote}
  $caption.TextWrapping='Wrap'
  $controls.PlayersTable.Children.Add($caption) | Out-Null
  Add-PlayerTableRow @('阵营','英雄','胜率 ↓','强度') $true 0
  $index=0
  foreach($row in $script:snapshot.playerRows){
   Add-PlayerTableRow @($row.side,$row.champion,$row.winRateText,$row.tierText) $false $index
   $index++
  }
 }
 $controls.ChatPanel.Visibility=if($script:tab -eq 'chat'){'Visible'}else{'Collapsed'}
 $scroll.UpdateLayout()
 if($script:tab -eq 'events' -or $followChat -or (!$samePage -and $script:tab -eq 'chat' -and !$script:scrollPositions.ContainsKey('chat'))){$scroll.ScrollToEnd()}
 elseif($samePage){$scroll.ScrollToVerticalOffset($offset)}
 elseif($script:scrollPositions.ContainsKey($script:tab)){$scroll.ScrollToVerticalOffset($script:scrollPositions[$script:tab])}
 else{$scroll.ScrollToTop()}
 $scroll.UpdateLayout()
 $script:renderedTab=$script:tab
}
function Set-Tab([string]$name){
 if($name -ne 'chat' -and $script:speechJob){Stop-Job $script:speechJob;Remove-Job $script:speechJob -Force;$script:speechJob=$null}
 if($name -eq 'stats'){$name='players'}
 $script:tab=$name
 foreach($button in $controls.Tabs.Children){$button.Background=if($button.Tag -eq $name){'#2563EB'}else{'#29364E'}}
 Set-Interaction ($name -eq 'chat')
 Update-Page
 if($name -eq 'chat' -and $window.IsVisible){$window.Activate() | Out-Null;$controls.QuestionBox.Focus() | Out-Null;[Windows.Input.Keyboard]::Focus($controls.QuestionBox) | Out-Null}
}
foreach($entry in @(@('advice','战况'),@('equipment','装备'),@('augments','海克斯'),@('players','胜率'),@('events','事件'),@('chat','聊天'))){
 $button=New-Object Windows.Controls.Button
 $button.Tag=$entry[0];$button.Content=$entry[1];$button.FontSize=12
 $button.Add_Click({param($sender,$eventArgs) Set-Tab ([string]$sender.Tag)})
 $controls.Tabs.Children.Add($button) | Out-Null
}
function Update-State {
 try{
  if((Get-Item -LiteralPath $stateFile -ErrorAction Stop).Length -gt 1048576){return}
  $next=[IO.File]::ReadAllText($stateFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
  if($script:snapshot -and ([string]$next.game -ne [string]$script:snapshot.game -or [string]$next.match -ne [string]$script:snapshot.match)){
   $script:scrollPositions=@{};$script:renderedTab=$null
  }
  $changed=(!$script:snapshot -or !$script:renderedTab -or [string]$next.($script:tab) -ne [string]$script:snapshot.($script:tab))
  $enteredSelection=$next.phase -eq 'ChampSelect' -and (!$script:snapshot -or $script:snapshot.phase -ne 'ChampSelect')
  $script:snapshot=$next
  $confirmation=$next.confirmation
  $confirmId=if($confirmation){[string]$confirmation.id}else{''}
  if($confirmId -ne $script:confirmationId){
   $script:confirmationId=$confirmId;$controls.ConfirmationChoices.Children.Clear()
   $controls.ConfirmationPanel.Visibility=if($confirmId){'Visible'}else{'Collapsed'}
   if($confirmId){
    $controls.ConfirmationTitle.Text=[string]$confirmation.title+'（推荐靠前，按实际选择确认）'
    foreach($option in $confirmation.options){
     $choice=New-Object Windows.Controls.Button;$choice.Content=[string]$option.label;$choice.Tag=[string]$option.name;$choice.FontSize=11
     $choice.Add_Click({param($sender,$e) Start-Request 'confirm' @{id=$script:confirmationId;name=[string]$sender.Tag}})
     $controls.ConfirmationChoices.Children.Add($choice)|Out-Null
    }
    $skip=New-Object Windows.Controls.Button;$skip.Content='都不是 / 暂不确认';$skip.FontSize=11
    $skip.Add_Click({Start-Request 'confirm' @{id=$script:confirmationId;dismiss=$true}});$controls.ConfirmationChoices.Children.Add($skip)|Out-Null
   }
  }
  if($enteredSelection){Set-Tab 'players'}
  $controls.TitleText.Text=[string]$next.title
  $controls.TimeText.Text=if($next.phase -eq 'ChampSelect'){'正在选择英雄'}elseif($next.gameTime -and $next.gameTime -ne '等待对局'){'对局 '+$next.gameTime+$(if($next.ended){' · 已结束'}else{''})}else{'等待对局'}
  $controls.SummaryText.Text=[string]$next.summary
  if($next.status -and !$script:job){$controls.HintText.Text=[string]$next.status}
  if($changed){Update-Page}
 }catch{}
 try{
  $launcher=[IO.File]::ReadAllText((Join-Path $StateDir 'launcher-state.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if($now-[double]$launcher.updatedAt -lt 45000 -and $launcher.phase -ne 'stopped'){
   $controls.LauncherText.Text=[string]$launcher.message
   $controls.LauncherText.Visibility=if($launcher.phase -in @('waiting','playing')){'Collapsed'}else{'Visible'}
   $controls.UpdateText.Text=if($launcher.update.result){[string]$launcher.update.result.message}else{[string]$launcher.update.message}
   $controls.UpdateText.Visibility=if($launcher.update.result -or $launcher.update.state -in @('downloading','verifying','extracting','ready','failed')){'Visible'}else{'Collapsed'}
   $controls.ActionButton.Tag=[string]$launcher.action
   $controls.ActionButton.Content=[string]$launcher.actionLabel
   $controls.ActionButton.Visibility=if($launcher.action){'Visible'}else{'Collapsed'}
   if($script:snapshot.phase -ne 'ChampSelect' -and (!$script:snapshot -or $script:snapshot.ended -or $now-[double]$script:snapshot.updatedAt -gt 30000)){
    $controls.TimeText.Text='等待进入游戏'
   }
  }else{$controls.LauncherText.Text='启动管理已停止，请重新打开金宝';$controls.ActionButton.Visibility='Collapsed'}
 }catch{}
 if($script:job -and $script:job.State -in @('Completed','Failed','Stopped')){
  $result=Receive-Job $script:job -ErrorAction SilentlyContinue
  if($result -and !$result.ok -and $script:pendingQuestion -and !$controls.QuestionBox.Text){$controls.QuestionBox.Text=$script:pendingQuestion}
  $script:pendingQuestion=$null
  if($result -and $result.ok){$script:renderedTab=$null}
  $controls.HintText.Text=if($result -and $result.ok){'已完成'}elseif($result -and $result.message){[string]$result.message}else{'请求失败，请检查设置页的模型和服务状态。'}
  Remove-Job $script:job -Force -ErrorAction SilentlyContinue;$script:job=$null
  $controls.SendButton.IsEnabled=$true
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
 if($route -eq 'confirm'){Start-Confirmation $payload;return}
 if($script:job){$controls.HintText.Text='正在处理上一个请求…';return}
 try{
  $url=[IO.File]::ReadAllText((Join-Path $StateDir 'settings-link.txt')).Trim()
  if($url -notmatch '^http://127\.0\.0\.1:[0-9]+/#[a-f0-9]{64}$'){throw 'Invalid local URL'}
  $uri=[Uri]$url;$endpoint=$uri.GetLeftPart([UriPartial]::Authority)+'/api/overlay/'+$route;$nonce=$uri.Fragment.Substring(1)
  $body=$payload | ConvertTo-Json -Compress
  $script:job=Start-Job -ArgumentList $endpoint,$nonce,$body -ScriptBlock {
   param($endpoint,$nonce,$body)
   try{
    Invoke-RestMethod -Uri $endpoint -Method Post -Headers @{'x-jinbao-setup'=$nonce} -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 310 | Out-Null
    @{ok=$true}
   }catch{
    $status=0;try{$status=[int]$_.Exception.Response.StatusCode}catch{}
    $message=switch($status){401{'登录已失效，请在设置页重新登录。'}403{'当前账号没有服务权限，请检查设置页。'}409{'教练忙碌或对局已切换，请稍后重试。'}429{'服务额度已用完或请求过于频繁，请稍后重试。'}default{'连接失败或回复超时，请检查网络后重试。'}}
    @{ok=$false;message=$message}
   }
  }
  $controls.SendButton.IsEnabled=$false
  $controls.HintText.Text=if($route -eq 'ask'){'教练思考中…'}else{'正在检索推荐…'}
 }catch{$controls.HintText.Text='请先启动 DSH，再打开金宝设置页。'}
}
function Send-Question {
 $question=$controls.QuestionBox.Text.Trim()
 if(!$question -or $script:job){return}
 Start-Request 'ask' @{question=$question}
 if($script:job){$script:pendingQuestion=$question;$controls.QuestionBox.Text=''}
}
$controls.SendButton.Add_Click({Send-Question})
$controls.QuestionBox.Add_PreviewKeyDown({param($sender,$eventArgs)
 if($eventArgs.Key -eq [Windows.Input.Key]::Return -and ([Windows.Input.Keyboard]::Modifiers -band [Windows.Input.ModifierKeys]::Shift) -eq 0){Send-Question;$eventArgs.Handled=$true}
})
$controls.CollapseButton.Add_Click({Set-Collapsed $true})
$controls.CloseButton.Add_Click({$window.Close()})
$controls.BubbleClose.Add_Click({$window.Close()})
$controls.ActionButton.Add_Click({
 $action=[string]$controls.ActionButton.Tag
 if($action -in @('login','settings','download')){
  $command=@{action=$action;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $StateDir 'launcher-control.json'),$command,[Text.UTF8Encoding]::new($false))
 }
})
$controls.SettingsButton.Add_Click({
 if($SelfTest){$script:testResult.settings=$controls.SettingsButton.ContextMenu.Items.Count -ge 2;return}
 $controls.SettingsButton.ContextMenu.PlacementTarget=$controls.SettingsButton
 $controls.SettingsButton.ContextMenu.IsOpen=$true
})
$controls.AccountMenuItem.Add_Click({
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
   elseif($script:collapsed){$window.Left=$area.Right-$window.Width}
  }else{
   $transform=$script:source.CompositionTarget.TransformFromDevice
   $dx=($x-$script:dragStartX)*$transform.M11;$dy=($y-$script:dragStartY)*$transform.M22
   if([Math]::Abs($dx)+[Math]::Abs($dy) -gt 3){$script:moved=$true}
   $window.Left=[Math]::Max($area.Left,[Math]::Min($script:dragLeft+$dx,$area.Right-$window.Width))
   $window.Top=[Math]::Max($area.Top,[Math]::Min($script:dragTop+$dy,$area.Bottom-$window.Height))
  }
 }
}
function Test-PointerHotzone([Windows.Point]$screenPoint) {
 $targets=if($script:collapsed){@($controls.Bubble)}else{@($controls.Header,$controls.ActionButton,$controls.Tabs,$controls.Footer,$controls.PageScroll,$controls.ChatPanel,$controls.ResizeGrip,$controls.ConfirmationPanel,$controls.NarrowPanel)}
 foreach($target in $targets){
  if(!$target.IsVisible){continue}
  $local=$target.PointFromScreen($screenPoint)
  if($local.X -ge 0 -and $local.Y -ge 0 -and $local.X -lt $target.ActualWidth -and $local.Y -lt $target.ActualHeight){return $true}
 }
 return $false
}
function Pointer-Tick {
 $p=New-Object 'JinbaoOverlayNative+Point'
 [JinbaoOverlayNative]::GetCursorPos([ref]$p) | Out-Null
 Update-Drag $p.X $p.Y (([JinbaoOverlayNative]::GetAsyncKeyState(1) -band 0x8000) -ne 0)
 Set-PointerMode (Test-PointerHotzone (New-Object Windows.Point($p.X,$p.Y)))
}
$hook=[Windows.Interop.HwndSourceHook]{
 param($handle,$message,$wParam,$lParam,[ref]$handled)
 if($message -eq 0x0312 -and $wParam.ToInt32() -eq 701){Set-Interaction (!$script:interactiveMode);$handled.Value=$true}
 return [IntPtr]::Zero
}
$window.Add_SourceInitialized({
 $script:windowHandle=(New-Object Windows.Interop.WindowInteropHelper($window)).Handle
 $script:source=[Windows.Interop.HwndSource]::FromHwnd($script:windowHandle);$script:source.AddHook($hook)
 [JinbaoOverlayNative]::SetWindowDisplayAffinity($script:windowHandle,0x11)|Out-Null
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
$timer.Add_Tick({Update-State;Update-OverlayPlayback})
$pointerTimer=New-Object Windows.Threading.DispatcherTimer;$pointerTimer.Interval=[TimeSpan]::FromMilliseconds(40)
$pointerTimer.Add_Tick({Pointer-Tick})
$window.Add_Closed({$script:closing=$true;$timer.Stop();$pointerTimer.Stop()})
. (Join-Path $PSScriptRoot 'overlay-modes.ps1')
Set-Tab $PreviewTab;Update-State
try{
 if($PreviewPath){
  $width=[int][Math]::Ceiling($window.Width);$height=[int][Math]::Ceiling($window.Height)
  $root=$window.Content;$root.Measure((New-Object Windows.Size($width,$height)));$root.Arrange((New-Object Windows.Rect(0,0,$width,$height)));$root.UpdateLayout()
  $bitmap=New-Object Windows.Media.Imaging.RenderTargetBitmap($width,$height,96,96,[Windows.Media.PixelFormats]::Pbgra32);$bitmap.Render($root)
  $encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder;$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream=[IO.File]::Create([IO.Path]::GetFullPath($PreviewPath));try{$encoder.Save($stream)}finally{$stream.Dispose()}
  Write-Output 'Overlay preview rendered.'
 }else{
  if($SelfTest){
   $window.Left=-10000;$window.Top=-10000;$window.Opacity=0
   $testing=New-Object Windows.Threading.DispatcherTimer;$testing.Interval=[TimeSpan]::FromMilliseconds(300)
   $testing.Add_Tick({
    $testing.Stop()
    $controls.FontSlider.Value=14
    Set-Tab 'advice'
    $controls.ConfirmationPanel.Visibility='Collapsed'
    Set-Interaction $false;Set-PointerMode $false
    $script:testResult.clickThrough=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x20) -ne 0
    Set-PointerMode $true
    $script:testResult.headerClickable=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x20) -eq 0
    $script:testResult.headerNoActivate=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x08000000) -ne 0
    $click=New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)
    $controls.SettingsButton.RaiseEvent($click)
    $controls.CollapseButton.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
    $script:testResult.collapsed=$script:collapsed -and $window.Width -eq 110
    $script:testResult.collapsedRightEdge=[Math]::Abs($window.Left+$window.Width-$area.Right) -lt 1
    Set-Collapsed $false;$script:testResult.expanded=$window.Width -ge 420
    $script:testResult.tabs=$controls.Tabs.Children.Count
    $script:testResult.simplifiedNavigation=$controls.Tabs.Children.Count -eq 6 -and @($controls.Tabs.Children | Where-Object {$_.Tag -eq 'teamfight'}).Count -eq 0 -and $null -eq $window.FindName('RefreshButton') -and $null -eq $window.FindName('TacticButton') -and $null -eq $window.FindName('InteractionButton') -and $null -eq $window.FindName('AppearanceButton')
    $script:testResult.appearanceInSettings=$controls.SettingsButton.ContextMenu.Items[0] -eq $controls.AppearanceMenuItem
    $script:testResult.singleWinRateTab=@($controls.Tabs.Children | Where-Object {$_.Content -eq '胜率'}).Count -eq 1 -and @($controls.Tabs.Children | Where-Object {$_.Content -eq '对手' -or $_.Tag -eq 'stats'}).Count -eq 0
    $script:dragStartX=0;$script:dragStartY=0;$script:dragLeft=100;$script:dragTop=100;$script:dragging=$true;$script:bubbleDrag=$false
    Update-Drag 50 40 $true;$script:testResult.dragMoved=$window.Left -gt 100 -and $window.Top -gt 100
    Update-Drag 50 40 $false;$script:testResult.dragReleased=!$script:dragging
    $window.UpdateLayout();$beforeBody=$controls.PageScroll.ActualHeight
    $beforeWidth=$window.Width;$beforeHeight=$window.Height
    $controls.ResizeGrip.RaiseEvent((New-Object Windows.Controls.Primitives.DragDeltaEventArgs(60,100)))
    $window.UpdateLayout()
    $script:testResult.resizeDrag=$window.Width -eq $beforeWidth+60 -and $window.Height -eq $beforeHeight+100
    $script:testResult.resizeExpandsBody=$controls.PageScroll.ActualHeight -ge $beforeBody+99
    Set-Interaction $false
    Set-PointerMode (Test-PointerHotzone ($controls.ResizeGrip.PointToScreen((New-Object Windows.Point(13,13)))))
    $script:testResult.resizeReceivesMouse=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x20) -eq 0
    Resize-Window -10000 -10000;$window.UpdateLayout()
    $script:testResult.resizeMinimum=$window.Width -eq 420 -and $window.Height -eq 220 -and $controls.PageScroll.ActualHeight -gt 60
    $script:testResult.summaryOnlyInBattle=$controls.TimeText.Parent.Visibility -eq 'Collapsed'
    Resize-Window 160 380;$window.UpdateLayout();Save-Bounds
    $savedBounds=[IO.File]::ReadAllText($boundsFile) | ConvertFrom-Json
    $script:testResult.resizeSaved=$savedBounds.width -eq 580 -and $savedBounds.height -eq 600
    $controls.FontSlider.Value=18
    $savedFont=[IO.File]::ReadAllText($preferencesFile) | ConvertFrom-Json
    $script:testResult.fontZoomSaved=$controls.PageText.FontSize -eq 18 -and $savedFont.bodyFontSize -eq 18
    $controls.FontSlider.Value=14
    $controls.AppearanceMenuItem.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.MenuItem]::ClickEvent)))
    $script:testResult.appearanceOpens=$controls.AppearancePanel.Visibility -eq 'Visible'
    $controls.AppearanceMenuItem.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.MenuItem]::ClickEvent)))
    foreach($button in $controls.Tabs.Children){$button.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))}
    $script:testResult.chatInteractive=$script:interactiveMode -and $controls.ChatPanel.Visibility -eq 'Visible'
    $script:testResult.chatFocusable=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x08000000) -eq 0
    $controls.OpacitySlider.Value=45
    $script:testResult.opacityChanged=$controls.MainBorder.Background.Color.A -eq 115 -and $controls.OpacityText.Text -eq '45%'
    $savedPreferences=[IO.File]::ReadAllText($preferencesFile) | ConvertFrom-Json
    $script:testResult.opacitySaved=$savedPreferences.backgroundOpacity -eq 45
    $longText=(1..150 | ForEach-Object {"第 $_ 条策略内容，用于验证滚动位置。"}) -join "`n"
    $script:snapshot=[pscustomobject]@{advice=$longText;equipment=$longText;chat=$longText}
    Set-Tab 'advice';Set-Interaction $false
    $contentPoint=$controls.PageScroll.PointToScreen((New-Object Windows.Point(50,50)))
    Set-PointerMode (Test-PointerHotzone $contentPoint)
    $script:testResult.contentReceivesMouse=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x20) -eq 0
    $wheel=New-Object Windows.Input.MouseWheelEventArgs([Windows.Input.Mouse]::PrimaryDevice,0,-120)
    $wheel.RoutedEvent=[Windows.Input.Mouse]::MouseWheelEvent
    $controls.PageScroll.RaiseEvent($wheel);$controls.PageScroll.UpdateLayout()
    $script:testResult.wheelScrolls=$controls.PageScroll.VerticalOffset -gt 0
    $controls.PageScroll.ScrollToVerticalOffset(200);$controls.PageScroll.UpdateLayout()
    $offset=$controls.PageScroll.VerticalOffset
    $script:snapshot.advice=$longText+"`n新增策略";Update-Page
    $script:testResult.refreshPreservesScroll=$offset -gt 0 -and [Math]::Abs($controls.PageScroll.VerticalOffset-$offset) -lt 1
    Set-Tab 'equipment';Set-Tab 'advice'
    $script:testResult.tabRestoresScroll=[Math]::Abs($controls.PageScroll.VerticalOffset-$offset) -lt 1
    Set-Tab 'chat';$controls.PageScroll.ScrollToVerticalOffset(200);$controls.PageScroll.UpdateLayout()
    $script:snapshot.chat=$longText+"`n新的聊天消息";Update-Page
    $script:testResult.chatReadingPreserved=[Math]::Abs($controls.PageScroll.VerticalOffset-200) -lt 1
    $controls.PageScroll.ScrollToEnd();$controls.PageScroll.UpdateLayout()
    $script:snapshot.chat+="`n又一条消息";Update-Page
    $script:testResult.chatFollowsBottom=($controls.PageScroll.ScrollableHeight-$controls.PageScroll.VerticalOffset) -lt 1
    $script:snapshot=[pscustomobject]@{events=$longText}
    Set-Tab 'events'
    $script:testResult.eventsOpenAtBottom=($controls.PageScroll.ScrollableHeight-$controls.PageScroll.VerticalOffset) -lt 1
    $controls.PageScroll.ScrollToVerticalOffset(100);$controls.PageScroll.UpdateLayout()
    $script:snapshot.events+="`n最新装备购买事件";Update-Page
    $script:testResult.eventsFollowNewest=($controls.PageScroll.ScrollableHeight-$controls.PageScroll.VerticalOffset) -lt 1 -and $controls.PageText.Text.EndsWith('最新装备购买事件')
    $script:snapshot=[pscustomobject]@{players='英雄战绩';playerRows=@([pscustomobject]@{side='敌';champion='厄斐琉斯';winRateText='55%';tierText='T0'})}
    Set-Tab 'players'
    $script:testResult.playerTableVisible=$controls.PlayersTable.Visibility -eq 'Visible' -and $controls.PageText.Visibility -eq 'Collapsed'
    $script:testResult.playerTableColumns=$controls.PlayersTable.Children[2].Child.ColumnDefinitions.Count -eq 4
    $selectionFixture=@{game='lol';match='select-selftest';phase='ChampSelect';title='金宝';gameTime='等待对局';summary='安妮';players='安妮 · 55% · T0';updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();playerRows=@(@{side='备选';champion='安妮';winRateText='55%';tierText='T0'})}
    [IO.File]::WriteAllText($stateFile,($selectionFixture | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    Update-State
    $script:testResult.selectionAutoOpens=$script:tab -eq 'players' -and $controls.TimeText.Text -eq '正在选择英雄'
    $script:testResult.gameTime=$controls.TimeText.Text
    Set-DisplayMode 'narrow';$window.UpdateLayout()
    $script:testResult.narrowMode=$controls.NarrowPanel.Visibility -eq 'Visible' -and $controls.Expanded.Visibility -eq 'Collapsed' -and $window.Height -ge 2*$script:subtitleRowHeight
    $lines=@(Split-Subtitle ('安妮现在先清线，等队友先手，再根据强化选择下一件装备。'*4) 180)
    $script:testResult.subtitleSplits=$lines.Count -gt 2 -and ($lines -join '') -eq ('安妮现在先清线，等队友先手，再根据强化选择下一件装备。'*4)
    $script:playbackQueue.Add([pscustomobject]@{id='native-test';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();text='安妮先清线，选择适合当前阵容的强化。'})
    Playback-Tick;$script:lineElapsed=10000;Playback-Tick
    $script:testResult.subtitleAdvances=$script:subtitleIndex -gt 0 -or $script:playbackPhase -eq 'linger' -or !$script:activePlayback
    Set-DisplayMode 'silent';$window.UpdateLayout();$script:testResult.silentMode=$script:collapsed -and $controls.Bubble.Visibility -eq 'Visible'
    Set-DisplayMode 'large';$window.UpdateLayout();$script:testResult.largeRestored=$controls.Expanded.Visibility -eq 'Visible' -and !$script:collapsed -and $window.Height -ge 220
    $selectionFixture.confirmation=@{id='test-confirm';title='刚才选了哪个海克斯？';options=@(@{name='乙';label='优先推荐 · 乙'},@{name='甲';label='甲'},@{name='丙';label='丙'})}
    [IO.File]::WriteAllText($stateFile,($selectionFixture|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false));Update-State
    $script:testResult.confirmationVisible=$controls.ConfirmationPanel.Visibility -eq 'Visible' -and $controls.ConfirmationChoices.Children.Count -eq 4 -and $controls.ConfirmationChoices.Children[0].Tag -eq '乙'
    Show-QuickConfirmation $selectionFixture.confirmation
    $script:testResult.quickConfirmationBuilt=$quickConfirm.Child.Child.Children.Count -eq 5 -and $quickConfirm.Child.Child.Children[1].Tag.name -eq '乙'
    $script:snapshot=[pscustomobject]@{keywords=@('安妮','残疫');summary='安妮'};Set-HighlightedText $controls.PageText '安妮下一件考虑残疫'
    $script:testResult.keywordHighlight=$controls.PageText.Inlines.Count -gt 1 -and $controls.PageText.Text -eq '安妮下一件考虑残疫'
    $script:testResult.voiceInputPresent=$mic.Content -eq '语音'
    $controls.CloseButton.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
    $script:testResult.closed=$script:closing
   });$testing.Start()
  }
  $timer.Start();if(!$SelfTest){$pointerTimer.Start()}
  $window.ShowDialog() | Out-Null
  if($SelfTest){$script:testResult | ConvertTo-Json -Compress}
  else{
   Save-Bounds
   [IO.File]::WriteAllText((Join-Path $StateDir 'overlay-stopped'),'closed',[Text.UTF8Encoding]::new($false))
  }
 }
}finally{
 $timer.Stop();$pointerTimer.Stop()
 if($modeClock){$modeClock.Stop()}
 if($quickConfirm){$quickConfirm.IsOpen=$false}
 foreach($ownedJob in @($script:confirmationJob,$script:speechJob)){if($ownedJob){Stop-Job $ownedJob -ErrorAction SilentlyContinue;Remove-Job $ownedJob -Force -ErrorAction SilentlyContinue}}
 if($script:synth){$script:synth.SpeakAsyncCancelAll();$script:synth.Dispose()}
 if($script:job){Stop-Job $script:job -ErrorAction SilentlyContinue;Remove-Job $script:job -Force -ErrorAction SilentlyContinue}
 if($script:tray){$script:tray.Visible=$false;$script:tray.Dispose()}
 if($script:hotkeyRegistered){[JinbaoOverlayNative]::UnregisterHotKey($script:windowHandle,701) | Out-Null}
 if($script:source){$script:source.RemoveHook($hook)}
 if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()
}
