Add-Type -AssemblyName System.Drawing
if(-not('JinbaoWindowPixels' -as [type])){Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class JinbaoWindowPixels {
 [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
 public static bool Usable(Bitmap image) {
  int minR=255,minG=255,minB=255,maxR=0,maxG=0,maxB=0;
  for(int row=0;row<12;row++)for(int col=0;col<16;col++){
   Color c=image.GetPixel((2*col+1)*image.Width/32,(2*row+1)*image.Height/24);
   minR=Math.Min(minR,c.R);maxR=Math.Max(maxR,c.R);minG=Math.Min(minG,c.G);maxG=Math.Max(maxG,c.G);minB=Math.Min(minB,c.B);maxB=Math.Max(maxB,c.B);
  }
  return Math.Max(maxR-minR,Math.Max(maxG-minG,maxB-minB))>12;
 }
 public static bool CopyWindow(IntPtr handle,Bitmap image) {
  using(Graphics graphics=Graphics.FromImage(image)){
   graphics.Clear(Color.Magenta);
   IntPtr hdc=graphics.GetHdc();bool ok;
   try{ok=PrintWindow(handle,hdc,3);}finally{graphics.ReleaseHdc(hdc);}
   if(!ok)return false;
  }
  return Usable(image);
 }
}
'@}
. (Join-Path $PSScriptRoot 'capture-coordination.ps1')
function Copy-JinbaoScreenPixels([Drawing.Graphics]$graphics,[Drawing.Bitmap]$bitmap,[int]$left,[int]$top){
 $graphics.CopyFromScreen($left,$top,0,0,$bitmap.Size)
}
function Copy-JinbaoGamePixels([IntPtr]$handle,[Drawing.Bitmap]$bitmap,[int]$left,[int]$top,[string]$stateDir){
 # Window rendering excludes other windows without changing OBS/display affinity.
 # Some hardware-rendered games return black pixels: detect that and use the
 # coordinated screen capture, never silently feed blank pixels to OCR.
 if([JinbaoWindowPixels]::CopyWindow($handle,$bitmap)){return 'window-client'}
 $graphics=[Drawing.Graphics]::FromImage($bitmap);$lease=$null
 try{$lease=Enter-JinbaoCapture $stateDir;Copy-JinbaoScreenPixels $graphics $bitmap $left $top}finally{Exit-JinbaoCapture $lease;$graphics.Dispose()}
 if(![JinbaoWindowPixels]::Usable($bitmap)){throw 'screen_render_empty'}
 return 'screen-fallback'
}
