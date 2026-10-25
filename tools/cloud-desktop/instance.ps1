param([ValidatePattern('^[a-f0-9]{64}$')][string]$Identity)
$ErrorActionPreference='Stop'
$mutex=[Threading.Mutex]::new($false,('Local\JinbaoCloud-'+$Identity))
$owned=$false
try {
 try {$owned=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owned=$true}
 if(!$owned){[Console]::Out.WriteLine('busy');exit 0}
 [Console]::Out.WriteLine('owned')
 [Console]::Out.Flush()
 # EOF releases ownership when the parent exits, including an unexpected crash.
 $null=[Console]::In.ReadLine()
} finally {
 if($owned){$mutex.ReleaseMutex()}
 $mutex.Dispose()
}
