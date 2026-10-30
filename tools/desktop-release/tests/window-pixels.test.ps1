$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../window-pixels.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -WarningAction SilentlyContinue -TypeDefinition @'
public class JinbaoNoActivateTestForm : System.Windows.Forms.Form {
 protected override bool ShowWithoutActivation {get{return true;}}
 protected override void WndProc(ref System.Windows.Forms.Message message) {
  if(message.Msg==0x0317||message.Msg==0x0318){
   using(System.Drawing.Graphics g=System.Drawing.Graphics.FromHdc(message.WParam)){
    g.Clear(System.Drawing.Color.Blue);g.FillRectangle(System.Drawing.Brushes.White,0,0,150,240);
   }
   message.Result=new System.IntPtr(1);return;
  }
  base.WndProc(ref message);
 }
}
'@
function Enter-JinbaoCapture([string]$stateDir){throw 'Window-only fixture must not exclude the overlay or read the desktop'}
$form=[JinbaoNoActivateTestForm]::new();$bitmap=[Drawing.Bitmap]::new(320,240)
try{
 $form.ShowInTaskbar=$false;$form.StartPosition='Manual';$form.Location=[Drawing.Point]::new(-20000,-20000);$form.ClientSize=[Drawing.Size]::new(320,240);$form.BackColor=[Drawing.Color]::Blue
 $panel=[Windows.Forms.Panel]::new();$panel.BackColor=[Drawing.Color]::White;$panel.Bounds=[Drawing.Rectangle]::new(0,0,150,240);$form.Controls.Add($panel)
 $form.Show();[Windows.Forms.Application]::DoEvents()
 $ready=$false
 for($attempt=0;$attempt -lt 20;$attempt++){
  if([JinbaoWindowPixels]::CopyWindow($form.Handle,$bitmap)){$ready=$true;break}
  [Threading.Thread]::Sleep(25);[Windows.Forms.Application]::DoEvents()
 }
 if(!$ready){throw 'Owned window did not complete its initial render'}
 $backend=Copy-JinbaoGamePixels $form.Handle $bitmap -20000 -20000 ''
 if($backend -ne 'window-client' -or ![JinbaoWindowPixels]::Usable($bitmap)){throw 'Window capture was not usable'}
 $graphics=[Drawing.Graphics]::FromImage($bitmap);try{$graphics.Clear([Drawing.Color]::Black)}finally{$graphics.Dispose()}
 if([JinbaoWindowPixels]::Usable($bitmap)){throw 'Black frame must be rejected'}
 function Enter-JinbaoCapture([string]$stateDir){return @{fixture=$true}}
 $script:releases=0
 function Exit-JinbaoCapture($lease){$script:releases++}
 function Copy-JinbaoScreenPixels($graphics,$bitmap,$left,$top){$graphics.Clear([Drawing.Color]::Black)}
 $rejected=$false;try{Copy-JinbaoGamePixels ([IntPtr]::Zero) $bitmap 0 0 ''|Out-Null}catch{$rejected=$_.Exception.Message -eq 'screen_render_empty'}
 if(!$rejected -or $script:releases -ne 1){throw 'Black screen fallback must release its lease and reject pixels'}
 @{windowOnly=$true;screenFallbackUsed=$false;blackFrameRejected=$true;screenFallbackBlackRejected=$true;fallbackLeaseReleased=$true}|ConvertTo-Json -Compress
}finally{$form.Close();$form.Dispose();$bitmap.Dispose()}
