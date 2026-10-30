param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
try {
 $raw=[Console]::In.ReadToEnd();if($raw.Length -gt 4096){throw 'speech_invalid'}
 $data=if($CheckOnly){[pscustomobject]@{role='jinbao';text='test';key='fixture'}}else{$raw|ConvertFrom-Json}
 $voices=@{jinbao='longanhuan';liurufeng='longqiang_v3';wangbatian='longtian_v3';tiezhi='longlaotie_v3'}
 if(!$voices.ContainsKey([string]$data.role) -or [string]::IsNullOrWhiteSpace($data.text) -or $data.text.Length -gt 160 -or [string]::IsNullOrWhiteSpace($data.key) -or $data.key.Length -gt 512){throw 'speech_invalid'}
 Add-Type -ReferencedAssemblies System.Web.Extensions.dll -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Net.WebSockets;
using System.Collections.Generic;
using System.Web.Script.Serialization;
public static class JinbaoRoleSpeech {
 static void Send(ClientWebSocket ws,string json,CancellationToken token){var bytes=Encoding.UTF8.GetBytes(json);ws.SendAsync(new ArraySegment<byte>(bytes),WebSocketMessageType.Text,true,token).GetAwaiter().GetResult();}
 public static byte[] Synthesize(string key,string id,string run,string next,string finish){
  using(var timeout=new CancellationTokenSource(30000))using(var ws=new ClientWebSocket())using(var pcm=new MemoryStream()){
   ws.Options.SetRequestHeader("Authorization","Bearer "+key);
   ws.ConnectAsync(new Uri("wss://dashscope.aliyuncs.com/api-ws/v1/inference"),timeout.Token).GetAwaiter().GetResult();
   Send(ws,run,timeout.Token);bool submitted=false;
   while(!timeout.IsCancellationRequested){
    using(var message=new MemoryStream()){
     WebSocketReceiveResult result;var buffer=new byte[16384];
     do{result=ws.ReceiveAsync(new ArraySegment<byte>(buffer),timeout.Token).GetAwaiter().GetResult();if(result.MessageType==WebSocketMessageType.Close)throw new Exception("closed");message.Write(buffer,0,result.Count);if(message.Length>1800000)throw new Exception("limit");}while(!result.EndOfMessage);
     if(result.MessageType==WebSocketMessageType.Binary){var chunk=message.ToArray();pcm.Write(chunk,0,chunk.Length);if(pcm.Length>1800000)throw new Exception("limit");continue;}
     if(message.Length>32768)throw new Exception("limit");
     var json=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(message.ToArray()));
     var header=(Dictionary<string,object>)json["header"];if((string)header["task_id"]!=id)throw new Exception("id");
     string evt=(string)header["event"];
     if(evt=="task-started"&&!submitted){Send(ws,next,timeout.Token);Send(ws,finish,timeout.Token);submitted=true;}
     if(evt=="task-failed")throw new Exception("provider");
     if(evt=="task-finished"){
      if(!submitted||pcm.Length<400||pcm.Length%2!=0)throw new Exception("empty");
      using(var output=new MemoryStream())using(var writer=new BinaryWriter(output)){
       writer.Write(Encoding.ASCII.GetBytes("RIFF"));writer.Write((uint)(pcm.Length+36));writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));writer.Write((uint)16);writer.Write((ushort)1);writer.Write((ushort)1);writer.Write((uint)22050);writer.Write((uint)44100);writer.Write((ushort)2);writer.Write((ushort)16);writer.Write(Encoding.ASCII.GetBytes("data"));writer.Write((uint)pcm.Length);writer.Write(pcm.ToArray());writer.Flush();return output.ToArray();
      }
     }
    }
   }
   throw new Exception("timeout");
  }
 }
}
'@
 if($CheckOnly){[Console]::Write('{"compiled":true}');exit 0}
 $id=[Guid]::NewGuid().ToString('N')
 $run=@{header=@{action='run-task';task_id=$id;streaming='duplex'};payload=@{task_group='audio';task='tts';function='SpeechSynthesizer';model='cosyvoice-v3-flash';parameters=@{text_type='PlainText';voice=$voices[[string]$data.role];format='pcm';sample_rate=22050;volume=50;rate=1.0;pitch=1.0};input=@{}}}|ConvertTo-Json -Depth 8 -Compress
 $next=@{header=@{action='continue-task';task_id=$id;streaming='duplex'};payload=@{input=@{text=[string]$data.text}}}|ConvertTo-Json -Depth 6 -Compress
 $finish=@{header=@{action='finish-task';task_id=$id;streaming='duplex'};payload=@{input=@{}}}|ConvertTo-Json -Depth 6 -Compress
 $bytes=[JinbaoRoleSpeech]::Synthesize([string]$data.key,$id,$run,$next,$finish)
 [Console]::Write((@{mediaType='audio/wav';audioBase64=[Convert]::ToBase64String($bytes)}|ConvertTo-Json -Compress))
}catch{[Console]::Error.Write('speech_provider_unavailable');exit 1}
