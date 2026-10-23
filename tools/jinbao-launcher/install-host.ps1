param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference='Stop'
try {
 $signature=Get-AuthenticodeSignature -LiteralPath $InstallerPath
 if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Hangzhou.*DeepSeek.*Artificial.*Intelligence'){
  throw 'Official installer signature verification failed'
 }
 # Keep official consent and installation UI; do not guess silent switches.
 $process=Start-Process -FilePath $InstallerPath -Wait -PassThru
 if($process.ExitCode -notin @(0,3010)){throw 'Installer did not complete'}
} catch {
 Write-Output 'Official DSH installer verification or installation failed.'
 exit 1
}
