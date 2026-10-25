param([ValidateSet('protect','unprotect')][string]$Action)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$value=[Console]::In.ReadToEnd()
$entropy=[Text.Encoding]::UTF8.GetBytes('jinbao-standalone-v1')
if($Action -eq 'protect'){
 $bytes=[Text.Encoding]::UTF8.GetBytes($value)
 [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser))
}else{
 $bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [Text.Encoding]::UTF8.GetString($bytes)
}
