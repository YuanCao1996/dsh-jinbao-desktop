param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
try {
 $inputData=[Console]::In.ReadToEnd()
 if($inputData.Length -gt 2500000){throw 'audio_limit'}
 $data=ConvertFrom-Json $inputData
 $bytes=[Convert]::FromBase64String([string]$data.audioBase64)
 if($bytes.Length -lt 44 -or $bytes.Length -gt 1800044 -or [Text.Encoding]::ASCII.GetString($bytes,0,4) -ne 'RIFF' -or [Text.Encoding]::ASCII.GetString($bytes,8,4) -ne 'WAVE'){throw 'audio_invalid'}
 $stream=New-Object IO.MemoryStream(,$bytes)
 $player=New-Object System.Media.SoundPlayer($stream)
 try{$player.Load();if(!$CheckOnly){$player.PlaySync()}}finally{$player.Stop();$player.Dispose();$stream.Dispose()}
 [Console]::Write($(if($CheckOnly){'{"decoded":true,"played":false}'}else{'{"played":true}'}))
}catch{[Console]::Error.Write('speech_playback_failed');exit 1}
