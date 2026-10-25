using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.IO;
using System.Text.RegularExpressions;

public sealed class JinbaoAllyUltimateObservation {
 public string Champion;public double X,Y,Size,Score;public bool? Ready;public double IndicatorScore;
}
public static class JinbaoAllyUltimateVision {
 sealed class Template {public string Alias;public Pattern Coarse,Fine;}
 static Template[] templates=new Template[0];
 static JinbaoAllyUltimateObservation[] layout=new JinbaoAllyUltimateObservation[0];
 static int layoutWidth,layoutHeight;
 static long nextCalibration;
 public static void Configure(string[] aliases,string[] encoded){
  templates=new Template[0];layout=new JinbaoAllyUltimateObservation[0];nextCalibration=0;
  if(aliases==null||encoded==null||aliases.Length!=encoded.Length||aliases.Length>5)return;
  var result=new List<Template>();
  for(int i=0;i<aliases.Length;i++){
   if(!Regex.IsMatch(aliases[i],"^[A-Za-z0-9_]{1,40}$")||encoded[i].Length>90000)continue;
   try{byte[] bytes=Convert.FromBase64String(encoded[i]);if(bytes.Length>65536)continue;using(var stream=new MemoryStream(bytes))using(var bitmap=new Bitmap(stream)){
    if(bitmap.Width<24||bitmap.Height<24||bitmap.Width>256||bitmap.Height>256)continue;
    var frame=Read(bitmap);result.Add(new Template{Alias=aliases[i],Coarse=Make(frame,8),Fine=Make(frame,16)});
   }}catch(ArgumentException){}catch(FormatException){}
  }
  templates=result.ToArray();
 }
 sealed class Frame {public int W,H;public byte[] Pixels;public float[] Gray;public double[] Integral;}
 sealed class Pattern {public float[] X,Y,Value;public double Norm;public int Grid;}
 static Frame Read(Bitmap bitmap) {
  var data=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  byte[] raw=new byte[Math.Abs(data.Stride)*bitmap.Height];try{Marshal.Copy(data.Scan0,raw,0,raw.Length);}finally{bitmap.UnlockBits(data);}
  var f=new Frame{W=bitmap.Width,H=bitmap.Height,Pixels=new byte[bitmap.Width*bitmap.Height*4],Gray=new float[bitmap.Width*bitmap.Height]};
  for(int y=0;y<f.H;y++)for(int x=0;x<f.W;x++){int source=y*Math.Abs(data.Stride)+x*4,index=y*f.W+x;for(int k=0;k<4;k++)f.Pixels[index*4+k]=raw[source+k];f.Gray[index]=(raw[source]*11+raw[source+1]*59+raw[source+2]*30)/100f;}
  f.Integral=new double[(f.W+1)*(f.H+1)];for(int y=0;y<f.H;y++){double sum=0;for(int x=0;x<f.W;x++){sum+=f.Gray[y*f.W+x];f.Integral[(y+1)*(f.W+1)+x+1]=sum+f.Integral[y*(f.W+1)+x+1];}}
  return f;
 }
 static float Box(Frame f,double cx,double cy,double half){int x0=Math.Max(0,(int)(cx-half)),y0=Math.Max(0,(int)(cy-half)),x1=Math.Min(f.W,(int)(cx+half+1)),y1=Math.Min(f.H,(int)(cy+half+1));int s=f.W+1;return (float)((f.Integral[y1*s+x1]-f.Integral[y0*s+x1]-f.Integral[y1*s+x0]+f.Integral[y0*s+x0])/Math.Max(1,(x1-x0)*(y1-y0)));}
 static Pattern Make(Frame f,int grid) {
  var xs=new List<float>();var ys=new List<float>();var values=new List<float>();
  for(int y=0;y<grid;y++)for(int x=0;x<grid;x++){float u=(x+.5f)/grid,v=(y+.5f)/grid;if((u-.5)*(u-.5)+(v-.5)*(v-.5)>.17)continue;xs.Add(u);ys.Add(v);values.Add(Box(f,u*f.W,v*f.H,f.W/(grid*2.0)));}
  double mean=values.Average(v=>(double)v);var centered=values.Select(v=>(float)(v-mean)).ToArray();return new Pattern{X=xs.ToArray(),Y=ys.ToArray(),Value=centered,Norm=Math.Sqrt(centered.Sum(v=>v*v)),Grid=grid};
 }
 static double Correlate(Frame f,Pattern p,int left,int top,int size) {
  if(left<0||top<0||left+size>=f.W||top+size>=f.H)return -1;
  double sum=0,squares=0,dot=0;for(int i=0;i<p.Value.Length;i++){float value=Box(f,left+p.X[i]*size,top+p.Y[i]*size,size/(p.Grid*2.0));sum+=value;squares+=value*value;dot+=value*p.Value[i];}
  double norm=Math.Sqrt(Math.Max(0,squares-sum*sum/p.Value.Length));return norm>3&&p.Norm>3?dot/(norm*p.Norm):-1;
 }
 static bool Green(Frame f,int x,int y){if(x<0||y<0||x>=f.W||y>=f.H)return false;int i=(y*f.W+x)*4;return f.Pixels[i+1]>105&&f.Pixels[i+1]>f.Pixels[i+2]*1.35&&f.Pixels[i+1]>f.Pixels[i]*1.08;}
 static void Indicator(Frame f,JinbaoAllyUltimateObservation match) {
  double best=-1;bool? ready=null;int r=Math.Max(3,(int)Math.Round(match.Size*.145));
  for(int oy=-(int)(match.Size*.14);oy<=(int)(match.Size*.04);oy++)for(int ox=-3;ox<=3;ox++){
   int cx=(int)(match.X+match.Size*.5)+ox,cy=(int)match.Y+oy;if(cx-r<0||cy-r<0||cx+r>=f.W||cy+r>=f.H)continue;
   double green=0,center=0,gold=0,edge=0;int samples=0;
   for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){green+=Green(f,cx+x,cy+y)?1:0;center+=f.Gray[(cy+y)*f.W+cx+x];samples++;}green/=samples;center/=samples;
   for(int i=0;i<16;i++){double a=i*Math.PI/8;int x=cx+(int)Math.Round(Math.Cos(a)*r),y=cy+(int)Math.Round(Math.Sin(a)*r),j=(y*f.W+x)*4;gold+=f.Pixels[j+2]>60&&f.Pixels[j+2]>f.Pixels[j]*1.25&&f.Pixels[j+1]>f.Pixels[j]*1.05?1:0;edge+=f.Gray[y*f.W+x];}gold/=16;edge/=16;
   bool? state=green>=.64?true:gold>=.25&&green<.16&&center<90&&edge>center+8?(bool?)false:null;
   double confidence=state==true?green+gold*.2:state==false?gold+Math.Min(.3,(edge-center)/100):0;
   if(state!=null&&confidence>best){best=confidence;ready=state;}
  }
  match.Ready=ready;match.IndicatorScore=Math.Round(Math.Max(0,best),3);
 }
 static JinbaoAllyUltimateObservation[] Find(Frame f) {
  var matches=new List<JinbaoAllyUltimateObservation>();
  foreach(var template in templates){
   var coarse=template.Coarse;var fine=template.Fine;var candidates=new List<JinbaoAllyUltimateObservation>();
   int min=(int)(32*f.H/1080.0),max=(int)(80*f.H/1080.0),step=Math.Max(3,(int)(5*f.H/1080.0));
   for(int size=Math.Max(24,min);size<=max;size+=Math.Max(3,(int)(4*f.H/1080.0)))for(int y=(int)(f.H*.12);y<f.H*.87-size;y+=step)for(int x=0;x<f.W-size;x+=step){
    if(x>f.W*.2&&x<f.W*.68)continue;double score=Correlate(f,coarse,x,y,size);if(score<.67)continue;
    var previous=candidates.FirstOrDefault(m=>Math.Abs(m.X-x)<size*.4&&Math.Abs(m.Y-y)<size*.4);if(previous!=null){if(score>previous.Score){previous.X=x;previous.Y=y;previous.Size=size;previous.Score=score;}continue;}
    candidates.Add(new JinbaoAllyUltimateObservation{Champion=template.Alias,X=x,Y=y,Size=size,Score=score});candidates=candidates.OrderByDescending(m=>m.Score).Take(12).ToList();
   }
   foreach(var candidate in candidates){JinbaoAllyUltimateObservation best=null;for(int size=(int)candidate.Size-3;size<=candidate.Size+3;size++)for(int y=(int)candidate.Y-step;y<=candidate.Y+step;y++)for(int x=(int)candidate.X-step;x<=candidate.X+step;x++){
    double score=Correlate(f,fine,x,y,size);if(best==null||score>best.Score)best=new JinbaoAllyUltimateObservation{Champion=template.Alias,X=x,Y=y,Size=size,Score=score};
   }
   if(best!=null&&best.Score>=.78){best.Score=Math.Round(best.Score,4);Indicator(f,best);if(best.Ready!=null)matches.Add(best);}}
  }
  return matches.ToArray();
 }
 static JinbaoAllyUltimateObservation[] Group(JinbaoAllyUltimateObservation[] matches){
  JinbaoAllyUltimateObservation[] best=new JinbaoAllyUltimateObservation[0];double bestScore=0;
  foreach(var seed in matches.Where(m=>m.Score>=.80))foreach(bool horizontal in new[]{true,false}){
   var group=matches.Where(m=>m.Score>=.80&&m.Size>=seed.Size*.75&&m.Size<=seed.Size*1.3&&
      Math.Abs(horizontal?(m.Y+m.Size/2)-(seed.Y+seed.Size/2):(m.X+m.Size/2)-(seed.X+seed.Size/2))<seed.Size*.22)
     .GroupBy(m=>m.Champion).Select(g=>g.OrderByDescending(m=>m.Score).First()).OrderBy(m=>horizontal?m.X:m.Y).ToArray();
   if(group.Length<3)continue;
   double size=group.Average(m=>m.Size);bool valid=true;
   for(int i=1;i<group.Length;i++){double gap=horizontal?group[i].X-group[i-1].X:group[i].Y-group[i-1].Y;if(gap<size*.85||gap>size*5.8)valid=false;}
   double score=group.Sum(m=>m.Score);
   if(valid&&(group.Length>best.Length||group.Length==best.Length&&score>bestScore)){best=group;bestScore=score;}
  }
  return best;
 }
 public static JinbaoAllyUltimateObservation[] Observe(Bitmap bitmap){
  if(templates.Length<3||bitmap.Width<640||bitmap.Height<480)return new JinbaoAllyUltimateObservation[0];
  Frame f=Read(bitmap);long now=DateTime.UtcNow.Ticks/TimeSpan.TicksPerMillisecond;
  if(layoutWidth==f.W&&layoutHeight==f.H&&layout.Length>=3){
   var observations=new List<JinbaoAllyUltimateObservation>();int matched=0;
   foreach(var slot in layout){var template=templates.FirstOrDefault(t=>t.Alias==slot.Champion);if(template==null)continue;double score=Correlate(f,template.Fine,(int)slot.X,(int)slot.Y,(int)slot.Size);if(score<.78)continue;matched++;
    var observation=new JinbaoAllyUltimateObservation{Champion=slot.Champion,X=slot.X,Y=slot.Y,Size=slot.Size,Score=Math.Round(score,4)};Indicator(f,observation);observations.Add(observation);
   }
   if(matched>=3)return observations.ToArray();
  }
  layout=new JinbaoAllyUltimateObservation[0];if(now<nextCalibration)return layout;
  nextCalibration=now+10000;layout=Group(Find(f));layoutWidth=f.W;layoutHeight=f.H;return layout;
 }
}
