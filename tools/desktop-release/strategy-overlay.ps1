param(
    [string]$StateDir=(Join-Path $env:USERPROFILE '.dsh/jinbao'),
    [switch]$Interactive,
    [string]$PreviewPath,
    [switch]$SelfTest
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JinbaoOverlayNative {
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr handle,int index);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr handle,int index,int value);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr handle,int id,uint modifiers,uint key);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr handle,int id);
}
'@
$StateDir=[IO.Path]::GetFullPath($StateDir)
[IO.Directory]::CreateDirectory($StateDir) | Out-Null
$stateFile=Join-Path $StateDir 'coach_live_state.json'
$boundsFile=Join-Path $StateDir 'strategy-overlay-bounds.json'
$hash=[Security.Cryptography.SHA256]::Create()
try{$identity=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($StateDir.ToLowerInvariant())))).Replace('-','').Substring(0,16)}finally{$hash.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Local\JinbaoStrategyOverlay-'+$identity))
$owned=$false
try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
if(!$owned){$mutex.Dispose();Write-Output 'Jinbao strategy overlay is already running.';exit 0}
[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="金宝策略悬浮窗" Width="470" Height="360" MinWidth="340" MinHeight="220" WindowStyle="None" AllowsTransparency="True" Background="Transparent" Topmost="True" ShowInTaskbar="False" ShowActivated="False" ResizeMode="CanResizeWithGrip">
 <Border Background="#EF172033" BorderBrush="#536078" BorderThickness="1" CornerRadius="14" Padding="18">
  <Grid>
   <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
   <Grid Grid.Row="0">
    <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
    <TextBlock x:Name="TitleText" Text="金宝 · 游戏策略" Foreground="#F1F5F9" FontSize="18" FontWeight="SemiBold" VerticalAlignment="Center" Cursor="SizeAll"/>
    <Button x:Name="SettingsButton" Grid.Column="1" Content="设置" Padding="8,4" Margin="6,0" Background="#29364E" Foreground="#E2E8F0" BorderThickness="0"/>
    <Button x:Name="CloseButton" Grid.Column="2" Content="×" FontSize="19" Padding="8,0" Background="#29364E" Foreground="#E2E8F0" BorderThickness="0"/>
   </Grid>
   <TextBlock x:Name="TimeText" Grid.Row="1" Text="等待游戏日志" Foreground="#94A3B8" FontSize="12" Margin="0,12,0,10"/>
   <ScrollViewer Grid.Row="2" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
    <TextBlock x:Name="AdviceText" Text="先启动 DSH、保存模型配置，再启动游戏日志采集。策略建议会自动显示在这里。" TextWrapping="Wrap" Foreground="#E2E8F0" FontSize="16" LineHeight="26"/>
   </ScrollViewer>
   <TextBlock x:Name="HintText" Grid.Row="3" Text="鼠标穿透 · Ctrl+Alt+J 切换交互" Foreground="#93C5FD" FontSize="12" Margin="0,12,0,0" TextWrapping="Wrap"/>
  </Grid>
 </Border>
</Window>
'@
$reader=New-Object Xml.XmlNodeReader $xaml
$window=[Windows.Markup.XamlReader]::Load($reader)
$title=$window.FindName('TitleText');$time=$window.FindName('TimeText');$advice=$window.FindName('AdviceText');$hint=$window.FindName('HintText')
$script:interactiveMode=[bool]$Interactive
$script:windowHandle=[IntPtr]::Zero
$script:source=$null
$script:hotkeyRegistered=$false
$script:testResult=$null
$area=[Windows.SystemParameters]::WorkArea
$window.Left=$area.Right-$window.Width-18;$window.Top=$area.Top+30
if(!$SelfTest){
    try{
        $saved=[IO.File]::ReadAllText($boundsFile) | ConvertFrom-Json
        if($saved.width -ge 340 -and $saved.width -le $area.Width){$window.Width=[double]$saved.width}
        if($saved.height -ge 220 -and $saved.height -le $area.Height){$window.Height=[double]$saved.height}
        $window.Left=[Math]::Max($area.Left,[Math]::Min([double]$saved.left,$area.Right-$window.Width))
        $window.Top=[Math]::Max($area.Top,[Math]::Min([double]$saved.top,$area.Bottom-$window.Height))
    }catch{}
}
function Update-Advice {
    try{
        if(!(Test-Path -LiteralPath $stateFile)){return}
        if((Get-Item -LiteralPath $stateFile).Length -gt 1048576){return}
        $state=[IO.File]::ReadAllText($stateFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
        $game= switch([string]$state.game){'lol'{'英雄联盟'}'wzry'{'王者荣耀'}default{'游戏'}}
        $title.Text='金宝 · '+$game+'策略'
        $text=[string]$state.lastReply.text
        if($text){
            $advice.Text=$text.Substring(0,[Math]::Min($text.Length,2000))
            try{$at=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$state.lastReply.at).LocalDateTime;$time.Text='最新建议 · '+$at.ToString('HH:mm:ss')}catch{$time.Text='最新策略建议'}
        }
    }catch{}
}
function Set-Interaction([bool]$enabled){
    $script:interactiveMode=$enabled
    if($script:windowHandle -ne [IntPtr]::Zero){
        $style=[JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20)
        if($enabled){$style=$style -band (-bnot (0x20 -bor 0x08000000))}
        else{$style=$style -bor 0x20 -bor 0x08000000}
        [JinbaoOverlayNative]::SetWindowLong($script:windowHandle,-20,$style) | Out-Null
    }
    $hint.Text=if($enabled){'可拖动、缩放和滚动 · Ctrl+Alt+J 恢复鼠标穿透'}else{'鼠标穿透 · Ctrl+Alt+J 切换交互'}
}
$hook=[Windows.Interop.HwndSourceHook]{
    param($handle,$message,$wParam,$lParam,[ref]$handled)
    if($message -eq 0x0312 -and $wParam.ToInt32() -eq 701){
        Set-Interaction (!$script:interactiveMode)
        $handled.Value=$true
    }
    return [IntPtr]::Zero
}
$window.Add_SourceInitialized({
    $script:windowHandle=(New-Object Windows.Interop.WindowInteropHelper($window)).Handle
    $script:source=[Windows.Interop.HwndSource]::FromHwnd($script:windowHandle)
    $script:source.AddHook($hook)
    $modifiers=if($SelfTest){7}else{3}
    $key=if($SelfTest){123}else{74}
    $script:hotkeyRegistered=[JinbaoOverlayNative]::RegisterHotKey($script:windowHandle,701,$modifiers,$key)
    if(!$script:hotkeyRegistered){Set-Interaction $true;$hint.Text='热键被占用 · 当前可直接拖动和关闭'}
    else{Set-Interaction $script:interactiveMode}
})
$title.Add_MouseLeftButtonDown({if($script:interactiveMode){$window.DragMove()}})
$window.FindName('CloseButton').Add_Click({$window.Close()})
$window.FindName('SettingsButton').Add_Click({
    try{
        $url=[IO.File]::ReadAllText((Join-Path $StateDir 'settings-link.txt')).Trim()
        if($url -notmatch '^http://127\.0\.0\.1:[0-9]+/#[a-f0-9]{64}$'){throw 'Invalid local URL'}
        Start-Process $url
    }catch{$hint.Text='请先启动 DSH，再从安装包打开设置。'}
})
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromMilliseconds(1200)
$timer.Add_Tick({Update-Advice})
Update-Advice
try{
    if($PreviewPath){
        $root=$window.Content
        $root.Measure((New-Object Windows.Size(470,360)))
        $root.Arrange((New-Object Windows.Rect(0,0,470,360)))
        $root.UpdateLayout()
        $bitmap=New-Object Windows.Media.Imaging.RenderTargetBitmap(470,360,96,96,[Windows.Media.PixelFormats]::Pbgra32)
        $bitmap.Render($root)
        $encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder
        $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
        $stream=[IO.File]::Create([IO.Path]::GetFullPath($PreviewPath))
        try{$encoder.Save($stream)}finally{$stream.Dispose()}
        Write-Output 'Overlay preview rendered.'
    }else{
        if($SelfTest){
            $window.Left=-10000;$window.Top=-10000;$window.Opacity=0
            $closing=New-Object Windows.Threading.DispatcherTimer
            $closing.Interval=[TimeSpan]::FromSeconds(2)
            $closing.Add_Tick({
                $closing.Stop()
                Set-Interaction $false
                $pass=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x20) -ne 0
                Set-Interaction $true
                $interactive=([JinbaoOverlayNative]::GetWindowLong($script:windowHandle,-20) -band 0x20) -eq 0
                $script:testResult=@{clickThrough=$pass;interactive=$interactive;hotkey=$script:hotkeyRegistered;title=$title.Text;text=$advice.Text;topmost=$window.Topmost}
                $window.Close()
            })
            $closing.Start()
        }
        $timer.Start()
        $window.ShowDialog() | Out-Null
        if($SelfTest){$script:testResult | ConvertTo-Json -Compress}
        else{
            $bounds=@{left=$window.Left;top=$window.Top;width=$window.Width;height=$window.Height}|ConvertTo-Json -Compress
            [IO.File]::WriteAllText($boundsFile,$bounds,[Text.UTF8Encoding]::new($false))
        }
    }
}finally{
    $timer.Stop()
    if($script:hotkeyRegistered){[JinbaoOverlayNative]::UnregisterHotKey($script:windowHandle,701) | Out-Null}
    if($script:source){$script:source.RemoveHook($hook)}
    if($owned){$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
