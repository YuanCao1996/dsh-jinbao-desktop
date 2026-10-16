param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Destination=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $Destination){throw 'Update destination must be new'}
$zip=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try{
 $seen=@{};$total=0L
 if($zip.Entries.Count -gt 5000){throw 'Too many archive entries'}
 foreach($entry in $zip.Entries){
  $name=$entry.FullName
  if($name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or $name.Contains([char]0)){throw 'Unsafe archive path'}
  $clean=$name.TrimEnd('/')
  if(!$clean -or @($clean.Split('/') | Where-Object {$_ -eq '.' -or $_ -eq '..' -or !$_ -or $_ -match '[. ]$'}).Count){throw 'Unsafe archive path'}
  $target=[IO.Path]::GetFullPath((Join-Path $Destination $clean))
  if(!$target.StartsWith($Destination+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive path escaped destination'}
  if($seen.ContainsKey($clean)){throw 'Duplicate archive path'};$seen[$clean]=$true
  $type=($entry.ExternalAttributes -shr 16) -band 0xF000
  if($type -ne 0 -and $type -ne 0x8000 -and $type -ne 0x4000){throw 'Archive links are not supported'}
  if(($entry.ExternalAttributes -band 0x400) -ne 0){throw 'Archive reparse points are not supported'}
  $total+=$entry.Length
  if($total -gt 314572800){throw 'Expanded archive is too large'}
 }
 if(!$seen.ContainsKey('manifest.json')){throw 'Archive must have a root manifest'}
}finally{$zip.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($Archive),$Destination)
